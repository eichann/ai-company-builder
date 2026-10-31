import { Hono } from 'hono'
import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { type AuthUser } from '../lib/auth'
import { clientIdentityFromHeaders, receivePackSucceeded } from '../lib/client-activity'
import { REPOS_DIR } from '../lib/config'
import { services } from '../composition'
import { preparePushCheck, scrubPushCheckEnv, type PreparedPushCheck } from '../lib/git-server'
import { canReadPrivateScope, type ScopeWithRules } from '../../shared/core/permissions'
import { noteRequestUser } from '../lib/request-log'
import {
  beginCompanyPush,
  beginScopePush,
  canWriteInPrivateFolder,
  endScopePush,
  isScopeClosing,
  privateRepoPath,
} from '../lib/private-folders'
import { logError } from '../lib/error-log'

export const gitHttpRoute = new Hono()

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

    // The session's user, looked up directly in auth.sqlite (Better Auth signs
    // cookies, so auth.api.getSession cannot take a raw token from Basic Auth)
    const user = services.accounts.bySessionToken(token)
    if (user) noteRequestUser(c.req.raw, user.id) // the request log prints the id (lib/request-log.ts)
    return user
  }

  return null
}

// Check if user has access to the company. Returns the member's role for that
// company (owner / admin / member), or null when the user is not a member.
function authorizeForCompany(userId: string, companyId: string): string | null {
  return services.access.memberOf(companyId, userId)?.role ?? null
}

// Sanitize company ID to prevent path traversal
function sanitizeCompanyId(raw: string): string {
  return raw.replace(/\.git$/, '').replace(/[^a-zA-Z0-9_-]/g, '')
}

// ============================================================================
// CGI handler: Spawn git http-backend and proxy request/response
// ============================================================================

// Cap on the receive-pack response kept for the report-status check. The
// report is a few lines per ref plus hook output (sideband progress); a
// response larger than this is not inspected and the push is not recorded.
const MAX_OBSERVED_BODY_BYTES = 1024 * 1024

interface CgiObserver {
  /** Keep a copy of the response body for onClose (bounded). */
  captureBody?: boolean
  /** Called once when git http-backend exits, before the response ends. */
  onClose: (exitCode: number | null, body: Buffer | null) => void
}

async function handleGitCgi(
  c: { req: { raw: Request; header: (name: string) => string | undefined; query: (name: string) => string | undefined } },
  user: AuthUser,
  role: string,
  pathInfo: string,
  method: string,
  observer?: CgiObserver,
  pushCheck?: PreparedPushCheck,
): Promise<Response> {
  const queryString = new URL(c.req.raw.url).searchParams.toString()

  const inherited = { ...process.env } as Record<string, string>
  // ACB_PUSH_POLICY / ACB_INTERNAL_PUSH select how the hook checks write
  // permission; only this request (below) may decide them.
  scrubPushCheckEnv(inherited)
  const cgiEnv: Record<string, string> = {
    ...inherited,
    GIT_PROJECT_ROOT: REPOS_DIR,
    GIT_HTTP_EXPORT_ALL: '1',
    PATH_INFO: pathInfo,
    QUERY_STRING: queryString,
    REQUEST_METHOD: method,
    REMOTE_USER: user.email,
    SERVER_PROTOCOL: 'HTTP/1.1',
    // Who is pushing, for the pre-receive hook: it lets only owner/admin
    // change agent-execution config (.claude/settings.json, .mcp.json,
    // .claude/hooks/ ...) and fails closed when ACB_PUSHER_ROLE is absent.
    // Derived only from the authenticated session + memberships table, and
    // set after the process.env spread so nothing inherited overrides it.
    // A client cannot inject these: request headers reach the CGI only as the
    // two variables copied explicitly below (CONTENT_TYPE,
    // HTTP_CONTENT_ENCODING), and push options are not advertised.
    ACB_PUSHER_ROLE: role,
    ACB_PUSHER_ID: user.id,
    ACB_PUSHER_EMAIL: user.email,
    // The hook inspects skill/agent/command Markdown for auto-run parts with
    // node. Hand it this server's own binary so the check does not depend on
    // PATH (it fails closed for those files when node cannot be run).
    ACB_NODE: process.execPath,
    // receive-pack: the permission snapshot for the write check (see
    // lib/push-check/policy.ts). Always present on a push, so a client push
    // is never write-unchecked.
    ...(pushCheck?.env ?? {}),
  }

  const contentType = c.req.header('Content-Type')
  if (contentType) {
    cgiEnv.CONTENT_TYPE = contentType
  }

  // git gzips some request bodies (e.g. upload-pack negotiation); http-backend
  // only inflates them when this CGI variable is present.
  const contentEncoding = c.req.header('Content-Encoding')
  if (contentEncoding) {
    cgiEnv.HTTP_CONTENT_ENCODING = contentEncoding
  }

  // Cap memory used by git pack-objects (invoked by upload-pack, receive-pack,
  // and the auto-gc that runs after pushes). Without these, a single push on
  // the 2.4 GiB company repo can spike to >2 GiB and approach the host's OOM
  // threshold. These settings apply only to the spawned process.
  const gitConfigs: Array<[string, string]> = [
    ['pack.windowMemory', '256m'],
    ['pack.threads', '1'],
    ['pack.deltaCacheSize', '128m'],
    ['core.bigFileThreshold', '16m'],
  ]
  cgiEnv.GIT_CONFIG_COUNT = String(gitConfigs.length)
  gitConfigs.forEach(([key, value], i) => {
    cgiEnv[`GIT_CONFIG_KEY_${i}`] = key
    cgiEnv[`GIT_CONFIG_VALUE_${i}`] = value
  })

  const cgi = spawn('git', ['http-backend'], {
    env: cgiEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  // Stream request body into CGI stdin. Buffering the whole body would put
  // multi-GB push payloads onto the Node heap and trigger OOM on small hosts.
  //
  // Two hard-won constraints (see PR for the forensics):
  // 1. The response below MUST NOT resolve before this body is consumed.
  //    @hono/node-server aborts the unread request body once the response
  //    completes (AbortError / ERR_STREAM_PREMATURE_CLOSE). Loopback tests
  //    hide this — the body finishes before the CGI emits headers — but on
  //    real networks the upload is still in flight when receive-pack writes
  //    its response headers, so every slow/large push died mid-transfer.
  //    git http-backend is half-duplex (reads the whole request before
  //    emitting the result), so holding the response is always safe.
  // 2. Read from the raw Node IncomingMessage instead of c.req.raw.body to
  //    stay decoupled from the web-Request/AbortController lifecycle.
  //    pipe() gives us backpressure for free.
  const incoming = (c as { env?: { incoming?: NodeJS.ReadableStream } }).env?.incoming
  let requestBodyConsumed = method !== 'POST'
  let onRequestBodyConsumed: (() => void) | null = null
  if (!requestBodyConsumed && incoming) {
    incoming.pipe(cgi.stdin)
    incoming.on('end', () => {
      requestBodyConsumed = true
      onRequestBodyConsumed?.()
    })
    incoming.on('error', (err) => {
      logError('git-http', 'error streaming the request body', err)
      cgi.stdin.destroy()
      cgi.kill()
      requestBodyConsumed = true
      onRequestBodyConsumed?.()
    })
  } else if (!requestBodyConsumed && c.req.raw.body) {
    // Fallback for non-node-server runtimes (tests etc.)
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
        logError('git-http', 'error streaming the request body', err)
        cgi.stdin.destroy()
        cgi.kill()
      } finally {
        requestBodyConsumed = true
        // TS narrows the captured variable to null inside this IIFE; it is
        // assigned in the Promise executor below before any await resolves.
        ;(onRequestBodyConsumed as (() => void) | null)?.()
      }
    })()
  } else {
    requestBodyConsumed = true
    cgi.stdin.end()
  }

  cgi.stdin.on('error', () => {
    // CGI may close stdin early (e.g. on protocol errors); avoid crashing the server.
  })

  // Drained, never logged: git's stderr can carry the push checker's messages,
  // which name paths (lib/error-log.ts).
  cgi.stderr.resume()

  // Observation only: a copy of stdout (headers included) for the observer.
  let observedChunks: Buffer[] | null = observer?.captureBody ? [] : null
  let observedBytes = 0
  if (observedChunks) {
    cgi.stdout.on('data', (chunk: Buffer) => {
      if (!observedChunks) return
      observedBytes += chunk.length
      if (observedBytes > MAX_OBSERVED_BODY_BYTES) observedChunks = null
      else observedChunks.push(chunk)
    })
  }
  const notifyObserver = (code: number | null) => {
    if (!observer) return
    let body: Buffer | null = null
    if (observedChunks) {
      const all = Buffer.concat(observedChunks)
      const end = all.indexOf('\r\n\r\n')
      body = end === -1 ? null : all.subarray(end + 4)
    }
    try {
      observer.onClose(code, body)
    } catch (err) {
      logError('git-http', 'observer failed', err)
    }
  }

  return new Promise<Response>((resolve) => {
    let headerBuffer = Buffer.alloc(0)
    let parsedHead: { status: number; headers: Headers; remainder: Buffer } | null = null
    let headersDone = false
    let resolved = false
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

      parsedHead = { status, headers, remainder }
      headersDone = true
      return true
    }

    // Resolve only once headers are parsed AND the request body is fully
    // handed to the CGI. Resolving earlier aborts the in-flight request
    // body (see the streaming block above). If the CGI already exited, the
    // client should get the result without waiting for the rest of the
    // upload to drain.
    const resolveResponse = () => {
      if (resolved || !parsedHead) return
      if (!requestBodyConsumed && !cgiClosed) return
      resolved = true
      const { status, headers, remainder } = parsedHead

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
    }

    onRequestBodyConsumed = resolveResponse

    cgi.stdout.on('data', (chunk: Buffer) => {
      if (headersDone) {
        if (bodyController) bodyController.enqueue(chunk)
        else pendingBodyChunks.push(chunk)
        return
      }
      headerBuffer = Buffer.concat([headerBuffer, chunk])
      if (tryParseHeaders()) {
        resolveResponse()
        return
      }
      if (headerBuffer.length > MAX_HEADER_BYTES) {
        headersDone = true
        resolved = true
        logError('git-http', 'CGI header section exceeded the limit', undefined, { user: user.id })
        cgi.kill()
        resolve(new Response('Internal Server Error', { status: 500 }))
      }
    })

    const logFailure = (code: number | null, phase: string) => {
      // Not pathInfo or stderr: stderr carries the push checker's rejections, which name paths.
      logError('git-http', `git http-backend exited with code ${code} (${phase})`, undefined, { method, user: user.id })
    }

    cgi.on('close', (code) => {
      pushCheck?.cleanup()
      notifyObserver(code)
      cgiClosed = true
      cgiExitCode = code
      if (!resolved) {
        if (!headersDone && headerBuffer.length > 0) tryParseHeaders()
        if (parsedHead) {
          resolveResponse()
          return
        }
        resolved = true
        if (code !== 0) {
          logFailure(code, 'before headers')
          resolve(new Response('Internal Server Error', { status: 500 }))
        } else {
          resolve(new Response(headerBuffer, { status: 200 }))
        }
      } else if (bodyController) {
        if (code === 0) bodyController.close()
        else {
          logFailure(code, 'mid-body')
          bodyController.error(new Error(`git http-backend exited with code ${code}`))
        }
      }
    })

    cgi.on('error', (err) => {
      pushCheck?.cleanup()
      if (!resolved) {
        resolved = true
        logError('git-http', 'failed to spawn git http-backend', err, { method, user: user.id })
        resolve(new Response('Internal Server Error', { status: 500 }))
      } else if (bodyController) {
        logError('git-http', 'git http-backend error after headers', err, { method, user: user.id })
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
function authAndAuthorize(c: { req: { raw: Request; header: (name: string) => string | undefined; param: (name: string) => string } }): { user: AuthUser; companyId: string; role: string } | Response {
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

  const role = authorizeForCompany(user.id, companyId)
  if (!role) {
    return new Response('Forbidden', { status: 403 })
  }

  return { user, companyId, role }
}

// The permission snapshot the hook checks this push against: the pusher and
// the company's scopes with their rules, read now (the same rows
// resolveAccess reads). ensureCompanyScope materialises the default
// `everyone: read + write` for a company that predates the permission tables
// (startup seeding normally did it already). If anything here fails, the
// snapshot is left out and the checker rejects the push (fail closed).
//
// For a scope repository (`scopePath` set) the checker evaluates every pushed
// path as `<scopePath>/<path>`; for the company repository it also refuses
// changes under private folders' paths ([RESERVED_PATH]).
function pushCheckFor(companyId: string, userId: string, scopePath?: string): PreparedPushCheck {
  try {
    services.scopes.ensureCompanyScope(companyId, null)
    const role = services.access.memberOf(companyId, userId)?.role ?? null
    // Department folders this pusher manages: instruction files (CLAUDE.md,
    // AGENTS.md ...) inside them are theirs to change.
    const managedFolders = services.permissionViews.managedFolders(companyId, userId)
    return preparePushCheck({
      companyId,
      pusher: { id: userId, role },
      scopes: services.scopes.listWithRules(companyId),
      ...(scopePath !== undefined ? { scopePath } : {}),
      managedFolders,
    })
  } catch (err) {
    logError('git-http', 'cannot build the push permission snapshot', err)
    return { env: { ACB_PUSH_POLICY: '' }, cleanup: () => {} }
  }
}

// Record which build the user ran (header or unknown) and, via the returned
// observer, a completed fetch / an accepted push. See services/client-activity.ts.
function trackActivity(
  c: { req: { header: (name: string) => string | undefined } },
  userId: string,
  companyId: string,
  op: 'other' | 'fetch' | 'push',
): CgiObserver | undefined {
  const { version, platform } = clientIdentityFromHeaders((n) => c.req.header(n))
  services.clientActivity.record({ userId, companyId, kind: 'seen', version, platform })
  if (op === 'fetch') {
    return {
      onClose: (code) => {
        if (code === 0) services.clientActivity.record({ userId, companyId, kind: 'fetch', version, platform })
      },
    }
  }
  if (op === 'push') {
    return {
      captureBody: true,
      onClose: (code, body) => {
        if (code === 0 && body && receivePackSucceeded(body)) {
          services.clientActivity.record({ userId, companyId, kind: 'push', version, platform })
          // A push may have renamed or removed a folder that has rules.
          // Deferred (setImmediate) and asynchronous: never delays the push.
          services.orphanedScopes.scheduleCheck(companyId)
        } else {
          // Rejected (or unproven): record any pre-receive hook sections it
          // printed. Deferred and non-throwing — see services/push-rejections.ts.
          services.pushRejections.observe(companyId, userId, body)
        }
      },
    }
  }
  return undefined
}

// GET /:repo/info/refs
gitHttpRoute.get('/:repo/info/refs', async (c) => {
  const result = authAndAuthorize(c)
  if (result instanceof Response) return result
  const { user, companyId, role } = result

  const service = c.req.query('service')
  if (!service || !['git-upload-pack', 'git-receive-pack'].includes(service)) {
    return c.text('Invalid service', 400)
  }

  // A fetch that finds nothing new stops after this advertisement (no
  // upload-pack POST), so it is what marks "fetched" for an up-to-date member.
  const observer = trackActivity(c, user.id, companyId, service === 'git-upload-pack' ? 'fetch' : 'other')
  return handleGitCgi(c, user, role, `/${companyId}.git/info/refs`, 'GET', observer)
})

// POST /:repo/git-upload-pack
gitHttpRoute.post('/:repo/git-upload-pack', async (c) => {
  const result = authAndAuthorize(c)
  if (result instanceof Response) return result
  const { user, companyId, role } = result

  const observer = trackActivity(c, user.id, companyId, 'fetch')
  return handleGitCgi(c, user, role, `/${companyId}.git/git-upload-pack`, 'POST', observer)
})

// POST /:repo/git-receive-pack
gitHttpRoute.post('/:repo/git-receive-pack', async (c) => {
  const result = authAndAuthorize(c)
  if (result instanceof Response) return result
  const { user, companyId, role } = result

  const observer = trackActivity(c, user.id, companyId, 'push')
  // Registered BEFORE the snapshot: creating a private folder waits for every
  // push whose snapshot may predate its reservation (lib/private-folders.ts).
  const endPush = beginCompanyPush(companyId)
  const check = pushCheckFor(companyId, user.id)
  const pushCheck: PreparedPushCheck = {
    env: check.env,
    cleanup: () => {
      check.cleanup()
      endPush()
    },
  }
  try {
    return await handleGitCgi(c, user, role, `/${companyId}.git/git-receive-pack`, 'POST', observer, pushCheck)
  } catch (err) {
    pushCheck.cleanup()
    throw err
  }
})

// GET /:repo/HEAD
gitHttpRoute.get('/:repo/HEAD', async (c) => {
  const result = authAndAuthorize(c)
  if (result instanceof Response) return result
  const { user, companyId, role } = result

  return handleGitCgi(c, user, role, `/${companyId}.git/HEAD`, 'GET')
})

// ============================================================================
// Private folders: scope repositories
//
//   /api/git-http/<companyId>/scopes/<scopeId>.git/...
//
// On disk <REPOS_DIR>/<companyId>.scopes/<repoId>.git (lib/git-server/
// scope-repo.ts). Fetch / clone (info/refs?service=git-upload-pack,
// git-upload-pack, HEAD) need READ of the private folder; push
// (info/refs?service=git-receive-pack, git-receive-pack) needs WRITE
// somewhere in it — the hook then checks every pushed path. Anyone who may
// not read it — or is not a member, or names a scope that does not exist or
// is not private — gets the same 404, so the URL reveals nothing.
// ============================================================================

const SCOPE_ID_RE = /^[A-Za-z0-9-]{1,64}$/

interface ScopeRequest {
  user: AuthUser
  companyId: string
  role: string
  scope: ScopeWithRules
  scopes: ScopeWithRules[]
  /** PATH_INFO prefix: /<companyId>.scopes/<repoId>.git */
  repoPathInfo: string
}

function authAndAuthorizeScope(c: { req: { raw: Request; header: (name: string) => string | undefined; param: (name: string) => string } }, access: 'read' | 'write'): ScopeRequest | Response {
  const user = authenticateGitRequest(c)
  if (!user) {
    return new Response('Authentication required', {
      status: 401,
      headers: { 'WWW-Authenticate': 'Basic realm="AI Company Builder Git"' },
    })
  }
  const notFound = () => new Response('Repository not found', { status: 404 })
  const companyId = sanitizeCompanyId(c.req.param('company'))
  const scopeId = c.req.param('repo').replace(/\.git$/, '')
  if (!companyId || !SCOPE_ID_RE.test(scopeId)) return notFound()
  const role = authorizeForCompany(user.id, companyId)
  if (!role) return notFound()
  const scopes = services.scopes.listWithRules(companyId)
  const scope = scopes.find(s => s.id === scopeId && s.repoId !== null)
  if (!scope || !canReadPrivateScope(scope, user.id, role)) return notFound()
  let repoPath: string
  try {
    repoPath = privateRepoPath(companyId, scope.repoId!)
  } catch {
    return notFound()
  }
  if (!existsSync(repoPath)) return notFound()
  if (access === 'write' && !canWriteInPrivateFolder(scopes, scope, companyId, user.id, role)) {
    return new Response('Forbidden', { status: 403 })
  }
  return { user, companyId, role, scope, scopes, repoPathInfo: `/${companyId}.scopes/${scope.repoId}.git` }
}

gitHttpRoute.get('/:company/scopes/:repo/info/refs', async (c) => {
  const service = c.req.query('service')
  if (!service || !['git-upload-pack', 'git-receive-pack'].includes(service)) {
    return c.text('Invalid service', 400)
  }
  const r = authAndAuthorizeScope(c, service === 'git-receive-pack' ? 'write' : 'read')
  if (r instanceof Response) return r
  const observer = trackActivity(c, r.user.id, r.companyId, service === 'git-upload-pack' ? 'fetch' : 'other')
  return handleGitCgi(c, r.user, r.role, `${r.repoPathInfo}/info/refs`, 'GET', observer)
})

gitHttpRoute.post('/:company/scopes/:repo/git-upload-pack', async (c) => {
  const r = authAndAuthorizeScope(c, 'read')
  if (r instanceof Response) return r
  const observer = trackActivity(c, r.user.id, r.companyId, 'fetch')
  return handleGitCgi(c, r.user, r.role, `${r.repoPathInfo}/git-upload-pack`, 'POST', observer)
})

gitHttpRoute.post('/:company/scopes/:repo/git-receive-pack', async (c) => {
  const r = authAndAuthorizeScope(c, 'write')
  if (r instanceof Response) return r
  // Being made public (lib/private-folders.ts): its contents are moving into
  // the company repository; a push now would be lost.
  if (isScopeClosing(r.scope.id) || !beginScopePush(r.scope.id)) {
    return new Response('This folder is being changed; try again shortly', { status: 503 })
  }
  const check = pushCheckFor(r.companyId, r.user.id, r.scope.path)
  let ended = false
  const pushCheck: PreparedPushCheck = {
    env: check.env,
    cleanup: () => {
      check.cleanup()
      if (!ended) {
        ended = true
        endScopePush(r.scope.id)
      }
    },
  }
  const observer = trackActivity(c, r.user.id, r.companyId, 'push')
  return handleGitCgi(c, r.user, r.role, `${r.repoPathInfo}/git-receive-pack`, 'POST', observer, pushCheck)
})

gitHttpRoute.get('/:company/scopes/:repo/HEAD', async (c) => {
  const r = authAndAuthorizeScope(c, 'read')
  if (r instanceof Response) return r
  return handleGitCgi(c, r.user, r.role, `${r.repoPathInfo}/HEAD`, 'GET')
})
