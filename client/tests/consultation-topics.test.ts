// The やること / 案件 a consultation is about (「AIへの相談」's search and rows, and 探す): read by
// main with the member's session as a plain read, its own やること before its 案件, and a record
// the member cannot read is never there to show.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRecordViewsApi } from '../electron/features/record-views/ipc'
import { consultationLinkedRecord, consultationTopicOf } from '../shared/consultation-topics'

const summary = (id: string, type: string, title: string) => ({ id, type, typeVersion: 1, title, summary: '', path: null, state: 'todo', fields: {}, version: 1, updatedAt: '2026-11-01' })
const BUNDLE_DEF = { name: 'deal', label: '案件', implements: ['bundle'] }
const TASK = { record: summary('task-0000aa', 'task', '見積書を作り直す'), links: [{ name: 'bundle', direction: 'out', record: summary('deal-0000bb', 'deal', '株式会社サンプル') }] }
const BUNDLE = { record: summary('deal-0000bb', 'deal', '株式会社サンプル'), links: [{ name: 'bundle', direction: 'in', record: summary('task-0000aa', 'task', '見積書を作り直す') }] }

function harness(items: Record<string, { status: number; body?: unknown } | 'down'>) {
  const requests: Array<{ method: string; path: string }> = []
  const api = createRecordViewsApi({
    baseUrl: () => 'https://acb.test',
    cookies: () => ['session=abc'],
    log: { warn: () => {} },
    fetch: (async (url: string, init: RequestInit = {}) => {
      const path = new URL(url).pathname
      requests.push({ method: String(init.method ?? 'GET'), path })
      if (path.endsWith('/records/types')) return new Response(JSON.stringify({ data: { types: [{ definition: BUNDLE_DEF }] } }), { status: 200 })
      const item = items[decodeURIComponent(path.split('/').pop() ?? '')]
      if (!item || item === 'down') throw new Error('unreachable')
      return new Response(JSON.stringify(item.body ?? { error: 'x' }), { status: item.status })
    }) as unknown as typeof fetch,
  })
  return { api, requests }
}

test('a task topic is the task, with its 案件; a 案件 topic is the 案件; unreadable is null; nothing is marked opened', async () => {
  const h = harness({ 'task-0000aa': { status: 200, body: { data: TASK } }, 'deal-0000bb': { status: 200, body: { data: BUNDLE } }, 'task-0000cc': { status: 404 } })
  const answer = await h.api.topics('co1', ['task-0000aa', 'deal-0000bb', 'task-0000cc', 'task-0000aa', '../x'])
  assert.equal(answer.success, true)
  if (!answer.success) return
  const deal = { id: 'deal-0000bb', title: '株式会社サンプル', thing: 'bundle', typeLabel: '案件', kindName: '案件' }
  assert.deepEqual(answer.topics['task-0000aa'], { own: { id: 'task-0000aa', title: '見積書を作り直す', thing: 'task', typeLabel: null, kindName: 'やること' }, bundle: deal })
  assert.deepEqual(answer.topics['deal-0000bb'], { own: null, bundle: deal })
  assert.equal(answer.topics['task-0000cc'], null)
  assert.deepEqual(Object.keys(answer.topics).sort(), ['deal-0000bb', 'task-0000aa', 'task-0000cc'])
  // Each record asked once, and only read: the 「番の人が最初に開いた」 signal is the card's alone.
  assert.equal(h.requests.filter(r => r.path.includes('/records/item/')).length, 3)
  assert.deepEqual(h.requests.filter(r => r.method !== 'GET' || r.path.endsWith('/opened')), [])
})

test('a record that could not be asked is left out (asked again later), not taken as unreadable', async () => {
  const h = harness({ 'task-0000aa': { status: 200, body: { data: TASK } }, 'task-0000dd': 'down' })
  const answer = await h.api.topics('co1', ['task-0000aa', 'task-0000dd'])
  assert.ok(answer.success && !('task-0000dd' in answer.topics) && answer.topics['task-0000aa'])
  const offline = await harness({ 'task-0000dd': 'down' }).api.topics('co1', ['task-0000dd'])
  assert.equal(offline.success ? null : offline.offline, true)
})

test('the record a consultation is found by: its own やること first, its 案件 only when it has none', () => {
  const defs = new Map([['deal', BUNDLE_DEF]])
  assert.equal(consultationLinkedRecord(consultationTopicOf(TASK as never, defs))?.id, 'task-0000aa')
  assert.equal(consultationLinkedRecord(consultationTopicOf(BUNDLE as never, defs))?.id, 'deal-0000bb')
  // A task whose 案件 the member cannot read: the server leaves the link's record out.
  const alone = consultationTopicOf({ record: TASK.record, links: [{ name: 'bundle', direction: 'out' }] } as never, defs)
  assert.equal(alone.bundle, null)
  assert.equal(consultationLinkedRecord(null), null)
  assert.equal(consultationLinkedRecord({ own: null, bundle: null }), null)
})
