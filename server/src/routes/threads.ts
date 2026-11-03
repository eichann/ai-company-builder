/**
 * The card's 元のスレッド (stage 3 A4, `.claude/rules/outbound-mail.md` "Replies";
 * contract shared/types/threads.ts): the original thread of a record that came
 * from outside, read now through the core role with the member's own
 * permission. Nothing is stored; rules in services/threads.ts.
 *
 *   threadsRoute (session, /api/companies/:companyId):   GET /threads/:recordId
 *   recordsAiThreadsRoute (record token, /api/records-ai/threads; a read token is enough):
 *     GET /:recordId — the member's AI reads the thread to draft a reply or follow up (B4 / B5);
 *     inside a plugin step's run only when the step declares the role (C4)
 */
import { Hono } from 'hono'
import { services } from '../composition'
import { aiReads, companyMember, type CompanyEnv, type RecordTokenEnv } from './guards'
import { connectorRoleRefusal } from './record-ai-auth'
import { refusal } from './respond'

export const threadsRoute = new Hono<CompanyEnv>()
const { threads } = services

threadsRoute.get('/threads/:recordId', companyMember, async (c) => {
  const r = await threads.thread(c.var.member, c.req.param('recordId'))
  if (!r.ok) return refusal(c, r)
  return c.json({ success: true, data: r.value }, 200)
})

export const recordsAiThreadsRoute = new Hono<RecordTokenEnv>()

recordsAiThreadsRoute.get('/:recordId', aiReads, async (c) => {
  const h = c.var.holder
  const r = await threads.thread(h.member, c.req.param('recordId'), async role => (await connectorRoleRefusal(c, h, role)) === null)
  if (!r.ok) return refusal(c, r)
  return c.json({ success: true, data: r.value }, 200)
})
