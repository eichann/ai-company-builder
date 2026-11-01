/**
 * Which company Skill a consultation used (`.claude/rules/records.md` "Which
 * Skill"). Mounted at /api/companies/:companyId; the member's session only
 * (their app's main process reports). Rules: services/skill-uses.ts.
 *
 *   POST /me/skill-uses   { conversationId, name, tree, dirty } → { recorded }
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import { getUserFromRequest } from '../lib/auth'
import { services } from '../composition'
import { refusal } from './respond'

export const skillUsesRoute = new Hono()
const { access, skillUses } = services

async function jsonBody(c: Context): Promise<unknown> {
  try { return await c.req.json() } catch { return null }
}

skillUsesRoute.post('/me/skill-uses', async (c) => {
  const user = await getUserFromRequest(c.req.raw)
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const companyId = c.req.param('companyId')
  if (!companyId) return c.json({ error: 'Company ID is required' }, 400)
  const member = access.memberOf(companyId, user.id)
  if (!member) return c.json({ error: 'Company not found or access denied' }, 404)
  const r = skillUses.report(member, await jsonBody(c))
  if (!r.ok) return refusal(c, r)
  return c.json({ success: true, data: r.value }, 200)
})
