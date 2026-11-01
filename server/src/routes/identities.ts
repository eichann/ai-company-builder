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
import { services } from '../composition'
import type { Outcome } from '../services/outcome'
import { refusal } from './respond'
import { companyMember, serviceBody } from './guards'

export const identitiesRoute = new Hono()
const { identities } = services

function answer<T>(c: Context, r: Outcome<T>, status: 200 | 201 = 200) {
  if (!r.ok) return refusal(c, r)
  return c.json({ success: true, data: r.value }, status)
}

identitiesRoute.get('/identities/records/:recordId', companyMember, async (c) => {
  const m = c.var.member
  return answer(c, identities.ofRecord(m, c.req.param('recordId')))
})

identitiesRoute.post('/identities/records/:recordId/split', companyMember, async (c) => {
  const m = c.var.member
  return answer(c, identities.split(m, c.req.param('recordId')))
})

identitiesRoute.get('/identities/proposals', companyMember, async (c) => {
  const m = c.var.member
  return answer(c, identities.proposals(m))
})

identitiesRoute.post('/identities/proposals', companyMember, serviceBody, async (c) => {
  const m = c.var.member
  const r = identities.propose(m, { kind: 'human' }, c.var.body)
  return answer(c, r, r.ok && r.value.created ? 201 : 200)
})

identitiesRoute.post('/identities/proposals/:proposalId/approve', companyMember, async (c) => {
  const m = c.var.member
  return answer(c, identities.decide(m, c.req.param('proposalId'), 'approve'))
})

identitiesRoute.post('/identities/proposals/:proposalId/reject', companyMember, async (c) => {
  const m = c.var.member
  return answer(c, identities.decide(m, c.req.param('proposalId'), 'reject'))
})
