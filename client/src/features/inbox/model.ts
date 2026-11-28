// The inbox (受け箱; redesign 2026-11-26, notifications.md "The inbox"): only two things — あなた待ち (what is stopped until
// the member acts: a stopped job, an approval, a mail to check before it goes; it leaves only when done) and 新着 (notices
// the member has not looked at yet; opening one or ［確認した］ moves it to 「確認したもの」). Tasks are the left list's, never
// rows or counts here. Pure: no React, no IPC. Nothing is stored: every answer main hands over is rebuilt into rows, and the
// inbox never decides who may see what — every row comes from an answer the server already filtered for this member.
// Over ~300 lines on purpose: the placement rules (which row, which section, which count) are one table read together.
import { UNDOABLE_NOTIFICATION_KINDS, type NotificationItem, type NotificationKind } from '../../../../shared/types/notifications'
import { STOP_LOOK, type StopMeaning } from '../../../../shared/design-tokens/stop-meaning'
import type { MeetingNews, NoticesState, TurnItem } from '../../../shared/notifications-app'
import { jobNoticeTarget } from '../../../shared/jobs'
import { CONTACT_NAME, thingKindOf, thingName, type ThingKind } from '../../../shared/thing-words'
import type { BrowserInboxPlans } from '../../../shared/browser-plans'
import type { ContactView } from '../../../shared/contact-card'
import { contactLook, contactPlace } from './contactModel'

/** あなた待ち, 新着 (counted), 「動いているもの」 under 新着 (not counted), 確認したもの. */
export type InboxSection = 'waiting' | 'new' | 'moving' | 'seen'
/** The chips: 「新着」 shows あなた待ち and 新着 (the first look), the others one part each. */
export type InboxFilter = 'new' | 'waiting' | 'seen'

/**
 * What a row's main button does. There is deliberately no approve or send here: ［承認する…］ and
 * ［確かめて送る…］ open the card (what, where, when), and only the card's own buttons act.
 */
export type InboxAction =
  | { kind: 'openRecord'; recordId: string; title: string }
  | { kind: 'openApprovalCard'; approvalId: string }
  | { kind: 'openMailDraft'; messageId: string }
  /** A 「ブラウザ操作」 plan's card (agent-browser.md): ［任せる］ and ［済んでいた］… are the card's own buttons. */
  | { kind: 'openBrowserPlan'; planId: string }
  /** 「連絡」1枚 (a 来た連絡 with its 返事のお願い, inbox.md "One contact"): ［返した］ / ［済んだ］ are the card's own buttons. */
  | { kind: 'openContact'; contactId: string }
  | { kind: 'openTasks' }
  | { kind: 'openJobs' }
  /** A notice about nothing that can be opened: its text says it all. */
  | { kind: 'none' }

/** The badge's look: a stop by its meaning (`STOP_LOOK`), else a plain set. */
export type InboxTone = StopMeaning | 'success' | 'neutral' | 'ai' | 'info'

export interface InboxItem {
  /** One job = one row: `record:<id>` for a record (a meeting too), `notice:<id>` for a notice about no record, `browser:<planId>`. */
  key: string
  section: InboxSection
  /** Order inside あなた待ち (smaller first): stopped, a run nobody knows the result of, approval, mail. */
  rank: number
  /** What it is, for the icon ('notice' for a notice about no record). */
  thing: ThingKind | 'notice'
  title: string
  /** One line: the newest unread notice about it, or what it needs. */
  line: string
  badge: { tone: InboxTone; word: string }
  /** Where it comes from, in members' words (承認のお願い, 知らせ, 議事録…). */
  source: string
  due: string | null
  /** When the notice came (or the meeting was): the row's time and the order of 新着. */
  at: string | null
  /** Unread notices this row stands for: opening it (or ［確認した］) marks exactly these read. */
  unreadNoticeIds: string[]
  action: InboxAction
  /** The main button's words (「承認する…」, 「確かめて送る…」, 「開く」). */
  actionLabel: string
  /**
   * A stop notice (あなた待ち): opening it never marks it read — only ［済んだ］ does, or the server settling it — so looking
   * at it is not mistaken for having dealt with it (owner decision 2026-11-26 「見ただけでは消えない」).
   */
  stop?: true
  /** A meeting row: its own buttons are the minutes feature's (found by this id). */
  meetingId?: string
  /** A finished meeting's 「読み終わりました」: opening it or ［確認した］ marks it looked at on this PC (no notice holds it). */
  meetingNews?: true
  /** 「あと1日で読めなくなります」: a meeting still waiting to be read that the server drops tomorrow. */
  expiresSoon?: true
  /**
   * A 新着 row the member opened in this look (owner decision 2026-11-28, 11番-3): already read on the server, kept in its
   * place until the chips change (`workModel.ts` `withLingering`) — no dot, not counted.
   */
  seenHere?: true
  /** ［元に戻す］ of a notice that offers it (UNDOABLE_NOTIFICATION_KINDS, `ai_changed`). */
  undo?: { noticeId: string; recordId: string; version: number; aiChange?: { pluginId: string; operationId: string } }
}

/**
 * The first day (owner decision 2026-11-26, Q4): notices from before this moment start in 「確認したもの」 — one fixed
 * instant for every member and PC, so it never moves: run again, on another PC or later, it never takes a notice that came
 * after it (a moving 「first day on this PC」 would, on a member's second PC). It is the day the redesign was decided, so a
 * release later than it only shows a few more days as 新着 (the safe side), never fewer. Stops are not news: no cutoff.
 */
export const INBOX_NEWS_SINCE = '2026-11-25T15:00:00.000Z' // 2026-11-26 00:00 in Japan

/**
 * Notices that say something stopped: あなた待ち while unread and not settled. Their look by what the stop means for the
 * member (`STOP_LOOK`, design-system.md 「止まっている」の色): a failure red, something they must pick up amber.
 */
const STOP_NOTICES: Partial<Record<NotificationKind, StopMeaning>> = {
  job_failed: 'failed',
  job_paused: 'needsAction',
  ai_turn_stuck: 'needsAction',
  job_expired: 'needsAction',
  job_chain_stopped: 'needsAction',
  delegate_stopped: 'needsAction',
  company_restored: 'needsAction',
  // 「ブラウザ操作」 (agent-browser.md "The strict read's notice"): a site's shape changed; members do it by hand meanwhile.
  browser_shape_changed: 'needsAction',
}

/** A news row's badge by its notice's kind (a kind this app does not know: 「お知らせ」 — still news, never dropped). */
const NEWS_WORDS: Partial<Record<NotificationKind, { tone: InboxTone; word: string }>> = {
  request_done: { tone: 'success', word: '終わりました' },
  ok_completed: { tone: 'success', word: '完了しました' },
  request_accepted: { tone: 'success', word: '引き受けられました' },
  approval_result: { tone: 'neutral', word: '承認の結果' },
  replied_done: { tone: 'neutral', word: '完了にしました' },
  mail_left_inbox: { tone: 'neutral', word: '閉じました' },
  mail_archived: { tone: 'neutral', word: 'アーカイブしました' },
  // Skipped on purpose (the responsible person was absent): nothing to do.
  job_skipped: { tone: 'stoppedOnPurpose', word: STOP_LOOK.stoppedOnPurpose.word },
  due_changed: { tone: 'neutral', word: '変わりました' },
  others: { tone: 'neutral', word: '変わりました' },
  ai_changed: { tone: 'ai', word: 'AI が変えました' },
  asked: { tone: 'info', word: '頼まれました' },
  from_message: { tone: 'info', word: 'やることができました' },
  overdue: { tone: 'neutral', word: '期限を過ぎました' },
  acceptance_waiting: { tone: 'neutral', word: '引き受け待ち' },
  request_returned: { tone: 'neutral', word: '戻ってきました' },
  intake_unsure: { tone: 'neutral', word: '確かめてください' },
  wait_over: { tone: 'neutral', word: '見込みを過ぎました' },
  reply_arrived: { tone: 'info', word: '返事が来ました' },
  due_tomorrow: { tone: 'neutral', word: '明日が期限' },
  minutes_arrived: { tone: 'info', word: '議事録が届きました' },
  job_accept_needed: { tone: 'neutral', word: '受け取ってください' },
  job_proposal_returned: { tone: 'neutral', word: '差し戻されました' },
  job_proposal: { tone: 'info', word: '案が届きました' },
  // A set watch's 見送る (4b-4 PR6): opens 「定期の仕事」, where its ［作ってもらう］ is.
  job_set_declined: { tone: 'neutral', word: 'AI は作りませんでした' },
}
const NEWS_DEFAULT = { tone: 'neutral' as const, word: 'お知らせ' }

/** An unread notice the server marks settled (`shared/core/notification-settle.ts`): news that its matter is over. */
const SETTLED_WORDS = { tone: 'success' as const, word: '片付きました' }

/** Notices that are no row at all: the morning summary only counts the left list. */
const NO_ROW_NOTICES: ReadonlySet<NotificationKind> = new Set(['morning_summary'])

/** Is this notice a stop that still waits for the member (あなた待ち)? A settled one is news that it is over. */
export const isWaitingStop = (n: Pick<NotificationItem, 'kind' | 'settled' | 'read'>) => !n.read && n.settled !== true && STOP_NOTICES[n.kind] !== undefined

const RANK = { stopped: 0, unsure: 1, approval: 2, mail: 3, other: 5 } as const

/**
 * 「ブラウザ操作」 rows (the member's own, `browserPlans:list`; none while the switch is off on this PC): a draft waits for
 * their approval, a run nobody knows the result of waits for their 「済んでいた」/「されていなかった」 once it can be pressed;
 * the rest moves on without them (under 新着, not counted). Every row only opens the card; a settled plan is gone.
 */
function browserRows(b: BrowserInboxPlans): InboxItem[] {
  const rows = new Map<string, InboxItem>()
  const base = (planId: string, title: string, at: string | null) => ({
    key: `browser:${planId}`, thing: 'approval' as const, title, source: '承認のお願い（ブラウザ操作）', due: null, at, unreadNoticeIds: [],
    action: { kind: 'openBrowserPlan' as const, planId },
  })
  for (const p of b.plans) {
    const title = `${p.label}（${p.site}）`
    rows.set(p.planId, p.state === 'draft'
      ? { ...base(p.planId, title, p.createdAt), section: 'waiting', rank: RANK.approval, line: 'サイトから読み取った中身と届く時を確かめてから、カードで任せてください', badge: { tone: 'awaitingApproval', word: STOP_LOOK.awaitingApproval.word }, actionLabel: '承認する…' }
      : { ...base(p.planId, title, p.createdAt), section: 'moving', rank: RANK.other, line: '承認しました。様子はカードで見られます', badge: { tone: 'neutral', word: '承認しました' }, actionLabel: '開く…' })
  }
  // A plan claimed for a run has left the open list; its run is the one row (the later list wins anyway).
  for (const e of b.unsure) {
    // The server's word (its clocks), not this PC's clock: the inbox reads again once `confirmableAt` has passed.
    const due = e.state === 'unknown' && e.canConfirm
    rows.set(e.planId, due
      ? { ...base(e.planId, e.label, e.permittedAt), section: 'waiting', rank: RANK.unsure, line: 'サイトで確かめて、済んでいたかどうかをカードで押してください', badge: { tone: 'needsAction', word: '届いたか分かりません' }, actionLabel: '確かめる…' }
      : { ...base(e.planId, e.label, e.permittedAt), section: 'moving', rank: RANK.other, line: 'しばらくすると、届いたかどうかをカードで確かめられます', badge: { tone: 'neutral', word: '結果を待っています' }, actionLabel: '開く…' })
  }
  return [...rows.values()]
}

/** A turn item that is あなた待ち (an approval, a mail to check before it goes), or null: tasks are the left list's. */
function waitingTurnRow(item: TurnItem): InboxItem | null {
  const r = { type: item.type, state: item.state }
  const thing = thingKindOf(r)
  const base = { key: `record:${item.id}`, section: 'waiting' as const, thing, title: item.title, source: thingName(r), due: item.due, at: null, unreadNoticeIds: [] }
  if (thing === 'approval') {
    // The approver's request waits for their approval; a request sent back waits for its requester to fix it.
    return item.state === 'sent_back'
      ? { ...base, rank: RANK.approval, line: '差し戻されました。直して出し直すか、取り下げてください', badge: { tone: 'needsAction', word: '差し戻されました' }, action: { kind: 'openApprovalCard', approvalId: item.id }, actionLabel: '開く…' }
      : { ...base, rank: RANK.approval, line: '中身・相手・いつ反映されるかを確かめてから承認してください', badge: { tone: 'awaitingApproval', word: '承認を待っています' }, action: { kind: 'openApprovalCard', approvalId: item.id }, actionLabel: '承認する…' }
  }
  if (thing === 'outbound') {
    return { ...base, rank: RANK.mail, line: '送る前に、宛先と中身を確かめてください', badge: { tone: 'awaitingApproval', word: '確かめて送る' }, action: { kind: 'openMailDraft', messageId: item.id }, actionLabel: '確かめて送る…' }
  }
  return null
}

const MEETING_BADGE: Record<Exclude<MeetingNews['stage'], 'stopped'>, { tone: InboxTone; word: string }> = {
  arrived: { tone: 'info', word: '議事録が届きました' },
  reading: { tone: 'ai', word: 'AI が読んでいます' },
  read: { tone: 'success', word: '読み終わりました' },
  ask: { tone: 'neutral', word: '選んでください' },
  skipped: { tone: 'neutral', word: '読まないことになりました' },
}

function meetingRow(m: MeetingNews): InboxItem {
  const stop = m.stage === 'stopped' ? (m.stop ?? 'failed') : null
  return {
    key: `record:${m.id}`, section: stop ? 'waiting' : 'seen', rank: RANK.stopped, thing: 'meeting', title: m.title, line: m.line,
    badge: stop ? { tone: stop, word: STOP_LOOK[stop].word } : MEETING_BADGE[m.stage as Exclude<MeetingNews['stage'], 'stopped'>],
    source: '議事録', due: null, at: m.meetingAt, unreadNoticeIds: [], meetingId: m.id,
    action: { kind: 'openRecord', recordId: m.id, title: m.title }, actionLabel: '開く',
    ...(m.expiresSoon ? { expiresSoon: true as const } : {}),
  }
}

function noticeAction(n: NotificationItem): InboxAction {
  if (n.recordId === '') {
    const job = jobNoticeTarget(n.kind)
    if (job === 'jobs') return { kind: 'openJobs' }
    if (job === 'none') return { kind: 'none' }
    return { kind: 'openTasks' }
  }
  if (n.recordType === 'approval') return { kind: 'openApprovalCard', approvalId: n.recordId }
  return { kind: 'openRecord', recordId: n.recordId, title: n.recordTitle }
}

/** ［元に戻す］ of a notice that offers it (UNDOABLE_NOTIFICATION_KINDS, an `ai_changed` not yet written back). */
function undoOf(n: NotificationItem): InboxItem['undo'] {
  if (!UNDOABLE_NOTIFICATION_KINDS.includes(n.kind) && !(n.aiChange && !n.aiChange.undone)) return undefined
  return { noticeId: n.id, recordId: n.recordId, version: n.version, ...(n.aiChange ? { aiChange: { pluginId: n.aiChange.pluginId, operationId: n.aiChange.operationId } } : {}) }
}

function noticeRow(n: NotificationItem, section: InboxSection, badge: InboxItem['badge']): InboxItem {
  const action = noticeAction(n)
  const undo = undoOf(n)
  return {
    key: n.recordId ? `record:${n.recordId}` : `notice:${n.id}`, section, rank: section === 'waiting' ? RANK.stopped : RANK.other,
    thing: n.recordId ? thingKindOf({ type: n.recordType }) : 'notice',
    title: n.recordTitle || (n.kind.startsWith('job_') ? '定期の仕事' : '知らせ'),
    line: n.text, badge, source: '知らせ', due: null, at: n.createdAt, unreadNoticeIds: n.read ? [] : [n.id],
    action, actionLabel: action.kind === 'none' ? '確認した' : '開く',
    ...(undo ? { undo } : {}),
  }
}

/**
 * The contact a record belongs to, as the inbox's store last read it (a 来た連絡 or a 返事のお願い of it), `'gone'` when the
 * server answered that it is not the member's to read (any id of it), or undefined (not read).
 */
export type ContactsOfRows = (recordId: string) => ContactView | 'gone' | undefined

/** The types 「連絡」1枚 stands for: their notices are one row per contact (inbox.md "One contact"). */
export const CONTACT_RECORD_TYPES: ReadonlySet<string> = new Set(['interaction', 'reply_request'])

function contactOf(n: NotificationItem, contacts: ContactsOfRows | undefined): ContactView | 'gone' | undefined {
  return contacts && n.recordId && CONTACT_RECORD_TYPES.has(n.recordType) ? contacts(n.recordId) : undefined
}

/** A notice's row as its contact's one row: named by the contact, opening its card. */
function asContact(row: InboxItem, contact: ContactView | undefined): InboxItem {
  if (!contact) return row
  const id = contact.interaction.id
  return { ...row, key: `contact:${id}`, thing: 'incoming', title: contact.interaction.title || row.title, source: CONTACT_NAME, action: { kind: 'openContact', contactId: id }, actionLabel: '開く' }
}

/**
 * The contacts the inbox reads for its rows (`id@stamp`, newest notices first, at most `limit`): every record a notice
 * names that 「連絡」1枚 stands for, read again when a newer notice about it comes (its version is the stamp).
 */
export function contactsToRead(source: NoticesState, limit: number): string[] {
  if (!source.available) return []
  const stamps = new Map<string, number>()
  for (const n of [...source.notices.items].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    if (!n.recordId || !CONTACT_RECORD_TYPES.has(n.recordType)) continue
    if (!stamps.has(n.recordId) && stamps.size >= limit) continue
    stamps.set(n.recordId, Math.max(stamps.get(n.recordId) ?? 0, n.version))
  }
  return [...stamps].map(([id, v]) => `${id}@${v}`)
}

/** The records the notices name (a read of them made after a contact went: what the server still shows the member). */
export const noticedRecordIds = (source: NoticesState): ReadonlySet<string> =>
  new Set(source.available ? source.notices.items.map(n => n.recordId).filter(Boolean) : [])

/** Within あなた待ち: by rank, then the nearest due (none last), then the newest. */
function byNeed(a: InboxItem, b: InboxItem): number {
  if (a.rank !== b.rank) return a.rank - b.rank
  if (a.due !== b.due) return a.due === null ? 1 : b.due === null ? -1 : a.due < b.due ? -1 : 1
  return (b.at ?? '').localeCompare(a.at ?? '')
}
const newestFirst = (a: InboxItem, b: InboxItem) => (b.at ?? '').localeCompare(a.at ?? '')

export interface InboxView {
  waiting: InboxItem[]
  /** 新着: one row per thing, newest first — the blue count. */
  news: InboxItem[]
  /** Moving on without the member (a meeting the AI reads, a まとまり to choose, an approved plan): shown under 新着, never counted. */
  moving: InboxItem[]
  /** 確認したもの: what was looked at, and what came before the first day; newest first. */
  seen: InboxItem[]
  /** Unread notices the server counts but did not list (past its newest 50, so older ones): told under 確認したもの. */
  unreadNotListed: number
  /** The server's turn was past its first 200: an approval or a mail beyond it may not be listed yet. */
  turnNotListed: boolean
  /**
   * 案2 (owner decision 2026-11-28, 11番): what else of this week's turn waits for the member but is not あなた待ち (a task due
   * today, overdue, 引き受け待ち…) — told beside the red count as 「ほかに … N 件は『やること』で」, never a row or a red count.
   * The complement of `waitingTurnRow` over the same turn, so the two can never disagree.
   */
  counts: { waiting: number; news: number; seen: number; elsewhere: number }
  /** What 「すべて確認した」 marks: every news row's unread notices, and the finished meetings among them (this PC). */
  newsNoticeIds: string[]
  newsMeetingIds: string[]
}

/**
 * The inbox from what main read for the company on screen (`NoticesState`), the meetings the minutes feature hands
 * (`MeetingNews`) and the member's browser plans. One thing is one row: an unread notice about a record that has a row is
 * that row's news, never a second row. `newsSince`: the first day (`INBOX_NEWS_SINCE`).
 */
export function inboxView(source: NoticesState, meetings: readonly MeetingNews[] = [], browser?: BrowserInboxPlans, newsSince: string = INBOX_NEWS_SINCE,
  contacts?: ContactsOfRows): InboxView {
  const turn = source.available ? source.myTurn : { total: 0, items: [] as TurnItem[] }
  const rows = new Map<string, InboxItem>()
  const elsewhereIds: string[] = []
  for (const item of turn.items) {
    const row = waitingTurnRow(item)
    if (row) rows.set(row.key, row)
    else elsewhereIds.push(item.id)
  }
  for (const m of meetings) if (!rows.has(`record:${m.id}`)) rows.set(`record:${m.id}`, meetingRow(m))
  const since = Date.parse(newsSince)
  const fresh = (iso: string) => Date.parse(iso) >= since

  // With records off, main still hands the company's own notices (`bellOnly`): those are rows too.
  const notices = (source.available ? [...source.notices.items] : []).filter(n => !NO_ROW_NOTICES.has(n.kind))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  // Unread first (newest first), so a row's line is its newest unread notice; read ones only find a row of their own.
  for (const n of [...notices.filter(x => !x.read), ...notices.filter(x => x.read)]) {
    const contact = contactOf(n, contacts)
    // The notices were read before the contact stopped being the member's to read: none of them is a row (not even a plain
    // notice's, which would show the title the server no longer shows them) until they are read again without it.
    if (contact === 'gone') continue
    const key = contact ? `contact:${contact.interaction.id}` : n.recordId ? `record:${n.recordId}` : `notice:${n.id}`
    const row = rows.get(key)
    const stop = isWaitingStop(n) ? STOP_NOTICES[n.kind]! : null
    if (row) {
      // A read notice is no news, but a change it offers to undo stays on the one row (its newest such notice).
      if (n.read) { if (!row.undo) { const undo = undoOf(n); if (undo) row.undo = undo } continue }
      // A meeting keeps its own line (where its reading stands is newer than 「議事録が届きました」).
      if (row.unreadNoticeIds.length === 0) { row.at = n.createdAt; if (!row.meetingId) row.line = n.text }
      row.unreadNoticeIds.push(n.id)
      if (!row.undo) { const undo = undoOf(n); if (undo) row.undo = undo }
      // A stop about a row makes it a stop of あなた待ち (first, its look); a news row of 確認したもの becomes 新着.
      if (stop && !row.stop) Object.assign(row, { section: 'waiting', rank: RANK.stopped, stop: true, badge: { tone: stop, word: STOP_LOOK[stop].word }, line: n.text })
      else if (row.section === 'seen' && !row.meetingId && fresh(n.createdAt)) { row.section = 'new'; row.line = n.text; row.at = n.createdAt }
      continue
    }
    if (stop) { rows.set(key, asContact({ ...noticeRow(n, 'waiting', { tone: stop, word: STOP_LOOK[stop].word }), stop: true }, contact)); continue }
    const badge = n.settled === true && !n.read ? SETTLED_WORDS : NEWS_WORDS[n.kind] ?? NEWS_DEFAULT
    rows.set(key, asContact(noticeRow(n, !n.read && fresh(n.createdAt) ? 'new' : 'seen', badge), contact))
  }
  // A contact's one row says where it stands (the card's words); its reply over with a やること left → 確認したもの.
  for (const row of rows.values()) {
    if (row.action.kind !== 'openContact' || row.stop) continue
    const view = contacts?.(row.action.contactId)
    if (!view || view === 'gone') continue
    const look = contactLook(view)
    row.badge = { tone: look.status.tone, word: look.status.word }
    if (contactPlace(view) === 'seen') row.section = 'seen'
  }

  // A meeting's place: its unread notice since the first day, or a finished reading not yet looked at here, is 新着; the AI
  // reading it (or a まとまり to choose, or still waiting to be read) stays in sight uncounted; anything else was looked at.
  for (const m of meetings) {
    const row = rows.get(`record:${m.id}`)
    if (!row?.meetingId || row.section === 'waiting') continue
    const unreadFresh = notices.some(n => !n.read && n.recordId === m.id && fresh(n.createdAt))
    const finished = m.stage === 'read' && !m.seen && (m.meetingAt === null || fresh(m.meetingAt))
    // An arrived one whose notice was read (or switched off, or from before the first day) stays in sight, uncounted:
    // it still waits for ［AI に読ませる］ (a failed reading says so on its line) and may run out.
    row.section = unreadFresh || finished ? 'new' : m.stage === 'reading' || m.stage === 'ask' || m.stage === 'arrived' ? 'moving' : 'seen'
    if (finished) row.meetingNews = true
  }

  const all = [...rows.values(), ...(browser ? browserRows(browser) : [])]
  const pick = (s: InboxSection) => all.filter(r => r.section === s)
  const waiting = pick('waiting').sort(byNeed)
  // A task of the turn that a stop made a row of あなた待ち is that row (red), never also told beside it.
  const waitingKeys = new Set(waiting.map(i => i.key))
  const elsewhere = elsewhereIds.filter(id => !waitingKeys.has(`record:${id}`)).length
  const news = pick('new').sort(newestFirst)
  const seen = pick('seen').sort(newestFirst)
  const listedUnread = source.available ? source.notices.items.filter(n => !n.read).length : 0
  return {
    waiting, news, moving: pick('moving'), seen,
    unreadNotListed: source.available ? Math.max(0, source.notices.unread - listedUnread) : 0,
    turnNotListed: turn.total > turn.items.length,
    counts: { waiting: waiting.length, news: news.length, seen: seen.length, elsewhere },
    newsNoticeIds: news.flatMap(i => i.unreadNoticeIds),
    newsMeetingIds: news.filter(i => i.meetingNews && i.meetingId).map(i => i.meetingId!),
  }
}

/** The title bar button's name (aria-label and tooltip alike): both counts in words, and the shortcut. */
export const inboxButtonName = (news: number, waiting: number) => `受け箱：新着 ${news} 件・あなた待ち ${waiting} 件 (⌘J)`

/** 99 at most, then 「99+」. */
export const countText = (n: number) => (n > 99 ? '99+' : String(n))

/**
 * Notice kinds only owners / admins are ever written (member proposals' PR C, owner decision 2026-11-22): `job_proposal` (a
 * member's proposal arrived), `job_paused` (a job paused because its responsible person left or lost rights) and
 * `company_restored` (the company's data put back from a backup; owner decision 2026-11-22), `browser_shape_changed` (a browser
 * operation's site changed shape: agent-browser.md "The strict read's notice"). A member's
 * 「知らせの設定」 does not offer them; an owner / admin's does. Unknown role (offline) → not offered (the safe side).
 */
export const ADMIN_ONLY_NOTICE_KINDS: readonly NotificationKind[] = ['job_proposal', 'job_paused', 'company_restored', 'browser_shape_changed']

export function noticeKindsForRole<K extends string>(kinds: readonly K[], fullAccess: boolean | null): K[] {
  return fullAccess === true ? [...kinds] : kinds.filter(k => !(ADMIN_ONLY_NOTICE_KINDS as readonly string[]).includes(k))
}

/** 「知らせの設定」 as the dialog holds it: the member's switches, why not, and whether they are an owner / admin. */
export interface NoticeSettingsState { kinds: Record<string, boolean> | null; error: string | null; fullAccess?: boolean | null }

/** One switch changed (or put back): everything else kept — also whether the owner / admin-only kinds are offered. */
export function settingsAfterSwitch(s: NoticeSettingsState | null, kind: string, value: boolean, error: string | null): NoticeSettingsState | null {
  return s?.kinds ? { ...s, kinds: { ...s.kinds, [kind]: value }, error } : s
}
