import { test } from 'node:test'
import assert from 'node:assert/strict'
import { coreTypeDefinitions } from '../../../../shared/core/core-types'
import type { LedgerEntry } from '../../../../shared/core/record-ledger'
import type { RecordDetail, RecordSummary } from '../../../../shared/types/records'
import { taskCardOf } from '../../../shared/task-card'
import { actionHint, actionText, doneWords, leavingWords, placeActions, SELF_ASSIGN, WHEN_DONE, whenDoneLine, whenDoneSteps } from './cardActions'

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

test('チームの進め方 off, or a task nobody else is in: no team actions (進めている印); 受けられない and 引き受ける stay on what someone asked', () => {
  const asked = card(task('todo', { assignee: ME, requested_by: BOSS }))
  const on = names(placeActions(asked, true)).more
  assert.ok(on.includes('decline') && on.includes('start'))
  const off = names(placeActions(asked, false)).more
  assert.ok(!off.includes('start'))
  assert.ok(off.includes('decline'))
  assert.equal(placeActions(card(task('awaiting_acceptance', { assignee: ME, requested_by: BOSS })), false).main?.action, 'accept')
  const own = names(placeActions(card(task('todo', { assignee: ME, requested_by: ME })), true)).more
  assert.ok(!own.includes('start'))
})

test('返事待ちにする is always in 「…」 for the assignee (owner decision 2026-11-03): team mode off, one\'s own task too; never the main button', () => {
  for (const team of [false, true]) {
    for (const fields of [{ assignee: ME, requested_by: ME }, { assignee: ME, requested_by: BOSS }, { assignee: ME }] as Array<Record<string, string>>) {
      const p = placeActions(card(task('todo', fields)), team)
      assert.notEqual(p.main?.action, 'wait')
      assert.ok(p.more.some(a => a.action === 'wait'), `wait offered (team ${team}, ${JSON.stringify(fields)})`)
    }
  }
  // Only whom the type allows: the requester of a task someone else holds is not offered it.
  assert.ok(!placeActions(card(task('todo', { assignee: 'u-tanaka', requested_by: ME })), false).more.some(a => a.action === 'wait'))
  // Not where it cannot move: done, or already waiting (「もう少し待つ」 is the band's).
  assert.ok(!placeActions(card(task('done', { assignee: ME, requested_by: ME })), false).more.some(a => a.action === 'wait'))
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
  assert.equal(actionText(p.more.find(a => a.action === 'dismiss')!), '要らない（AI の案を外す）')
  const review = card(task('todo', { assignee: ME, requested_by: ME, task_kind: 'minutes_review' }))
  assert.equal(actionText(placeActions(review, false).main!, { review: { meetingId: 'm', meetingTitle: 'm', summary: null, decisions: [] } }), '確認を終える')
})

test('受けられないと返した: the requester main action is 担当を替える; やり直す（同じ人にもう一度）and アーカイブ are in 「…」, 完了 never first', () => {
  const returned = card(task('declined', { assignee: 'u-tanaka', requested_by: ME }))
  const p = placeActions(returned, false)
  assert.equal(p.main?.action, 'assign')
  const more = Object.fromEntries(p.more.map(a => [a.action, actionText(a, returned)]))
  assert.equal(more.reopen, 'やり直す（同じ人にもう一度）')
  assert.equal(more.cancel, 'アーカイブ')
})

test('「要らない（AI の案を外す）」 only while the task is an AI proposal (owner decision 2026-11-03), though the type allows it from 未着手 too', () => {
  for (const state of ['todo', 'awaiting_acceptance']) {
    for (const fields of [{ assignee: 'u-tanaka', requested_by: ME }, { assignee: ME, requested_by: ME }] as Array<Record<string, string>>) {
      const c = card(task(state, fields))
      assert.ok(c.actions.some(a => a.action === 'dismiss'), `the type offers it (${state})`)
      assert.ok(!placeActions(c, true).more.some(a => a.action === 'dismiss'), `not in 「…」 (${state})`)
    }
  }
  assert.ok(placeActions(card(task('proposed', { assignee: ME, requested_by: ME })), false).more.some(a => a.action === 'dismiss'))
})

test('アーカイブ: the label, its line and window in plain words (normal colour); archived, ［戻す］ is the main button; やり直す stays for a done task', () => {
  const asked = card(task('todo', { assignee: 'u-tanaka', requested_by: ME }))
  const archive = placeActions(asked, false).more.find(a => a.action === 'cancel')!
  assert.equal(actionText(archive, asked), 'アーカイブ')
  assert.equal(actionHint(archive, asked), '一覧から外します。消しません。［戻す］で元に戻せます')
  const words = leavingWords(archive, asked, null)
  assert.deepEqual([words.title, words.what, words.tell, words.done], ['アーカイブしますか？', '一覧から外します。消しません。［戻す］で元に戻せます', '田中さん', 'アーカイブしました'])

  const archived = card(task('cancelled', { assignee: 'u-tanaka', requested_by: ME }))
  assert.equal(archived.record.stateLabel, 'アーカイブ済み')
  const p = placeActions(archived, false)
  assert.equal(p.main?.action, 'reopen')
  assert.equal(actionText(p.main!, archived), '戻す')
  assert.equal(doneWords(p.main!, archived), '一覧に戻しました')

  const done = card(task('done', { assignee: 'u-tanaka', requested_by: ME }))
  const reopen = placeActions(done, false).more.find(a => a.action === 'reopen')!
  assert.equal(actionText(reopen, done), 'やり直す')
})

test('アーカイブ in 経緯: 「〇〇さんがアーカイブしました」 and 「…アーカイブから戻しました」', () => {
  const entries = [
    { version: 5, action: 'cancel', actorId: ME, actorKind: 'human', at: '2026-11-05T02:00:00.000Z', note: 'もう要らない', fromState: 'todo', toState: 'cancelled', changes: [] },
    { version: 6, action: 'reopen', actorId: ME, actorKind: 'human', at: '2026-11-05T03:00:00.000Z', note: '', fromState: 'cancelled', toState: 'in_progress', changes: [] },
  ] as unknown as LedgerEntry[]
  const c = card(task('in_progress', { assignee: 'u-tanaka', requested_by: ME }), [], entries)
  assert.deepEqual(c.history.map(h => h.text), ['佐藤さんがアーカイブから戻しました', '佐藤さんがアーカイブしました（もう要らない）'])
})

test('「終わったら」 is one item instead of 確かめる人を決める and 終わったらを決める; its chooser sets the person and 確かめてから together', () => {
  const c = card(task('todo', { assignee: 'u-tanaka', requested_by: ME, when_done: 'notify' }))
  const more = placeActions(c, false).more.map(a => a.action)
  assert.ok(more.includes(WHEN_DONE))
  assert.ok(!more.includes('set_when_done') && !more.includes('set_reviewer'))
  assert.equal(actionText(placeActions(c, false).more.find(a => a.action === WHEN_DONE)!, c), '終わったら')
  // 〇〇さんに確かめてもらう: the person first, then 確かめてから — both in one press.
  assert.deepEqual(whenDoneSteps(c, 'check', BOSS), [
    { action: 'set_reviewer', args: { reviewer: BOSS } },
    { action: 'set_when_done', args: { when_done: 'check' } },
  ])
  assert.deepEqual(whenDoneSteps(c, 'check', null), [])
  assert.deepEqual(whenDoneSteps(c, 'notify', null), [])
  // Already 確かめてから with 阿部さん: another person only changes the person; 知らせるだけ only 終わったら.
  const checked = card(task('todo', { assignee: 'u-tanaka', requested_by: ME, when_done: 'check', reviewer: BOSS }))
  assert.deepEqual(whenDoneSteps(checked, 'check', ME), [{ action: 'set_reviewer', args: { reviewer: ME } }])
  assert.deepEqual(whenDoneSteps(checked, 'check', BOSS), [])
  assert.deepEqual(whenDoneSteps(checked, 'notify', null), [{ action: 'set_when_done', args: { when_done: 'notify' } }])
  // Not for whom the type does not allow it (the assignee).
  assert.ok(!placeActions(card(task('todo', { assignee: ME, requested_by: BOSS })), false).more.some(a => a.action === WHEN_DONE))
})

test('nobody holds it: 「自分が担当する」 heads the 「…」; with an assignee it is not offered', () => {
  const unassigned = card(task('todo', { requested_by: ME }))
  const p = placeActions(unassigned, false)
  assert.equal(p.more[0]?.action, SELF_ASSIGN)
  assert.equal(actionText(p.more[0], unassigned), '自分が担当する')
  assert.equal(unassigned.self.id, ME)
  assert.ok(!placeActions(card(task('todo', { assignee: 'u-tanaka', requested_by: ME })), false).more.some(a => a.action === SELF_ASSIGN))
})
