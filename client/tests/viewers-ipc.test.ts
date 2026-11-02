// viewers:get (electron/features/viewers/ipc.ts): the company id from the renderer goes into the
// server URL, so one that could change the path — or a list the server would refuse — never
// reaches the server; what the server answers is handed on unchanged.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createViewersApi } from '../electron/features/viewers/ipc'

function api() {
  const calls: Array<{ url: string; body?: string }> = []
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: init.body as string | undefined })
    return new Response(JSON.stringify({ data: { records: {}, files: { '営業部/a.md': { kind: 'company', text: '会社のみんな', count: 3 } } } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof globalThis.fetch
  return { calls, viewers: createViewersApi({ baseUrl: () => 'https://acb.example', cookies: () => ['s=1'], fetch, log: { warn() {} } }) }
}

test('a path-changing company id or a list the server would refuse never reaches the server', async () => {
  const { calls, viewers } = api()
  const tooMany = Array.from({ length: 201 }, (_, i) => `task-${i}`)
  for (const [companyId, query] of [['../admin', { files: ['a.md'] }], ['c%2F..', {}], ['c1', { records: tooMany }], ['c1', { files: [1] }], ['c1', null]] as const) {
    const r = await viewers.get(companyId, query)
    assert.equal(r.success === false && r.code, 'BAD_REQUEST')
  }
  assert.deepEqual(calls, [])
  const r = await viewers.get('c1', { files: ['営業部/a.md'] })
  assert.equal(r.success && r.answer.files['営業部/a.md'].text, '会社のみんな')
  assert.deepEqual(calls.map(c => [c.url, c.body]), [['https://acb.example/api/companies/c1/viewers', '{"records":[],"files":["営業部/a.md"]}']])
})
