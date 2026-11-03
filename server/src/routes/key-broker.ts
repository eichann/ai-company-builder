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
 *   PUT    /broker/services/:service/default-key { keyId } which company key the service uses (null: none chosen)
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
import { services } from '../composition'
import type { Outcome } from '../services/outcome'
import { refusal } from './respond'
import { companyMember, serviceBody } from './guards'

export const keyBrokerRoute = new Hono()
const { keyBroker, brokerTokens, ownBrokerKeys } = services

function answer<T>(c: Context, result: Outcome<T>) {
  if (!result.ok) return refusal(c, result)
  c.header('Cache-Control', 'no-store')
  return c.json({ success: true, data: result.value })
}

keyBrokerRoute.get('/broker', companyMember, async (c) => {
  const member = c.var.member
  return answer(c, keyBroker.get(member))
})

keyBrokerRoute.post('/broker/keys', companyMember, serviceBody, async (c) => {
  const member = c.var.member
  return answer(c, await keyBroker.create(member, c.var.body))
})

keyBrokerRoute.put('/broker/keys/:keyId/secret', companyMember, serviceBody, async (c) => {
  const member = c.var.member
  return answer(c, await keyBroker.replaceSecret(member, c.req.param('keyId'), c.var.body))
})

keyBrokerRoute.patch('/broker/keys/:keyId', companyMember, serviceBody, async (c) => {
  const member = c.var.member
  return answer(c, keyBroker.update(member, c.req.param('keyId'), c.var.body))
})

keyBrokerRoute.delete('/broker/keys/:keyId', companyMember, async (c) => {
  const member = c.var.member
  return answer(c, keyBroker.delete(member, c.req.param('keyId')))
})

keyBrokerRoute.put('/broker/services/:service', companyMember, serviceBody, async (c) => {
  const member = c.var.member
  return answer(c, keyBroker.setService(member, c.req.param('service'), c.var.body))
})

keyBrokerRoute.put('/broker/services/:service/own-keys', companyMember, serviceBody, async (c) => {
  const member = c.var.member
  return answer(c, keyBroker.setOwnKeys(member, c.req.param('service'), c.var.body))
})

keyBrokerRoute.put('/broker/services/:service/read-only', companyMember, serviceBody, async (c) => {
  const member = c.var.member
  return answer(c, keyBroker.setReadOnly(member, c.req.param('service'), c.var.body))
})

keyBrokerRoute.put('/broker/services/:service/default-key', companyMember, serviceBody, async (c) => {
  const member = c.var.member
  return answer(c, keyBroker.setDefaultKey(member, c.req.param('service'), c.var.body))
})

keyBrokerRoute.put('/broker/relay-services/:service', companyMember, serviceBody, async (c) => {
  const member = c.var.member
  return answer(c, keyBroker.setRelayService(member, c.req.param('service'), c.var.body))
})

keyBrokerRoute.delete('/broker/relay-services/:service', companyMember, async (c) => {
  const member = c.var.member
  return answer(c, keyBroker.deleteRelayService(member, c.req.param('service')))
})

keyBrokerRoute.put('/broker/settings', companyMember, serviceBody, async (c) => {
  const member = c.var.member
  return answer(c, keyBroker.setSettings(member, c.var.body))
})

keyBrokerRoute.post('/broker/stop-all', companyMember, async (c) => {
  const member = c.var.member
  return answer(c, keyBroker.stopAll(member))
})

keyBrokerRoute.post('/me/broker-tokens', companyMember, serviceBody, async (c) => {
  const member = c.var.member
  return answer(c, brokerTokens.issue(member, c.var.body))
})

keyBrokerRoute.delete('/me/broker-tokens/:tokenId', companyMember, async (c) => {
  const member = c.var.member
  return answer(c, brokerTokens.revoke(member, c.req.param('tokenId')))
})

keyBrokerRoute.get('/me/broker-keys', companyMember, async (c) => {
  const member = c.var.member
  return answer(c, ownBrokerKeys.list(member))
})

keyBrokerRoute.put('/me/broker-keys/:service', companyMember, serviceBody, async (c) => {
  const member = c.var.member
  return answer(c, await ownBrokerKeys.save(member, c.req.param('service'), c.var.body))
})

keyBrokerRoute.delete('/me/broker-keys/:service', companyMember, async (c) => {
  const member = c.var.member
  return answer(c, ownBrokerKeys.remove(member, c.req.param('service')))
})
