import type { MiddlewareHandler } from 'hono'
import { getUserFromRequest } from '../lib/auth'
import { CLIENT_VERSION_HEADER, clientIdentityFromHeaders } from '../lib/client-activity'
import { services } from '../composition'
import { logError } from '../lib/error-log'

// API paths that carry a company context.
const COMPANY_PATHS = [
  /^\/api\/companies\/([^/]+)(?:\/|$)/,
  /^\/api\/git\/repos\/([^/]+)(?:\/|$)/,
]

export function companyIdFromApiPath(path: string): string | null {
  for (const re of COMPANY_PATHS) {
    const m = path.match(re)
    if (m) {
      try {
        return decodeURIComponent(m[1])
      } catch {
        return null
      }
    }
  }
  return null
}

/**
 * Records the desktop-app build for API requests made under a company by one
 * of its members. Only requests that carry X-ACB-Client-Version are recorded:
 * old apps and the admin panel (browser) send none, and must not overwrite
 * what the member's app reported. Runs after the route and never affects the
 * response.
 */
export const clientActivityMiddleware: MiddlewareHandler = async (c, next) => {
  await next()
  try {
    if (!c.req.header(CLIENT_VERSION_HEADER)) return
    const companyId = companyIdFromApiPath(c.req.path)
    if (!companyId) return
    const user = await getUserFromRequest(c.req.raw)
    if (!user) return
    if (!services.access.memberOf(companyId, user.id)) return
    const { version, platform } = clientIdentityFromHeaders((n) => c.req.header(n))
    services.clientActivity.record({ userId: user.id, companyId, kind: 'seen', version, platform })
  } catch (err) {
    logError('client-activity', 'middleware failed', err)
  }
}
