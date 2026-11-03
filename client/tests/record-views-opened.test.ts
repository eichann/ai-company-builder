// 「番の人が最初に開いた」 (records.md "Whose turn it was"): opening a record's card in the app is
// what tells the server (POST …/opened, the member's session in main) — nobody presses 着手. A
// card that could not be shown (not found, offline) tells nothing, and the card never waits for it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRecordViewsApi } from '../electron/features/record-views/ipc'

const DETAIL = {
  record: { id: 'task-abc123', type: 'task', title: '請求書を確かめる', summary: '', state: 'todo', version: 2, fields: {}, path: null, folder: null },
  links: [],
}

function harness(item: { status: number; body: unknown }, opened: 'ok' | 'hang' = 'ok') {
  const requests: Array<{ method: string; path: string; cookie: string | null }> = []
  const api = createRecordViewsApi({
    baseUrl: () => 'https://acb.test',
    cookies: () => ['session=abc'],
    log: { warn: () => {} },
    fetch: (async (url: string, init: RequestInit = {}) => {
      const path = new URL(url).pathname
      requests.push({ method: String(init.method ?? 'GET'), path, cookie: new Headers(init.headers).get('cookie') })
      if (path.endsWith('/opened')) {
        if (opened === 'hang') return new Promise(() => {})
        return new Response(JSON.stringify({ success: true, data: {} }), { status: 200 })
      }
      if (path.endsWith('/records/item/task-abc123')) return new Response(JSON.stringify(item.body), { status: item.status })
      if (path.endsWith('/history')) return new Response(JSON.stringify({ data: { entries: [] } }), { status: 200 })
      if (path.endsWith('/records/types')) return new Response(JSON.stringify({ data: { types: [] } }), { status: 200 })
      return new Response(JSON.stringify({ data: [] }), { status: 200 })
    }) as unknown as typeof fetch,
  })
  return { api, requests }
}

test('opening a card tells the server once, with the session, without waiting for it', async () => {
  const h = harness({ status: 200, body: { success: true, data: DETAIL } }, 'hang')
  const card = await h.api.card('co1', 'task-abc123')
  assert.equal(card.success, true)
  assert.deepEqual(h.requests.filter(r => r.path.endsWith('/opened')),
    [{ method: 'POST', path: '/api/companies/co1/records/item/task-abc123/opened', cookie: 'session=abc' }])
})

test('a card that could not be shown tells nothing', async () => {
  for (const status of [404, 500]) {
    const h = harness({ status, body: { error: 'x' } })
    assert.equal((await h.api.card('co1', 'task-abc123')).success, false)
    assert.deepEqual(h.requests.filter(r => r.path.endsWith('/opened')), [])
  }
})
