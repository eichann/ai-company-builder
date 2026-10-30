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
import type { Context } from 'hono'
import { getUserFromRequest } from '../lib/auth'
import { services } from '../composition'
import type { Member } from '../services/access'
import { refusal } from './respond'
import { noteStopSupport } from './agent-stops'

export const agentSandboxRoute = new Hono()
const { access, agentSandbox, agentPolicy } = services

async function authAndAuthorize(c: Context): Promise<Member | Response> {
  const user = await getUserFromRequest(c.req.raw)
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const companyId = c.req.param('companyId')
  if (!companyId) return c.json({ error: 'Company ID is required' }, 400)
  const member = access.memberOf(companyId, user.id)
  if (!member) return c.json({ error: 'Company not found or access denied' }, 404)
  return member
}

async function jsonBody(c: Context): Promise<unknown> {
  try { return await c.req.json() } catch { return null }
}

agentSandboxRoute.get('/agent-sandbox', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  const result = agentSandbox.get(member)
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value })
})

agentSandboxRoute.put('/agent-sandbox', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  const result = agentSandbox.update(member, await jsonBody(c))
  if (!result.ok) return refusal(c, result)
  agentPolicy.announce(member.companyId)
  return c.json({ success: true, data: result.value })
})

agentSandboxRoute.put('/agent-sandbox/overrides/:userId', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  const result = agentSandbox.setOverride(member, c.req.param('userId'), await jsonBody(c))
  if (!result.ok) return refusal(c, result)
  agentPolicy.announce(member.companyId)
  return c.json({ success: true, data: result.value })
})

agentSandboxRoute.get('/me/agent-policy', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  noteStopSupport(c, member)
  const data = agentPolicy.policyFor(member)
  const etag = `"${data.version}"`
  c.header('ETag', etag)
  c.header('Cache-Control', 'private, no-cache')
  const inm = c.req.header('If-None-Match')
  if (inm && inm.split(',').some(t => t.trim() === etag)) return c.body(null, 304)
  return c.json({ success: true, data })
})
