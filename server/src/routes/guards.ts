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
import type { Context } from 'hono'
import type { z } from 'zod'
import { getUserFromRequest, type AuthUser } from '../lib/auth'
import { services } from '../composition'
import { hasFullAccess, NOT_MEMBER_ERROR, type Member } from '../services/access'
import type { RecordTokenHolder } from '../services/record-ai-tokens'
import { tagged } from './guard-tags'
import { holderOf } from './record-ai-auth'

export { guardKind, ownCredential, publicRoute } from './guard-tags'

export type SignedInEnv = { Variables: { user: AuthUser } }
export type CompanyEnv = { Variables: { user: AuthUser; member: Member } }

const unauthorized = { error: 'Unauthorized' }

function memberGuard(notMember: (c: Context) => Response, role?: { error: string }) {
  return tagged('company', createMiddleware<CompanyEnv>(async (c, next) => {
    const user = await getUserFromRequest(c.req.raw)
    if (!user) return c.json(unauthorized, 401)
    const companyId = c.req.param('companyId')
    if (!companyId) return c.json({ error: 'Company ID is required' }, 400)
    const member = services.access.memberOf(companyId, user.id)
    if (role) {
      // Endpoints that never told a non-member from a member without the role: one 403 for both.
      if (!member || !hasFullAccess(member.role)) return c.json({ error: role.error }, 403)
    } else if (!member) {
      return notMember(c)
    }
    c.set('user', user)
    c.set('member', member)
    await next()
  }))
}

const notMemberAnswer = (c: Context) => c.json({ error: NOT_MEMBER_ERROR }, 404)

export const companyMember = memberGuard(notMemberAnswer)

/**
 * `companyMember` whose non-member answer is the endpoint's own 404 body (one
 * that has always read differently, e.g. /api/git's `Repository not found`),
 * the same for every company id.
 */
export function companyMemberNotFound(body: Record<string, unknown>) {
  return memberGuard((c) => c.json(body, 404))
}

/**
 * Owners and admins of `:companyId` only; anyone else signed in (a member with
 * another role or a non-member alike) gets 403 `{ error }`, the endpoint's own
 * text. For endpoints that always answered that way.
 */
export function companyAdmin(error: string) {
  return memberGuard(notMemberAnswer, { error })
}

/** A session only. `error` is the endpoint's own 401 text when it always had one. */
export function signedInOr(error: string) {
  return tagged('signed-in', createMiddleware<SignedInEnv>(async (c, next) => {
    const user = await getUserFromRequest(c.req.raw)
    if (!user) return c.json({ error }, 401)
    c.set('user', user)
    await next()
  }))
}

export const signedIn = signedInOr('Unauthorized')

export type RecordTokenEnv = { Variables: { holder: RecordTokenHolder } }

/**
 * The member's AI on /api/records-ai (records.md "Who is acting"): a record
 * token, never a session (401 without one; 403 `READ_ONLY_TOKEN` for `act`
 * with a read token). The handler reads `c.var.holder` (member, scope, run).
 */
function recordToken(needs: 'read' | 'act') {
  return tagged('record-token', createMiddleware<RecordTokenEnv>(async (c, next) => {
    const holder = holderOf(c, needs)
    if (holder instanceof Response) return holder
    // A built-in 「AI の番」 step's token: only its routes (shared/core/ai-turn-routes.ts, ai-turns.md).
    if (holder.run) {
      const route = `${c.req.method} ${c.req.routePath.replace(/^\/api\/records-ai(?=\/)/, '')}`
      const refused = services.aiRuns.routeRefusal(holder.member, holder.run.id, route, c.req.param(), c.req.header('X-ACB-Client-Version'))
      if (refused) return c.json(refused.body, 403)
    }
    c.set('holder', holder)
    await next()
  }))
}

/** A record token of either scope (a read token or an act token). */
export const aiReads = recordToken('read')
/** An act record token only. */
export const aiActs = recordToken('act')

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
