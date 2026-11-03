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
import { services } from '../composition'
import { refusal } from './respond'
import { companyMember } from './guards'

export const calendarRoute = new Hono()
const { calendar } = services

calendarRoute.get('/me/calendar/today', companyMember, async (c) => {
  const result = await calendar.today(c.var.member)
  c.header('Cache-Control', 'no-store')
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value })
})
