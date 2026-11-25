/**
 * 「ブラウザ操作」: the company's browser-operation setting (.claude/rules/agent-browser.md).
 * Mounted at /api/companies/:companyId. Shapes: shared/types/agent-browser.ts;
 * rules: services/agent-browser.ts. The member's own part reaches the app through
 * GET /me/agent-policy (`browser`, routes/agent-sandbox.ts).
 *
 *   GET  /agent-browser                       setting + overrides + history (owner/admin)
 *   PUT  /agent-browser                       the whole setting (owner/admin)
 *   PUT  /agent-browser/overrides/:userId     { mode: off|on|null } (owner/admin)
 *   PUT  /agent-browser/site-parts            one registered domain's 「詳しい設定」 (owner/admin)
 *
 * A change is announced on the push channel (/me/events), like a sandbox change.
 * Non-members get 404 like every company route.
 */
import { Hono } from 'hono'
import { services } from '../composition'
import { refusal } from './respond'
import { companyMember, serviceBody } from './guards'

export const agentBrowserRoute = new Hono()
const { agentBrowser, agentPolicy } = services

agentBrowserRoute.get('/agent-browser', companyMember, async (c) => {
  const result = agentBrowser.get(c.var.member)
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value })
})

agentBrowserRoute.put('/agent-browser', companyMember, serviceBody, async (c) => {
  const member = c.var.member
  const result = agentBrowser.update(member, c.var.body)
  if (!result.ok) return refusal(c, result)
  agentPolicy.announce(member.companyId)
  return c.json({ success: true, data: result.value })
})

agentBrowserRoute.put('/agent-browser/overrides/:userId', companyMember, serviceBody, async (c) => {
  const member = c.var.member
  const result = agentBrowser.setOverride(member, c.req.param('userId'), c.var.body)
  if (!result.ok) return refusal(c, result)
  agentPolicy.announce(member.companyId)
  return c.json({ success: true, data: result.value })
})

agentBrowserRoute.put('/agent-browser/site-parts', companyMember, serviceBody, async (c) => {
  const member = c.var.member
  const result = agentBrowser.setSiteParts(member, c.var.body)
  if (!result.ok) return refusal(c, result)
  agentPolicy.announce(member.companyId)
  return c.json({ success: true, data: result.value })
})
