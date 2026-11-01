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
import { getUserFromRequest } from '../lib/auth'
import { services } from '../composition'
import type { Member } from '../services/access'
import type { Outcome } from '../services/outcome'
import { refusal } from './respond'

export const notificationsRoute = new Hono()
const { access, notifications } = services

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
  c.header('Cache-Control', 'no-store')
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value })
}

notificationsRoute.get('/me/notifications', async (c) => {
  const member = await authAndAuthorize(c)
  return member instanceof Response ? member : answer(c, notifications.list(member))
})

notificationsRoute.post('/me/notifications/read', async (c) => {
  const member = await authAndAuthorize(c)
  return member instanceof Response ? member : answer(c, notifications.markRead(member, await jsonBody(c)))
})

notificationsRoute.get('/me/notifications/settings', async (c) => {
  const member = await authAndAuthorize(c)
  return member instanceof Response ? member : answer(c, notifications.settings(member))
})

notificationsRoute.put('/me/notifications/settings', async (c) => {
  const member = await authAndAuthorize(c)
  return member instanceof Response ? member : answer(c, notifications.setSettings(member, await jsonBody(c)))
})
