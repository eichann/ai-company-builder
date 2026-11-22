import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type { RecordsTablePage, RecordsTableQuery, RecordsTableRow } from '../../../shared/records-table'
import type { RecordsTableReads } from './api'
import { useAuthStore } from '../../stores/authStore'
import { chooseKind, openRecordsTable, readMore, reloadTable, resetRecordsTable, useRecordsTableState } from './tableState'

const row = (id: string): RecordsTableRow => ({ id, title: id, stateLabel: null, finished: false, updatedAt: '2026-11-20T00:00:00Z', cells: {} })
const ok = (kind: string, ids: string[], total = ids.length): Extract<RecordsTablePage, { success: true }> => ({
  success: true, available: true, kinds: [{ name: 'task', label: 'やること' }, { name: 'decision', label: '決めたこと' }],
  kind, columns: [], total, offset: 0, rows: ids.map(row),
})

/** Answers each question when the test says so (in any order). */
function manualReads() {
  const asked: Array<{ query: RecordsTableQuery; answer: (p: RecordsTablePage) => void }> = []
  const reads: RecordsTableReads = {
    getRecordsTablePage: (_c, query) => new Promise(resolve => { asked.push({ query, answer: resolve }) }),
  }
  return { reads, asked }
}
const ids = () => useRecordsTableState.getState().page?.rows.map(r => r.id)

beforeEach(() => resetRecordsTable())

test('rows are exactly what the server answered: a record it did not return is never shown', async () => {
  const { reads, asked } = manualReads()
  const done = openRecordsTable('u1:c1', 'c1', 'task', reads)
  const first = ok('task', ['task-1', 'task-3', 'task-5'])
  first.rows[1] = { ...first.rows[1], personal: true, cells: { assignee: { text: '佐藤', sort: '佐藤' } } }
  first.rows[2] = { ...first.rows[2], membersOnly: true, finished: true }
  asked[0].answer(first)
  await done
  assert.deepEqual(useRecordsTableState.getState().page?.rows, first.rows, 'the rows answered, whole: none added, left out or changed')
  // Read again: what the server no longer returns (made owner-only, moved private) is gone.
  const again = reloadTable('c1', reads)
  asked[1].answer(ok('task', ['task-3']))
  await again
  assert.deepEqual(ids(), ['task-3'])
})

test('switching kinds fast: an older answer arriving last never replaces the newer one', async () => {
  const { reads, asked } = manualReads()
  const first = openRecordsTable('u1:c1', 'c1', 'task', reads)
  const second = chooseKind('c1', 'decision', reads)
  asked[1].answer(ok('decision', ['decision-1']))
  await second
  asked[0].answer(ok('task', ['task-1']))
  await first
  const s = useRecordsTableState.getState()
  assert.equal(s.page?.kind, 'decision')
  assert.deepEqual(ids(), ['decision-1'])
  assert.equal(s.loading, null)
})

test('another member or company starts from nothing, and an answer for the earlier one is dropped', async () => {
  const { reads, asked } = manualReads()
  const a = openRecordsTable('u1:c1', 'c1', 'task', reads)
  asked[0].answer(ok('task', ['task-1']))
  await a
  const late = reloadTable('c1', reads)
  const b = openRecordsTable('u2:c1', 'c1', undefined, reads)
  assert.equal(useRecordsTableState.getState().page, null, 'u2 never sees u1\'s rows, even while loading')
  asked[1].answer(ok('task', ['task-1', 'task-secret']))
  await late
  assert.equal(useRecordsTableState.getState().page, null)
  asked[2].answer(ok('task', ['task-2']))
  await b
  assert.deepEqual(ids(), ['task-2'])
})

test('さらに読む asks from the end of what is read and adds each record once', async () => {
  const { reads, asked } = manualReads()
  const a = openRecordsTable('u1:c1', 'c1', 'task', reads)
  asked[0].answer(ok('task', ['t1', 't2'], 4))
  await a
  const more = readMore('c1', reads)
  assert.equal(asked[1].query.offset, 2)
  asked[1].answer(ok('task', ['t3', 't4'], 4))
  await more
  assert.deepEqual(ids(), ['t1', 't2', 't3', 't4'])
  assert.equal(useRecordsTableState.getState().page?.stopped, undefined)
})

test('a record added ahead between pages: the next page counts by the server offset, reading stops and says the list changed', async () => {
  const { reads, asked } = manualReads()
  const a = openRecordsTable('u1:c1', 'c1', 'task', reads)
  asked[0].answer(ok('task', ['t1', 't2'], 6))
  await a
  const more = readMore('c1', reads)
  // t0 came in ahead: the server's page 2 starts with t2 again.
  asked[1].answer(ok('task', ['t2', 't3'], 7))
  await more
  const page = useRecordsTableState.getState().page!
  assert.deepEqual(ids(), ['t1', 't2', 't3'])
  assert.equal(page.consumed, 4, 'the offset reached, not the rows shown')
  assert.equal(page.stopped, 'changed')
  void readMore('c1', reads)
  assert.equal(asked.length, 2, 'stopped: the same tail is never asked again')
  // A record already read in the next page (same total: one moved ahead) also stops; so does a page adding nothing.
  const b = reloadTable('c1', reads)
  asked[2].answer(ok('task', ['t1', 't2'], 4))
  await b
  const again = readMore('c1', reads)
  assert.equal(asked[3].query.offset, 2)
  asked[3].answer(ok('task', ['t1', 't2'], 4))
  await again
  assert.equal(useRecordsTableState.getState().page?.stopped, 'changed')
  // Same total, one record moved ahead: page 2 repeats t2 and another may be skipped — stop too.
  const c = reloadTable('c1', reads)
  asked[4].answer(ok('task', ['t1', 't2'], 6))
  await c
  const shifted = readMore('c1', reads)
  asked[5].answer(ok('task', ['t2', 't3'], 6))
  await shifted
  assert.deepEqual(ids(), ['t1', 't2', 't3'])
  assert.equal(useRecordsTableState.getState().page?.stopped, 'changed')
})

test('さらに読む answered with another kind (the kind gone) keeps the rows read and stops', async () => {
  const { reads, asked } = manualReads()
  const a = openRecordsTable('u1:c1', 'c1', 'decision', reads)
  asked[0].answer(ok('decision', ['d1'], 3))
  await a
  const more = readMore('c1', reads)
  asked[1].answer(ok('task', ['t1']))
  await more
  const page = useRecordsTableState.getState().page!
  assert.equal(page.kind, 'decision')
  assert.deepEqual(ids(), ['d1'])
  assert.equal(page.stopped, 'kindGone')
})

test('past the query\'s reach (offset 10000) nothing more is asked; the page says to narrow', async () => {
  const { reads, asked } = manualReads()
  const a = openRecordsTable('u1:c1', 'c1', 'task', reads)
  asked[0].answer(ok('task', ['t1'], 20_000))
  await a
  useRecordsTableState.setState(s => ({ page: { ...s.page!, consumed: 10_001 } }))
  void readMore('c1', reads)
  assert.equal(asked.length, 1)
  assert.equal(useRecordsTableState.getState().page?.stopped, 'limit')
})

test('nobody signed in reads nothing; signing out forgets the rows and drops an answer on its way', async () => {
  const { reads, asked } = manualReads()
  await openRecordsTable(null, 'c1', 'task', reads)
  void reloadTable('c1', reads)
  void readMore('c1', reads)
  assert.equal(asked.length, 0)
  assert.equal(useRecordsTableState.getState().scope, null)
  useAuthStore.setState({ user: { id: 'u1', name: 'a', email: 'a@example.com' } as never })
  const a = openRecordsTable('u1:c1', 'c1', 'task', reads)
  asked[0].answer(ok('task', ['t1']))
  await a
  const late = reloadTable('c1', reads)
  useAuthStore.setState({ user: null })
  assert.equal(useRecordsTableState.getState().page, null)
  asked[1].answer(ok('task', ['t1']))
  await late
  assert.equal(useRecordsTableState.getState().page, null)
})

test('a failed read keeps the same question\'s rows and says why; another kind\'s rows are not left under it', async () => {
  const { reads, asked } = manualReads()
  const a = openRecordsTable('u1:c1', 'c1', 'task', reads)
  asked[0].answer(ok('task', ['t1']))
  await a
  const again = reloadTable('c1', reads)
  asked[1].answer({ success: false, offline: true, error: 'サーバーにつながらないため、表示できません。' })
  await again
  assert.deepEqual(ids(), ['t1'])
  assert.equal(useRecordsTableState.getState().error?.offline, true)
  const other = chooseKind('c1', 'decision', reads)
  asked[2].answer({ success: false, offline: true, error: 'x' })
  await other
  assert.equal(useRecordsTableState.getState().page, null)
})
