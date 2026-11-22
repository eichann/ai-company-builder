import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { NotificationItem } from '../../../../shared/types/notifications'
import type { NoticesState, TurnItem } from '../../../shared/notifications-app'
import { bulkSeenIds, countText, INBOX_MAX_ROWS, inboxView, type InboxAction } from './model'

// Type-level guard (`pnpm typecheck`): no row action may approve or send; such a kind fails to compile here.
type ActsOutside = Extract<InboxAction['kind'], `${string}${'approve' | 'Approve' | 'send' | 'Send'}${string}`>
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
  assert.deepEqual(after.seenToday.map(i => i.key), [`notice:${done.id}`])
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
  assert.equal(read.waiting.length + read.done.length + read.seenToday.length, 0)
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
