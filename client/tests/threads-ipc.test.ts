// The card's 元のスレッド in main (electron/features/threads/ipc.ts, outbound-mail.md "Replies").
// Protects: an id the renderer hands over that is not a record id never reaches the server (no
// path of another kind can be built from it); a record whose 連絡 the member cannot see (the
// server's one 404) shows nothing — no sentence that would tell an owner-only 連絡 exists; an
// answer that is not a thread is not drawn.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createThreadsApi } from '../electron/features/threads/ipc'

const thread = {
  recordId: 'interaction-0123456789ab', interactionId: 'interaction-0123456789ab', channel: 'email', more: false, unavailable: null, replies: [],
  messages: [{ id: 'm1', fromName: '鈴木', fromAddress: 'suzuki@a.example', to: [], cc: [], at: null, subject: '見積', text: '本文', truncated: false, mine: false }],
}

function api(answer: { status: number; body: unknown } | 'down') {
  const urls: string[] = []
  const fetch = (async (url: string) => {
    urls.push(url)
    if (answer === 'down') throw new Error('ECONNREFUSED')
    return new Response(JSON.stringify(answer.body), { status: answer.status })
  }) as unknown as typeof globalThis.fetch
  return { urls, threads: createThreadsApi({ baseUrl: () => 'https://acb.example', cookies: () => ['s=1'], fetch, log: { warn: () => {} } }) }
}

test('an id that is not a record id never leaves main', async () => {
  const { urls, threads } = api({ status: 200, body: { data: { thread } } })
  for (const [co, id] of [['co', '../outbound/x'], ['co', 'interaction-0123456789ab/../../x'], ['co/../x', 'interaction-0123456789ab'], ['co', 42]] as const) {
    assert.deepEqual(await threads.get(co, id), { success: false, none: true })
  }
  assert.deepEqual(urls, [])
  assert.equal((await threads.get('co', 'interaction-0123456789ab')).success, true)
  assert.deepEqual(urls, ['https://acb.example/api/companies/co/threads/interaction-0123456789ab'])
})

test('the server\'s 404 (no 連絡, or one the member cannot see) shows nothing', async () => {
  const { threads } = api({ status: 404, body: { error: '元の連絡が見つかりません', code: 'THREAD_NOT_FOUND' } })
  assert.deepEqual(await threads.get('co', 'task-0123456789ab'), { success: false, none: true })
})

test('an answer that is not a thread is not drawn; a lost server is said as such', async () => {
  const bad = api({ status: 200, body: { data: { thread: { ...thread, messages: [{ id: 'm1' }] } } } })
  assert.equal((await bad.threads.get('co', 'interaction-0123456789ab')).success, false)
  const down = api('down')
  const r = await down.threads.get('co', 'interaction-0123456789ab')
  assert.deepEqual(r, { success: false, none: false, offline: true, error: 'サーバーにつながらないため、元の連絡を読めません。' })
})
