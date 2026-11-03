/**
 * 「つないでいるサービス」 (stage 3 A1, `.claude/rules/connector-roles.md`
 * "Built-in connectors"): the core connectors built into ACB, their state, the
 * roles they serve, and the admin's choice when two could serve a role. Rules in
 * services/core-connectors.ts; shapes in shared/types/core-connectors.ts.
 * Owners and admins; members 403, non-members 404.
 *
 *   GET /connectors                          every built-in connector + every role
 *   PUT /connector-roles/:role              { connectorId | null } — the admin's choice
 *   PUT /connectors/:connectorId/enabled     { enabled } — the connector's own on / off
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import { services } from '../composition'
import type { Outcome } from '../services/outcome'
import { refusal } from './respond'
import { companyMember, serviceBody } from './guards'

export const coreConnectorsRoute = new Hono()
const { coreConnectors } = services

function answer<T>(c: Context, result: Outcome<T>) {
  c.header('Cache-Control', 'no-store')
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value })
}

coreConnectorsRoute.get('/connectors', companyMember, async (c) => {
  const member = c.var.member
  return answer(c, await coreConnectors.view(member))
})

coreConnectorsRoute.put('/connector-roles/:role', companyMember, serviceBody, async (c) => {
  const member = c.var.member
  return answer(c, await coreConnectors.chooseRole(member, c.req.param('role'), c.var.body))
})

coreConnectorsRoute.put('/connectors/:connectorId/enabled', companyMember, serviceBody, async (c) => {
  const member = c.var.member
  return answer(c, await coreConnectors.setEnabled(member, c.req.param('connectorId'), c.var.body))
})
