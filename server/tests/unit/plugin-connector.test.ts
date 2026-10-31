/**
 * The connector's calls (services/plugin-connector.ts, `.claude/rules/plugins.md`
 * "The connector"): only declared calls with a plain outside id; reads retried
 * with a capped backoff (Retry-After honoured), writes never re-sent — a lost
 * answer to a write is `unknown`, never "failed" or "done"; the precheck runs
 * before every attempt, also after a wait; the key goes only in the
 * credential header and never into a result.
 */
import { describe, expect, it } from 'vitest'
import { parsePluginManifest } from '../../shared/core/plugins'
import { readFileSync } from 'fs'
import { join } from 'path'
import { createPluginConnector } from '../../src/services/plugin-connector'
import type { UpstreamClient, UpstreamRequest } from '../../src/ports/upstream'
import type { ActivePlugin } from '../../src/services/plugins'

const KEY = 'pat-fake-NOT-REAL-connector-0123'
const manifest = (() => {
  const m = parsePluginManifest(readFileSync(join(__dirname, '../fixtures/plugins/sample-hub/plugin.yaml'), 'utf8'))
  if (!m.ok) throw new Error(m.errors.join())
  return m.value
})()
const plugin: ActivePlugin = {
  pluginId: 'sample-hub', version: '0.1.0', manifest, types: {}, mapping: { objects: {}, people: {}, policy: {} }, mappingVersion: 1,
  keyId: 'k1', fingerprint: 'f', connectionId: 'c1', accountId: '1',
}

type Scripted = { status: number; headers?: Array<[string, string]>; body?: string } | { fail: 'timeout' | 'connect' | 'dns' }

function world(script: Scripted[]) {
  const sent: UpstreamRequest[] = []
  const waits: number[] = []
  let clock = 1_000_000
  const upstream: UpstreamClient = {
    async send(req) {
      sent.push(req)
      const next = script.shift() ?? { status: 200, body: '{}' }
      if ('fail' in next) return { ok: false, reason: next.fail }
      const bytes = new TextEncoder().encode(next.body ?? '{}')
      return { ok: true, response: { status: next.status, headers: next.headers ?? [], body: (async function* () { yield bytes })(), viaPrivateAddress: false } }
    },
  }
  const connector = createPluginConnector({
    upstream,
    reveal: async () => KEY,
    credential: () => ({ header: 'authorization', value: k => `Bearer ${k}` }),
    sleep: async ms => { waits.push(ms); clock += ms },
    nowMs: () => clock,
  })
  return { connector, sent, waits }
}

const go = async () => null

describe('the connector', () => {
  it('sends only declared calls with a plain id, to the declared host, the key only in its header', async () => {
    const { connector, sent } = world([{ status: 200, body: '{"id":"1","properties":{}}' }])
    const r = await connector.call('co', plugin, { endpoint: 'get', object: 'deal', id: '1000000001', query: { properties: ['dealname'] } }, go)
    expect(r).toMatchObject({ ok: true, status: 200 })
    expect(sent[0]).toMatchObject({ host: 'api.hubapi.com', method: 'GET', path: '/crm/objects/2026-03/deals/1000000001?properties=dealname' })
    expect(sent[0].headers.authorization).toBe(`Bearer ${KEY}`)
    for (const bad of [
      { endpoint: 'get' as const, object: 'deal', id: '../owners' },
      { endpoint: 'get' as const, object: 'deal', id: '1/2' },
      { endpoint: 'update' as const, object: 'company', id: '1' },
      { endpoint: 'search' as const, object: 'note' },
      { endpoint: 'get' as const, object: 'contact', id: '1' },
    ]) {
      expect(await connector.call('co', plugin, bad, go)).toEqual({ ok: false, kind: 'not-sent', reason: 'undeclared-call' })
    }
    expect(sent).toHaveLength(1)
  })

  it('reads: a 429 waits (Retry-After, capped) and retries; 5xx retried; at most 3 retries', async () => {
    const { connector, sent, waits } = world([{ status: 429, headers: [['retry-after', '2']] }, { status: 503 }, { status: 200, body: '{"results":[]}' }])
    expect(await connector.call('co', plugin, { endpoint: 'search', object: 'deal', body: {} }, go)).toMatchObject({ ok: true })
    expect(sent).toHaveLength(3)
    expect(waits).toEqual([2000, 2000])
    const many = world([{ status: 429, headers: [['retry-after', '600']] }, { status: 429 }, { status: 429 }, { status: 429 }, { status: 429 }])
    expect(await many.connector.call('co', plugin, { endpoint: 'get', object: 'deal', id: '1' }, go)).toMatchObject({ ok: false, kind: 'rate-limited' })
    expect(many.waits[0]).toBe(10_000) // a long Retry-After is capped
    expect(many.sent.length).toBeLessThanOrEqual(4)
    // Without Retry-After: 1 s, 2 s, 4 s, then give up (the first try + 3 retries).
    const plain = world(Array.from({ length: 8 }, () => ({ status: 429 })))
    expect(await plain.connector.call('co', plugin, { endpoint: 'get', object: 'deal', id: '1' }, go)).toMatchObject({ ok: false, kind: 'rate-limited' })
    expect(plain.waits).toEqual([1000, 2000, 4000])
    expect(plain.sent).toHaveLength(4)
  })

  it('writes are never re-sent: 429 / 5xx returned as is, a lost answer is unknown', async () => {
    for (const [answer, kind] of [[{ status: 429 }, 'rate-limited'], [{ status: 500 }, 'server-error'], [{ fail: 'timeout' }, 'unknown'], [{ fail: 'connect' }, 'unknown']] as const) {
      for (const call of [
        { endpoint: 'update' as const, object: 'deal', id: '1', body: { properties: {} } },
        { endpoint: 'create' as const, object: 'note', body: { properties: {} } },
      ]) {
        const { connector, sent } = world([answer as Scripted, { status: 200 }])
        const r = await connector.call('co', plugin, call, go)
        expect([call.endpoint, r]).toMatchObject([call.endpoint, { ok: false, kind }])
        expect(sent).toHaveLength(1)
      }
    }
    // Nothing left ACB (the name did not resolve): not sent, and still not retried.
    const dns = world([{ fail: 'dns' }])
    expect(await dns.connector.call('co', plugin, { endpoint: 'update', object: 'deal', id: '1', body: {} }, go)).toMatchObject({ ok: false, kind: 'not-sent' })
    expect(dns.sent).toHaveLength(1)
  })

  it('the precheck runs before every attempt, also after a wait: a stop during the wait sends nothing more', async () => {
    const { connector, sent } = world([{ status: 429 }, { status: 200 }])
    let calls = 0
    const precheck = async () => (++calls > 1 ? 'stopped' : null)
    expect(await connector.call('co', plugin, { endpoint: 'get', object: 'deal', id: '1' }, precheck)).toEqual({ ok: false, kind: 'not-sent', reason: 'stopped' })
    expect(sent).toHaveLength(1)
  })

  it('an error answer never carries the outside body or the key into the result', async () => {
    const { connector } = world([{ status: 400, body: `{"message":"bad ${KEY}"}` }])
    const r = await connector.call('co', plugin, { endpoint: 'update', object: 'deal', id: '1', body: {} }, go)
    expect(r).toEqual({ ok: false, kind: 'refused', status: 400, reason: 'refused' })
  })
})
