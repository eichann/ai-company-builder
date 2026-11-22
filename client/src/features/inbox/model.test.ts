import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { NotificationItem } from '../../../../shared/types/notifications'
import type { MeetingTurn, NoticesState, TurnItem } from '../../../shared/notifications-app'
import type { BrowserInboxPlans } from '../../../shared/browser-plans'
import { bulkSeenIds, countText, hasInboxNews, INBOX_MAX_ROWS, inboxNewsBaseline, inboxNewsKeys, inboxView, seenWhileShown, type InboxAction } from './model'

// Type-level guard (`pnpm typecheck`): no row action may approve, send, run or confirm (a browser plan's ［任せる］ and
// ［済んでいた］ are its card's); such a kind fails to compile here.
type ActsOutside = Extract<InboxAction['kind'], `${string}${'approve' | 'Approve' | 'send' | 'Send' | 'run' | 'Run' | 'confirm' | 'Confirm'}${string}`>
const noRowActsOutside: [ActsOutside] extends [never] ? true : false = true
void noRowActsOutside

const NOW = new Date('2026-11-22T10:00:00+09:00')
const turn = (id: string, type: string, state: string | null, due: string | null = null, extra: Partial<TurnItem> = {}): TurnItem => ({ id, type, title: id, state, due, ...extra })
let n = 0
const notice = (kind: NotificationItem['kind'], recordId: string, createdAt: string, read = false, extra: Partial<NotificationItem> = {}): NotificationItem => ({
  id: `n${++n}`, kind, recordId, recordType: recordId.split('-')[0] ?? '', recordTitle: recordId ? `「${recordId}」` : '', version: 3,
  text: `${kind} の知らせ`, createdAt, read, ...extra,
})
const state = (items: TurnItem[], notices: NotificationItem[], total = items.length, resting?: number): NoticesState => ({
  available: true,
  myTurn: { total, items, ...(resting ? { resting } : {}) },
  notices: { available: true, unread: notices.filter(x => !x.read).length, items: notices },
})

test('あなた待ち comes in order of what it needs: stopped, approvals, mail, checks, the rest; then by due', () => {
  const v = inboxView(state([
    turn('task-plain', 'task', 'todo', '2026-11-20'),
    turn('task-check', 'task', 'review'),
    turn('outbound_message-a', 'outbound_message', 'draft'),
    turn('approval-late', 'approval', 'pending', '2026-11-30'),
    turn('approval-soon', 'approval', 'pending', '2026-11-23'),
    turn('task-nodue', 'task', 'todo'),
  ], [notice('job_failed', '', '2026-11-22T00:00:00Z')]), NOW)
  assert.deepEqual(v.waiting.map(i => i.key), [
    `notice:${v.waiting[0].key.slice(7)}`, 'record:approval-soon', 'record:approval-late', 'record:outbound_message-a', 'record:task-check', 'record:task-plain', 'record:task-nodue',
  ])
  assert.equal(v.waiting[0].badge.tone, 'failed')
  assert.equal(v.counts.waiting, 7)
})

test('an approval and a mail draft only ever open their card: no row action approves or sends', () => {
  const v = inboxView(state([turn('approval-1', 'approval', 'pending'), turn('outbound_message-1', 'outbound_message', 'draft')],
    [notice('approval_result', 'approval-2', '2026-11-22T00:00:00Z')]), NOW)
  assert.deepEqual(v.waiting.map(i => i.action), [{ kind: 'openApprovalCard', approvalId: 'approval-1' }, { kind: 'openMailDraft', messageId: 'outbound_message-1' }])
  assert.deepEqual(v.done[0].action, { kind: 'openApprovalCard', approvalId: 'approval-2' })
  assert.equal(v.waiting[0].actionLabel, '承認する…')
  for (const i of [...v.waiting, ...v.done]) assert.doesNotMatch(i.action.kind, /approve|send/i)
})

test('one record is one row: its unread notices become its line and are what opening marks seen', () => {
  const older = notice('asked', 'task-a', '2026-11-21T00:00:00Z')
  const newer = notice('wait_over', 'task-a', '2026-11-22T00:00:00Z')
  const read = notice('due_tomorrow', 'task-a', '2026-11-20T00:00:00Z', true)
  const v = inboxView(state([turn('task-a', 'task', 'todo')], [older, newer, read]), NOW)
  assert.equal(v.waiting.length, 1)
  assert.equal(v.done.length, 0)
  assert.equal(v.waiting[0].line, newer.text)
  assert.deepEqual(v.waiting[0].unreadNoticeIds.sort(), [older.id, newer.id].sort())
})

test('a stop notice waits while unread and is gone once opened; a done notice moves to today\'s seen', () => {
  const stop = notice('job_paused', '', '2026-11-22T00:00:00Z')
  const done = notice('request_done', 'task-b', '2026-11-22T00:30:00Z')
  const before = inboxView(state([], [stop, done]), NOW)
  assert.deepEqual(before.waiting.map(i => i.key), [`notice:${stop.id}`])
  assert.deepEqual(before.done.map(i => i.key), [`notice:${done.id}`])
  const after = inboxView(state([], [{ ...stop, read: true }, { ...done, read: true }]), NOW)
  assert.equal(after.waiting.length, 0)
  assert.equal(after.done.length, 0)
  // Both stay findable, folded in 「きょう確認したもの」 (the bell listed read ones too), counted nowhere.
  assert.deepEqual(after.seenToday.map(i => i.key), [`notice:${stop.id}`, `notice:${done.id}`].reverse())
  assert.equal(after.counts.all, 0)
  // The morning summary is no row (it only counts what あなた待ち shows).
  assert.equal(inboxView(state([], [notice('morning_summary', '', '2026-11-22T00:00:00Z')]), NOW).counts.all, 0)
})

test('「期限が変わりました」 and other news are できた・未確認; a change that can be undone keeps ［元に戻す］', () => {
  const due = notice('due_changed', 'task-c', '2026-11-22T00:00:00Z')
  const replied = notice('replied_done', 'task-d', '2026-11-22T01:00:00Z')
  const v = inboxView(state([], [due, replied]), NOW)
  assert.deepEqual(v.done.map(i => [i.key, i.badge.word, !!i.undo]), [[`notice:${replied.id}`, '完了にしました', true], [`notice:${due.id}`, '変わりました', false]])
})

test('できた・未確認 older than 14 days folds into one line, counted', () => {
  const recent = notice('request_done', 'task-e', '2026-11-09T02:00:00Z')
  const old = notice('request_done', 'task-f', '2026-11-07T00:00:00Z')
  const v = inboxView(state([], [recent, old]), NOW)
  assert.deepEqual(v.done.map(i => i.key), [`notice:${recent.id}`])
  assert.deepEqual(v.olderDone, { count: 1, noticeIds: [old.id] })
  assert.equal(v.counts.done, 2)
})

test('「まとめて確認済みにする」 marks only できた・未確認, never a notice of あなた待ち', () => {
  const stop = notice('ai_turn_stuck', 'task-x', '2026-11-22T00:00:00Z')
  const rowNews = notice('asked', 'task-g', '2026-11-22T00:00:00Z')
  const done = notice('request_done', 'task-h', '2026-11-22T00:00:00Z')
  const old = notice('ok_completed', 'task-i', '2026-10-01T00:00:00Z')
  const v = inboxView(state([turn('task-g', 'task', 'todo')], [stop, rowNews, done, old]), NOW)
  assert.deepEqual(bulkSeenIds(v, 'done').sort(), [done.id, old.id].sort())
  assert.deepEqual(bulkSeenIds(v, 'older'), [old.id])
})

test('あなた待ち is never folded or capped: the list keeps every one and drops the oldest できた first', () => {
  const items = Array.from({ length: INBOX_MAX_ROWS + 5 }, (_, i) => turn(`task-${i}`, 'task', 'todo'))
  const done = [notice('request_done', 'task-z', '2026-11-22T00:00:00Z')]
  const v = inboxView(state(items, done, items.length + 7, 2), NOW)
  assert.equal(v.waiting.length, INBOX_MAX_ROWS + 5)
  assert.equal(v.waitingNotListed, 7)
  assert.equal(v.counts.waiting, INBOX_MAX_ROWS + 12)
  assert.equal(v.done.length, 0)
  assert.equal(v.doneLeftOut, 1)
  assert.equal(v.resting, 2)
  // A できた left out of the list is still counted and still marked by 「まとめて確認済みにする」.
  assert.equal(v.counts.done, 1)
  assert.deepEqual(bulkSeenIds(v, 'done'), [done[0].id])
})

test('records off with no notices of the company: nothing (no panel); records off with its own notices: those only', () => {
  const off = inboxView({ available: false, myTurn: { total: 3, items: [turn('task-a', 'task', 'todo')] }, notices: { available: false, unread: 0, items: [] } }, NOW)
  assert.equal(off.counts.all, 0)
  const bellOnly = inboxView({ available: true, bellOnly: true, myTurn: { total: 0, items: [] }, notices: { available: false, unread: 1, items: [notice('company_restored', '', '2026-11-22T00:00:00Z')] } }, NOW)
  assert.equal(bellOnly.waiting.length, 1)
  assert.equal(bellOnly.waiting[0].action.kind, 'none')
})

test('counts stop at 99+', () => {
  assert.equal(countText(99), '99')
  assert.equal(countText(100), '99+')
})

test('a notice that asks for something waits even when its record is not in the listed turn, and the bulk never clears it', () => {
  const kinds = ['asked', 'overdue', 'acceptance_waiting', 'request_returned', 'intake_unsure', 'wait_over', 'reply_arrived', 'job_accept_needed'] as const
  const asks = kinds.map(k => notice(k, k === 'job_accept_needed' ? '' : `task-${k}`, '2026-11-22T00:00:00Z'))
  // A kind this app does not know yet (a newer server) waits too: the safe side.
  const unknown = notice('brand_new_kind' as never, 'task-new', '2026-11-22T00:00:00Z')
  const finished = notice('request_done', 'task-fin', '2026-11-22T00:00:00Z')
  const v = inboxView(state([], [...asks, unknown, finished]), NOW)
  assert.deepEqual(v.waiting.map(i => i.key).sort(), [...asks, unknown].map(x => `notice:${x.id}`).sort())
  assert.deepEqual(bulkSeenIds(v, 'done'), [finished.id])
  // Gone once opened, like a stop.
  const read = inboxView(state([], asks.map(a => ({ ...a, read: true }))), NOW)
  assert.equal(read.waiting.length + read.done.length, 0)
  assert.equal(read.counts.all, 0)
})

test('with the turn past the server\'s first 200, news about a record may be about a waiting one: it waits', () => {
  const due = notice('due_changed', 'task-unlisted', '2026-11-22T00:00:00Z')
  const fin = notice('request_done', 'task-other', '2026-11-22T00:00:00Z')
  const v = inboxView(state([turn('task-a', 'task', 'todo')], [due, fin], 250), NOW)
  assert.ok(v.waiting.some(i => i.key === `notice:${due.id}`))
  assert.deepEqual(bulkSeenIds(v, 'done'), [fin.id])
  const complete = inboxView(state([turn('task-a', 'task', 'todo')], [due, fin]), NOW)
  assert.deepEqual(bulkSeenIds(complete, 'done').sort(), [due.id, fin.id].sort())
})

test('stops look by what they mean for the member: a failure red, one to pick up amber, one skipped on purpose grey and not waiting', () => {
  const failed = notice('job_failed', '', '2026-11-22T00:00:00Z')
  const paused = notice('job_paused', '', '2026-11-22T00:00:00Z')
  const stuck = notice('ai_turn_stuck', 'task-s', '2026-11-22T00:00:00Z')
  const expired = notice('job_expired', '', '2026-11-22T00:00:00Z')
  const skipped = notice('job_skipped', '', '2026-11-22T00:00:00Z')
  const v = inboxView(state([], [failed, paused, stuck, expired, skipped]), NOW)
  const badge = (id: string) => [...v.waiting, ...v.done].find(i => i.key === `notice:${id}`)!.badge
  assert.deepEqual(badge(failed.id), { tone: 'failed', word: '止まりました' })
  for (const id of [paused.id, stuck.id, expired.id]) assert.deepEqual(badge(id), { tone: 'needsAction', word: '止まっています' })
  assert.deepEqual(badge(skipped.id), { tone: 'stoppedOnPurpose', word: '止めています' })
  assert.ok(v.done.some(i => i.key === `notice:${skipped.id}`))
  assert.ok(!v.waiting.some(i => i.key === `notice:${skipped.id}`))
})

test('a stop about a record already waiting makes that row a stop: its badge and first place', () => {
  const stuck = notice('ai_turn_stuck', 'task-b', '2026-11-22T00:00:00Z')
  const v = inboxView(state([turn('approval-a', 'approval', 'pending'), turn('task-b', 'task', 'todo')], [stuck]), NOW)
  assert.equal(v.waiting.length, 2)
  assert.equal(v.waiting[0].key, 'record:task-b')
  assert.deepEqual(v.waiting[0].badge, { tone: 'needsAction', word: '止まっています' })
  assert.deepEqual(v.waiting[0].unreadNoticeIds, [stuck.id])
})

// I2: what the title bar's 「あなたの番」 and bell carried for a department without the task list.
const meeting = (id: string, needsPerson: boolean, ai: MeetingTurn['ai'] = null, kind: MeetingTurn['kind'] = 'minutes'): MeetingTurn =>
  ({ id, title: id, kind, text: `${id} の様子`, needsPerson, ai })

test('a meeting waiting for the member is あなた待ち and counted (the old 「あなたの番 N」); one the AI reads is 作業中, not counted', () => {
  const v = inboxView(state([turn('task-a', 'task', 'todo')], []), NOW, [
    meeting('meeting-choose', true, null, 'bundle'),
    meeting('meeting-failed', true, { recordId: 'meeting-failed', state: 'failed', reason: '議事録が空でした', canRetry: true, canHand: true }),
    meeting('meeting-reading', false, { recordId: 'meeting-reading', state: 'running', reason: '', canRetry: false, canHand: false }),
  ])
  assert.deepEqual(v.waiting.map(i => i.key), ['record:meeting-failed', 'record:meeting-choose', 'record:task-a'])
  assert.equal(v.waiting[0].badge.tone, 'failed')
  assert.equal(v.waiting[1].meetingId, 'meeting-choose')
  assert.deepEqual(v.working.map(i => i.key), ['record:meeting-reading'])
  assert.equal(v.counts.waiting, 3)
  assert.equal(v.counts.working, 1)
  assert.deepEqual(v.waiting[1].action, { kind: 'openRecord', recordId: 'meeting-choose', title: 'meeting-choose' })
})

test('a meeting already in the server\'s turn stays one row; a notice about a waiting meeting is that row\'s news', () => {
  const asked = notice('minutes_arrived', 'meeting-x', '2026-11-22T00:00:00Z')
  const v = inboxView(state([turn('meeting-y', 'meeting', 'received')], [asked]), NOW, [meeting('meeting-y', true), meeting('meeting-x', true)])
  assert.deepEqual(v.waiting.map(i => i.key).sort(), ['record:meeting-x', 'record:meeting-y'])
  assert.equal(v.waiting.find(i => i.key === 'record:meeting-y')?.meetingId, 'meeting-y', 'its buttons stay with the one row')
  assert.deepEqual(v.waiting.find(i => i.key === 'record:meeting-x')?.unreadNoticeIds, [asked.id])
})

test('the title bar\'s dot: at the start only an unread notice is new; then a new waiting row or notice, until the inbox is shown', () => {
  const first = inboxView(state([turn('task-a', 'task', 'todo')], [notice('request_done', 'task-d', '2026-11-22T00:00:00Z', true)]), NOW)
  let seen = new Set(inboxNewsBaseline(first))
  assert.equal(hasInboxNews(inboxNewsKeys(first), seen), false, 'what the count already says is not news')
  const unread = inboxView(state([turn('task-a', 'task', 'todo')], [notice('request_done', 'task-e', '2026-11-22T01:00:00Z')]), NOW)
  assert.equal(hasInboxNews(inboxNewsKeys(unread), new Set(inboxNewsBaseline(unread))), true, 'an unread notice at the start is the old bell\'s dot')
  const more = inboxView(state([turn('task-a', 'task', 'todo'), turn('approval-b', 'approval', 'pending')], []), NOW)
  assert.equal(hasInboxNews(inboxNewsKeys(more), seen), true, 'a new approval request is new')
  seen = new Set(inboxNewsKeys(more))
  assert.equal(hasInboxNews(inboxNewsKeys(more), seen), false, 'shown: nothing new any more')
  const fewer = inboxView(state([turn('approval-b', 'approval', 'pending')], []), NOW)
  assert.equal(hasInboxNews(inboxNewsKeys(fewer), seen), false, 'something leaving is not news')
  const nowWaiting = inboxView(state([], []), NOW, [meeting('meeting-r', true)])
  assert.equal(hasInboxNews(inboxNewsKeys(nowWaiting), new Set(inboxNewsKeys(inboxView(state([], []), NOW, [meeting('meeting-r', false)])))), true,
    'a meeting the AI was reading that now waits for the member is new')
})

test('the dot sees every unread できた notice, also one the row limit leaves out', () => {
  const many = Array.from({ length: INBOX_MAX_ROWS }, (_, i) => turn(`task-${i}`, 'task', 'todo'))
  const before = inboxView(state(many, []), NOW)
  const done = notice('request_done', 'task-done', '2026-11-22T00:00:00Z')
  const after = inboxView(state(many, [done]), NOW)
  assert.equal(after.done.length, 0, 'no room for the row')
  assert.equal(hasInboxNews(inboxNewsKeys(after), new Set(inboxNewsKeys(before))), true)
})

test('a meeting the AI reads keeps its unread notice as its own news: one row in 作業中, not a second one waiting', () => {
  const arrived = notice('minutes_arrived', 'meeting-r', '2026-11-22T00:00:00Z')
  const v = inboxView(state([], [arrived]), NOW, [meeting('meeting-r', false, { recordId: 'meeting-r', state: 'running', reason: '', canRetry: false, canHand: false })])
  assert.deepEqual(v.waiting, [])
  assert.deepEqual(v.working.map(i => [i.key, i.unreadNoticeIds]), [['record:meeting-r', [arrived.id]]])
  assert.equal(v.counts.waiting, 0)
})

// The independent review of I2: nothing the bell showed may disappear.
const aiChanged = (recordId: string, createdAt: string, read = false) => notice('ai_changed', recordId, createdAt, read, { aiChange: { pluginId: 'corporate-sales', operationId: `op-${recordId}`, undone: false } })

test('［元に戻す］ stays wherever its notice lands: on a waiting row it merged into, and on a waiting notice row', () => {
  const onTurn = aiChanged('task-mine', '2026-11-22T00:00:00Z')
  const v = inboxView(state([turn('task-mine', 'task', 'todo')], [onTurn]), NOW)
  assert.equal(v.waiting.length, 1)
  assert.deepEqual(v.waiting[0].undo, { noticeId: onTurn.id, recordId: 'task-mine', version: 3, aiChange: { pluginId: 'corporate-sales', operationId: 'op-task-mine' } })
  // The turn past the server's first 200: a change may be about a waiting record, so it waits — with its button.
  const partial = aiChanged('task-unlisted', '2026-11-22T00:00:00Z')
  const w = inboxView(state([turn('task-a', 'task', 'todo')], [partial], 300), NOW)
  assert.equal(w.waiting.find(i => i.key === `notice:${partial.id}`)?.undo?.noticeId, partial.id)
})

test('read notices from before today stay in 「前に確認したもの」, newest first, with ［元に戻す］ where the bell had it', () => {
  const older = notice('request_done', 'task-x', '2026-11-18T00:00:00Z', true)
  const newer = aiChanged('task-mine', '2026-11-20T00:00:00Z', true)
  const today = notice('request_done', 'task-y', '2026-11-22T00:00:00Z', true)
  // Even a read notice about a record that waits now is listed (not only folded into its row).
  const v = inboxView(state([turn('task-mine', 'task', 'todo')], [older, today, newer]), NOW)
  assert.deepEqual(v.seenBefore.map(i => i.key), [`notice:${newer.id}`, `notice:${older.id}`])
  assert.equal(v.seenBefore[0].undo?.noticeId, newer.id)
  assert.deepEqual(v.seenToday.map(i => i.key), [`notice:${today.id}`])
  assert.equal(v.waiting[0].undo, undefined, 'a read change is not the waiting row\'s news')
  assert.equal(v.counts.all, 1)
})

test('unread notices past the server\'s list are told and counted, and more of them is news', () => {
  const listed = notice('request_done', 'task-x', '2026-11-22T00:00:00Z')
  const three = inboxView({ ...state([], [listed]), notices: { available: true, unread: 4, items: [listed] } }, NOW)
  assert.equal(three.unreadNotListed, 3)
  assert.equal(three.counts.all, 4)
  const four = inboxView({ ...state([], [listed]), notices: { available: true, unread: 5, items: [listed] } }, NOW)
  assert.equal(hasInboxNews(inboxNewsKeys(four), new Set(inboxNewsKeys(three))), true)
  assert.equal(hasInboxNews(inboxNewsKeys(three), new Set(inboxNewsKeys(four))), false, 'fewer is not news')
})

test('only what the chosen chip shows counts as seen: あなた待ち hidden by 「できた・未確認」 stays new', () => {
  const v = inboxView(state([turn('approval-new', 'approval', 'pending')], [notice('request_done', 'task-x', '2026-11-22T00:00:00Z')]), NOW)
  const all = inboxNewsKeys(v)
  const seen = seenWhileShown(new Set(), all, inboxNewsKeys(v, 'done'))
  assert.equal(hasInboxNews(all, seen), true)
  assert.equal(seen.has('record:approval-new#waiting'), false)
  // Seen before and only hidden now: still seen.
  const again = seenWhileShown(new Set(all), all, inboxNewsKeys(v, 'done'))
  assert.equal(hasInboxNews(all, again), false)
})

// 「ブラウザ操作」 plans (agent-browser.md, the member's own through `browserPlans:list`).
const bp = (n: number) => `bp_${String(n).repeat(32)}`
const plans = (over: Partial<BrowserInboxPlans> = {}): BrowserInboxPlans => ({
  plans: [
    { planId: bp(1), state: 'draft', label: 'テンプレートを足す', site: 'Lステップ', createdAt: '2026-11-22T00:30:00Z' },
    { planId: bp(2), state: 'approved', label: 'テンプレートを足す', site: 'Lステップ', createdAt: '2026-11-22T00:10:00Z' },
  ],
  unsure: [
    { planId: bp(3), state: 'unknown', label: '段に足す（済）', permittedAt: '2026-11-22T00:00:00Z', confirmableAt: '2026-11-22T00:00:35Z' },
    { planId: bp(4), state: 'unknown', label: '段に足す（まだ）', permittedAt: '2026-11-22T00:59:40Z', confirmableAt: '2026-11-22T01:00:15Z' },
    { planId: bp(5), state: 'permitted', label: '段に足す（送信中）', permittedAt: '2026-11-22T00:59:50Z', confirmableAt: null },
  ],
  ...over,
})

test('a browser plan waiting for approval and a run due for its confirm wait for the member; the rest is 作業中', () => {
  // NOW = 01:00:00Z: bp(3)'s confirm opened at 00:00:35, bp(4)'s opens at 01:00:15.
  const v = inboxView(state([turn('approval-a', 'approval', 'pending'), turn('task-a', 'task', 'todo')], [notice('job_failed', '', '2026-11-22T00:00:00Z')]), NOW, [], plans())
  assert.deepEqual(v.waiting.map(i => i.key).slice(1), [`browser:${bp(3)}`, `browser:${bp(1)}`, 'record:approval-a', 'record:task-a'], 'after a stop: the unknown result, then the approvals (newest first)')
  const draft = v.waiting.find(i => i.key === `browser:${bp(1)}`)!
  assert.deepEqual([draft.badge, draft.actionLabel, draft.title], [{ tone: 'awaitingApproval', word: '承認を待っています' }, '承認する…', 'テンプレートを足す（Lステップ）'])
  const unsure = v.waiting.find(i => i.key === `browser:${bp(3)}`)!
  assert.deepEqual([unsure.badge, unsure.actionLabel], [{ tone: 'needsAction', word: '届いたか分かりません' }, '確かめる…'])
  assert.deepEqual(v.working.map(i => i.key).sort(), [`browser:${bp(2)}`, `browser:${bp(4)}`, `browser:${bp(5)}`].sort())
  assert.equal(v.counts.waiting, 5)
  // Sixteen seconds later bp(4)'s confirm has opened: the same answer puts it in あなた待ち.
  const later = inboxView(state([], []), new Date(NOW.getTime() + 16_000), [], plans())
  assert.ok(later.waiting.some(i => i.key === `browser:${bp(4)}`))
})

test('a browser plan row only opens its card: never an approval or a run', () => {
  const v = inboxView(state([], []), NOW, [], plans())
  for (const i of [...v.waiting, ...v.working]) {
    assert.deepEqual(i.action, { kind: 'openBrowserPlan', planId: i.key.slice('browser:'.length) })
    assert.deepEqual(i.unreadNoticeIds, [])
  }
})

test('without the plans (switched off) or once settled (no longer listed), there is no browser row', () => {
  assert.equal(inboxView(state([], []), NOW).counts.all, 0)
  assert.equal(inboxView(state([], []), NOW, [], plans({ plans: [], unsure: [] })).counts.all, 0)
  // A plan claimed for its run is one row, its run's (were a late answer still to list it as open).
  const both = inboxView(state([], []), NOW, [], plans({ plans: [{ planId: bp(3), state: 'approved', label: 'x', site: 'y', createdAt: '2026-11-22T00:00:00Z' }] }))
  assert.equal([...both.waiting, ...both.working].filter(i => i.key === `browser:${bp(3)}`).length, 1)
  assert.equal(both.waiting.find(i => i.key === `browser:${bp(3)}`)?.actionLabel, '確かめる…')
})
