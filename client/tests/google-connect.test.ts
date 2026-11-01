// 「Google で許可」 in main (electron/features/google/ipc.ts): main opens exactly
// the sign-in page the server named, in the system browser, and the renderer
// never gets that URL (its one-time state would let another page finish the
// member's permission) nor any server text; anything but Google's sign-in page
// (or the practice Google on this machine) is never opened.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createGoogleApi } from '../electron/features/google/ipc'

const STATE = 'co1.' + 'a'.repeat(64)
const GOOGLE_URL = `https://accounts.google.com/o/oauth2/v2/auth?client_id=x&state=${STATE}&code_challenge=abc`

function harness(answer: { status: number; body: unknown } | 'offline') {
  const opened: string[] = []
  const logs: string[] = []
  const requests: Array<{ url: string; method: string; body: unknown; cookie: string | null }> = []
  const api = createGoogleApi({
    baseUrl: () => 'https://acb.test',
    cookies: () => ['session=abc'],
    shell: { openExternal: async (url: string) => { opened.push(url) } },
    log: { warn: (line: string) => logs.push(line) },
    fetch: (async (url: string, init: RequestInit) => {
      if (answer === 'offline') throw new TypeError(`fetch failed ${GOOGLE_URL}`)
      requests.push({ url, method: String(init.method), body: init.body ? JSON.parse(String(init.body)) : undefined, cookie: new Headers(init.headers).get('cookie') })
      return new Response(JSON.stringify(answer.body), { status: answer.status })
    }) as unknown as typeof fetch,
  })
  return { api, opened, logs, requests }
}

test('connect opens the server\'s sign-in page in the browser and answers only { success: true }', async () => {
  const h = harness({ status: 200, body: { success: true, data: { authorizeUrl: GOOGLE_URL, expiresAt: '2026-11-01T00:10:00Z' } } })
  const r = await h.api.connect('co1', ['minutes'])
  assert.deepEqual(r, { success: true })
  assert.deepEqual(h.opened, [GOOGLE_URL])
  assert.deepEqual(h.requests, [{ url: 'https://acb.test/api/companies/co1/me/google/connect', method: 'POST', body: { features: ['minutes'] }, cookie: 'session=abc' }])
  assert.ok(!JSON.stringify(r).includes(STATE))
  assert.ok(!h.logs.join('\n').includes(STATE))
})

test('a URL that is not Google\'s sign-in page is never opened', async () => {
  for (const url of [
    'https://evil.example/o/oauth2/v2/auth?state=x', // Google's path on another host
    'https://accounts.google.com.evil.example/o/oauth2/v2/auth',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'http://accounts.google.com/o/oauth2/v2/auth', // http only on this machine (the practice Google)
    'http://192.168.0.5:4011/o/oauth2/v2/auth',
    'https://accounts.google.com/somewhere-else',
  ]) {
    const h = harness({ status: 200, body: { data: { authorizeUrl: url } } })
    const r = await h.api.connect('co1', ['minutes'])
    assert.equal(r.success, false, url)
    assert.deepEqual(h.opened, [], url)
  }
  const practice = harness({ status: 200, body: { data: { authorizeUrl: `http://127.0.0.1:4011/o/oauth2/v2/auth?state=${STATE}` } } })
  assert.deepEqual(await practice.api.connect('co1', ['minutes']), { success: true })
})

test('a refusal or an offline server answers a sentence built from the status only, never the server\'s text', async () => {
  const quoting = harness({ status: 409, body: { error: `secret ${STATE} 4/fake-code`, code: 'GOOGLE_UNAVAILABLE', reason: 'off' } })
  const r = await quoting.api.connect('co1', ['mail'])
  assert.deepEqual(r, { success: false, offline: false, error: '管理者が Google を止めています。' })
  assert.deepEqual(quoting.opened, [])
  const status = await harness({ status: 500, body: { error: `secret ${STATE}` } }).api.status('co1')
  assert.deepEqual(status, { success: false, offline: false, error: 'うまくいきませんでした（サーバーの応答 500）。' })
  const off = harness('offline')
  const o = await off.api.disconnect('co1')
  assert.equal(o.success, false)
  assert.ok(!JSON.stringify(o).includes(STATE) && !off.logs.join('\n').includes(STATE))
})
