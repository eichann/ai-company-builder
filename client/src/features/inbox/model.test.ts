// The inbox's placement rules (notifications.md "The inbox", redesign 2026-11-26). Each test names what it guards.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { NotificationItem } from '../../../../shared/types/notifications'
import type { MeetingNews, NoticesState, TurnItem } from '../../../shared/notifications-app'
import type { BrowserInboxPlans } from '../../../shared/browser-plans'
import type { ContactView } from '../../../shared/contact-card'
import { contactsToRead, countText, inboxView, INBOX_NEWS_SINCE, noticeKindsForRole, settingsAfterSwitch, type InboxAction } from './model'

// Type-level guard (`pnpm typecheck`): no row action may approve, send, run or confirm (a browser plan's ［任せる］ and
// ［済んでいた］ are its card's); such a kind fails to compile here.
type ActsOutside = Extract<InboxAction['kind'], `${string}${'approve' | 'Approve' | 'send' | 'Send' | 'run' | 'Run' | 'confirm' | 'Confirm'}${string}`>
const noRowActsOutside: [ActsOutside] extends [never] ? true : false = true
void noRowActsOutside

const AFTER = '2026-11-26T01:00:00Z'
const LATER = '2026-11-26T03:00:00Z'
const BEFORE = '2026-11-20T01:00:00Z'
const turn = (id: string, type: string, state: string | null, due: string | null = null): TurnItem => ({ id, type, title: id, state, due })
let n = 0
const notice = (kind: NotificationItem['kind'], recordId: string, createdAt = AFTER, read = false, extra: Partial<NotificationItem> = {}): NotificationItem => ({
  id: `n${++n}`, kind, recordId, recordType: recordId.split('-')[0] ?? '', recordTitle: recordId ? `「${recordId}」` : '', version: 3,
  text: `${kind} の知らせ`, createdAt, read, ...extra,
})
const state = (items: TurnItem[], notices: NotificationItem[], total = items.length): NoticesState => ({
  available: true,
  myTurn: { total, items },
  notices: { available: true, unread: notices.filter(x => !x.read).length, items: notices },
})
const meeting = (id: string, stage: MeetingNews['stage'], over: Partial<MeetingNews> = {}): MeetingNews =>
  ({ id, title: id, stage, line: `${stage} の行`, meetingAt: AFTER, expiresSoon: false, seen: false, ...over })
/** What the server answers after the member opened these notices (another read of the same state). */
const readAll = (s: NoticesState, ids: readonly string[]): NoticesState =>
  state(s.myTurn.items, s.notices.items.map(x => (ids.includes(x.id) ? { ...x, read: true } : x)), s.myTurn.total)

test('the red count is あなた待ち only: stops, approvals and mail to check — never a task due today, a resting turn item or a notice that only tells', () => {
  const s = state([
    turn('task-today', 'task', 'todo', '2026-11-26'),
    turn('task-check', 'task', 'review'),
    turn('approval-1', 'approval', 'pending'),
    turn('outbound_message-1', 'outbound_message', 'draft'),
  ], [notice('job_failed', ''), notice('asked', 'task-new'), notice('due_tomorrow', 'task-today'), notice('overdue', 'task-x')])
  const v = inboxView(s)
  assert.deepEqual(v.waiting.map(i => i.key), [v.waiting[0].key, 'record:approval-1', 'record:outbound_message-1'])
  assert.equal(v.waiting[0].badge.tone, 'failed')
  assert.equal(v.counts.waiting, 3)
  // Tasks are the left list's: no row, no count.
  for (const i of [...v.waiting, ...v.news, ...v.moving, ...v.seen]) assert.notEqual(i.key, 'record:task-check')
})

test('opening or ［確認した］ on a 新着 row lowers the blue count by exactly one; it grows only when a new notice comes', () => {
  const a1 = notice('asked', 'task-a')
  const a2 = notice('due_changed', 'task-a', LATER)
  const b = notice('reply_arrived', 'reply_request-b')
  const s = state([], [a1, a2, b])
  const v = inboxView(s)
  assert.equal(v.counts.news, 2)
  // Two notices about one task are one row: opening it marks both, the count goes down by one.
  const row = v.news.find(i => i.key === 'record:task-a')!
  assert.deepEqual(row.unreadNoticeIds.sort(), [a1.id, a2.id].sort())
  const after = inboxView(readAll(s, row.unreadNoticeIds))
  assert.equal(after.counts.news, 1)
  assert.equal(after.seen.some(i => i.key === 'record:task-a'), true)
  // Read again with nothing new: the same count.
  assert.equal(inboxView(readAll(s, row.unreadNoticeIds)).counts.news, 1)
  // A new notice about a task already looked at: news again.
  const back = inboxView(state([], [...readAll(s, row.unreadNoticeIds).notices.items, notice('wait_over', 'task-a', '2026-11-26T05:00:00Z')]))
  assert.equal(back.counts.news, 2)
})

test('「すべて確認した」 marks every 新着 row\'s notices and finished meetings — never a stop or the news of an approval', () => {
  const stop = notice('job_failed', '')
  const approvalNews = notice('asked', 'approval-1')
  const news = notice('request_done', 'task-x')
  const v = inboxView(state([turn('approval-1', 'approval', 'pending')], [stop, approvalNews, news]), [meeting('meeting-m', 'read')])
  assert.deepEqual(v.newsNoticeIds, [news.id])
  assert.deepEqual(v.newsMeetingIds, ['meeting-m'])
})

test('a stop leaves あなた待ち only when done: opening is not 済んだ (no read is asked); settled by the server it is news that it is over', () => {
  const failed = notice('job_failed', '')
  const v = inboxView(state([], [failed]))
  assert.equal(v.waiting[0].stop, true)
  assert.equal(v.counts.news, 0)
  const settled = inboxView(state([], [{ ...failed, settled: true }]))
  assert.equal(settled.counts.waiting, 0)
  assert.equal(settled.news[0].badge.word, '片付きました')
  // ［済んだ］ (read) on one the server cannot settle: out of あなた待ち, findable in 確認したもの.
  const done = inboxView(state([], [{ ...failed, read: true }]))
  assert.deepEqual([done.counts.waiting, done.seen.length], [0, 1])
})

test('stops look by what they mean: a failure red, one to pick up amber; one skipped on purpose is grey news, not waiting', () => {
  const v = inboxView(state([], [notice('job_failed', ''), notice('ai_turn_stuck', 'task-1'), notice('job_skipped', '')]))
  assert.deepEqual(v.waiting.map(i => i.badge.tone).sort(), ['failed', 'needsAction'])
  assert.equal(v.news[0].badge.tone, 'stoppedOnPurpose')
})

test('one meeting is one row: its 「議事録が届きました」 notice is that row\'s news, never a second row', () => {
  const arrived = notice('minutes_arrived', 'meeting-a')
  const v = inboxView(state([], [arrived]), [meeting('meeting-a', 'arrived')])
  const all = [...v.waiting, ...v.news, ...v.moving, ...v.seen]
  assert.equal(all.filter(i => i.key === 'record:meeting-a').length, 1)
  assert.deepEqual(v.news[0].unreadNoticeIds, [arrived.id])
  assert.equal(v.news[0].line, 'arrived の行')
  assert.equal(v.counts.news, 1)
})

test('a meeting the AI reads is shown but never counted; a finished one is 新着 until looked at here; this PC\'s AI stopped on one is あなた待ち', () => {
  const v = inboxView(state([], []), [meeting('meeting-r', 'reading'), meeting('meeting-d', 'read'), meeting('meeting-s', 'read', { seen: true }), meeting('meeting-x', 'stopped', { stop: 'failed' })])
  assert.deepEqual(v.moving.map(i => i.key), ['record:meeting-r'])
  assert.deepEqual(v.news.map(i => [i.key, i.meetingNews]), [['record:meeting-d', true]])
  assert.deepEqual(v.seen.map(i => i.key), ['record:meeting-s'])
  assert.deepEqual(v.waiting.map(i => [i.key, i.badge.tone]), [['record:meeting-x', 'failed']])
  assert.deepEqual(v.counts, { waiting: 1, news: 1, seen: 1, elsewhere: 0 })
})

test('an arrived meeting whose notice was already read (or switched off) stays in sight, not counted, never hidden in 確認したもの', () => {
  const read = notice('minutes_arrived', 'meeting-a', AFTER, true)
  const v = inboxView(state([], [read]), [meeting('meeting-a', 'arrived'), meeting('meeting-b', 'arrived')])
  assert.deepEqual(v.moving.map(i => i.key).sort(), ['record:meeting-a', 'record:meeting-b'])
  assert.equal(v.counts.news, 0)
})

test('a stop about a record that waits makes that row a stop (its look, first place); a settled one changes nothing of the row', () => {
  const stop = notice('ai_turn_stuck', 'approval-9', LATER)
  const v = inboxView(state([turn('outbound_message-1', 'outbound_message', 'draft'), turn('approval-9', 'approval', 'pending')], [stop]))
  assert.deepEqual(v.waiting.map(i => [i.key, i.stop ?? false, i.badge.tone]), [['record:approval-9', true, 'needsAction'], ['record:outbound_message-1', false, 'awaitingApproval']])
  const settled = inboxView(state([turn('approval-9', 'approval', 'pending')], [{ ...stop, settled: true }]))
  assert.deepEqual(settled.waiting.map(i => [i.key, i.stop ?? false, i.badge.word]), [['record:approval-9', false, '承認を待っています']])
  assert.deepEqual(settled.waiting[0].unreadNoticeIds, [stop.id])
  assert.equal(settled.counts.news, 0)
})

test('the first day: notices from before it start in 確認したもの; one after it is never taken, however often it runs', () => {
  const old = notice('asked', 'task-old', BEFORE)
  const fresh = notice('asked', 'task-new', AFTER)
  const s = state([], [old, fresh])
  const once = inboxView(s)
  assert.ok(Date.parse(BEFORE) < Date.parse(INBOX_NEWS_SINCE) && Date.parse(AFTER) >= Date.parse(INBOX_NEWS_SINCE))
  assert.deepEqual(once.news.map(i => i.key), ['record:task-new'])
  // Still unread on the server: opening it from 確認したもの marks it read.
  assert.deepEqual(once.seen.find(i => i.key === 'record:task-old')?.unreadNoticeIds, [old.id])
  // A second run (or the member's other PC) decides the same, with nothing written.
  assert.deepEqual(inboxView(s).news.map(i => i.key), ['record:task-new'])
  // A finished meeting from before the first day is not news either.
  assert.equal(inboxView(state([], []), [meeting('meeting-o', 'read', { meetingAt: BEFORE })]).counts.news, 0)
})

test('an approval and a mail draft only ever open their card: no row action approves or sends', () => {
  const v = inboxView(state([turn('approval-1', 'approval', 'pending'), turn('outbound_message-1', 'outbound_message', 'draft')],
    [notice('approval_result', 'approval-2')]))
  assert.deepEqual(v.waiting.map(i => i.action), [{ kind: 'openApprovalCard', approvalId: 'approval-1' }, { kind: 'openMailDraft', messageId: 'outbound_message-1' }])
  assert.deepEqual(v.news[0].action, { kind: 'openApprovalCard', approvalId: 'approval-2' })
  assert.equal(v.waiting[0].actionLabel, '承認する…')
})

test('a kind this app does not know is still 新着 (never dropped), and ［元に戻す］ stays on the row its notice lands on', () => {
  const unknown = notice('some_future_kind' as NotificationItem['kind'], 'task-u')
  const undoable = notice('replied_done', 'task-r')
  const v = inboxView(state([], [unknown, undoable]))
  assert.equal(v.news.find(i => i.key === 'record:task-u')?.badge.word, 'お知らせ')
  assert.equal(v.news.find(i => i.key === 'record:task-r')?.undo?.noticeId, undoable.id)
})

test('［元に戻す］ of a read notice stays on its record\'s one row when a newer notice made the row (Codex review)', () => {
  const readChange = notice('ai_changed', 'deal-1', AFTER, true, { aiChange: { pluginId: 'p', operationId: 'op-1', undone: false } })
  const newer = notice('due_changed', 'deal-1', LATER)
  const v = inboxView(state([], [newer, readChange]))
  const rows = [...v.news, ...v.seen].filter(i => i.key === 'record:deal-1')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].undo?.noticeId, readChange.id)
})

test('unread notices past the server\'s list are told, never counted as 新着 (they are older than the listed ones)', () => {
  const s = state([], [notice('asked', 'task-1')])
  const v = inboxView({ ...s, notices: { ...s.notices, unread: 7 } })
  assert.deepEqual([v.unreadNotListed, v.counts.news], [6, 1])
})

test('records off with no notices of the company: nothing; with its own notices: those only', () => {
  const off: NoticesState = { available: false, myTurn: { total: 0, items: [] }, notices: { available: false, unread: 0, items: [] } }
  assert.deepEqual(inboxView(off).counts, { waiting: 0, news: 0, seen: 0, elsewhere: 0 })
})

test('counts stop at 99+', () => {
  assert.equal(countText(99), '99')
  assert.equal(countText(100), '99+')
})

test('a returned proposal\'s notice shows its words and opens 「定期の仕事」; an arrived one opens nothing in the app', () => {
  const returned = notice('job_proposal_returned', '', AFTER, false, { text: '出した定期の仕事の案「議事録まとめ」は差し戻されました（理由：先に話をしたい）' })
  const arrived = notice('job_proposal', '')
  const v = inboxView(state([], [returned, arrived]))
  const row = (id: string) => v.news.find(i => i.key === `notice:${id}`)
  assert.equal(row(returned.id)?.line, returned.text)
  assert.deepEqual(row(returned.id)?.action, { kind: 'openJobs' })
  assert.deepEqual(row(arrived.id)?.action, { kind: 'none' })
})

test('知らせの設定: the owner / admin-only kinds are offered to owners / admins only, never when the role is not known; a switch keeps that', () => {
  const kinds = ['asked', 'job_paused', 'job_proposal', 'job_proposal_returned', 'company_restored', 'browser_shape_changed'] as const
  assert.deepEqual(noticeKindsForRole(kinds, false), ['asked', 'job_proposal_returned'])
  assert.deepEqual(noticeKindsForRole(kinds, null), ['asked', 'job_proposal_returned'])
  assert.deepEqual(noticeKindsForRole(kinds, true), [...kinds])
  const s = { kinds: { asked: true, job_proposal: true }, error: null, fullAccess: true }
  assert.deepEqual(settingsAfterSwitch(s, 'asked', false, null), { kinds: { asked: false, job_proposal: true }, error: null, fullAccess: true })
  assert.equal(settingsAfterSwitch(null, 'asked', true, null), null)
})

// 「ブラウザ操作」 plans (agent-browser.md, the member's own through `browserPlans:list`).
const bp = (k: number) => `bp_${String(k).repeat(32)}`
const plans = (): BrowserInboxPlans => ({
  plans: [
    { planId: bp(1), state: 'draft', label: 'テンプレートを足す', site: 'Lステップ', createdAt: '2026-11-22T00:30:00Z' },
    { planId: bp(2), state: 'approved', label: 'テンプレートを足す', site: 'Lステップ', createdAt: '2026-11-22T00:10:00Z' },
  ],
  unsure: [
    { planId: bp(3), state: 'unknown', label: '段に足す（済）', permittedAt: '2026-11-22T00:00:00Z', confirmableAt: '2026-11-22T00:00:35Z', canConfirm: true },
    { planId: bp(4), state: 'unknown', label: '段に足す（まだ）', permittedAt: '2026-11-22T00:59:40Z', confirmableAt: '2026-11-22T01:00:15Z', canConfirm: false },
  ],
})

test('a browser plan waiting for approval and a run due for its confirm are あなた待ち; the rest moves on, not counted; each only opens its card', () => {
  const v = inboxView(state([], []), [], plans())
  assert.deepEqual(v.waiting.map(i => i.key), [`browser:${bp(3)}`, `browser:${bp(1)}`])
  assert.deepEqual(v.moving.map(i => i.key).sort(), [`browser:${bp(2)}`, `browser:${bp(4)}`].sort())
  for (const i of [...v.waiting, ...v.moving]) assert.equal(i.action.kind, 'openBrowserPlan')
  assert.equal(v.counts.waiting, 2)
})

test('a plan listed both as open and as a run is one row, its run\'s', () => {
  const p = plans()
  const both: BrowserInboxPlans = { plans: [p.plans[0]], unsure: [{ ...p.unsure[0], planId: bp(1) }] }
  const v = inboxView(state([], []), [], both)
  const rows = [...v.waiting, ...v.moving].filter(i => i.key === `browser:${bp(1)}`)
  assert.deepEqual(rows.map(i => i.actionLabel), ['確かめる…'])
})

// 「連絡」1枚 (inbox.md "One contact", decision 5): a 来た連絡 and its 返事のお願い are one row, never a row of the 返事のお願い alone.
const contactView = (replyState: string, tasks: ContactView['tasks'] = []): ContactView => ({
  interaction: { id: 'interaction-abc123', title: 'A社 見積のご相談', state: 'handled', version: 7, assignee: 'u-me', maySettle: false },
  replyRequests: [{ id: 'reply_request-def456', title: '返事', state: replyState, version: 4, assignee: 'u-me', due: '2026-12-02', guidelineDue: null, waitUntil: null, drafts: [],
    may: replyState === 'closed' ? { replied_elsewhere: false, close: false, drop: false } : { replied_elsewhere: true, close: true, drop: true } }],
  tasks,
})
const contactsOf = (v: ContactView) => (id: string) => (id === v.interaction.id || v.replyRequests.some(r => r.id === id) ? v : undefined)

test('a 来た連絡 and its 返事のお願い are one row 「連絡」 that opens the card; no row for the 返事のお願い alone', () => {
  const s = state([], [
    notice('reply_arrived', 'reply_request-def456', LATER),
    notice('intake_unsure', 'interaction-abc123', AFTER),
  ])
  const v = inboxView(s, [], undefined, INBOX_NEWS_SINCE, contactsOf(contactView('checking')))
  const all = [...v.waiting, ...v.news, ...v.moving, ...v.seen]
  assert.deepEqual(all.map(r => r.key), ['contact:interaction-abc123'])
  const row = all[0]
  assert.deepEqual(row.action, { kind: 'openContact', contactId: 'interaction-abc123' })
  assert.equal(row.source, '連絡')
  assert.equal(row.title, 'A社 見積のご相談')
  // The row says what the card says, and stands for both notices (opening it marks both read).
  assert.equal(row.badge.word, '返事が来ました・確かめています')
  assert.equal(row.unreadNoticeIds.length, 2)
  assert.equal(v.counts.news, 1)
  // Not read yet (offline, the first look): each notice keeps its own row, as before.
  assert.equal(inboxView(s).news.length, 2)
})

test('a contact whose reply is over with a やること left goes to 「確認したもの」 (the やること stays in the task list)', () => {
  const s = state([], [notice('reply_arrived', 'reply_request-def456', LATER)])
  const left = contactView('closed', [{ id: 'task-ghi789', title: '経費を承認する', state: 'todo', version: 2, assignee: 'u-me' }])
  const v = inboxView(s, [], undefined, INBOX_NEWS_SINCE, contactsOf(left))
  assert.equal(v.news.length, 0)
  assert.deepEqual(v.seen.map(r => r.key), ['contact:interaction-abc123'])
  assert.equal(v.seen[0].badge.word, '返事は済みました・やることが 1 件残っています')
  // Still to reply: 新着 as its notice puts it.
  assert.equal(inboxView(s, [], undefined, INBOX_NEWS_SINCE, contactsOf(contactView('open'))).news.length, 1)
})

test('the contacts read for the rows are the ones the notices name, read again when a newer notice comes, and capped', () => {
  const s = state([], [
    notice('reply_arrived', 'reply_request-def456', LATER, false, { version: 5 }),
    notice('intake_unsure', 'interaction-abc123', AFTER, false, { version: 2 }),
    notice('asked', 'task-xyz999', AFTER),
  ])
  assert.deepEqual(contactsToRead(s, 30), ['reply_request-def456@5', 'interaction-abc123@2'])
  assert.deepEqual(contactsToRead(s, 1), ['reply_request-def456@5'])
})
