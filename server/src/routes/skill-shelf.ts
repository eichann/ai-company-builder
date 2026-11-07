/**
 * The Skill shelf (「会社の Skill」, plugins.md "The Skill shelf"): Skills, AI instruction texts and
 * rule files of a company without the shared company folder. Any member; what each may see and
 * change is the service's rule (services/skill-shelf.ts). A company with the folder: 409
 * SKILL_SHELF_NOT_HERE. Contract: shared/types/skill-shelf.ts. Mounted at /api/companies/:companyId.
 */
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { SHELF_LIMITS } from '../../shared/core/skill-shelf'
import { services } from '../composition'
import { refusal } from './respond'
import { companyMember, serviceBody } from './guards'

export const skillShelfRoute = new Hono()
const { skillShelf } = services

/** A whole Skill as base64 JSON: its size limit with room for the encoding and the paths. */
const publishBodyLimit = bodyLimit({
  maxSize: Math.ceil(SHELF_LIMITS.skillBytes / 3) * 4 + 512 * 1024,
  onError: c => c.json({ error: `Skill 全体が大きすぎます（${SHELF_LIMITS.skillBytes / 1024 / 1024} MB まで）。`, code: 'SHELF_TOO_LARGE' }, 413),
})

skillShelfRoute.get('/skill-shelf', companyMember, (c) => {
  const result = skillShelf.list(c.var.member)
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value })
})

skillShelfRoute.post('/skill-shelf', companyMember, publishBodyLimit, serviceBody, (c) => {
  const result = skillShelf.publish(c.var.member, c.var.body)
  if (!result.ok) return refusal(c, result)
  const { created, ...data } = result.value
  return c.json({ success: true, data }, created ? 201 : 200)
})

skillShelfRoute.get('/skill-shelf/:itemId/versions', companyMember, (c) => {
  const result = skillShelf.versions(c.var.member, c.req.param('itemId'))
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value })
})

skillShelfRoute.get('/skill-shelf/:itemId/versions/:version', companyMember, (c) => {
  const result = skillShelf.content(c.var.member, c.req.param('itemId'), c.req.param('version'))
  if (!result.ok) return refusal(c, result)
  c.header('Cache-Control', 'no-store')
  return c.json({ success: true, data: result.value })
})

skillShelfRoute.post('/skill-shelf/:itemId/restore', companyMember, serviceBody, (c) => {
  const result = skillShelf.restore(c.var.member, c.req.param('itemId'), c.var.body)
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value })
})

skillShelfRoute.post('/skill-shelf/:itemId/unpublish', companyMember, serviceBody, (c) => {
  const result = skillShelf.unpublish(c.var.member, c.req.param('itemId'), c.var.body)
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value })
})

skillShelfRoute.get('/me/skill-shelf', companyMember, (c) => {
  const result = skillShelf.mine(c.var.member)
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value })
})
