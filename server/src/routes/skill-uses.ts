/**
 * Which company Skill a consultation used (`.claude/rules/records.md` "Which
 * Skill"). Mounted at /api/companies/:companyId; the member's session only
 * (their app's main process reports). Rules: services/skill-uses.ts.
 *
 *   POST /me/skill-uses   { conversationId, name, tree, dirty } → { recorded }
 */
import { Hono } from 'hono'
import { services } from '../composition'
import { refusal } from './respond'
import { companyMember, serviceBody } from './guards'

export const skillUsesRoute = new Hono()
const { skillUses } = services

skillUsesRoute.post('/me/skill-uses', companyMember, serviceBody, (c) => {
  const r = skillUses.report(c.var.member, c.var.body)
  if (!r.ok) return refusal(c, r)
  return c.json({ success: true, data: r.value }, 200)
})
