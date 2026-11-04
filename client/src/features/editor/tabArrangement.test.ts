import { test } from 'node:test'
import assert from 'node:assert/strict'
import { recordTabKey, type RecordTabLook } from './editorTabs'
import {
  addToGroup, arrangeTabs, canMoveTab, createTabGroupingStore, moveTab, NO_GROUPING, parseGrouping, pruneGrouping, tabGroupName, tabGroupOf,
  type ArrangeOptions, type TabGrouping,
} from './tabArrangement'

const a = '/c/営業/A社.md'
const b = '/c/営業/B社.md'
const c = '/c/総務/備品.md'
const task1 = recordTabKey('task-aaaaaa')
const task2 = recordTabKey('task-bbbbbb')
const deal = recordTabKey('deal-cccccc')
const show = recordTabKey('program-dddddd')
const meeting = recordTabKey('meeting-eeeeee')
const unknown = recordTabKey('memo-ffffff')
const looks: Record<string, RecordTabLook> = {
  'task-aaaaaa': { title: '見積', type: 'task' },
  'task-bbbbbb': { title: '請求', type: 'task' },
  'deal-cccccc': { title: 'A社', type: 'deal', typeLabel: '案件', implements: ['bundle'] },
  'program-dddddd': { title: '朝の番組', type: 'program', typeLabel: '番組', implements: ['bundle'] },
  'meeting-eeeeee': { title: '定例', type: 'meeting' },
}
const opts = (pinned: string[] = [], grouping: Partial<TabGrouping> = {}): ArrangeOptions =>
  ({ pinned: new Set(pinned), looks, grouping: { ...NO_GROUPING, ...grouping } })
const proposal = { id: 'g1', name: '提案準備', color: 'rose' as const }
const ids = (o: ArrangeOptions, order: string[]) => arrangeTabs(order, o).map(s => [s.id, s.keys])

test('pinned tabs stand first, the rest keep their order', () => {
  assert.deepEqual(ids(opts([b]), [a, task1, b, deal]), [['pinned', [b]], ['all', [a, task1, deal]]])
})

test('by kind: pinned first, then files, tasks, bundles, meetings, others; a record not read yet is その他', () => {
  assert.deepEqual(ids(opts([task2], { byKind: true }), [meeting, task1, a, unknown, deal, task2, b, show]), [
    ['pinned', [task2]], ['file', [a, b]], ['task', [task1]], ['bundle', [deal, show]], ['meeting', [meeting]], ['other', [unknown]],
  ])
  assert.equal(tabGroupOf(unknown, looks), 'other')
  // The bundles' name comes from the kinds open (the company's own words).
  assert.equal(tabGroupName('bundle', [deal, show], looks), '案件・番組')
  assert.equal(tabGroupName('task', [task1], looks), 'やること')
})

test('named groups stand after the pinned tabs and before the rest (by kind or not); a pinned member stands with the pinned', () => {
  const grouping = { groups: [proposal], members: { [b]: 'g1', [task2]: 'g1', [c]: 'g1' } }
  assert.deepEqual(ids(opts([c], grouping), [a, b, task1, task2, c]), [['pinned', [c]], ['group:g1', [b, task2]], ['all', [a, task1]]])
  assert.deepEqual(ids(opts([], { ...grouping, byKind: true }), [a, b, task1, task2]), [['group:g1', [b, task2]], ['file', [a]], ['task', [task1]]])
})

test('a tab moves within its run; never in among the pinned ones; by kind, only among its kind', () => {
  const order = [a, task1, b, task2]
  assert.deepEqual(moveTab(order, b, a, 'before', opts()).order, [b, a, task1, task2])
  assert.deepEqual(moveTab(order, a, task2, 'after', opts()).order, [task1, b, task2, a])
  assert.equal(canMoveTab(b, a, opts([a])), false)
  assert.deepEqual(moveTab(order, b, a, 'before', opts([a])).order, order)
  assert.deepEqual(moveTab([a, b, task1], b, a, 'before', opts([a, b])).order, [b, a, task1])
  assert.equal(canMoveTab(a, task1, opts([], { byKind: true })), false)
  assert.deepEqual(moveTab(order, task2, task1, 'before', opts([], { byKind: true })).order, [a, task2, task1, b])
})

test('dropped beside a tab of a named group, a tab joins it; beside one outside, it leaves its group', () => {
  const grouping = { groups: [proposal], members: { [b]: 'g1' } }
  const joined = moveTab([a, b, task1], task1, b, 'after', opts([], grouping))
  assert.deepEqual(joined.members, { [b]: 'g1', [task1]: 'g1' })
  // By kind, any kind may join a named group.
  assert.equal(canMoveTab(task1, b, opts([], { ...grouping, byKind: true })), true)
  const left = moveTab([a, b, task1], b, a, 'after', opts([], grouping))
  assert.deepEqual(left.members, {})
  // Added from its chip or the menu: at the end of the group.
  assert.deepEqual(addToGroup([b, a, c], c, 'g1', opts([], grouping)), { order: [b, c, a], members: { [b]: 'g1', [c]: 'g1' } })
  assert.deepEqual(addToGroup([b, a], a, 'nope', opts([], grouping)).members, { [b]: 'g1' })
})

test('a group with no open tab left goes, and closed tabs leave their group', () => {
  const grouping: TabGrouping = { ...NO_GROUPING, groups: [proposal, { id: 'g2', name: '別', color: 'blue' }], members: { [a]: 'g1', [b]: 'g2' } }
  assert.deepEqual(pruneGrouping(grouping, [a, c]), { ...grouping, groups: [proposal], members: { [a]: 'g1' } })
})

test('the grouping is kept per company on this Mac, and an unreadable entry reads as nothing', () => {
  const data = new Map<string, string>()
  const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v) }, removeItem: (k: string) => { data.delete(k) } }
  const store = createTabGroupingStore(() => storage)
  store.update('co-a', g => ({ ...g, byKind: true, collapsedKinds: ['task'], groups: [proposal], members: { [a]: 'g1' } }))
  assert.deepEqual(store.get('co-b'), NO_GROUPING)
  // A fresh store (a restart) reads it back.
  assert.deepEqual(createTabGroupingStore(() => storage).get('co-a'), { byKind: true, collapsedKinds: ['task'], groups: [proposal], members: { [a]: 'g1' } })
  assert.deepEqual(parseGrouping({ byKind: 'yes', collapsedKinds: ['task', 'nope'], groups: [{ id: 'x', name: ' ' }, { id: 'y', name: 'Y', color: 'pink' }], members: { [a]: 'x', [b]: 'y' } }),
    { byKind: false, collapsedKinds: ['task'], groups: [{ id: 'y', name: 'Y', color: 'blue' }], members: { [b]: 'y' } })
  data.set('tabGroups:co-d', '{')
  assert.deepEqual(createTabGroupingStore(() => storage).get('co-d'), NO_GROUPING)
  store.update('co-a', () => NO_GROUPING)
  assert.equal(data.has('tabGroups:co-a'), false)
})
