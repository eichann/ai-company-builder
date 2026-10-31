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
 *   PUT  /plugins/:pluginId/mapping            { text } a new mapping version
 *   POST /plugins/:pluginId/mapping/restore    { version } an earlier mapping as the next version
 *   POST /plugins/:pluginId/import             bring the outside objects into the company map (one run per company)
 *   POST /plugins/:pluginId/connection/renew   the outside account changed on purpose: a new connection
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import { getUserFromRequest } from '../lib/auth'
import { services } from '../composition'
import type { Member } from '../services/access'
import type { Outcome } from '../services/outcome'
import { refusal } from './respond'

export const pluginsRoute = new Hono()
const { access, plugins, pluginImport } = services

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
  if (!result.ok) return refusal(c, result)
  c.header('Cache-Control', 'no-store')
  return c.json({ success: true, data: result.value })
}

pluginsRoute.get('/plugins', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  return answer(c, await plugins.list(member))
})

pluginsRoute.get('/plugins/:pluginId', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  return answer(c, await plugins.get(member, c.req.param('pluginId')))
})

pluginsRoute.put('/plugins/:pluginId', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  return answer(c, await plugins.install(member, c.req.param('pluginId'), await jsonBody(c)))
})

pluginsRoute.put('/plugins/:pluginId/enabled', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  return answer(c, await plugins.setEnabled(member, c.req.param('pluginId'), await jsonBody(c)))
})

pluginsRoute.put('/plugins/:pluginId/mapping', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  return answer(c, await plugins.saveMapping(member, c.req.param('pluginId'), await jsonBody(c)))
})

pluginsRoute.post('/plugins/:pluginId/mapping/restore', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  return answer(c, await plugins.restoreMapping(member, c.req.param('pluginId'), await jsonBody(c)))
})

pluginsRoute.post('/plugins/:pluginId/import', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  return answer(c, await pluginImport.run(member, c.req.param('pluginId')))
})

pluginsRoute.post('/plugins/:pluginId/connection/renew', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  return answer(c, pluginImport.renewConnection(member, c.req.param('pluginId')))
})
