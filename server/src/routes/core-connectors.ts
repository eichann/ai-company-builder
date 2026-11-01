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
import { getUserFromRequest } from '../lib/auth'
import { services } from '../composition'
import type { Member } from '../services/access'
import type { Outcome } from '../services/outcome'
import { refusal } from './respond'

export const coreConnectorsRoute = new Hono()
const { access, coreConnectors } = services

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

function answer<T>(c: Context, result: Outcome<T>) {
  c.header('Cache-Control', 'no-store')
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value })
}

coreConnectorsRoute.get('/connectors', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  return answer(c, await coreConnectors.view(member))
})

coreConnectorsRoute.put('/connector-roles/:role', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  return answer(c, await coreConnectors.chooseRole(member, c.req.param('role'), await jsonBody(c)))
})

coreConnectorsRoute.put('/connectors/:connectorId/enabled', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  return answer(c, await coreConnectors.setEnabled(member, c.req.param('connectorId'), await jsonBody(c)))
})
