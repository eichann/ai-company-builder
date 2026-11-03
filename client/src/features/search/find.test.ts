// The left 探す tab's rules (find.ts). Guards: one row per thing (a file with many matching lines is
// one row, its best sentence shown); a consultation is found through its one linked record (its
// やること, never that やること's 案件) and folded under the right rows; summary cards for the hubs only, then names, then contents;
// the scope keeps things of no department and drops other departments (counted as elsewhere);
// period and 「自分が関わった」 narrow; chips only for kinds found, bundles named per kind.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { FindHitView, RecordViewSummary } from '../../../shared/record-views'
import type { RecordFindHub } from '../../../../shared/types/records'
import type { ConsultationTopic } from '../../../shared/consultation-topics'
import {
  bestSentence, chipsOf, classify, consultationsOf, foundCount, foundThings, lineOf, passes, whereOf, withTopics,
  type FindFilters, type FindInputs, type FoundThing,
} from './find'

const TODAY = '2026-11-03'
const rec = (id: string, thing: RecordViewSummary['thing'], title: string, extra: Partial<RecordViewSummary> = {}): RecordViewSummary =>
  ({ id, type: id.split('-')[0], typeLabel: thing === 'bundle' ? '案件' : 'やること', kind: 'other', title, summary: '', stateLabel: null, updatedAt: '2026-11-02T03:00:00.000Z', thing, ...extra })
const hit = (r: RecordViewSummary, department: string | null, more: Partial<FindHitView> = {}): FindHitView => ({ record: r, department, mine: false, ...more })
const hub = (id: string): RecordFindHub => ({ id, counts: { bundles: 0, openTasks: 2, meetings: 1, decisions: 0, files: 3 }, nextMeetingAt: null, lastMovedAt: '', memberIds: ['task-inside'] })
const all: FindFilters = { scope: null, period: 'all', mineOnly: false, today: TODAY }

function inputs(over: Partial<FindInputs> = {}): FindInputs {
  return { query: 'サンプル', hits: [], hubs: [], files: [], lines: [], fileTimes: {}, consultations: [], ...over }
}

test('a file with many matching lines is one row, shown by its best sentence', () => {
  const lines = [
    { file: '営業部/顧客/見積.md', line: 3, text: '株式会社サンプル様へのご提案。' },
    { file: '営業部/顧客/見積.md', line: 9, text: 'サンプルの予算はサンプル価格で。' },
    { file: '営業部/メモ.md', line: 1, text: 'サンプル' },
  ]
  const things = foundThings(inputs({ lines, files: ['営業部/顧客/見積.md', '営業部/サンプル一覧.md'] }))
  const files = things.filter(t => t.kind === 'file')
  assert.deepEqual(files.map(f => f.path).sort(), ['営業部/サンプル一覧.md', '営業部/メモ.md', '営業部/顧客/見積.md'])
  const quote = files.find(f => f.path === '営業部/顧客/見積.md')!
  assert.equal(lineOf(quote, 'サンプル'), 9)
  assert.equal(bestSentence('予算は300万円。サンプルです。\n## サンプル', 'サンプル'), 'サンプル')
  // Found by name only: where it lives instead of a sentence.
  assert.equal(whereOf(files.find(f => f.path === '営業部/サンプル一覧.md')!), 'フォルダの直下')
  assert.equal(whereOf(quote), '顧客')
  const found = classify(things, [], 'サンプル', all)
  assert.deepEqual(found.byName.map(t => t.path), ['営業部/サンプル一覧.md'])
  assert.equal(found.byContent.length, 2)
})

test('a consultation is found by its title, or through its own やること — its 案件 only when it has none', () => {
  const deal = { id: 'deal-a', title: '株式会社サンプル 研修導入', thing: 'bundle' as const, typeLabel: '案件', kindName: '案件' }
  const task = { id: 'task-a', title: '見積書を直す', thing: 'task' as const, typeLabel: null, kindName: 'やること' }
  const topics = new Map<string, ConsultationTopic | null>([
    ['task-a', { own: task, bundle: deal }], ['deal-a', { own: null, bundle: deal }], ['task-secret', null],
  ])
  const consultations = withTopics([
    { id: 'c-title', title: 'サンプルの見積を考える', updatedAt: '2026-11-03T00:00:00Z' },
    { id: 'c-task', title: '相談', updatedAt: '2026-11-02T00:00:00Z', topicRecordId: 'task-a' },
    { id: 'c-deal', title: '相談', updatedAt: '2026-11-01T00:00:00Z', topicRecordId: 'deal-a' },
    { id: 'c-secret', title: '相談', updatedAt: '2026-11-01T00:00:00Z', topicRecordId: 'task-secret' },
  ], topics)
  // 「サンプル」 is in the 案件's name only: the consultation about its やること is not found through the 案件.
  const things = foundThings(inputs({ consultations }))
  assert.deepEqual(things.map(t => t.sessionId), ['c-title', 'c-deal'])
  assert.equal(things.find(t => t.sessionId === 'c-deal')!.why, '案件『株式会社サンプル 研修導入』の相談')
  // Words in the やること's name: found through it, with why; a record the member cannot read finds nothing.
  const byTask = foundThings(inputs({ query: '見積書', consultations }))
  assert.deepEqual(byTask.map(t => [t.sessionId, t.why]), [['c-task', 'やること『見積書を直す』の相談']])
  assert.deepEqual(foundThings(inputs({ query: '秘密', consultations })), [])
  // Found through the record: listed by name, not by content.
  assert.ok(classify(byTask, [], '見積書', all).byName.some(t => t.sessionId === 'c-task'))
  // Folded under rows: a やること's own; a 案件's every one in it; a 相手's those in its 案件.
  const row = (recordId: string, kind: FoundThing['kind']): FoundThing => ({ key: recordId, kind, title: '', department: null, at: '', mine: false, recordId })
  assert.deepEqual(consultationsOf(row('task-a', 'task'), consultations).map(c => c.id), ['c-task'])
  assert.deepEqual(consultationsOf(row('deal-a', 'bundle'), consultations).map(c => c.id), ['c-task', 'c-deal'])
  assert.deepEqual(consultationsOf(row('company-a', 'counterpart'), consultations, { ...hub('company-a'), memberIds: ['deal-a'] }).map(c => c.id), ['c-task', 'c-deal'])
})

test('summary cards only for the hubs the server summarised, then names, then contents', () => {
  const deal = rec('deal-a', 'bundle', 'サンプル 研修導入')
  const other = rec('deal-b', 'bundle', '別の案件', { summary: '相手はサンプル社' })
  const task = rec('task-a', 'task', 'サンプルに電話')
  const things = foundThings(inputs({ hits: [hit(deal, '営業部'), hit(other, '営業部'), hit(task, '営業部')] }))
  const found = classify(things, [hub('deal-a')], 'サンプル', all)
  assert.deepEqual(found.cards.map(t => t.recordId), ['deal-a'])
  assert.deepEqual(found.byName.map(t => t.recordId), ['task-a'])
  assert.deepEqual(found.byContent.map(t => t.recordId), ['deal-b'])
})

test('the scope keeps things of no department, drops other departments; period and 自分 narrow', () => {
  const t = (key: string, department: string | null, at: string, mine = false): FoundThing => ({ key, kind: 'task', title: 'サンプル', department, at, mine })
  const sales = { ...all, scope: '営業部' }
  assert.equal(passes(t('a', '営業部', ''), sales), true)
  assert.equal(passes(t('b', null, ''), sales), true)
  assert.equal(passes(t('c', '開発部', ''), sales), false)
  assert.equal(passes(t('c', '開発部', ''), all), true)
  // 1週間 = today and the six days before; a thing with no known time is kept.
  assert.equal(passes(t('d', null, '2026-10-28T03:00:00'), { ...all, period: 'week' }), true)
  assert.equal(passes(t('e', null, '2026-10-27T03:00:00'), { ...all, period: 'week' }), false)
  assert.equal(passes(t('e', null, '2026-10-27T03:00:00'), { ...all, period: 'month' }), true)
  assert.equal(passes(t('f', null, ''), { ...all, period: 'week' }), true)
  assert.equal(passes(t('g', null, '', false), { ...all, mineOnly: true }), false)
  assert.equal(passes(t('h', null, '', true), { ...all, mineOnly: true }), true)
  // What another department holds is counted, not shown.
  const things = [t('a', '営業部', ''), t('c', '開発部', ''), t('x', '総務', '')]
  assert.equal(foundCount(classify(things, [], 'サンプル', all)) - foundCount(classify(things, [], 'サンプル', sales)), 2)
})

test('chips only for kinds found; bundles of different kinds get their own names', () => {
  const things = foundThings(inputs({
    hits: [hit(rec('deal-a', 'bundle', 'サンプル案件'), null), hit(rec('project-a', 'bundle', 'サンプル計画', { typeLabel: 'プロジェクト' }), null), hit(rec('task-a', 'minutes_check', 'サンプル議事録', { typeLabel: '議事録を確認する' }), null)],
    bundleKinds: { core: { type: 'project', name: '取り組み', source: 'core' }, departments: [], kinds: [{ type: 'deal', name: '案件', source: 'plugin' }, { type: 'project', name: '取り組み', source: 'core' }] },
  }))
  const chips = chipsOf(classify(things, [], 'サンプル', all))
  assert.deepEqual(chips[0], { key: 'task', label: 'やること', count: 1 })
  assert.deepEqual(chips.slice(1).map(c => c.label).sort(), ['取り組み', '案件'].sort())
  assert.equal(chips.length, 3)
  assert.ok(!chips.some(c => c.label.includes('まとまり')))
})
