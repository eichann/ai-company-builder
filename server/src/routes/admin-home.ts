/**
 * The admin console's home (server.md "Admin home"; rules: services/admin-home.ts).
 * Mounted at /api/companies/:companyId.
 *
 *   GET /home                    owner/admin: 「最初にやること」 + 「対応が必要なこと」;
 *                                a department manager: their departments' 「対応が必要なこと」 only
 *   PUT /home/holidays-checked   owner/admin: { checked: true } 「会社の休みを確かめた」
 *
 * Others 403; non-members 404 like every company route.
 */
import { Hono } from 'hono'
import { services } from '../composition'
import { companyMember, serviceBody } from './guards'
import { refusal } from './respond'

export const adminHomeRoute = new Hono()
const { adminHome } = services

adminHomeRoute.get('/home', companyMember, async (c) => {
  const result = await adminHome.view(c.var.member)
  if (!result.ok) return refusal(c, result)
  c.header('Cache-Control', 'no-store')
  return c.json({ success: true, data: result.value })
})

adminHomeRoute.put('/home/holidays-checked', companyMember, serviceBody, async (c) => {
  const result = await adminHome.checkHolidays(c.var.member, c.var.body)
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value })
})
