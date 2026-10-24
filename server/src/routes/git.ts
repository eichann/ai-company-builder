import { Hono } from 'hono'
import { existsSync, mkdirSync } from 'fs'
import { getUserFromRequest } from '../lib/auth'
import { REPOS_DIR } from '../lib/config'
import {
  configureAllBareRepos as configureAllBareReposIn,
  configureBareRepo,
  installPreReceiveHook,
} from '../lib/git-server'
import { services } from '../composition'

/**
 * /api/git — what the desktop app needs to find its company's repository.
 *
 *   GET /api/git/repos/:companyId   members of that company only (anyone
 *                                   else: 404) → { companyId, httpsUrl }.
 *                                   Never a server filesystem path.
 *
 * Repository administration is not an API: the server creates a company's
 * repository with the company (routes/companies.ts) and configures every
 * repository and hook at startup (configureAllBareRepos). The former
 * endpoints — list every repository with its server path, create a bare
 * repository for any id, reinstall hooks, run the http.receivepack
 * migration, delete a repository — were callable by any signed-in user of
 * any company and were removed (2026-10-22 security review).
 */
export const gitRoute = new Hono()

// Ensure repos directory exists
if (!existsSync(REPOS_DIR)) {
  mkdirSync(REPOS_DIR, { recursive: true })
}

// Repository setup and the pre-receive hook live behind the git server
// boundary (lib/git-server); re-exported for existing callers.
export { configureBareRepo, installPreReceiveHook }

// Bring every existing repository up to the current standard configuration.
export function configureAllBareRepos(): { total: number; failed: number } {
  return configureAllBareReposIn(REPOS_DIR)
}

// Get repository info (members of the company)
gitRoute.get('/repos/:companyId', async (c) => {
  const user = await getUserFromRequest(c.req.raw)
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const companyId = c.req.param('companyId')
  const sanitizedId = companyId.replace(/[^a-zA-Z0-9_-]/g, '')
  const notFound = () => c.json({ success: false, error: 'Repository not found' }, 404)

  // Not a member: the same answer as for a repository that does not exist.
  const membership = services.access.memberOf(companyId, user.id)
  if (!membership || sanitizedId !== companyId) return notFound()

  if (!services.repoStore.companyRepoExists(sanitizedId)) return notFound()

  // Build the git remote URL. Without PUBLIC_URL, mirror the scheme the
  // client actually reached us with — hardcoding https breaks plain-HTTP
  // setups (e.g. http://localhost:3001 in development): git is told an
  // https:// remote and fails the TLS handshake on every fetch/push.
  const requestProto =
    c.req.header('x-forwarded-proto') || new URL(c.req.url).protocol.replace(':', '')
  const publicUrl =
    process.env.PUBLIC_URL || `${requestProto}://${c.req.header('host') || 'localhost:3001'}`
  const httpsUrl = `${publicUrl}/api/git-http/${sanitizedId}.git`

  // The legacy sshUrl (user@host:<HOST_REPOS_DIR>/<id>.git) is no longer
  // sent: it carried the server's filesystem path, and no app uses SSH.
  return c.json({
    success: true,
    data: {
      companyId: sanitizedId,
      httpsUrl,
    },
  })
})
