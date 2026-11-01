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
 *
 * A request the member may not read (another company's, or not theirs to
 * see) is the same 404 as one that does not exist.
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import { getUserFromRequest } from '../lib/auth'
import { services } from '../composition'
import type { Member } from '../services/access'
import type { Outcome } from '../services/outcome'
import { refusal } from './respond'

export const approvalsRoute = new Hono()
const { access, approvals } = services

async function authAndAuthorize(c: Context): Promise<Member | Response> {
  const user = await getUserFromRequest(c.req.raw)
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const companyId = c.req.param('companyId')
  if (!companyId) return c.json({ error: 'Company ID is required' }, 400)
  const member = access.memberOf(companyId, user.id)
  if (!member) return c.json({ error: 'Company not found or access denied' }, 404)
  return member
}

async function jsonBody(c: Context): Promise<unknown> {
  try { return await c.req.json() } catch { return null }
}

function answer<T>(c: Context, result: Outcome<T>) {
  if (!result.ok) return refusal(c, result)
  c.header('Cache-Control', 'no-store')
  return c.json({ success: true, data: result.value })
}

approvalsRoute.get('/approvals', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  return answer(c, await approvals.list(member, { scope: c.req.query('scope'), state: c.req.query('state') }))
})

approvalsRoute.get('/approvals/:approvalId', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  return answer(c, await approvals.get(member, c.req.param('approvalId')))
})

approvalsRoute.post('/approvals/:approvalId/approve', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  return answer(c, await approvals.approve(member, c.req.param('approvalId'), await jsonBody(c)))
})

approvalsRoute.post('/approvals/:approvalId/send-back', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  return answer(c, await approvals.sendBack(member, c.req.param('approvalId'), await jsonBody(c)))
})

approvalsRoute.post('/approvals/:approvalId/withdraw', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  return answer(c, await approvals.withdraw(member, c.req.param('approvalId')))
})
