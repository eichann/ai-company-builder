/**
 * Approval requests (承認のお願い, milestone 4 G6, `.claude/rules/approvals.md`).
 * Mounted at /api/companies/:companyId. **Session only**: approving, sending
 * back and withdrawing are a person's acts — there is no route for the AI's
 * record token (routes/records-ai.ts only lists and reads) nor for any other
 * credential. Rules: services/approvals.ts; contract: shared/types/approvals.ts.
 *
 *   GET  /approvals?scope=mine|to-me&state=pending|any    requests the member may read (no list screen yet: milestone 5)
 *   GET  /approvals/:approvalId                           the card: fixed content, precedents, materials, state
 *   POST /approvals/:approvalId/approve     { hash, reason }   the person who qualifies; runs the operation once
 *   POST /approvals/:approvalId/send-back   { reason }         back to the requester's turn
 *   POST /approvals/:approvalId/withdraw                       the requester
 *   POST /approvals/:approvalId/same-as     { recordId, linkMeeting? }   「これと同じ…です（作らない）」: requester or approver
 *
 * A request the member may not read (another company's, or not theirs to
 * see) is the same 404 as one that does not exist.
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import { services } from '../composition'
import type { Outcome } from '../services/outcome'
import { refusal } from './respond'
import { companyMember, serviceBody } from './guards'

export const approvalsRoute = new Hono()
const { approvals } = services

function answer<T>(c: Context, result: Outcome<T>) {
  if (!result.ok) return refusal(c, result)
  c.header('Cache-Control', 'no-store')
  return c.json({ success: true, data: result.value })
}

approvalsRoute.get('/approvals', companyMember, async (c) => {
  const member = c.var.member
  return answer(c, await approvals.list(member, { scope: c.req.query('scope'), state: c.req.query('state') }))
})

approvalsRoute.get('/approvals/:approvalId', companyMember, async (c) => {
  const member = c.var.member
  return answer(c, await approvals.get(member, c.req.param('approvalId')))
})

approvalsRoute.post('/approvals/:approvalId/approve', companyMember, serviceBody, async (c) => {
  const member = c.var.member
  return answer(c, await approvals.approve(member, c.req.param('approvalId'), c.var.body))
})

approvalsRoute.post('/approvals/:approvalId/send-back', companyMember, serviceBody, async (c) => {
  const member = c.var.member
  return answer(c, await approvals.sendBack(member, c.req.param('approvalId'), c.var.body))
})

approvalsRoute.post('/approvals/:approvalId/withdraw', companyMember, async (c) => {
  const member = c.var.member
  return answer(c, await approvals.withdraw(member, c.req.param('approvalId')))
})

approvalsRoute.post('/approvals/:approvalId/same-as', companyMember, serviceBody, async (c) => {
  const member = c.var.member
  return answer(c, await approvals.sameAs(member, c.req.param('approvalId'), c.var.body))
})
