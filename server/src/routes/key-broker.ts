/**
 * The API key broker's admin API (「API キー」), mounted at
 * /api/companies/:companyId. Shapes: shared/types/key-broker.ts; rules:
 * services/key-broker.ts (.claude/rules/key-broker.md). All owner/admin.
 *
 *   GET    /broker                        keys (last 4 only), services, setting, history
 *   POST   /broker/keys                   register a company key (write-only value)
 *   PUT    /broker/keys/:keyId/secret     replace a key's value
 *   PATCH  /broker/keys/:keyId            destinations, who, caps, flag, status
 *   DELETE /broker/keys/:keyId
 *   PUT    /broker/services/:service      { category, rule, ownKeyHosts }
 *   PUT    /broker/services/:service/own-keys { allowed } the one switch 「メンバーが自分の鍵を使ってよい」
 *   PUT    /broker/services/:service/read-only { readOnly } the relay forwards only reads for the service
 *   PUT    /broker/relay-services/:service { label, baseUrl, header, format?, category? } a generic service (K9)
 *   DELETE /broker/relay-services/:service once no key exists for it
 *   PUT    /broker/settings               { memberKeysAllowed?, internalHosts? }
 *   POST   /broker/stop-all               stop every key and token now (emergency stop)
 *
 * Any member (the desktop app, K3):
 *   POST   /me/broker-tokens              { conversationId, services?, department?, ttlMinutes? }
 *                                         → a short-lived token for the chat's child processes
 *   DELETE /me/broker-tokens/:tokenId     revoke one's own token
 *   GET    /me/broker-keys                 「自分の鍵」: services, company keys one may use, one's own keys (last 4)
 *   PUT    /me/broker-keys/:service        { secret, displayName? } register / replace one's own key (K8)
 *   DELETE /me/broker-keys/:service        delete one's own key
 *
 * Registering or replacing a key (company or own) checks it once with a free,
 * read-only request to the service's fixed host: a key the service refuses →
 * 400 KEY_REJECTED (not saved); otherwise the answer carries `check`.
 *
 * No answer ever carries a key's value. Non-members get 404 like every
 * company route. Registering / replacing answers 503 BROKER_OFF without a
 * key-encryption key.
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import { getUserFromRequest } from '../lib/auth'
import { services } from '../composition'
import type { Member } from '../services/access'
import type { Outcome } from '../services/outcome'
import { refusal } from './respond'

export const keyBrokerRoute = new Hono()
const { access, keyBroker, brokerTokens, ownBrokerKeys } = services

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

keyBrokerRoute.get('/broker', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  return answer(c, keyBroker.get(member))
})

keyBrokerRoute.post('/broker/keys', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  return answer(c, await keyBroker.create(member, await jsonBody(c)))
})

keyBrokerRoute.put('/broker/keys/:keyId/secret', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  return answer(c, await keyBroker.replaceSecret(member, c.req.param('keyId'), await jsonBody(c)))
})

keyBrokerRoute.patch('/broker/keys/:keyId', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  return answer(c, keyBroker.update(member, c.req.param('keyId'), await jsonBody(c)))
})

keyBrokerRoute.delete('/broker/keys/:keyId', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  return answer(c, keyBroker.delete(member, c.req.param('keyId')))
})

keyBrokerRoute.put('/broker/services/:service', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  return answer(c, keyBroker.setService(member, c.req.param('service'), await jsonBody(c)))
})

keyBrokerRoute.put('/broker/services/:service/own-keys', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  return answer(c, keyBroker.setOwnKeys(member, c.req.param('service'), await jsonBody(c)))
})

keyBrokerRoute.put('/broker/services/:service/read-only', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  return answer(c, keyBroker.setReadOnly(member, c.req.param('service'), await jsonBody(c)))
})

keyBrokerRoute.put('/broker/relay-services/:service', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  return answer(c, keyBroker.setRelayService(member, c.req.param('service'), await jsonBody(c)))
})

keyBrokerRoute.delete('/broker/relay-services/:service', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  return answer(c, keyBroker.deleteRelayService(member, c.req.param('service')))
})

keyBrokerRoute.put('/broker/settings', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  return answer(c, keyBroker.setSettings(member, await jsonBody(c)))
})

keyBrokerRoute.post('/broker/stop-all', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  return answer(c, keyBroker.stopAll(member))
})

keyBrokerRoute.post('/me/broker-tokens', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  return answer(c, brokerTokens.issue(member, await jsonBody(c)))
})

keyBrokerRoute.delete('/me/broker-tokens/:tokenId', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  return answer(c, brokerTokens.revoke(member, c.req.param('tokenId')))
})

keyBrokerRoute.get('/me/broker-keys', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  return answer(c, ownBrokerKeys.list(member))
})

keyBrokerRoute.put('/me/broker-keys/:service', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  return answer(c, await ownBrokerKeys.save(member, c.req.param('service'), await jsonBody(c)))
})

keyBrokerRoute.delete('/me/broker-keys/:service', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  return answer(c, ownBrokerKeys.remove(member, c.req.param('service')))
})
