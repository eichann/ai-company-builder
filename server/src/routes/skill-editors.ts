/**
 * 「Skill を直せる人」: who may change skill / agent / command files besides
 * owners, admins and a department's managers (shared/core/skill-files.ts;
 * enforced by the push checker from the snapshot git-http writes). Being on a
 * list grants no folder access by itself. Mounted at /api/companies/:companyId.
 *
 *   GET /skill-editors   owner/admin: the whole company's list and the departments'
 *   PUT /skill-editors   owner/admin: { departmentId: string | null, userIds };
 *                        replaces one list (null: the whole company)
 *   PUT /skill-editors/everyone   owner/admin: { everyone: boolean }, 「全員が直せる」:
 *                        everyone with write access may change skill files
 */
import { Hono } from 'hono'
import { z } from 'zod'
import { services } from '../composition'
import { requireFullAccess } from '../services/access'
import { refusal } from './respond'
import { companyMember, serviceBody } from './guards'

export const skillEditorsRoute = new Hono()
const { departments } = services

const SkillEditorsBody = z.object({
  departmentId: z.string().min(1).nullable(),
  userIds: z.array(z.string().min(1)),
})

const EveryoneBody = z.object({ everyone: z.boolean() })

skillEditorsRoute.put('/skill-editors/everyone', companyMember, serviceBody, async (c) => {
  const actor = requireFullAccess(c.var.member, 'Only owners and admins can choose who may change skills')
  if (!actor.ok) return refusal(c, actor)
  if (c.var.body === null) return c.json({ error: 'Invalid JSON body' }, 400)
  const parsed = EveryoneBody.safeParse(c.var.body)
  if (!parsed.success) return c.json({ error: 'everyone must be true or false' }, 400)
  return c.json({ success: true, data: departments.setSkillEditingOpen(actor.value, parsed.data.everyone) })
})

skillEditorsRoute.get('/skill-editors', companyMember, async (c) => {
  const actor = requireFullAccess(c.var.member, 'Only owners and admins can view who may change skills')
  if (!actor.ok) return refusal(c, actor)
  return c.json({ success: true, data: departments.skillEditors(actor.value) })
})

skillEditorsRoute.put('/skill-editors', companyMember, serviceBody, async (c) => {
  const actor = requireFullAccess(c.var.member, 'Only owners and admins can choose who may change skills')
  if (!actor.ok) return refusal(c, actor)
  if (c.var.body === null) return c.json({ error: 'Invalid JSON body' }, 400)
  const parsed = SkillEditorsBody.safeParse(c.var.body)
  if (!parsed.success) return c.json({ error: 'departmentId must be a department id or null, userIds an array of user IDs' }, 400)

  const view = departments.replaceSkillEditors(actor.value, parsed.data.departmentId, parsed.data.userIds)
  if (!view.ok) return refusal(c, view)
  return c.json({ success: true, data: view.value })
})
