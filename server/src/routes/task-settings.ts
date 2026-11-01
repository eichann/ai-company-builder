/**
 * The company's task settings (stage 2 S6, .claude/rules/tasks.md). Mounted at
 * /api/companies/:companyId. Shapes: shared/types/task-settings.ts; rules:
 * services/task-settings.ts.
 *
 *   GET  /task-settings   any member: the settings in force (+ canEdit)
 *   PUT  /task-settings   owner/admin: the whole document
 *
 * Department membership (所属する部署) is under the departments:
 * GET|PUT /departments/:id/members (routes/departments.ts).
 * Non-members get 404 like every company route.
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import { getUserFromRequest } from '../lib/auth'
import { services } from '../composition'
import type { Member } from '../services/access'
import { refusal } from './respond'

export const taskSettingsRoute = new Hono()
const { access, taskSettings } = services

async function authAndAuthorize(c: Context): Promise<Member | Response> {
  const user = await getUserFromRequest(c.req.raw)
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const companyId = c.req.param('companyId')
  if (!companyId) return c.json({ error: 'Company ID is required' }, 400)
  const member = access.memberOf(companyId, user.id)
  if (!member) return c.json({ error: 'Company not found or access denied' }, 404)
  return member
}

taskSettingsRoute.get('/task-settings', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  return c.json({ success: true, data: taskSettings.get(member) })
})

taskSettingsRoute.put('/task-settings', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  let body: unknown
  try { body = await c.req.json() } catch { body = null }
  const result = taskSettings.update(member, body)
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value })
})
