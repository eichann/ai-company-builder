import { test } from 'node:test'
import assert from 'node:assert/strict'
import { coreTypeDefinitions } from '../../../../shared/core/core-types'
import type { LedgerEntry } from '../../../../shared/core/record-ledger'
import type { RecordDetail, RecordSummary } from '../../../../shared/types/records'
import { taskCardOf } from '../../../shared/task-card'
import { actionText, placeActions, whenDoneLine } from './cardActions'

const defs = new Map(coreTypeDefinitions().map(d => [d.name, d]))
const ME = 'u-sato'
const BOSS = 'u-abe'
const people = { [ME]: '佐藤', [BOSS]: '阿部', 'u-tanaka': '田中' }
const task = (state: string, fields: Record<string, string>): RecordSummary =>
  ({ id: 'task-0000aa', type: 'task', typeVersion: 8, title: '見積書', summary: '', path: null, state, fields, version: 4, updatedAt: '2026-11-05T01:00:00.000Z' })
const card = (record: RecordSummary, links: RecordDetail['links'] = [], entries: LedgerEntry[] = []) =>
  taskCardOf({ me: ME, detail: { record, links }, def: defs.get('task'), defs, entries, people, runs: [] })
const names = (p: ReturnType<typeof placeActions>) => ({ main: p.main?.action ?? null, status: p.status, more: p.more.map(a => a.action) })

test('one main action by where the task stands: 自分で進める, 引き受ける, then 完了', () => {
  assert.equal(placeActions(card(task('preparing', { assignee: ME, requested_by: BOSS })), true).main?.action, 'take_over')
  assert.equal(placeActions(card(task('awaiting_acceptance', { assignee: ME, requested_by: BOSS })), true).main?.action, 'accept')
  assert.equal(placeActions(card(task('in_progress', { assignee: 'u-tanaka', requested_by: ME })), true).main?.action, 'complete')
})

test('確かめてから: the assignee\'s main action is 「終わったので見てもらう」, even with チームの進め方 off', () => {
  const c = card(task('in_progress', { assignee: ME, requested_by: BOSS, when_done: 'check', reviewer: BOSS }))
  assert.equal(placeActions(c, false).main?.action, 'request_review')
  assert.equal(whenDoneLine(c), '終わったら：阿部さんに確かめてもらう（阿部さんの OK で完了）')
})

test('チームの進め方 off, or a task nobody else is in: no team actions (返事待ち・進めている印); 受けられない and 引き受ける stay on what someone asked', () => {
  const asked = card(task('todo', { assignee: ME, requested_by: BOSS }))
  const on = names(placeActions(asked, true)).more
  assert.ok(on.includes('wait') && on.includes('decline') && on.includes('start'))
  const off = names(placeActions(asked, false)).more
  assert.ok(!off.includes('wait') && !off.includes('start'))
  assert.ok(off.includes('decline'))
  assert.equal(placeActions(card(task('awaiting_acceptance', { assignee: ME, requested_by: BOSS })), false).main?.action, 'accept')
  const own = names(placeActions(card(task('todo', { assignee: ME, requested_by: ME })), true)).more
  assert.ok(!own.includes('wait') && !own.includes('start'))
})

test('while someone else checks it, the card says so instead of a button; 延ばす is never in 「…」', () => {
  const p = placeActions(card(task('review', { assignee: ME, requested_by: BOSS, reviewer: 'u-tanaka' })), true)
  assert.equal(p.main, null)
  assert.equal(p.status, '田中さんが確かめています')
  assert.ok(!p.more.some(a => a.action === 'set_due'))
})

test('where it came from: the meeting, made by the AI, with the words it rests on; the 案件 goes to the head', () => {
  const meeting: RecordSummary = { ...task('read', { meeting_at: '2026-11-05T14:30' }), id: 'meeting-01', type: 'meeting', title: 'A社 打ち合わせ' }
  const deal: RecordSummary = { ...task('open', {}), id: 'deal-01', type: 'deal', title: 'A社 研修導入' }
  const created = { version: 1, action: 'create', actorId: 'ai-1', actorKind: 'ai', note: '「見積は来週までに」（鈴木様）', at: '2026-11-05T06:00:00Z', changes: [] } as unknown as LedgerEntry
  const c = card(task('todo', { assignee: ME, requested_by: BOSS }), [{ name: 'meeting', direction: 'out', record: meeting }, { name: 'bundle', direction: 'out', record: deal }], [created])
  assert.deepEqual(c.origin && { kind: c.origin.kind, title: c.origin.title, byAi: c.origin.byAi, basis: c.origin.basis, at: c.origin.at },
    { kind: 'meeting', title: 'A社 打ち合わせ', byAi: true, basis: '「見積は来週までに」（鈴木様）', at: '2026-11-05T14:30' })
  assert.equal(c.bundle?.id, 'deal-01')
  assert.ok(!c.links.some(l => l.record?.id === 'deal-01'))
})

test('an AI proposal opened on its own: 「足す」 is the main action, 「要らない（AI の案を外す）」 in 「…」; 「議事録を確認する」 finishes with 確認を終える', () => {
  const proposal = card(task('proposed', { assignee: ME, requested_by: ME }))
  const p = placeActions(proposal, false)
  assert.equal(p.main?.action, 'adopt')
  assert.ok(p.more.some(a => a.action === 'dismiss'))
  const aiMade = placeActions(card(task('todo', { assignee: 'u-tanaka', requested_by: ME })), false)
  assert.equal(actionText(aiMade.more.find(a => a.action === 'dismiss')!), '要らない（AI の案を外す）')
  const review = card(task('todo', { assignee: ME, requested_by: ME, task_kind: 'minutes_review' }))
  assert.equal(actionText(placeActions(review, false).main!, { review: { meetingId: 'm', meetingTitle: 'm', summary: null, decisions: [] } }), '確認を終える')
})
