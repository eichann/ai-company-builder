// The archive (アーカイブ, tasks-ui.md "The archive"): `tasks:archived` in main and `archivePage`
// (client/shared/tasks.ts). Guards: 20 per page, newest first, each archived task once across all
// pages though one's own task is in both queries; 「さらに読み込む」 stops when both are read; only
// archived tasks of the member (assignee or requester) are asked for, archived within 30 days
// (older ones only left out of the fold); a bad cursor never reaches the server; an archived task
// is not in 今日終わったこと.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTasksApi } from '../electron/features/tasks/ipc'
import { ARCHIVE_PAGE, archivePage, classifyTasks, type ArchiveCursor } from '../shared/tasks'
import type { RecordSummary } from '../../shared/types/records'

const ME = 'u-me'
const at = (n: number) => new Date(Date.parse('2026-11-01T00:00:00.000Z') + n * 60_000).toISOString()
const task = (id: string, minute: number, fields: Record<string, string>): RecordSummary =>
  ({ id, type: 'task', typeVersion: 12, title: id, summary: '', path: null, state: 'cancelled', fields, version: 4, updatedAt: at(minute) })

/** The server's order (records.md "Reading"): most recently changed first, then the id. */
const serverOrder = (list: RecordSummary[]) => [...list].sort((a, b) => (a.updatedAt === b.updatedAt ? (a.id < b.id ? -1 : 1) : a.updatedAt > b.updatedAt ? -1 : 1))

/** A server holding archived tasks: answers `/records/query` by its field, offset and limit, as the real one pages. */
function server(all: RecordSummary[], nowMs?: number) {
  const queries: Array<Record<string, unknown>> = []
  const api = createTasksApi({
    ...(nowMs !== undefined ? { now: () => nowMs } : {}),
    baseUrl: () => 'https://acb.test',
    cookies: () => ['session=abc'],
    log: { warn: () => {} },
    fetch: (async (url: string, init: RequestInit) => {
      if (url.endsWith('/api/me')) return new Response(JSON.stringify({ data: { id: ME } }), { status: 200 })
      const body = JSON.parse(String(init.body)) as { state: string[]; fields: Record<string, string>; finishedSince?: string; limit: number; offset: number }
      queries.push(body)
      const [[field, value]] = Object.entries(body.fields)
      // finishedSince: entered the final state since then (here the last change is the archiving).
      const matching = serverOrder(all.filter(r => body.state.includes(r.state ?? '') && r.fields[field] === value && (!body.finishedSince || r.updatedAt >= body.finishedSince)))
      return new Response(JSON.stringify({ data: { total: matching.length, records: matching.slice(body.offset, body.offset + body.limit) } }), { status: 200 })
    }) as unknown as typeof fetch,
  })
  return { api, queries }
}

test('「さらに読み込む」 pages 20 at a time, newest first, each archived task once — one\'s own task is in both queries', async () => {
  const all: RecordSummary[] = []
  // 30 of the member's own (assignee and requester), 15 asked of 田中さん, 12 asked of the member by 阿部さん, interleaved in time.
  for (let n = 0; n < 57; n++) {
    const fields = n % 4 === 1 ? { assignee: 'u-tanaka', requested_by: ME } : n % 4 === 3 && n < 48 ? { assignee: ME, requested_by: 'u-abe' } : { assignee: ME, requested_by: ME }
    all.push(task(`task-${String(n).padStart(6, '0')}`, n % 7 === 0 ? 0 : n, fields))
  }
  // Someone else's archived task never shows.
  all.push(task('task-other0', 99, { assignee: 'u-tanaka', requested_by: 'u-abe' }))
  const h = server(all, Date.parse('2026-11-10T00:00:00.000Z'))
  let cursor: ArchiveCursor | null = { assignee: 0, requester: 0 }
  const pages: string[][] = []
  while (cursor) {
    const r = await h.api.archived('co1', cursor)
    assert.ok(r.success)
    assert.ok(r.items.length <= ARCHIVE_PAGE)
    pages.push(r.items.map(i => i.id))
    cursor = r.next
    assert.ok(pages.length < 10, 'it ends')
  }
  assert.equal(pages[0].length, 20)
  const shown = pages.flat()
  const expected = serverOrder(all.filter(r => r.id !== 'task-other0')).map(r => r.id)
  assert.deepEqual(shown, expected)
  // Only archived tasks of the member, by each of the two fields, 20 at a time.
  for (const q of h.queries) {
    assert.deepEqual(q.state, ['cancelled'])
    assert.equal(q.type, 'task')
    assert.equal(q.limit, ARCHIVE_PAGE)
    assert.deepEqual(Object.values(q.fields as object), [ME])
  }
})

test('the folded archive shows only the last 30 days of archiving; older ones are only left out (asked for nothing older)', async () => {
  const nowMs = Date.parse('2026-12-15T00:00:00.000Z')
  const day = 24 * 60 * 60 * 1000
  const archived = (id: string, daysAgo: number) => ({ ...task(id, 0, { assignee: ME, requested_by: ME }), updatedAt: new Date(nowMs - daysAgo * day).toISOString() })
  const h = server([archived('task-recent', 1), archived('task-edge29', 29), archived('task-old031', 31), archived('task-old200', 200)], nowMs)
  const r = await h.api.archived('co1', { assignee: 0, requester: 0 })
  assert.ok(r.success)
  assert.deepEqual(r.items.map(i => i.id), ['task-recent', 'task-edge29'])
  assert.equal(r.next, null)
  for (const q of h.queries) assert.equal(q.finishedSince, new Date(nowMs - 30 * day).toISOString())
})

test('a page never goes past a window whose query has more; the next page picks up there', () => {
  // The assignee query's window ends at minute 50 but it has more; the requester's goes on older.
  const a = { records: [task('task-a1', 60, {}), task('task-a2', 50, {})], total: 5 }
  const r = { records: [task('task-r1', 55, {}), task('task-r2', 10, {}), task('task-r3', 5, {})], total: 3 }
  const p = archivePage(a, r, { assignee: 0, requester: 0 }, 20)
  assert.deepEqual(p.records.map(x => x.id), ['task-a1', 'task-r1', 'task-a2'])
  assert.deepEqual(p.next, { assignee: 2, requester: 1 })
  // Both read to the end: nothing more to load.
  assert.equal(archivePage({ records: [], total: 0 }, { records: [task('task-r9', 1, {})], total: 1 }, { assignee: 0, requester: 0 }).next, null)
})

test('a cursor that is not one never reaches the server', async () => {
  const h = server([])
  for (const bad of [null, { assignee: -1, requester: 0 }, { assignee: 1.5, requester: 0 }, { assignee: 0 }, { assignee: 0, requester: 20_000 }, '0']) {
    assert.equal((await h.api.archived('co1', bad)).success, false, JSON.stringify(bad))
  }
  assert.equal((await h.api.archived('../co1', { assignee: 0, requester: 0 })).success, false)
  assert.equal(h.queries.length, 0)
})

test('an archived task left the list: not among today\'s done', () => {
  const rec = (id: string, state: string): RecordSummary => ({ ...task(id, 1, { assignee: ME, requested_by: ME }), state })
  const items = classifyTasks({ me: ME, myTurn: [], aiTurn: [], asked: [], doneToday: [rec('task-done01', 'done'), rec('task-arch01', 'cancelled')], typeLabels: { task: 'タスク' }, people: {}, bundles: {} })
  assert.deepEqual(items.map(i => i.id), ['task-done01'])
})
