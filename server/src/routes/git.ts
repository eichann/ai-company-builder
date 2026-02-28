import { Hono } from 'hono'
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, readFileSync, writeFileSync, chmodSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { getUserFromRequest } from '../lib/auth'

export const gitRoute = new Hono()

// Base directory for Git repositories
const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), 'data')
const REPOS_DIR = process.env.REPOS_DIR || join(DATA_DIR, 'repos')

// Ensure repos directory exists
if (!existsSync(REPOS_DIR)) {
  mkdirSync(REPOS_DIR, { recursive: true })
}

// Path to the pre-receive hook template
const HOOK_TEMPLATE_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'templates', 'pre-receive-hook.sh')

// Install pre-receive hook to a bare repository
function installPreReceiveHook(repoPath: string): boolean {
  try {
    const hooksDir = join(repoPath, 'hooks')
    if (!existsSync(hooksDir)) {
      mkdirSync(hooksDir, { recursive: true })
    }
    const hookDest = join(hooksDir, 'pre-receive')
    const hookContent = readFileSync(HOOK_TEMPLATE_PATH, 'utf-8')
    writeFileSync(hookDest, hookContent)
    chmodSync(hookDest, 0o755)
    return true
  } catch (error) {
    console.error(`Failed to install pre-receive hook to ${repoPath}:`, error)
    return false
  }
}

// List all repositories
gitRoute.get('/repos', async (c) => {
  const user = await getUserFromRequest(c.req.raw)
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  try {
    // Ensure directory exists
    if (!existsSync(REPOS_DIR)) {
      mkdirSync(REPOS_DIR, { recursive: true })
    }

    const files = readdirSync(REPOS_DIR)
    const repos = files
      .filter((name: string) => name.endsWith('.git'))
      .map((name: string) => ({
        id: name.replace('.git', ''),
        path: join(REPOS_DIR, name),
      }))

    return c.json({
      success: true,
      data: repos,
    })
  } catch (error) {
    console.error('Failed to list repositories:', error)
    return c.json({
      success: false,
      error: `Failed to list repositories: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }, 500)
  }
})

// Create a bare repository for a company
gitRoute.post('/repos', async (c) => {
  const user = await getUserFromRequest(c.req.raw)
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  try {
    const body = await c.req.json()
    const { companyId } = body

    if (!companyId) {
      return c.json({
        success: false,
        error: 'companyId is required',
      }, 400)
    }

    // Sanitize companyId to prevent path traversal
    const sanitizedId = companyId.replace(/[^a-zA-Z0-9_-]/g, '')
    const repoPath = join(REPOS_DIR, `${sanitizedId}.git`)

    if (existsSync(repoPath)) {
      return c.json({
        success: true,
        data: {
          companyId: sanitizedId,
          path: repoPath,
          message: 'Repository already exists',
        },
      })
    }

    // Create bare repository
    mkdirSync(repoPath, { recursive: true })
    execFileSync('git', ['init', '--bare', repoPath], { stdio: 'pipe' })

    // Enable HTTP push (required for git-http-backend)
    execFileSync('git', ['-C', repoPath, 'config', 'http.receivepack', 'true'], { stdio: 'pipe' })

    // Install pre-receive hook for secret detection
    installPreReceiveHook(repoPath)

    return c.json({
      success: true,
      data: {
        companyId: sanitizedId,
        path: repoPath,
        message: 'Repository created successfully',
      },
    })
  } catch (error) {
    console.error('Failed to create repository:', error)
    return c.json({
      success: false,
      error: 'Failed to create repository',
    }, 500)
  }
})

// Get repository info
gitRoute.get('/repos/:companyId', async (c) => {
  const user = await getUserFromRequest(c.req.raw)
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const companyId = c.req.param('companyId')
  const sanitizedId = companyId.replace(/[^a-zA-Z0-9_-]/g, '')
  const repoPath = join(REPOS_DIR, `${sanitizedId}.git`)

  if (!existsSync(repoPath)) {
    return c.json({
      success: false,
      error: 'Repository not found',
    }, 404)
  }

  // Build HTTPS URL
  const publicUrl = process.env.PUBLIC_URL || `https://${c.req.header('host') || 'localhost:3001'}`
  const httpsUrl = `${publicUrl}/api/git-http/${sanitizedId}.git`

  // Build SSH URL (legacy, for backwards compatibility)
  const serverHost = process.env.SERVER_HOST
  const serverUser = process.env.SERVER_USER
  const hostRepoPath = process.env.HOST_REPOS_DIR
  const sshUrl = serverHost && serverUser && hostRepoPath
    ? `${serverUser}@${serverHost}:${hostRepoPath}/${sanitizedId}.git`
    : null

  return c.json({
    success: true,
    data: {
      companyId: sanitizedId,
      path: repoPath,
      httpsUrl,
      sshUrl, // legacy: will be removed in a future version
    },
  })
})

// Install pre-receive hooks to all existing repositories
gitRoute.post('/hooks/install', async (c) => {
  const user = await getUserFromRequest(c.req.raw)
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  try {
    if (!existsSync(REPOS_DIR)) {
      return c.json({ success: true, data: { installed: 0, failed: 0, repos: [] } })
    }

    const files = readdirSync(REPOS_DIR)
    const repos = files.filter((name: string) => name.endsWith('.git'))

    const results: { repo: string; success: boolean }[] = []
    let installed = 0
    let failed = 0

    for (const repoName of repos) {
      const repoPath = join(REPOS_DIR, repoName)
      const ok = installPreReceiveHook(repoPath)
      results.push({ repo: repoName, success: ok })
      if (ok) installed++
      else failed++
    }

    return c.json({
      success: true,
      data: { installed, failed, repos: results },
    })
  } catch (error) {
    console.error('Failed to install hooks:', error)
    return c.json({
      success: false,
      error: 'Failed to install hooks',
    }, 500)
  }
})

// Enable http.receivepack on all existing bare repos (migration)
gitRoute.post('/repos/migrate-http', async (c) => {
  const user = await getUserFromRequest(c.req.raw)
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  try {
    if (!existsSync(REPOS_DIR)) {
      return c.json({ success: true, data: { migrated: 0, repos: [] } })
    }

    const files = readdirSync(REPOS_DIR)
    const repos = files.filter((name: string) => name.endsWith('.git'))
    const results: { repo: string; success: boolean }[] = []

    for (const repoName of repos) {
      const repoPath = join(REPOS_DIR, repoName)
      try {
        execFileSync('git', ['-C', repoPath, 'config', 'http.receivepack', 'true'], { stdio: 'pipe' })
        results.push({ repo: repoName, success: true })
      } catch (err) {
        console.error(`Failed to enable http.receivepack for ${repoName}:`, err)
        results.push({ repo: repoName, success: false })
      }
    }

    return c.json({
      success: true,
      data: { migrated: results.filter(r => r.success).length, repos: results },
    })
  } catch (error) {
    console.error('Failed to migrate repos:', error)
    return c.json({ success: false, error: 'Failed to migrate repositories' }, 500)
  }
})

// Delete a repository (owner only)
gitRoute.delete('/repos/:companyId', async (c) => {
  const user = await getUserFromRequest(c.req.raw)
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const companyId = c.req.param('companyId')
  const sanitizedId = companyId.replace(/[^a-zA-Z0-9_-]/g, '')

  // Check if user is owner of this company
  const { db } = await import('../db')
  const membership = db.prepare(
    'SELECT role FROM memberships WHERE user_id = ? AND company_id = ?'
  ).get(user.id, companyId) as { role: string } | undefined

  if (!membership || membership.role !== 'owner') {
    return c.json({ error: 'Only the company owner can delete repositories' }, 403)
  }

  const repoPath = join(REPOS_DIR, `${sanitizedId}.git`)

  if (!existsSync(repoPath)) {
    return c.json({
      success: false,
      error: 'Repository not found',
    }, 404)
  }

  try {
    rmSync(repoPath, { recursive: true, force: true })

    return c.json({
      success: true,
      data: {
        companyId: sanitizedId,
        message: 'Repository deleted successfully',
      },
    })
  } catch (error) {
    return c.json({
      success: false,
      error: 'Failed to delete repository',
    }, 500)
  }
})
