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
import type { Context } from 'hono'
import { getUserFromRequest } from '../lib/auth'
import { services } from '../composition'
import type { Member } from '../services/access'
import { refusal } from './respond'

export const absencesRoute = new Hono()
const { access, absences } = services

async function authAndAuthorize(c: Context): Promise<Member | Response> {
  const user = await getUserFromRequest(c.req.raw)
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const companyId = c.req.param('companyId')
  if (!companyId) return c.json({ error: 'Company ID is required' }, 400)
  const member = access.memberOf(companyId, user.id)
  if (!member) return c.json({ error: 'Company not found or access denied' }, 404)
  return member
}

absencesRoute.get('/absences', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  const userId = c.req.query('userId')
  const result = absences.view(member, userId === undefined || userId === '' ? undefined : userId)
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value })
})

absencesRoute.post('/absences', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  let body: unknown
  try { body = await c.req.json() } catch { body = null }
  const result = absences.create(member, body)
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value }, 201)
})

absencesRoute.delete('/absences/:absenceId', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  const result = absences.remove(member, c.req.param('absenceId'))
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value })
})
