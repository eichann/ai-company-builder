/**
 * 見られる人 (who can see a record or a file), many at once for the lists.
 * Mounted at /api/companies/:companyId. Rules: services/viewers.ts; phrase:
 * shared/core/viewers.ts; shape: shared/types/viewers.ts.
 *
 *   POST /viewers { records?: string[], files?: string[] }   any member
 */
import { Hono } from 'hono'
import { services } from '../composition'
import { companyMember, serviceBody } from './guards'
import { refusal } from './respond'

export const viewersRoute = new Hono()

viewersRoute.post('/viewers', companyMember, serviceBody, (c) => {
  const result = services.viewers.labels(c.var.member, c.var.body)
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value })
})
