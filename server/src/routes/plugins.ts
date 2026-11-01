/**
 * Connector plugins of a company (milestone 3, `.claude/rules/plugins.md`).
 * Mounted at /api/companies/:companyId. Contract: shared/types/plugins.ts;
 * rules: services/plugins.ts. Owner/admin only (403 for others); non-members
 * get 404 like every company route. A plugin this company may not use
 * (`available_to`) is the same 404 as one that exists nowhere.
 *
 *   GET  /plugins                              the shelf as this company sees it + its installs
 *   GET  /plugins/:pluginId                    one plugin: install, mapping in force, versions, policies, history
 *   PUT  /plugins/:pluginId                    { version, keyId } install / choose version or key
 *   PUT  /plugins/:pluginId/enabled            { enabled } on / off
 *   PUT  /plugins/:pluginId/read-scope         { departmentIds, userIds } who may read it through the relay
 *   PUT  /plugins/:pluginId/mapping            { text } a new mapping version
 *   POST /plugins/:pluginId/mapping/restore    { version } an earlier mapping as the next version
 *   POST /plugins/:pluginId/mapping/check      { text? } 「HubSpot に聞いて確かめる」: the mapping against the outside property list
 *   POST /plugins/:pluginId/import             bring the outside objects into the company map (one run per company)
 *   POST /plugins/:pluginId/connection/renew   the outside account changed on purpose: a new connection
 *
 * Handing packages to the app (plan C2; any member, services/plugin-distribution.ts):
 *   GET  /plugins/:pluginId/package/:version   a version the member's agent policy lists now: its files (base64)
 *
 * Business roles (plan C3, services/plugin-roles.ts, plugin-roles.md):
 *   GET  /plugins/:pluginId/roles                              owner/admin: declared roles, the company's assignment, overrides, history
 *   PUT  /plugins/:pluginId/roles/:role                        owner/admin: { userIds } the company's holders
 *   PUT  /plugins/:pluginId/roles/:role/bundles/:recordId      owner/admin or the まとまり's department manager: { userIds | null }
 *
 * Typed operations (P6; any member — the record, the operation's `who` and the
 * field policies decide; the member's AI uses routes/records-ai.ts):
 *   POST /plugins/:pluginId/records/:recordId/operations/:operation   { expectedVersion, fields, note?, basis?, conversationId?, proposedBy? } / {}
 *   (a field or create needing approval → 202 { outcome: 'approval-requested', approval }: routes/approvals.ts)
 *   (conversationId / proposedBy: informational provenance the app reports, never authorizing — records.md)
 *   GET  /plugins/:pluginId/operations/:operationId                   an operation record (its record's readers)
 *   POST /plugins/:pluginId/operations/:operationId/undo              「変更前の値を書き戻す」 (people only) { conversationId?, proposedBy? }
 *   POST /plugins/:pluginId/operations/:operationId/reconcile         read back a write whose answer was lost (a create: look it up by its correlation value)
 * Creates (milestone 4): log_meeting goes through the record route above ({ title, body?, at, outcome?, note? } on the deal);
 *   POST /plugins/:pluginId/create/:operation                         a create of a record (create_deal) { title, fields, note?, basis? } — never auto: 202 approval request
 *   POST /plugins/:pluginId/operations/:operationId/recreate          「もう一度作る」 after reconcile found nothing (people only) { confirm: true }
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import { services } from '../composition'
import type { Outcome } from '../services/outcome'
import { selfReportedProvenance } from '../services/record-engine'
import { refusal } from './respond'
import { companyMember, serviceBody } from './guards'

export const pluginsRoute = new Hono()
const { plugins, pluginImport, pluginOperations, pluginMappingCheck, approvals, agentPolicy, pluginDistribution, pluginRoles } = services
/** A call with the member's session is the member's own (their AI calls with a record token: records-ai.ts). */
const HUMAN = { kind: 'human' } as const

function answer<T>(c: Context, result: Outcome<T>) {
  if (!result.ok) return refusal(c, result)
  c.header('Cache-Control', 'no-store')
  return c.json({ success: true, data: result.value })
}

/** An operation's answer: 202 when it became an approval request (`{ outcome: 'approval-requested', approval }`). */
function accepted(c: Context, result: Outcome<unknown>) {
  if (!result.ok) return refusal(c, result)
  c.header('Cache-Control', 'no-store')
  const requested = typeof result.value === 'object' && result.value !== null && (result.value as { outcome?: unknown }).outcome === 'approval-requested'
  return c.json({ success: true, data: result.value }, requested ? 202 : 200)
}

pluginsRoute.get('/plugins', companyMember, async (c) => {
  const member = c.var.member
  return answer(c, await plugins.list(member))
})

pluginsRoute.get('/plugins/:pluginId', companyMember, async (c) => {
  const member = c.var.member
  return answer(c, await plugins.get(member, c.req.param('pluginId')))
})

pluginsRoute.put('/plugins/:pluginId', companyMember, serviceBody, async (c) => {
  const member = c.var.member
  const result = await plugins.install(member, c.req.param('pluginId'), c.var.body)
  // Another version changes what the members' apps keep (their agent policy, plan C2).
  if (result.ok) agentPolicy.announce(member.companyId)
  return answer(c, result)
})

pluginsRoute.put('/plugins/:pluginId/enabled', companyMember, serviceBody, async (c) => {
  const member = c.var.member
  const result = await plugins.setEnabled(member, c.req.param('pluginId'), c.var.body)
  if (result.ok) agentPolicy.announce(member.companyId)
  return answer(c, result)
})

pluginsRoute.get('/plugins/:pluginId/roles', companyMember, async (c) => {
  const member = c.var.member
  return answer(c, pluginRoles.roles(member, c.req.param('pluginId')))
})

pluginsRoute.put('/plugins/:pluginId/roles/:role', companyMember, serviceBody, async (c) => {
  const member = c.var.member
  return answer(c, pluginRoles.assign(member, c.req.param('pluginId'), c.req.param('role'), c.var.body))
})

pluginsRoute.put('/plugins/:pluginId/roles/:role/bundles/:recordId', companyMember, serviceBody, async (c) => {
  const member = c.var.member
  return answer(c, pluginRoles.setBundleOverride(member, c.req.param('pluginId'), c.req.param('role'), c.req.param('recordId'), c.var.body))
})

// Any member: a package their app keeps (plan C2; only a version their agent policy lists now).
pluginsRoute.get('/plugins/:pluginId/package/:version', companyMember, async (c) => {
  const member = c.var.member
  return answer(c, await pluginDistribution.packageFor(member, c.req.param('pluginId'), c.req.param('version')))
})

pluginsRoute.put('/plugins/:pluginId/read-scope', companyMember, serviceBody, async (c) => {
  const member = c.var.member
  return answer(c, await plugins.setReadScope(member, c.req.param('pluginId'), c.var.body))
})

pluginsRoute.put('/plugins/:pluginId/mapping', companyMember, serviceBody, async (c) => {
  const member = c.var.member
  return answer(c, await plugins.saveMapping(member, c.req.param('pluginId'), c.var.body))
})

pluginsRoute.post('/plugins/:pluginId/mapping/restore', companyMember, serviceBody, async (c) => {
  const member = c.var.member
  return answer(c, await plugins.restoreMapping(member, c.req.param('pluginId'), c.var.body))
})

pluginsRoute.post('/plugins/:pluginId/mapping/check', companyMember, serviceBody, async (c) => {
  const member = c.var.member
  return answer(c, await pluginMappingCheck.check(member, c.req.param('pluginId'), c.var.body))
})

pluginsRoute.post('/plugins/:pluginId/import', companyMember, async (c) => {
  const member = c.var.member
  return answer(c, await pluginImport.run(member, c.req.param('pluginId')))
})

pluginsRoute.post('/plugins/:pluginId/connection/renew', companyMember, async (c) => {
  const member = c.var.member
  return answer(c, pluginImport.renewConnection(member, c.req.param('pluginId')))
})

pluginsRoute.post('/plugins/:pluginId/records/:recordId/operations/:operation', companyMember, serviceBody, async (c) => {
  const member = c.var.member
  const body = c.var.body
  // A field or create that needs approval makes an approval request instead (202; approvals.md).
  return accepted(c, await approvals.runOrRequest(member, { ...HUMAN, ...selfReportedProvenance(body) }, c.req.param('pluginId'), c.req.param('recordId'), c.req.param('operation'), body))
})

pluginsRoute.post('/plugins/:pluginId/create/:operation', companyMember, serviceBody, async (c) => {
  const member = c.var.member
  const body = c.var.body
  // Never auto: it becomes an approval request (202; approvals.md).
  return accepted(c, await approvals.createOrRequest(member, { ...HUMAN, ...selfReportedProvenance(body) }, c.req.param('pluginId'), c.req.param('operation'), body))
})

pluginsRoute.post('/plugins/:pluginId/operations/:operationId/recreate', companyMember, serviceBody, async (c) => {
  const member = c.var.member
  return answer(c, await pluginOperations.recreate(member, c.req.param('pluginId'), c.req.param('operationId'), c.var.body))
})

pluginsRoute.get('/plugins/:pluginId/operations/:operationId', companyMember, async (c) => {
  const member = c.var.member
  return answer(c, await pluginOperations.get(member, c.req.param('pluginId'), c.req.param('operationId')))
})

pluginsRoute.post('/plugins/:pluginId/operations/:operationId/undo', companyMember, serviceBody, async (c) => {
  const member = c.var.member
  return answer(c, await pluginOperations.undo(member, c.req.param('pluginId'), c.req.param('operationId'), selfReportedProvenance(c.var.body)))
})

pluginsRoute.post('/plugins/:pluginId/operations/:operationId/reconcile', companyMember, async (c) => {
  const member = c.var.member
  return answer(c, await pluginOperations.reconcile(member, c.req.param('pluginId'), c.req.param('operationId')))
})
