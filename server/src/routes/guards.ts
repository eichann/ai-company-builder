/**
 * The way into a route (server.md "Route guards"). Every endpoint of
 * src/routes names, as its first handler, one guard from this module:
 *
 *   route.get('/things', companyMember, (c) => { const { member } = c.var; … })
 *   route.put('/things', companyMember, body(ThingInput), (c) => { c.var.body … })
 *   route.post('/things', companyMember, serviceBody, (c) => things.create(c.var.member, c.var.body))
 *   route.get('/', signedIn, (c) => { const { user } = c.var; … })
 *   route.post('/hook', publicRoute('why no session is needed'), (c) => …)
 *
 * - `companyMember`: a session (else 401) and membership of the URL's
 *   `:companyId` (else 404 `Company not found or access denied`, the same
 *   answer as a company that does not exist). The handler reads `c.var.member`
 *   (company id, user id, role, all from the server) and `c.var.user`; it never
 *   reads `companyId` from the URL itself.
 * - `signedIn`: a session only (routes without a company: /api/me, …).
 * - `publicRoute(reason)`: no ACB session on purpose; the handler checks its own
 *   proof (a signature, an OAuth state, an invitation token). Each one is also
 *   listed in tests/security/auth-guards.test.ts PUBLIC_ENDPOINTS.
 * - `body(schema, error?)` / `query(schema, error?)`: zod-parsed input in
 *   `c.var.body` / `c.var.query`; anything else → 400 with a fixed plain
 *   message (never the request's values or zod's text, which can quote them).
 *   They run after the guard, so a caller who may not be there never learns
 *   what a valid body looks like. Role checks that must come before the body
 *   (a member's 403 rather than 400) stay in the service with `serviceBody`.
 * - `serviceBody`: the JSON body as `unknown` (null when it is not JSON) for a
 *   service that validates its own input (most newer services do).
 *
 * tests/security/auth-guards.test.ts fails for an endpoint whose first handler
 * is not one of these guards; eslint.config.js forbids `getUserFromRequest`,
 * `c.req.json()` and `c.req.param('companyId')` in routes outside this file.
 */
import { createMiddleware } from 'hono/factory'
import type { z } from 'zod'
import { getUserFromRequest, type AuthUser } from '../lib/auth'
import { services } from '../composition'
import { NOT_MEMBER_ERROR, type Member } from '../services/access'
import { tagged } from './guard-tags'

export { guardKind, publicRoute } from './guard-tags'

export type SignedInEnv = { Variables: { user: AuthUser } }
export type CompanyEnv = { Variables: { user: AuthUser; member: Member } }

const unauthorized = { error: 'Unauthorized' }

export const companyMember = tagged('company', createMiddleware<CompanyEnv>(async (c, next) => {
  const user = await getUserFromRequest(c.req.raw)
  if (!user) return c.json(unauthorized, 401)
  const companyId = c.req.param('companyId')
  if (!companyId) return c.json({ error: 'Company ID is required' }, 400)
  const member = services.access.memberOf(companyId, user.id)
  if (!member) return c.json({ error: NOT_MEMBER_ERROR }, 404)
  c.set('user', user)
  c.set('member', member)
  await next()
}))

export const signedIn = tagged('signed-in', createMiddleware<SignedInEnv>(async (c, next) => {
  const user = await getUserFromRequest(c.req.raw)
  if (!user) return c.json(unauthorized, 401)
  c.set('user', user)
  await next()
}))

const INVALID_BODY = 'Invalid request body'

async function jsonOrNull(req: { json(): Promise<unknown> }): Promise<unknown> {
  try { return await req.json() } catch { return null }
}

/** The JSON body parsed by `schema` into `c.var.body`; otherwise 400 `{ error }` (a fixed text). */
export function body<S extends z.ZodType>(schema: S, error = INVALID_BODY) {
  return createMiddleware<{ Variables: { body: z.output<S> } }>(async (c, next) => {
    const parsed = schema.safeParse(await jsonOrNull(c.req))
    if (!parsed.success) return c.json({ error }, 400)
    c.set('body', parsed.data)
    await next()
  })
}

/** The query string parsed by `schema` into `c.var.query`; otherwise 400 `{ error }` (a fixed text). */
export function query<S extends z.ZodType>(schema: S, error = 'Invalid query') {
  return createMiddleware<{ Variables: { query: z.output<S> } }>(async (c, next) => {
    const parsed = schema.safeParse(c.req.query())
    if (!parsed.success) return c.json({ error }, 400)
    c.set('query', parsed.data)
    await next()
  })
}

/** The JSON body as `unknown` (null when it is not JSON), for a service that validates its own input. */
export const serviceBody = createMiddleware<{ Variables: { body: unknown } }>(async (c, next) => {
  c.set('body', await jsonOrNull(c.req))
  await next()
})
