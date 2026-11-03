/**
 * The AI sandbox (「AI の囲い」) and the policy the desktop app follows.
 * Mounted at /api/companies/:companyId. Shapes: shared/types/agent-sandbox.ts;
 * rules: services/agent-sandbox.ts.
 *
 *   GET  /agent-sandbox                       setting + overrides + history (owner/admin)
 *   PUT  /agent-sandbox                       the whole setting (owner/admin)
 *   PUT  /agent-sandbox/overrides/:userId     { mode: off|observe|enforce|null } (owner/admin)
 *   GET  /me/agent-policy                     any member: the policy their app's AI follows —
 *                                             the sandbox and the emergency stop (M2,
 *                                             routes/agent-stops.ts) — (ETag = version,
 *                                             If-None-Match → 304). A change is announced
 *                                             on the push channel (/me/events).
 *
 * Non-members get 404 like every company route.
 */
import { Hono } from 'hono'
import { services } from '../composition'
import { refusal } from './respond'
import { companyMember, serviceBody } from './guards'
import { noteStopSupport } from './agent-stops'

export const agentSandboxRoute = new Hono()
const { agentSandbox, agentPolicy } = services

agentSandboxRoute.get('/agent-sandbox', companyMember, async (c) => {
  const member = c.var.member
  const result = agentSandbox.get(member)
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value })
})

agentSandboxRoute.put('/agent-sandbox', companyMember, serviceBody, async (c) => {
  const member = c.var.member
  const result = agentSandbox.update(member, c.var.body)
  if (!result.ok) return refusal(c, result)
  agentPolicy.announce(member.companyId)
  return c.json({ success: true, data: result.value })
})

agentSandboxRoute.put('/agent-sandbox/overrides/:userId', companyMember, serviceBody, async (c) => {
  const member = c.var.member
  const result = agentSandbox.setOverride(member, c.req.param('userId'), c.var.body)
  if (!result.ok) return refusal(c, result)
  agentPolicy.announce(member.companyId)
  return c.json({ success: true, data: result.value })
})

agentSandboxRoute.get('/me/agent-policy', companyMember, async (c) => {
  const member = c.var.member
  noteStopSupport(c, member)
  const data = await agentPolicy.policyFor(member)
  const etag = `"${data.version}"`
  c.header('ETag', etag)
  c.header('Cache-Control', 'private, no-cache')
  const inm = c.req.header('If-None-Match')
  if (inm && inm.split(',').some(t => t.trim() === etag)) return c.body(null, 304)
  return c.json({ success: true, data })
})
