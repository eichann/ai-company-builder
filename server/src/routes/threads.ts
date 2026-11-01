/**
 * The card's 元のスレッド (stage 3 A4, `.claude/rules/outbound-mail.md` "Replies";
 * contract shared/types/threads.ts): the original thread of a record that came
 * from outside, read now through the core role with the member's own
 * permission. Nothing is stored; rules in services/threads.ts. Mounted at
 * /api/companies/:companyId.
 *
 *   GET /threads/:recordId
 */
import { Hono } from 'hono'
import { services } from '../composition'
import { companyMember, type CompanyEnv } from './guards'
import { refusal } from './respond'

export const threadsRoute = new Hono<CompanyEnv>()
const { threads } = services

threadsRoute.get('/threads/:recordId', companyMember, async (c) => {
  const r = await threads.thread(c.var.member, c.req.param('recordId'))
  if (!r.ok) return refusal(c, r)
  return c.json({ success: true, data: r.value }, 200)
})
