// The key broker's tokens on this computer (K6, services/broker-token-store.ts):
// every turn starts with a token that outlives it (refreshed before expiry),
// one per consultation and department; a failure means "no broker this turn"
// (never an error, never a token in the log).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBrokerTokenStore, REFRESH_MARGIN_MS } from '../electron/services/broker-token-store'

const T = (n: number) => `acb_tok_${String(n).padStart(2, '0').repeat(32)}`

function harness() {
  let now = Date.parse('2026-10-30T09:00:00.000Z')
  let n = 0
  let offline = false
  const requests: Array<{ url: string; body: Record<string, unknown> }> = []
  const logs: string[] = []
  const store = createBrokerTokenStore({
    baseUrl: () => 'https://acb.test',
    cookies: () => ['session=abc'],
    nowMs: () => now,
    log: { warn: (line: string) => logs.push(line) },
    fetch: (async (url: string, init: RequestInit) => {
      if (offline) throw new TypeError('fetch failed')
      requests.push({ url, body: JSON.parse(String(init.body)) })
      n++
      return new Response(JSON.stringify({ data: {
        enabled: true, token: T(n), tokenId: `id${n}`, expiresAt: new Date(now + 30 * 60_000).toISOString(),
        services: [{ service: 'gemini', source: 'company' }], unavailable: [],
      } }), { status: 200 })
    }) as unknown as typeof fetch,
  })
  return { store, requests, logs, advance: (ms: number) => { now += ms }, setOffline: (v: boolean) => { offline = v } }
}

test('one token per consultation, reused while it has time left, replaced before it runs out', async () => {
  const h = harness()
  const req = { companyId: 'co', conversationId: 'conv-1', department: '営業部' }
  assert.equal((await h.store.envFor(req)).GEMINI_API_KEY, T(1))
  assert.equal((await h.store.envFor(req)).GEMINI_API_KEY, T(1))
  assert.equal(h.requests.length, 1)
  assert.deepEqual(h.requests[0].body, { conversationId: 'conv-1', department: '営業部' })
  // Another department of the same consultation is another token (dial ①).
  assert.equal((await h.store.envFor({ ...req, department: '開発' })).GEMINI_API_KEY, T(2))
  // Less than the margin left: a new one, so the turn never starts on an almost-expired token.
  h.advance(30 * 60_000 - REFRESH_MARGIN_MS + 1000)
  assert.equal((await h.store.envFor(req)).GEMINI_API_KEY, T(3))
  h.store.clear()
  assert.equal((await h.store.envFor(req)).GEMINI_API_KEY, T(4))
})

test('offline or refused: no broker variables this turn, and no token in the log', async () => {
  const h = harness()
  await h.store.envFor({ companyId: 'co', conversationId: 'c' })
  h.setOffline(true)
  assert.deepEqual(await h.store.envFor({ companyId: 'co', conversationId: 'other' }), {})
  assert.ok(h.logs.length > 0)
  assert.ok(!h.logs.join('\n').includes('acb_tok_'))
})
