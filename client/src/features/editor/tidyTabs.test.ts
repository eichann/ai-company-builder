import { test } from 'node:test'
import assert from 'node:assert/strict'
import { recordTabKey } from './editorTabs'
import {
  addGroup, companyDay, createTidyStore, dueForDailyTidy, groupsByDay, parseGroups, planTidy, removeItems, tabKeyOf, tidiedItemOf,
  type TidiedGroup,
} from './tidyTabs'

const root = '/Users/me/会社'
const a = `${root}/営業/A社.md`
const b = `${root}/営業/B社.md`
const task = recordTabKey('task-abc123')

const group = (id: string, n: number, at = `2026-11-0${id.length}T09:00:00Z`): TidiedGroup => ({
  id, at, day: at.slice(0, 10), auto: false,
  items: Array.from({ length: n }, (_, i) => ({ id: `${id}-${i}`, kind: 'file' as const, path: `f${i}.md`, title: `f${i}.md` })),
})

function memoryStorage() {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, v) },
    removeItem: (k: string) => { data.delete(k) },
  }
}

test('a tidy closes every tab but the pinned ones and the ones with unsaved edits', () => {
  const plan = planTidy([a, task, b], [task], [b])
  assert.deepEqual(plan.close, [a])
  assert.deepEqual(plan.pinned, [task])
  // Unsaved edits are never closed away: the tab stays and the member is told.
  assert.deepEqual(plan.unsaved, [b])
})

test('a tidied file is kept by its company path and reopens under the company folder', () => {
  const item = tidiedItemOf(a, root, {})
  assert.equal(item.kind, 'file')
  assert.equal(item.kind === 'file' && item.path, '営業/A社.md')
  assert.equal(item.title, 'A社.md')
  assert.equal(tabKeyOf(item, '/Volumes/new/会社'), '/Volumes/new/会社/営業/A社.md')
  const rec = tidiedItemOf(task, root, { 'task-abc123': { title: '見積を出す', type: 'task' } })
  assert.equal(rec.title, '見積を出す')
  assert.equal(tabKeyOf(rec, root), task)
})

test('the list keeps at most 30 tidies and 500 tabs, dropping the oldest and counting them', () => {
  let groups: TidiedGroup[] = []
  for (let i = 0; i < 32; i++) groups = addGroup(groups, { ...group(`g${i}`, 1), at: new Date(Date.UTC(2026, 9, 1, i)).toISOString() }).groups
  assert.equal(groups.length, 30)
  assert.equal(groups[0].id, 'g31')
  const big = addGroup([group('old', 300), group('older', 150)], group('new', 100))
  assert.equal(big.groups.reduce((n, g) => n + g.items.length, 0), 500)
  assert.equal(big.dropped, 50)
  // The oldest tidy loses its items first; the newest is kept whole.
  assert.equal(big.groups[0].items.length, 100)
  assert.equal(big.groups.at(-1)!.id, 'older')
  assert.equal(big.groups.at(-1)!.items.length, 100)
})

test('removing items drops a group left empty; days are listed newest first', () => {
  const g1 = { ...group('x', 2), day: '2026-11-02', at: '2026-11-02T01:00:00Z' }
  const g2 = { ...group('y', 1), day: '2026-11-03', at: '2026-11-03T01:00:00Z' }
  assert.deepEqual(removeItems([g1, g2], ['y-0']).map(g => g.id), ['x'])
  assert.deepEqual(groupsByDay([g1, g2]).map(d => d.day), ['2026-11-03', '2026-11-02'])
})

test('the daily tidy is due only after an earlier day; the first day ever closes nothing', () => {
  assert.equal(dueForDailyTidy(null, '2026-11-04'), false)
  assert.equal(dueForDailyTidy('2026-11-04', '2026-11-04'), false)
  assert.equal(dueForDailyTidy('2026-11-02', '2026-11-04'), true)
  // The company's day (Japan time): 23:30 UTC is already the next morning there.
  assert.equal(companyDay(Date.UTC(2026, 10, 3, 23, 30)), '2026-11-04')
})

test('the daily tidy runs once per company day and not when switched off', () => {
  const storage = memoryStorage()
  const store = createTidyStore(() => storage)
  assert.equal(store.dailyTidyDue('c1', '2026-11-03'), false)
  assert.equal(store.dailyTidyDue('c1', '2026-11-04'), true)
  assert.equal(store.dailyTidyDue('c1', '2026-11-04'), false, 'the second open of the day')
  assert.equal(store.dailyTidyDue('c2', '2026-11-04'), false, 'each company has its own day')
  store.setDailyTidy(false)
  assert.equal(store.dailyTidyOn(), false)
  assert.equal(store.dailyTidyDue('c1', '2026-11-05'), false)
  store.setDailyTidy(true)
  assert.equal(store.dailyTidyDue('c1', '2026-11-06'), true)
})

test('tidied tabs live in this Mac\'s storage only, per company, and survive a restart', () => {
  const storage = memoryStorage()
  const store = createTidyStore(() => storage)
  store.add('c1', group('g', 2))
  // Only the company's own key is written (no server, nothing shared with another company).
  assert.deepEqual([...storage.data.keys()], ['tidiedTabs:c1'])
  const restarted = createTidyStore(() => storage)
  assert.deepEqual(restarted.groups('c1').map(g => g.id), ['g'])
  assert.deepEqual(restarted.groups('c2'), [])
  restarted.removeDay('c1', group('g', 2).day)
  assert.equal(storage.data.has('tidiedTabs:c1'), false)
})

test('a hand-edited or broken saved list is read without what it cannot use', () => {
  assert.deepEqual(parseGroups('x'), [])
  const parsed = parseGroups([{ id: 'g', at: '2026-11-03T00:00:00Z', day: '2026-11-03', items: [{ id: 'i', kind: 'file', title: 'a.md' }, { id: 'j', kind: 'file', path: 'a.md', title: 'a.md' }] }, null])
  assert.equal(parsed.length, 1)
  assert.deepEqual(parsed[0].items.map(i => i.id), ['j'])
})
