import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { RecordsTableColumn, RecordsTableRow } from '../../../shared/records-table'
import { filterRows, isOverdue, nextSort, pageNote, shownColumns, sortRows } from './model'

const row = (id: string, title: string, due: string | null, extra: Partial<RecordsTableRow> = {}): RecordsTableRow => ({
  id, title, stateLabel: 'まだ', finished: false, updatedAt: '2026-11-20T00:00:00Z',
  cells: { due: { text: due, sort: due }, assignee: { text: id === 'a' ? '佐藤' : '田中', sort: id === 'a' ? '佐藤' : '田中' } },
  ...extra,
})
const ROWS = [row('a', '見積もりを送る', '2026-11-28'), row('b', '契約書を回す', null), row('c', 'ＡＢＣ社に連絡', '2026-11-19')]
const COLS: RecordsTableColumn[] = [
  { field: 'assignee', label: '担当', kind: 'person', shown: true },
  { field: 'due', label: '期限', kind: 'date', shown: true },
  { field: 'tags', label: 'タグ', kind: 'tags', shown: false },
]

test('sorting by a column: ascending, descending, empty values last both ways, ties in the server order', () => {
  assert.deepEqual(sortRows(ROWS, { key: 'field:due', dir: 'asc' }).map(r => r.id), ['c', 'a', 'b'])
  assert.deepEqual(sortRows(ROWS, { key: 'field:due', dir: 'desc' }).map(r => r.id), ['a', 'c', 'b'])
  assert.deepEqual(sortRows(ROWS, null).map(r => r.id), ['a', 'b', 'c'])
  const same = [row('x', 'あ', '2026-11-01'), row('y', 'あ', '2026-11-01')]
  assert.deepEqual(sortRows(same, { key: 'title', dir: 'desc' }).map(r => r.id), ['x', 'y'])
})

test('a header press goes ascending → descending → the server order; another column starts ascending', () => {
  const a = nextSort(null, 'title')
  assert.deepEqual(a, { key: 'title', dir: 'asc' })
  const d = nextSort(a, 'title')
  assert.deepEqual(d, { key: 'title', dir: 'desc' })
  assert.equal(nextSort(d, 'title'), null)
  assert.deepEqual(nextSort(d, 'updated'), { key: 'updated', dir: 'asc' })
})

test('the text filter matches every word in the title, state or a shown cell, width and case folded', () => {
  assert.deepEqual(filterRows(ROWS, 'abc', COLS).map(r => r.id), ['c'])
  assert.deepEqual(filterRows(ROWS, '田中', COLS).map(r => r.id), ['b', 'c'])
  assert.deepEqual(filterRows(ROWS, '田中 契約', COLS).map(r => r.id), ['b'])
  assert.deepEqual(filterRows(ROWS, '  ', COLS).map(r => r.id), ['a', 'b', 'c'])
  // A hidden column is not searched (the member cannot see why a row matched).
  assert.deepEqual(filterRows(ROWS, '田中', COLS.filter(c => c.field !== 'assignee')).map(r => r.id), [])
})

test('期限切れ: only the due field, before today, on a record not finished', () => {
  const late = row('c', 'x', '2026-11-19')
  assert.equal(isOverdue(late, 'due', late.cells.due, '2026-11-22'), true)
  assert.equal(isOverdue(late, 'due', late.cells.due, '2026-11-19'), false)
  assert.equal(isOverdue({ ...late, finished: true }, 'due', late.cells.due, '2026-11-22'), false)
  assert.equal(isOverdue(late, 'wait_until', late.cells.due, '2026-11-22'), false)
})

test('shown columns: the kind\'s first few until the member picks', () => {
  assert.deepEqual(shownColumns(COLS, undefined).map(c => c.field), ['assignee', 'due'])
  assert.deepEqual(shownColumns(COLS, ['tags']).map(c => c.field), ['tags'])
})

test('the page note says when only part is read (and that sorting stays inside it)', () => {
  assert.deepEqual(pageNote(3, 3), { text: '3 件', more: false })
  const part = pageNote(200, 450)
  assert.equal(part.more, true)
  assert.match(part.text, /全 450 件のうち 200 件/)
})
