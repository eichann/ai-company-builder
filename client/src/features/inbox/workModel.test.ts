// Working through the inbox (notifications.md "Working through the inbox", owner decisions 2026-11-28 11番). Each test
// names what it guards. The clock is fixed: every date below is a literal.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { NotificationItem } from '../../../../shared/types/notifications'
import type { NoticesState, TurnItem } from '../../../shared/notifications-app'
import type { ContactView } from '../../../shared/contact-card'
import { inboxView, type InboxItem } from './model'
import { besideCardOf, foldKinds, INBOX_PAGE, kindCounts, kindOf, limitShowing, narrowed, orderOf, paged, sectionsOf, withLingering } from './workModel'

const AT = (minute: number) => new Date(Date.UTC(2026, 10, 27, 1, minute)).toISOString() // 2026-11-27 10:mm in Japan
const turn = (id: string, type: string, state: string | null, due: string | null = null): TurnItem => ({ id, type, title: id, state, due })
let n = 0
const notice = (kind: NotificationItem['kind'], recordId: string, minute: number, read = false): NotificationItem => ({
  id: `n${++n}`, kind, recordId, recordType: recordId.split('-')[0] ?? '', recordTitle: recordId || '知らせ', version: 3,
  text: `${kind} の知らせ`, createdAt: AT(minute), read,
})
const state = (items: TurnItem[], notices: NotificationItem[]): NoticesState => ({
  available: true, myTurn: { total: items.length, items }, notices: { available: true, unread: notices.filter(x => !x.read).length, items: notices },
})
const readAll = (s: NoticesState, ids: readonly string[]): NoticesState =>
  state(s.myTurn.items, s.notices.items.map(x => (ids.includes(x.id) ? { ...x, read: true } : x)))
const NONE = new Map<string, InboxItem>()

test('案2: the red count stays what is stopped; the rest of this week\'s turn is told beside it, never a row or a red count', () => {
  const s = state([
    turn('task-today', 'task', 'todo', '2026-11-27'),
    turn('task-late', 'task', 'todo', '2026-11-20'),
    turn('task-asked', 'task', 'awaiting_acceptance'),
    turn('approval-1', 'approval', 'pending'),
    turn('outbound_message-1', 'outbound_message', 'draft'),
  ], [notice('job_failed', '', 1)])
  const v = inboxView(s)
  assert.equal(v.counts.waiting, 3)
  assert.equal(v.counts.elsewhere, 3)
  // The two can never disagree: every turn item is either a row of あなた待ち or told beside it.
  assert.equal(v.waiting.filter(i => i.key.startsWith('record:')).length + v.counts.elsewhere, s.myTurn.items.length)
  for (const i of [...v.waiting, ...v.news, ...v.moving, ...v.seen]) assert.ok(!i.key.startsWith('record:task-'))
})

const contact = (id: string, replyState: string): ContactView => ({
  interaction: { id, title: `連絡 ${id}`, state: 'handled', version: 2, assignee: 'u-me', maySettle: false },
  replyRequests: [{ id: `reply_request-${id.slice(-3)}`, title: '返事', state: replyState, version: 3, assignee: 'u-me', due: null, guidelineDue: null, waitUntil: '2026-12-05', drafts: [], may: { replied_elsewhere: false, close: true, drop: false } }],
  tasks: [],
})

test('a reply that came to a contact is 新着, never あなた待ち; a contact only waiting for its reply is not 新着 (decision 11番-2)', () => {
  const came = notice('reply_arrived', 'interaction-aaa', 5)
  const waitingRead = notice('intake_unsure', 'interaction-bbb', 4, true)
  const views: Record<string, ContactView> = { 'interaction-aaa': contact('interaction-aaa', 'open'), 'interaction-bbb': contact('interaction-bbb', 'waiting_reply') }
  const v = inboxView(state([], [came, waitingRead]), [], undefined, undefined, id => views[id])
  assert.deepEqual(v.news.map(i => i.key), ['contact:interaction-aaa'])
  assert.equal(v.counts.waiting, 0)
  assert.ok(!v.news.some(i => i.key === 'contact:interaction-bbb'))
})

test('a 新着 row opened stays where it was, without its dot and uncounted, until the chips change (decision 11番-3)', () => {
  const a = notice('request_done', 'task-a', 9)
  const b = notice('request_done', 'task-b', 8)
  const c = notice('request_done', 'task-c', 7)
  const s = state([], [a, b, c])
  const opened = inboxView(s).news.find(i => i.key === 'record:task-b')!
  const after = inboxView(readAll(s, opened.unreadNoticeIds))
  const kept = new Map([[opened.key, opened]])
  const news = withLingering(after, kept)
  assert.deepEqual(news.map(i => i.key), ['record:task-a', 'record:task-b', 'record:task-c'])
  assert.equal(news[1].seenHere, true)
  assert.deepEqual(news[1].unreadNoticeIds, [])
  // The blue count is the server's: one less, the kept row is not news.
  assert.equal(after.counts.news, 2)
  // Another chip or kind (nothing kept): it is in 確認したもの.
  assert.deepEqual(withLingering(after, NONE).map(i => i.key), ['record:task-a', 'record:task-c'])
  assert.ok(after.seen.some(i => i.key === 'record:task-b'))
})

test('a kept row that became あなた待ち (a stop came about it) is that row only, never twice', () => {
  const asked = notice('asked', 'task-x', 3)
  const s = state([], [asked])
  const opened = inboxView(s).news[0]
  const stopped = inboxView(state([], [{ ...asked, read: true }, notice('ai_turn_stuck', 'task-x', 6)]))
  const all = [...stopped.waiting, ...withLingering(stopped, new Map([[opened.key, opened]]))]
  assert.equal(all.filter(i => i.key === 'record:task-x').length, 1)
})

test('the kinds: each row is one kind, the counts add up, and narrowing keeps only that kind in every section', () => {
  const v = inboxView(state(
    [turn('approval-1', 'approval', 'pending'), turn('outbound_message-1', 'outbound_message', 'draft')],
    [notice('job_failed', '', 1), notice('approval_result', 'approval-9', 2), notice('request_done', 'task-1', 3), notice('reply_arrived', 'reply_request-1', 4)],
  ))
  const sections = sectionsOf(v, 'new', NONE)
  assert.deepEqual([...sections.waiting, ...sections.news].map(i => [i.key.split(':')[1] || i.key, kindOf(i)]).map(([, k]) => k).sort(),
    ['approval', 'approval', 'contact', 'contact', 'notice', 'stop'])
  const counts = kindCounts(sections)
  assert.deepEqual(counts, { all: 6, stop: 1, approval: 2, contact: 2, notice: 1 })
  const approvals = narrowed(sections, 'approval')
  assert.deepEqual(orderOf(approvals), ['record:approval-1', 'record:approval-9'])
  assert.equal(narrowed(sections, 'all'), sections)
  // The chip decides the sections: あなた待ち alone, or 確認したもの alone.
  assert.deepEqual(sectionsOf(v, 'waiting', NONE).news, [])
  assert.deepEqual(sectionsOf(v, 'seen', NONE).waiting, [])
})

test('15 rows first, the rest as the member goes down; ↓ past the last drawn row draws up to the next page', () => {
  const many = Array.from({ length: 40 }, (_, i) => notice('request_done', `task-${String(i).padStart(2, '0')}`, 59 - i))
  const v = inboxView(state([turn('approval-1', 'approval', 'pending')], many))
  const rows = sectionsOf(v, 'new', NONE)
  const first = paged(rows, INBOX_PAGE)
  assert.equal(INBOX_PAGE, 15)
  assert.deepEqual([first.sections.waiting.length, first.sections.news.length, first.left], [1, 14, 26])
  // The order covers every row, drawn or not: 「n / N」 counts them all.
  assert.equal(orderOf(rows).length, 41)
  const order = orderOf(rows)
  assert.equal(limitShowing(order, order[14], 15), 15)
  assert.equal(limitShowing(order, order[15], 15), 30)
  assert.equal(limitShowing(order, order[40], 15), 45)
  assert.equal(paged(rows, 45).left, 0)
})

test('the kind chips on one line: when they do not fit, すべて and the first two stay and the rest go under その他', () => {
  assert.deepEqual(foldKinds(false), { shown: ['all', 'stop', 'approval', 'contact', 'notice'], folded: [] })
  assert.deepEqual(foldKinds(true), { shown: ['all', 'stop', 'approval'], folded: ['contact', 'notice'] })
})

test('only a card opens beside the list (approval, mail, plan, contact); a record or a notice opens where it lives', () => {
  const v = inboxView(state([turn('approval-1', 'approval', 'pending'), turn('outbound_message-1', 'outbound_message', 'draft')], [notice('request_done', 'task-1', 1), notice('job_failed', '', 2)]))
  const of = (key: string) => [...v.waiting, ...v.news].find(i => i.key === key)!
  assert.deepEqual(besideCardOf(of('record:approval-1')), { kind: 'approval', id: 'approval-1' })
  assert.deepEqual(besideCardOf(of('record:outbound_message-1')), { kind: 'mail', id: 'outbound_message-1' })
  assert.equal(besideCardOf(of('record:task-1')), null)
  assert.equal(besideCardOf(v.waiting.find(i => i.stop)!), null)
})
