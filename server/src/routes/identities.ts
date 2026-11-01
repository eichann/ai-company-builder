/**
 * Matching people and companies (名寄せ, `.claude/rules/identity.md`). Mounted
 * at /api/companies/:companyId; a member's session. Rules and the no-leak
 * answers: services/identities.ts. No screen yet (stage 5).
 *
 *   GET  /identities/records/:recordId          the 相手's identity (readable members, pending proposals, history)
 *   POST /identities/records/:recordId/split    take it out into an identity of its own
 *   GET  /identities/proposals                  pending proposals the caller can read both sides of
 *   POST /identities/proposals                  { a, b, reason, confidence? } a person proposes
 *   POST /identities/proposals/:proposalId/approve | /reject
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import { getUserFromRequest } from '../lib/auth'
import { services } from '../composition'
import type { Member } from '../services/access'
import type { Outcome } from '../services/outcome'
import { refusal } from './respond'

export const identitiesRoute = new Hono()
const { access, identities } = services

async function jsonBody(c: Context): Promise<unknown> {
  try { return await c.req.json() } catch { return null }
}

async function memberOf(c: Context): Promise<Member | Response> {
  const user = await getUserFromRequest(c.req.raw)
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const companyId = c.req.param('companyId')
  if (!companyId) return c.json({ error: 'Company ID is required' }, 400)
  const member = access.memberOf(companyId, user.id)
  if (!member) return c.json({ error: 'Company not found or access denied' }, 404)
  return member
}

function answer<T>(c: Context, r: Outcome<T>, status: 200 | 201 = 200) {
  if (!r.ok) return refusal(c, r)
  return c.json({ success: true, data: r.value }, status)
}

identitiesRoute.get('/identities/records/:recordId', async (c) => {
  const m = await memberOf(c)
  if (m instanceof Response) return m
  return answer(c, identities.ofRecord(m, c.req.param('recordId')))
})

identitiesRoute.post('/identities/records/:recordId/split', async (c) => {
  const m = await memberOf(c)
  if (m instanceof Response) return m
  return answer(c, identities.split(m, c.req.param('recordId')))
})

identitiesRoute.get('/identities/proposals', async (c) => {
  const m = await memberOf(c)
  if (m instanceof Response) return m
  return answer(c, identities.proposals(m))
})

identitiesRoute.post('/identities/proposals', async (c) => {
  const m = await memberOf(c)
  if (m instanceof Response) return m
  const r = identities.propose(m, { kind: 'human' }, await jsonBody(c))
  return answer(c, r, r.ok && r.value.created ? 201 : 200)
})

identitiesRoute.post('/identities/proposals/:proposalId/approve', async (c) => {
  const m = await memberOf(c)
  if (m instanceof Response) return m
  return answer(c, identities.decide(m, c.req.param('proposalId'), 'approve'))
})

identitiesRoute.post('/identities/proposals/:proposalId/reject', async (c) => {
  const m = await memberOf(c)
  if (m instanceof Response) return m
  return answer(c, identities.decide(m, c.req.param('proposalId'), 'reject'))
})
