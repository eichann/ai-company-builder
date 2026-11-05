/**
 * 「気になる動き」 (security-alerts.md; rules: services/security-alerts.ts).
 * Mounted at /api/companies/:companyId.
 *
 *   GET /security-alerts            owner/admin: the last 30 days' alerts and the setting
 *   PUT /security-alerts/settings   owner/admin: { slackDm: boolean }
 *
 * Others 403; non-members 404 like every company route.
 */
import { Hono } from 'hono'
import { services } from '../composition'
import { companyMember, serviceBody } from './guards'
import { refusal } from './respond'

export const securityAlertsRoute = new Hono()
const { securityAlerts } = services

securityAlertsRoute.get('/security-alerts', companyMember, (c) => {
  const result = securityAlerts.list(c.var.member)
  if (!result.ok) return refusal(c, result)
  c.header('Cache-Control', 'no-store')
  return c.json({ success: true, data: result.value })
})

securityAlertsRoute.put('/security-alerts/settings', companyMember, serviceBody, (c) => {
  const result = securityAlerts.saveSettings(c.var.member, c.var.body)
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value })
})
