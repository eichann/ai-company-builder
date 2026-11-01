/**
 * Absence and the delegate (代わりの人, stage 2 S4; records.md "Absence and the
 * delegate"). Mounted at /api/companies/:companyId. Shapes:
 * shared/types/absences.ts; rules: services/absences.ts.
 *
 *   GET    /absences?userId=      the member's absences (default: the caller)
 *   POST   /absences              { userId?, from, until, delegateId }
 *   DELETE /absences/:absenceId
 *
 * The member, owners / admins and managers of a department the member belongs
 * to; anyone else 403. Non-members get 404 like every company route.
 */
import { Hono } from 'hono'
import { services } from '../composition'
import { z } from 'zod'
import { refusal } from './respond'
import { companyMember, query, serviceBody } from './guards'

export const absencesRoute = new Hono()
const { absences } = services

const AbsencesQuery = z.object({ userId: z.string().optional() })

absencesRoute.get('/absences', companyMember, query(AbsencesQuery), (c) => {
  const { userId } = c.var.query
  const result = absences.view(c.var.member, userId === undefined || userId === '' ? undefined : userId)
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value })
})

absencesRoute.post('/absences', companyMember, serviceBody, (c) => {
  const result = absences.create(c.var.member, c.var.body)
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value }, 201)
})

absencesRoute.delete('/absences/:absenceId', companyMember, (c) => {
  const result = absences.remove(c.var.member, c.req.param('absenceId'))
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value })
})
