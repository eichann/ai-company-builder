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
import { services } from '../composition'
import { companyMember, serviceBody } from './guards'
import { refusal } from './respond'

export const taskSettingsRoute = new Hono()
const { taskSettings } = services

taskSettingsRoute.get('/task-settings', companyMember, (c) => {
  return c.json({ success: true, data: taskSettings.get(c.var.member) })
})

taskSettingsRoute.put('/task-settings', companyMember, serviceBody, (c) => {
  const result = taskSettings.update(c.var.member, c.var.body)
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value })
})

// Each member's own switches (自分の設定: 受信を読む, AI が自動で進める; shared/types/work-switches.ts).
//   GET  /me/work-switches                  any member: their own, with the company's 使ってよいか / 初めの値
//   PUT  /me/work-switches { switch, on }   any member, their own only (409 WORK_SWITCH_COMPANY_OFF)
taskSettingsRoute.get('/me/work-switches', companyMember, async (c) => {
  return c.json({ success: true, data: await services.workSwitches.my(c.var.member) })
})

taskSettingsRoute.put('/me/work-switches', companyMember, serviceBody, async (c) => {
  const result = await services.workSwitches.set(c.var.member, c.var.body)
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value })
})
