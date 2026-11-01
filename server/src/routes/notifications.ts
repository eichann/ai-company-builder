/**
 * The member's notices (知らせ, stage 2 S5, `.claude/rules/notifications.md`),
 * mounted at /api/companies/:companyId. Contract: shared/types/notifications.ts;
 * rules: services/notifications.ts. Every route reads or changes the caller's
 * own notices only (the member comes from the session; no user id is taken).
 *
 *   GET  /me/notifications           the notices the member may see now (text built now)
 *   POST /me/notifications/read      { ids: [...] } or { all: true }
 *   GET  /me/notifications/settings  the kinds turned on / off
 *   PUT  /me/notifications/settings  { kinds: { <kind>: boolean } }
 *
 * Non-members get 404 like every company route.
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import { services } from '../composition'
import type { Outcome } from '../services/outcome'
import { refusal } from './respond'
import { companyMember, serviceBody } from './guards'

export const notificationsRoute = new Hono()
const { notifications } = services

function answer<T>(c: Context, result: Outcome<T>) {
  c.header('Cache-Control', 'no-store')
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value })
}

notificationsRoute.get('/me/notifications', companyMember, (c) => {
  return answer(c, notifications.list(c.var.member))
})

notificationsRoute.post('/me/notifications/read', companyMember, serviceBody, (c) => {
  return answer(c, notifications.markRead(c.var.member, c.var.body))
})

notificationsRoute.get('/me/notifications/settings', companyMember, (c) => {
  return answer(c, notifications.settings(c.var.member))
})

notificationsRoute.put('/me/notifications/settings', companyMember, serviceBody, (c) => {
  return answer(c, notifications.setSettings(c.var.member, c.var.body))
})
