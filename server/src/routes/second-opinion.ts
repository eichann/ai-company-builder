/**
 * 「もう一方の AI に聞く」 as a company setting. Mounted at /api/companies/:companyId.
 * Shapes: shared/types/second-opinion.ts; rules: services/second-opinion-setting.ts.
 *
 *   GET  /second-opinion     { allowed, updatedAt, updatedByName } (owner/admin)
 *   PUT  /second-opinion     { allowed: boolean } (owner/admin); a change is announced to the
 *                            company's apps (their policy, /me/agent-policy, carries it)
 *
 * Non-members get 404 like every company route.
 */
import { Hono } from 'hono'
import { services } from '../composition'
import { refusal } from './respond'
import { companyMember, serviceBody } from './guards'

export const secondOpinionRoute = new Hono()
const { secondOpinion, agentPolicy } = services

secondOpinionRoute.get('/second-opinion', companyMember, async (c) => {
  const result = secondOpinion.get(c.var.member)
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value })
})

secondOpinionRoute.put('/second-opinion', companyMember, serviceBody, async (c) => {
  const member = c.var.member
  const result = secondOpinion.update(member, c.var.body)
  if (!result.ok) return refusal(c, result)
  if (result.value.changed) agentPolicy.announce(member.companyId)
  return c.json({ success: true, data: result.value.view })
})
