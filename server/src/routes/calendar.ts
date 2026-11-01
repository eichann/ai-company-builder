/**
 * 「今日の予定」 (stage 2 S7a, `.claude/rules/calendar.md`), mounted at
 * /api/companies/:companyId. Contract: shared/types/calendar.ts; rules:
 * services/calendar.ts.
 *
 *   GET /me/calendar/today    any member: my own meetings today (the company's day),
 *                             read now with my own permission; nothing stored
 *
 * No permission / the connection off or stopped → 200 with an empty list and a
 * reason, not an error. `Cache-Control: no-store`. Non-members get 404 like every
 * company route.
 */
import { Hono } from 'hono'
import { getUserFromRequest } from '../lib/auth'
import { services } from '../composition'
import { refusal } from './respond'

export const calendarRoute = new Hono()
const { access, calendar } = services

calendarRoute.get('/me/calendar/today', async (c) => {
  const user = await getUserFromRequest(c.req.raw)
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const companyId = c.req.param('companyId')
  if (!companyId) return c.json({ error: 'Company ID is required' }, 400)
  const member = access.memberOf(companyId, user.id)
  if (!member) return c.json({ error: 'Company not found or access denied' }, 404)
  const result = await calendar.today(member)
  c.header('Cache-Control', 'no-store')
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value })
})
