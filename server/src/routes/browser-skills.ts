/**
 * 「Skill の承認」 (agent-browser.md "A Skill's browser declaration and its approval"). Rules: services/browser-skills.ts;
 * shapes: shared/types/browser-skills.ts. Owners / admins only (the service answers 403 to anyone else).
 *
 * Mounted at /api/companies/:companyId:
 *   GET  /browser-skill-approvals          the company Skills with `browser.yaml`, as the server reads them now
 *   POST /browser-skill-approvals          { skill, declarationHash, mode }: approve exactly the declaration seen
 *   POST /browser-skill-approvals/revoke   { skill }: take the approval back
 */
import { Hono } from 'hono'
import { services } from '../composition'
import { refusal } from './respond'
import { companyMember, serviceBody } from './guards'

export const browserSkillsRoute = new Hono()
const { browserSkills } = services

browserSkillsRoute.get('/browser-skill-approvals', companyMember, async (c) => {
  const r = await browserSkills.list(c.var.member)
  if (!r.ok) return refusal(c, r)
  c.header('Cache-Control', 'no-store')
  return c.json({ success: true, data: r.value })
})

browserSkillsRoute.post('/browser-skill-approvals', companyMember, serviceBody, async (c) => {
  const r = await browserSkills.approve(c.var.member, c.var.body)
  return r.ok ? c.json({ success: true, data: r.value }) : refusal(c, r)
})

browserSkillsRoute.post('/browser-skill-approvals/revoke', companyMember, serviceBody, (c) => {
  const r = browserSkills.revoke(c.var.member, c.var.body)
  return r.ok ? c.json({ success: true, data: r.value }) : refusal(c, r)
})
