/**
 * The request log: one line per request on stdout, shared by every company on
 * the server, so it holds only what troubleshooting needs and nothing a
 * member wrote (2026-10-31; it replaced hono/logger, which printed the URL
 * with its query — file paths, folder names, search terms, private-folder
 * names, a relay token in `?key=`).
 *
 *   [http] <request id> <METHOD> <route pattern> <status> <ms>ms [company=<id>] [user=<id>] [<param>=<id> …]
 *
 * - The route pattern as registered (`/api/companies/:companyId/files/content`),
 *   never the URL; never the query string.
 * - The request id is new for each request and returned in `X-Request-Id`, so
 *   support can find a member's request in the log.
 * - Company and user are opaque ids (never names or emails). Other route
 *   parameters are printed only when listed in OPAQUE_PARAMS and shaped like
 *   an id; anything else is left out (an invitation `:token` is a secret).
 *
 * Detailed per-company history belongs in the per-company, access-controlled
 * records (agent_events, broker_history, push_rejections…), not here.
 */
import { randomUUID } from 'crypto'
import type { MiddlewareHandler } from 'hono'
import { matchedRoutes } from 'hono/route'

export const REQUEST_ID_HEADER = 'X-Request-Id'

/** Route parameters that hold opaque ids (or a service name), safe to print. */
const OPAQUE_PARAMS = new Set([
  'companyId', 'company', 'id', 'userId', 'ruleId', 'scopeId', 'stopId', 'keyId', 'tokenId',
  'invitationId', 'repo', 'service',
])

/** What an id looks like; any other value (a name, a path, Japanese text) is not printed. */
const ID_SHAPE = /^[A-Za-z0-9._-]{1,80}$/

// The signed-in user of a request, noted by whoever authenticated it
// (lib/auth.ts getUserFromRequest, git-http's token check).
const usersByRequest = new WeakMap<Request, string>()

export function noteRequestUser(request: Request, userId: string): void {
  usersByRequest.set(request, userId)
}

/** The company a route is about: `:companyId`, `/api/companies/:id`, or a git repository `<companyId>.git`. */
function companyOf(pattern: string, params: Record<string, string>): string | undefined {
  if (params.companyId) return params.companyId
  if (params.company) return params.company
  if (pattern.startsWith('/api/companies/:id') && params.id) return params.id
  if (pattern.startsWith('/api/git-http/:repo/') && params.repo) return params.repo.replace(/\.git$/, '')
  return undefined
}

/** The log line's fields after the duration, each `key=value` with an id-shaped value. */
export function describeRequest(pattern: string, params: Record<string, string>, userId: string | undefined): string[] {
  const fields: string[] = []
  const company = companyOf(pattern, params)
  if (company && ID_SHAPE.test(company)) fields.push(`company=${company}`)
  if (userId && ID_SHAPE.test(userId)) fields.push(`user=${userId}`)
  for (const [key, value] of Object.entries(params)) {
    if (!OPAQUE_PARAMS.has(key) || !ID_SHAPE.test(value)) continue
    if (value === company && (key === 'companyId' || key === 'company' || key === 'id' || key === 'repo')) continue
    fields.push(`${key}=${value}`)
  }
  return fields
}

export function requestLog(print: (line: string) => void = line => console.log(line)): MiddlewareHandler {
  return async (c, next) => {
    const id = randomUUID()
    const started = performance.now()
    c.header(REQUEST_ID_HEADER, id)
    try {
      await next()
    } finally {
      // The route that answered; middleware (app.use: method ALL) answering
      // means no route did (unknown path, CORS preflight).
      const answered = matchedRoutes(c)[c.req.routeIndex]
      const route = answered && answered.method !== 'ALL' ? answered.path : '(no route)'
      let params: Record<string, string> = {}
      try {
        if (answered && answered.method !== 'ALL') params = c.req.param() as Record<string, string>
      } catch {
        params = {}
      }
      const ms = Math.round(performance.now() - started)
      const fields = describeRequest(route, params, usersByRequest.get(c.req.raw))
      // A response a handler built itself (git-http, Better Auth) does not carry it yet.
      if (!c.res.headers.get(REQUEST_ID_HEADER)) {
        try {
          const headers = new Headers(c.res.headers)
          headers.set(REQUEST_ID_HEADER, id)
          c.res = new Response(c.res.body, { status: c.res.status, statusText: c.res.statusText, headers })
        } catch { /* the log line still carries the id */ }
      }
      print(['[http]', id, c.req.method, route, String(c.res.status), `${ms}ms`, ...fields].join(' '))
    }
  }
}
