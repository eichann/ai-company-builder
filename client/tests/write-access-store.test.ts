import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createWriteAccessStore } from '../electron/write-access-store'
import type { WriteAccess } from '../shared/write-access'

const A: WriteAccess = { version: 'a', role: 'member', all: false, scopes: [{ path: '', write: true }, { path: '営業部', write: false }] }
const B: WriteAccess = { ...A, version: 'b', scopes: [{ path: '', write: true }] }
const quiet = { warn: () => {}, log: () => {} }

function server(responses: Array<() => Response | Promise<Response>>) {
  const requests: Array<{ url: string; headers: Record<string, string> }> = []
  const fetchFn = (async (url: string, init?: RequestInit) => {
    requests.push({ url, headers: (init?.headers ?? {}) as Record<string, string> })
    const next = responses.shift()
    if (!next) throw new Error('no more responses')
    return next()
  }) as unknown as typeof fetch
  return { fetchFn, requests }
}
const json = (data: unknown) => () => new Response(JSON.stringify({ success: true, data }), { status: 200 })

test('caches per company, revalidates with If-None-Match, and reports changes', async () => {
  const { fetchFn, requests } = server([json(A), () => new Response(null, { status: 304 }), json(B)])
  const changes: string[] = []
  const store = createWriteAccessStore({ baseUrl: () => 'http://api', cookies: () => ['s=1'], fetch: fetchFn, log: quiet, onChange: (c, a) => changes.push(`${c}:${a.version}`) })
  assert.equal(store.get('co'), undefined)
  assert.deepEqual(await store.refresh('co'), A)
  assert.equal(requests[0].url, 'http://api/api/companies/co/me/write-access')
  assert.equal(requests[0].headers.Cookie, 's=1')
  assert.equal(requests[0].headers['If-None-Match'], undefined)
  assert.deepEqual(await store.refresh('co'), A)
  assert.equal(requests[1].headers['If-None-Match'], '"a"')
  assert.deepEqual(await store.refresh('co'), B)
  assert.deepEqual(changes, ['co:a', 'co:b'])
  store.clear()
  assert.equal(store.get('co'), undefined)
})

test('a failed refresh keeps the last answer; with none the access stays unknown', async () => {
  const { fetchFn } = server([() => { throw new Error('offline') }, json(A), () => new Response('{}', { status: 500 }), json({ bogus: true })])
  const store = createWriteAccessStore({ baseUrl: () => 'http://api', cookies: () => [], fetch: fetchFn, log: quiet })
  assert.equal(await store.refresh('co'), undefined)
  assert.deepEqual(await store.refresh('co'), A)
  assert.deepEqual(await store.refresh('co'), A)
  assert.deepEqual(await store.refresh('co'), A)
})

test('timeoutMs bounds the wait, the fetch still lands in the cache', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const { fetchFn } = server([async () => { await gate; return json(A)() }])
  const store = createWriteAccessStore({ baseUrl: () => 'http://api', cookies: () => [], fetch: fetchFn, log: quiet })
  assert.equal(await store.refresh('co', { timeoutMs: 20 }), undefined)
  release()
  assert.deepEqual(await store.refresh('co'), A) // joins the in-flight request
  assert.deepEqual(store.get('co'), A)
})
