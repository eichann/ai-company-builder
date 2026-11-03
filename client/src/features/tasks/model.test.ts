// The list's placing rules (model.ts, tasks-ui.md). Guards: "today" is the company's day, not
// the PC's; a time today that has passed counts as overdue; the far future folds and only the
// member's own turn folds (nothing waiting for others hides); meetings to come sit with today's
// work and meetings over with today's done; the list shows only where the company setting says.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { TaskListItem } from '../../../shared/tasks'
import { bundleListWord, companyNow, companyPathOf, dueText, dueWhen, listEvents, listRows, listSections, listShownFor, filterByTag, linkCandidates } from './model'

// Thursday 2026-11-05 15:45 in Japan (06:45 UTC).
const NOW = companyNow(Date.parse('2026-11-05T06:45:00.000Z'))

function item(id: string, turn: TaskListItem['turn'], due: string | null, tags: string[] = []): TaskListItem {
  return { id, type: 'task', typeLabel: 'タスク', title: id, state: 'todo', stateLabel: '未着手', version: 1, due, tags, turn, waitingFor: null, personal: false, own: true, actingFor: null, bundle: null, finishedAt: null }
}

test('today is the company\'s day: 00:30 in Tokyo is already the next day there', () => {
  const n = companyNow(Date.parse('2026-11-04T15:30:00.000Z'))
  assert.equal(n.date, '2026-11-05')
  assert.equal(n.weekday, 4)
})

test('a due reads from today: a passed time today is overdue, the week ends on Sunday', () => {
  assert.equal(dueWhen('2026-11-05T15:00', NOW), 'overdue')
  assert.equal(dueWhen('2026-11-05T17:00', NOW), 'today')
  assert.equal(dueWhen('2026-11-05', NOW), 'today')
  assert.equal(dueWhen('2026-11-04', NOW), 'overdue')
  assert.equal(dueWhen('2026-11-08', NOW), 'week')
  assert.equal(dueWhen('2026-11-09', NOW), 'later')
  // On a Sunday, tomorrow is not the far future.
  assert.equal(dueWhen('2026-11-02', companyNow(Date.parse('2026-11-01T03:00:00.000Z'))), 'week')
  assert.equal(dueText('2026-11-06T09:00', NOW), '明日 09:00')
  assert.equal(dueText('2026-11-10', NOW), '11/10（火）')
  assert.equal(dueText('2027-01-15', NOW), '2027/1/15（金）')
})

test('by turn: only the member\'s own far future folds; meetings to come join their turn, meetings over join today\'s done', () => {
  const events = listEvents([
    { id: 'e1', title: '定例', start: '2026-11-05T01:00:00.000Z', end: '2026-11-05T01:30:00.000Z', allDay: false, online: false, attendeeCount: 4, hasExternalAttendees: false },
    { id: 'e2', title: 'B社', start: '2026-11-05T08:00:00.000Z', end: '2026-11-05T08:30:00.000Z', allDay: false, online: true, attendeeCount: 3, hasExternalAttendees: true },
  ], NOW)
  const sections = listSections([
    item('soon', 'mine', '2026-11-06'), item('far', 'mine', '2026-12-10'), item('far-other', 'others', '2026-12-10'),
    item('acc', 'acceptance', null), item('done', 'done', null),
  ], events, 'turn', NOW)
  const by = Object.fromEntries(sections.map(s => [s.key, s]))
  assert.deepEqual(sections.map(s => s.key), ['acceptance', 'mine', 'others', 'later', 'done'])
  assert.deepEqual(by.mine.items.map(i => i.id), ['soon'])
  assert.deepEqual(by.mine.events.map(e => e.event.id), ['e2'])
  assert.equal(by.mine.events[0].start, '17:00')
  assert.deepEqual(by.later.items.map(i => i.id), ['far'])
  assert.equal(by.later.foldable, true)
  assert.deepEqual(by.others.items.map(i => i.id), ['far-other'])
  assert.deepEqual(by.done.events.map(e => e.event.id), ['e1'])
})

test('by date: overdue, today, tomorrow, this week, later (folded), no due — whoever holds it', () => {
  const sections = listSections([
    item('late', 'others', '2026-11-03'), item('today', 'mine', '2026-11-05T18:00'), item('tomorrow', 'mine', '2026-11-06T09:00'),
    item('week', 'ai', '2026-11-07'), item('later', 'mine', '2026-11-20'), item('none', 'mine', null),
  ], [], 'date', NOW)
  assert.deepEqual(sections.map(s => [s.key, s.items.map(i => i.id)]), [
    ['overdue', ['late']], ['today', ['today']], ['tomorrow', ['tomorrow']], ['week', ['week']], ['later', ['later']], ['none', ['none']],
  ])
  assert.equal(sections.find(s => s.key === 'later')?.foldable, true)
})

test('by bundle: each one with its open items, then the ones in none; the word is the kinds in the list', () => {
  const deal = { id: 'deal-a00001', title: 'A社 研修導入', typeLabel: '案件' }
  const proj = { id: 'project-b00001', title: '新サービス', typeLabel: 'プロジェクト' }
  const items = [
    { ...item('a2', 'others', '2026-11-09'), bundle: deal }, { ...item('a1', 'mine', '2026-11-06'), bundle: deal },
    { ...item('p1', 'mine', null), bundle: proj }, item('loose', 'mine', null), { ...item('fin', 'done', null), bundle: deal },
  ]
  const sections = listSections(items, [], 'bundle', NOW)
  assert.deepEqual(sections.map(s => [s.title, s.items.map(i => i.id)]), [
    ['A社 研修導入', ['a1', 'a2']], ['新サービス', ['p1']], ['案件・プロジェクトなし', ['loose']], ['今日終わったこと', ['fin']],
  ])
  assert.equal(sections[0].bundle?.id, 'deal-a00001')
  assert.equal(bundleListWord([{ ...item('x', 'mine', null), bundle: deal }]), '案件')
  assert.equal(bundleListWord([item('x', 'mine', null)]), 'プロジェクト')
  // Nothing in the list belongs to one: the department on screen's kind names it (営業部 → 案件).
  assert.equal(bundleListWord([item('x', 'mine', null)], '案件'), '案件')
  assert.equal(listSections([item('loose', 'mine', null)], [], 'bundle', NOW, '案件')[0].title, '案件なし')
})

test('a tag keeps only items carrying it', () => {
  assert.deepEqual(filterByTag([item('a', 'mine', null, ['営業']), item('b', 'mine', null, ['経理'])], '営業').map(i => i.id), ['a'])
})

test('the list shows only for the departments the company setting names (null = all; 全社 when any shows it)', () => {
  assert.equal(listShownFor('d1', null), true)
  assert.equal(listShownFor('d1', ['d2']), false)
  assert.equal(listShownFor('d2', ['d2']), true)
  assert.equal(listShownFor(null, []), false)
  assert.equal(listShownFor(null, ['d2']), true)
})

test('a dragged path is named inside the company folder; one outside it (or the folder itself) is not linked', () => {
  assert.equal(companyPathOf('/Users/me/会社/営業/見積.xlsx', '/Users/me/会社'), '営業/見積.xlsx')
  assert.equal(companyPathOf('/Users/me/会社/営業/見積.xlsx', '/Users/me/会社/'), '営業/見積.xlsx')
  assert.equal(companyPathOf('/Users/me/会社2/x.md', '/Users/me/会社'), null)
  assert.equal(companyPathOf('/Users/me/会社', '/Users/me/会社'), null)
})

test('meetings asking for their まとまり in one group become one row where the first stands; a lone one stays a row', () => {
  const base = { type: 'meeting', typeLabel: '会議', state: 'read', stateLabel: null, version: 1, due: null, tags: [], turn: 'mine' as const, waitingFor: null, personal: false, own: false, actingFor: null, bundle: null, finishedAt: null }
  const q = (id: string, key: string): TaskListItem => ({ ...base, id, title: id, needsBundle: true, bundleGroup: { key, label: `相手${key}` } })
  const task: TaskListItem = { ...base, id: 't1', type: 'task', title: 't1' }
  const rows = listRows([q('m1', 'a'), task, q('m2', 'b'), q('m3', 'a'), q('m4', 'a')])
  assert.deepEqual(rows.map(r => r.kind === 'item' ? r.item.id : `${r.label}:${r.items.map(i => i.id).join(',')}`), ['相手a:m1,m3,m4', 't1', 'm2'])
  // An item with a group key but no question (never happens from the server) is not swallowed.
  const odd: TaskListItem = { ...task, id: 't2', bundleGroup: { key: 'a', label: 'x' } }
  assert.equal(listRows([odd, q('m5', 'a')]).length, 2)
})

// 「＋ファイル・フォルダをつなぐ」: a folder must be linkable without dragging (owner decision 2026-11-03).
test('the link chooser offers every folder above the files once, then the files', () => {
  assert.deepEqual(linkCandidates(['営業部/見積/A社.md', '営業部/見積/B社.md', 'メモ.md']), [
    { path: '営業部', folder: true }, { path: '営業部/見積', folder: true },
    { path: '営業部/見積/A社.md', folder: false }, { path: '営業部/見積/B社.md', folder: false }, { path: 'メモ.md', folder: false },
  ])
})
