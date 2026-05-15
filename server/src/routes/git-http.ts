import { Hono } from 'hono'
import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import Database from 'better-sqlite3'
import { type AuthUser } from '../lib/auth'
import { db } from '../db'

export const gitHttpRoute = new Hono()

const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), 'data')
const REPOS_DIR = process.env.REPOS_DIR || join(DATA_DIR, 'repos')

// Auth DB for direct session lookup (Better Auth signs cookies, so we can't
// use auth.api.getSession with raw tokens from Basic Auth)
const authDb = new Database(join(DATA_DIR, 'auth.sqlite'))

// ============================================================================
// Authentication: Extract user from Basic Auth header (session token as password)
// ============================================================================

function authenticateGitRequest(c: { req: { raw: Request; header: (name: string) => string | undefined } }): AuthUser | null {
  const authHeader = c.req.header('Authorization')
  if (!authHeader) return null

  // Basic Auth: username is ignored, password is the session token
  if (authHeader.startsWith('Basic ')) {
    const decoded = Buffer.from(authHeader.slice(6), 'base64').toString()
    const colonIndex = decoded.indexOf(':')
    const token = colonIndex >= 0 ? decoded.slice(colonIndex + 1) : decoded

    if (!token) return null

    // Look up session directly in auth.sqlite
    const session = authDb.prepare(
      'SELECT userId FROM session WHERE token = ? AND expiresAt > ?'
    ).get(token, new Date().toISOString()) as { userId: string } | undefined

    if (!session) return null

    // Get user from auth.sqlite
    const user = authDb.prepare(
      'SELECT id, email, name, image, emailVerified FROM user WHERE id = ?'
    ).get(session.userId) as { id: string; email: string; name: string | null; image: string | null; emailVerified: boolean } | undefined

    if (!user) return null

    return {
      id: user.id,
      email: user.email,
      name: user.name ?? null,
      image: user.image ?? null,
      emailVerified: !!user.emailVerified,
    }
  }

  return null
}

// Check if user has access to the company
function authorizeForCompany(userId: string, companyId: string): boolean {
  const membership = db.prepare(
    'SELECT role FROM memberships WHERE user_id = ? AND company_id = ?'
  ).get(userId, companyId) as { role: string } | undefined
  return !!membership
}

// Sanitize company ID to prevent path traversal
function sanitizeCompanyId(raw: string): string {
  return raw.replace(/\.git$/, '').replace(/[^a-zA-Z0-9_-]/g, '')
}

// ============================================================================
// CGI handler: Spawn git http-backend and proxy request/response
// ============================================================================

async function handleGitCgi(
  c: { req: { raw: Request; header: (name: string) => string | undefined; query: (name: string) => string | undefined } },
  user: AuthUser,
  pathInfo: string,
  method: string,
): Promise<Response> {
  const queryString = new URL(c.req.raw.url).searchParams.toString()

  const cgiEnv: Record<string, string> = {
    ...process.env as Record<string, string>,
    GIT_PROJECT_ROOT: REPOS_DIR,
    GIT_HTTP_EXPORT_ALL: '1',
    PATH_INFO: pathInfo,
    QUERY_STRING: queryString,
    REQUEST_METHOD: method,
    REMOTE_USER: user.email,
    SERVER_PROTOCOL: 'HTTP/1.1',
  }

  const contentType = c.req.header('Content-Type')
  if (contentType) {
    cgiEnv.CONTENT_TYPE = contentType
  }

  const cgi = spawn('git', ['http-backend'], {
    env: cgiEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  // Stream request body into CGI stdin. Buffering the whole body would put
  // multi-GB push payloads onto the Node heap and trigger OOM on small hosts.
  if (method === 'POST' && c.req.raw.body) {
    const reader = c.req.raw.body.getReader()
    void (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          if (!cgi.stdin.write(value)) {
            await new Promise<void>(r => cgi.stdin.once('drain', () => r()))
          }
        }
        cgi.stdin.end()
      } catch (err) {
        console.error('[git-http] Error streaming request body:', err)
        cgi.stdin.destroy()
        cgi.kill()
      }
    })()
  } else {
    cgi.stdin.end()
  }

  cgi.stdin.on('error', () => {
    // CGI may close stdin early (e.g. on protocol errors); avoid crashing the server.
  })

  let stderrData = ''
  cgi.stderr.on('data', (data: Buffer) => { stderrData += data.toString() })

  return new Promise<Response>((resolve) => {
    let headerBuffer = Buffer.alloc(0)
    let headersResolved = false
    let bodyController: ReadableStreamDefaultController<Uint8Array> | null = null
    const pendingBodyChunks: Buffer[] = []
    let cgiClosed = false
    let cgiExitCode: number | null = null

    const MAX_HEADER_BYTES = 64 * 1024

    const tryParseHeaders = (): boolean => {
      const headerEnd = headerBuffer.indexOf('\r\n\r\n')
      if (headerEnd === -1) return false

      const headerSection = headerBuffer.subarray(0, headerEnd).toString()
      const remainder = headerBuffer.subarray(headerEnd + 4)

      const headers = new Headers()
      let status = 200
      for (const line of headerSection.split('\r\n')) {
        const colonIdx = line.indexOf(':')
        if (colonIdx === -1) continue
        const key = line.slice(0, colonIdx).trim()
        const value = line.slice(colonIdx + 1).trim()
        if (key.toLowerCase() === 'status') {
          const code = parseInt(value, 10)
          if (!isNaN(code)) status = code
        } else {
          headers.set(key, value)
        }
      }

      headersResolved = true

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          bodyController = controller
          if (remainder.length > 0) controller.enqueue(remainder)
          for (const chunk of pendingBodyChunks) controller.enqueue(chunk)
          pendingBodyChunks.length = 0
          if (cgiClosed) {
            if (cgiExitCode === 0) controller.close()
            else controller.error(new Error(`git http-backend exited with code ${cgiExitCode}`))
          }
        },
        cancel() {
          cgi.kill()
        },
      })

      resolve(new Response(stream, { status, headers }))
      return true
    }

    cgi.stdout.on('data', (chunk: Buffer) => {
      if (headersResolved) {
        if (bodyController) bodyController.enqueue(chunk)
        else pendingBodyChunks.push(chunk)
        return
      }
      headerBuffer = Buffer.concat([headerBuffer, chunk])
      if (tryParseHeaders()) return
      if (headerBuffer.length > MAX_HEADER_BYTES) {
        headersResolved = true
        console.error('[git-http] CGI header section exceeded limit', stderrData)
        cgi.kill()
        resolve(new Response('Internal Server Error', { status: 500 }))
      }
    })

    cgi.on('close', (code) => {
      cgiClosed = true
      cgiExitCode = code
      if (!headersResolved) {
        if (headerBuffer.length > 0 && tryParseHeaders()) return
        if (code !== 0) {
          console.error(`[git-http] git http-backend exited with code ${code}`, stderrData)
          headersResolved = true
          resolve(new Response('Internal Server Error', { status: 500 }))
        } else {
          headersResolved = true
          resolve(new Response(headerBuffer, { status: 200 }))
        }
      } else if (bodyController) {
        if (code === 0) bodyController.close()
        else bodyController.error(new Error(`git http-backend exited with code ${code}`))
      }
    })

    cgi.on('error', (err) => {
      if (!headersResolved) {
        headersResolved = true
        console.error('[git-http] Failed to spawn git http-backend:', err)
        resolve(new Response('Internal Server Error', { status: 500 }))
      } else if (bodyController) {
        bodyController.error(err)
      }
    })
  })
}

// ============================================================================
// Route handlers
// ============================================================================

// Extract companyId from repo param (e.g. "97dfe9kimy5cnl5crh87e.git" -> "97dfe9kimy5cnl5crh87e")
function extractCompanyId(repo: string): string {
  return sanitizeCompanyId(repo.replace(/\.git$/, ''))
}

// Middleware: authenticate and authorize
function authAndAuthorize(c: { req: { raw: Request; header: (name: string) => string | undefined; param: (name: string) => string } }): { user: AuthUser; companyId: string } | Response {
  const user = authenticateGitRequest(c)
  if (!user) {
    return new Response('Authentication required', {
      status: 401,
      headers: { 'WWW-Authenticate': 'Basic realm="AI Company Builder Git"' },
    })
  }

  const repo = c.req.param('repo')
  const companyId = extractCompanyId(repo)
  if (!companyId) {
    return new Response('Invalid repository', { status: 400 })
  }

  const repoPath = join(REPOS_DIR, `${companyId}.git`)

  if (!existsSync(repoPath)) {
    return new Response('Repository not found', { status: 404 })
  }

  if (!authorizeForCompany(user.id, companyId)) {
    return new Response('Forbidden', { status: 403 })
  }

  return { user, companyId }
}

// GET /:repo/info/refs
gitHttpRoute.get('/:repo/info/refs', async (c) => {
  const result = authAndAuthorize(c)
  if (result instanceof Response) return result
  const { user, companyId } = result

  const service = c.req.query('service')
  if (!service || !['git-upload-pack', 'git-receive-pack'].includes(service)) {
    return c.text('Invalid service', 400)
  }

  return handleGitCgi(c, user, `/${companyId}.git/info/refs`, 'GET')
})

// POST /:repo/git-upload-pack
gitHttpRoute.post('/:repo/git-upload-pack', async (c) => {
  const result = authAndAuthorize(c)
  if (result instanceof Response) return result
  const { user, companyId } = result

  return handleGitCgi(c, user, `/${companyId}.git/git-upload-pack`, 'POST')
})

// POST /:repo/git-receive-pack
gitHttpRoute.post('/:repo/git-receive-pack', async (c) => {
  const result = authAndAuthorize(c)
  if (result instanceof Response) return result
  const { user, companyId } = result

  return handleGitCgi(c, user, `/${companyId}.git/git-receive-pack`, 'POST')
})

// GET /:repo/HEAD
gitHttpRoute.get('/:repo/HEAD', async (c) => {
  const result = authAndAuthorize(c)
  if (result instanceof Response) return result
  const { user, companyId } = result

  return handleGitCgi(c, user, `/${companyId}.git/HEAD`, 'GET')
})
