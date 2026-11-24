// The inbox (受け箱, I1; design 2026-11-22 「下のパネルを「受け箱」1 つにする」): one list of what the server
// already says concerns the member — 「あなたの番」 (`/records/my-turn`, this week's) and the notices
// (`/me/notifications`) — ordered by what it needs from them. Pure: no React, no IPC. The inbox stores
// nothing of its own (what the server answered is rebuilt into rows every time), and it never decides
// who may see what: every row comes from an answer the server already filtered for this member.
import { UNDOABLE_NOTIFICATION_KINDS, type NotificationItem, type NotificationKind } from '../../../../shared/types/notifications'
import { STOP_LOOK, type StopMeaning } from '../../../../shared/design-tokens/stop-meaning'
import type { MeetingTurn, NoticesState, TurnItem } from '../../../shared/notifications-app'
import { jobNoticeTarget } from '../../../shared/jobs'
import { thingKindOf, thingName, type ThingKind } from '../../../shared/thing-words'
import type { BrowserInboxPlans } from '../../../shared/browser-plans'

/** あなた待ち (only the member's press moves it), 作業中, できた・未確認. */
export type InboxState = 'waiting' | 'working' | 'done'
export type InboxFilter = 'all' | InboxState

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
  | { kind: 'openTasks' }
  | { kind: 'openJobs' }
  /** A notice about nothing that can be opened: opening only marks it seen (its text says it all). */
  | { kind: 'none' }

/** The badge's look: a stop by its meaning (`STOP_LOOK`), else a plain set. */
export type InboxTone = StopMeaning | 'success' | 'neutral' | 'ai'

export interface InboxItem {
  /** One job = one row: `record:<id>` for a record, `notice:<id>` for a notice about no row, `browser:<planId>` for a plan. */
  key: string
  state: InboxState
  /** Order inside あなた待ち (smaller first): stopped, a run nobody knows the result of, approval, mail, check, the rest. */
  rank: number
  /** What it is, for the icon ('notice' for a notice about no record). */
  thing: ThingKind | 'notice'
  title: string
  /** One line: the newest unread notice about it, or what it needs. */
  line: string
  badge: { tone: InboxTone; word: string }
  /** Where it comes from, in members' words (承認のお願い, やること, 知らせ…). */
  source: string
  due: string | null
  /** When the notice was made (a turn item has none). */
  at: string | null
  /** Unread notices this row stands for: opening the row marks exactly these read. */
  unreadNoticeIds: string[]
  action: InboxAction
  /** The main button's words (「承認する…」, 「確かめて送る…」, 「開く」). */
  actionLabel: string
  /**
   * A meeting the title bar used to carry (a department without the task list, `useMinutesSlots`): its
   * own buttons (choose a まとまり, read it yourself, もう一度…) are the minutes feature's, found by this id.
   */
  meetingId?: string
  /** ［元に戻す］ of a done notice that offers it (UNDOABLE_NOTIFICATION_KINDS, `ai_changed`). */
  undo?: { noticeId: string; recordId: string; version: number; aiChange?: { pluginId: string; operationId: string } }
}

/** できた・未確認 older than this is not a row but one folded line (owner decision ⑥). */
export const DONE_KEEP_DAYS = 14
/** The whole list's rows at most; the oldest できた go first, あなた待ち never. */
export const INBOX_MAX_ROWS = 100

/**
 * Notices that say something stopped (owner decision ③): あなた待ち while unread, gone once opened (today's
 * read state — no new 「済んだ」 on the server). Their look by what the stop means for the member
 * (`STOP_LOOK`, design-system.md 「止まっている」の色): a failure red, something they must pick up amber.
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

/**
 * Notices that only tell of something finished or changed: できた・未確認 (owner decision ④), the only ones
 * 「まとめて確認済みにする」 may clear. Every other kind — one that asks for something, and any kind this app
 * does not know yet — waits for the member (the safe side).
 */
const DONE_WORDS: Partial<Record<NotificationKind, { tone: InboxTone; word: string }>> = {
  request_done: { tone: 'success', word: '終わりました' },
  ok_completed: { tone: 'success', word: '完了しました' },
  request_accepted: { tone: 'success', word: '引き受けられました' },
  approval_result: { tone: 'neutral', word: '承認の結果' },
  replied_done: { tone: 'neutral', word: '完了にしました' },
  mail_left_inbox: { tone: 'neutral', word: '閉じました' },
  mail_archived: { tone: 'neutral', word: 'アーカイブしました' },
  // Skipped on purpose (the responsible person was absent): nothing to do.
  job_skipped: { tone: 'stoppedOnPurpose', word: STOP_LOOK.stoppedOnPurpose.word },
}
/**
 * 「変わりました」 news about a record (owner decision ④): できた・未確認 — unless the turn the server listed is
 * incomplete (past its first 200), when the record may be one waiting for the member: then あなた待ち.
 */
const CHANGE_WORDS: Partial<Record<NotificationKind, { tone: InboxTone; word: string }>> = {
  due_changed: { tone: 'neutral', word: '変わりました' },
  others: { tone: 'neutral', word: '変わりました' },
  ai_changed: { tone: 'ai', word: 'AI が変えました' },
}

/** What a notice that asks for something says on its badge (a kind not listed: 「あなたの番」). */
const ASK_WORDS: Partial<Record<NotificationKind, string>> = {
  asked: '頼まれました',
  from_message: 'やることができました',
  overdue: '期限を過ぎました',
  acceptance_waiting: '引き受け待ち',
  request_returned: '戻ってきました',
  intake_unsure: '確かめてください',
  wait_over: '見込みを過ぎました',
  reply_arrived: '返事が来ました',
  due_tomorrow: '明日が期限',
  minutes_arrived: '議事録が届きました',
  job_accept_needed: '受け取ってください',
  job_proposal_returned: '差し戻されました',
  job_proposal: '案が届きました',
  // A set watch's 見送る (4b-4 PR6): opens 「定期の仕事」, where its ［作ってもらう］ is.
  job_set_declined: 'AI は作りませんでした',
}

/**
 * An unread notice the server marks settled (`settled`, shared/core/notification-settle.ts: the meeting was taken up
 * (read, being read or set aside), the occurrence ran afterwards, the job runs again): できた・未確認 with this badge, out of あなた待ち and its
 * count, never a stop. Still unread: opening it marks it read as any notice.
 */
const SETTLED_WORDS = { tone: 'success' as const, word: '片付きました' }

/** Notices that are no row at all: the morning summary says what あなた待ち already counts. */
const NO_ROW_NOTICES: ReadonlySet<NotificationKind> = new Set(['morning_summary'])

/** Where a notice that is not part of a listed row goes. */
export function noticePlace(kind: NotificationKind, turnComplete: boolean, settled = false): 'stop' | 'done' | 'waiting' {
  if (settled) return 'done'
  if (STOP_NOTICES[kind]) return 'stop'
  if (DONE_WORDS[kind]) return 'done'
  if (CHANGE_WORDS[kind] && turnComplete) return 'done'
  return 'waiting'
}


const RANK = { stopped: 0, unsure: 1, approval: 2, mail: 3, check: 4, other: 5 } as const

/**
 * 「ブラウザ操作」 rows (the member's own, `browserPlans:list`; none while the switch is off on this PC): a draft
 * waits for their approval, a run nobody knows the result of waits for their 「済んでいた」/「されていなかった」 once
 * it can be pressed (until then, and while one may be sending, 作業中), an approved plan not started is 作業中.
 * Every row only opens the card; a settled plan is in neither server list, so it is gone (nothing is stored).
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
      ? { ...base(p.planId, title, p.createdAt), state: 'waiting', rank: RANK.approval, line: 'サイトから読み取った中身と届く時を確かめてから、カードで任せてください', badge: { tone: 'awaitingApproval', word: STOP_LOOK.awaitingApproval.word }, actionLabel: '承認する…' }
      : { ...base(p.planId, title, p.createdAt), state: 'working', rank: RANK.other, line: '承認しました。様子はカードで見られます', badge: { tone: 'neutral', word: '承認しました' }, actionLabel: '開く…' })
  }
  // A plan claimed for a run has left the open list; its run is the one row (the later list wins anyway).
  for (const e of b.unsure) {
    // The server's word (its clocks), not this PC's clock: the inbox reads again once `confirmableAt` has passed.
    const due = e.state === 'unknown' && e.canConfirm
    rows.set(e.planId, due
      ? { ...base(e.planId, e.label, e.permittedAt), state: 'waiting', rank: RANK.unsure, line: 'サイトで確かめて、済んでいたかどうかをカードで押してください', badge: { tone: 'needsAction', word: '届いたか分かりません' }, actionLabel: '確かめる…' }
      : { ...base(e.planId, e.label, e.permittedAt), state: 'working', rank: RANK.other, line: 'しばらくすると、届いたかどうかをカードで確かめられます', badge: { tone: 'neutral', word: '結果を待っています' }, actionLabel: '開く…' })
  }
  return [...rows.values()]
}

function turnRow(item: TurnItem): InboxItem {
  const r = { type: item.type, state: item.state }
  const thing = thingKindOf(r)
  const base = { key: `record:${item.id}`, state: 'waiting' as const, thing, title: item.title, source: thingName(r), due: item.due, at: null, unreadNoticeIds: [] }
  if (thing === 'approval') {
    // The approver's request waits for their approval; a request sent back waits for its requester to fix it.
    return item.state === 'sent_back'
      ? { ...base, rank: RANK.approval, line: '差し戻されました。直して出し直すか、取り下げてください', badge: { tone: 'needsAction', word: '差し戻されました' }, action: { kind: 'openApprovalCard', approvalId: item.id }, actionLabel: '開く…' }
      : { ...base, rank: RANK.approval, line: '中身・相手・いつ反映されるかを確かめてから承認してください', badge: { tone: 'awaitingApproval', word: '承認を待っています' }, action: { kind: 'openApprovalCard', approvalId: item.id }, actionLabel: '承認する…' }
  }
  if (thing === 'outbound') {
    return { ...base, rank: RANK.mail, line: '送る前に、宛先と中身を確かめてください', badge: { tone: 'awaitingApproval', word: '確かめて送る' }, action: { kind: 'openMailDraft', messageId: item.id }, actionLabel: '確かめて送る…' }
  }
  const check = thing === 'minutes_check' || item.state === 'review'
  const line = item.waitCameBack ? '返事の見込みを過ぎました。追いかけてください' : check ? '中身を確かめてください' : 'あなたの番です'
  return { ...base, rank: check ? RANK.check : RANK.other, line, badge: { tone: 'neutral', word: check ? '確かめる' : 'あなたの番' }, action: { kind: 'openRecord', recordId: item.id, title: item.title }, actionLabel: '開く' }
}

/**
 * A meeting of a department without the task list (what the title bar's 「あなたの番」 and bell carried
 * before I2): one waiting for the member is あなた待ち (a stopped reading first, by its meaning), one the
 * AI is reading or will read is 作業中.
 */
function meetingRow(m: MeetingTurn): InboxItem {
  const base = {
    key: `record:${m.id}`, thing: 'meeting' as const, title: m.title, line: m.text, source: m.kind === 'bundle' ? '会議' : '議事録',
    due: null, at: null, unreadNoticeIds: [], meetingId: m.id,
    action: { kind: 'openRecord' as const, recordId: m.id, title: m.title }, actionLabel: '開く',
  }
  if (!m.needsPerson) return { ...base, state: 'working', rank: RANK.other, badge: { tone: 'ai', word: m.ai?.state === 'waiting' ? 'AI が読む予定' : 'AI が読んでいます' } }
  const stop: StopMeaning | null = m.ai?.state === 'failed' ? 'failed' : m.ai?.state === 'not-allowed' ? 'needsAction' : null
  if (stop) return { ...base, state: 'waiting', rank: RANK.stopped, badge: { tone: stop, word: STOP_LOOK[stop].word } }
  return { ...base, state: 'waiting', rank: RANK.check, badge: { tone: 'neutral', word: m.kind === 'bundle' ? '選んでください' : m.ai ? 'あなたの番' : '議事録が届きました' } }
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

function noticeRow(n: NotificationItem, state: InboxState, rank: number, badge: InboxItem['badge']): InboxItem {
  const action = noticeAction(n)
  const recordKind = n.recordId ? thingKindOf({ type: n.recordType }) : null
  const undo = undoOf(n)
  return {
    key: `notice:${n.id}`, state, rank, thing: recordKind ?? 'notice',
    title: n.recordTitle || (n.kind.startsWith('job_') ? '定期の仕事' : '知らせ'),
    line: n.text, badge,
    source: '知らせ',
    due: null, at: n.createdAt, unreadNoticeIds: n.read ? [] : [n.id],
    action, actionLabel: action.kind === 'none' ? '確認した' : '開く',
    // In every state: a change that can be undone keeps its button wherever its notice lands (as the bell had it).
    ...(undo ? { undo } : {}),
  }
}

/** Within あなた待ち: by rank, then the nearest due (none last), then the newest. */
function byNeed(a: InboxItem, b: InboxItem): number {
  if (a.rank !== b.rank) return a.rank - b.rank
  if (a.due !== b.due) return a.due === null ? 1 : b.due === null ? -1 : a.due < b.due ? -1 : 1
  return (b.at ?? '').localeCompare(a.at ?? '')
}
const newestFirst = (a: InboxItem, b: InboxItem) => (b.at ?? '').localeCompare(a.at ?? '')

export interface InboxView {
  waiting: InboxItem[]
  working: InboxItem[]
  /** できた・未確認 of the last DONE_KEEP_DAYS days, newest first. */
  done: InboxItem[]
  /** できた・未確認 older than that: one line, 「まとめて確認済みにする」. */
  olderDone: { count: number; noticeIds: string[] }
  /** Notices already read whose notice came today (on this PC's clock): 「きょう確認したもの」. */
  seenToday: InboxItem[]
  /** The other read notices of the server's list (its newest 50), newest first: 「前に確認したもの」, folded. */
  seenBefore: InboxItem[]
  /** Unread notices the server counts but did not list (past its newest 50): told, never dropped. */
  unreadNotListed: number
  /** あなた待ち the server counted but did not list (past its first 200): never hidden, only told. */
  waitingNotListed: number
  /** This week's turn does not hold them (`thisWeeksTurn`): 「先のこと」「いつか」 in the task list. */
  resting: number
  /** できた rows left out to keep the list at INBOX_MAX_ROWS. */
  doneLeftOut: number
  /** Every できた・未確認 notice, shown or left out (what 「まとめて確認済みにする」 marks). */
  doneNoticeIds: string[]
  counts: Record<InboxFilter, number>
}

const sameLocalDay = (iso: string, now: Date) => {
  const d = new Date(iso)
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
}

/**
 * The inbox from what main read for the company on screen (`NoticesState`) and the meetings of a department
 * without the task list. One record is one row: an unread notice about a record in あなた待ち becomes that
 * row's line and new mark, not a row of its own.
 */
export function inboxView(source: NoticesState, now: Date, meetings: readonly MeetingTurn[] = [], browser?: BrowserInboxPlans): InboxView {
  const turn = source.available ? source.myTurn : { total: 0, items: [] as TurnItem[] }
  const rows = new Map<string, InboxItem>()
  for (const item of turn.items) rows.set(item.id, turnRow(item))
  // A meeting the AI reads is one row too (作業中): its unread notices are its news, not rows of their own.
  // One already in the server's turn stays that row and keeps the meeting's own buttons.
  for (const m of meetings) {
    const listed = rows.get(m.id)
    if (listed) listed.meetingId = m.id
    else rows.set(m.id, meetingRow(m))
  }

  const waiting: InboxItem[] = []
  const done: InboxItem[] = []
  const seenToday: InboxItem[] = []
  const seenBefore: InboxItem[] = []
  const oldIds: string[] = []
  const keepFrom = now.getTime() - DONE_KEEP_DAYS * 24 * 60 * 60 * 1000
  // Newest first, so a row's line is its newest unread notice. With records off, main still hands the company's
  // own notices (`bellOnly`, the list's `available` false): those are rows too.
  const notices = source.available ? [...source.notices.items].sort((a, b) => b.createdAt.localeCompare(a.createdAt)) : []
  const turnComplete = turn.total <= turn.items.length
  const stopBadge = (m: StopMeaning) => ({ tone: m, word: STOP_LOOK[m].word })
  const badgeOf = (n: NotificationItem, place: 'stop' | 'done' | 'waiting') => place === 'stop' ? stopBadge(STOP_NOTICES[n.kind]!)
    : place === 'done' ? (n.settled === true ? SETTLED_WORDS : DONE_WORDS[n.kind] ?? CHANGE_WORDS[n.kind]!) : { tone: 'neutral' as const, word: ASK_WORDS[n.kind] ?? 'あなたの番' }
  for (const n of notices) {
    if (NO_ROW_NOTICES.has(n.kind)) continue
    const place = noticePlace(n.kind, turnComplete, n.settled === true)
    // Every read notice the server listed stays findable (the bell showed them, ［元に戻す］ included): folded at the bottom.
    if (n.read) {
      const seen = noticeRow(n, 'done', 0, badgeOf(n, place))
      if (sameLocalDay(n.createdAt, now)) seenToday.push(seen)
      else seenBefore.push(seen)
      continue
    }
    const row = n.recordId ? rows.get(n.recordId) : undefined
    const stop = STOP_NOTICES[n.kind]
    if (row) {
      if (row.unreadNoticeIds.length === 0) { row.line = n.text; row.at = n.createdAt }
      row.unreadNoticeIds.push(n.id)
      // Its newest change that can be undone keeps ［元に戻す］ on the one row.
      if (!row.undo) { const undo = undoOf(n); if (undo) row.undo = undo }
      // A stop about a waiting record makes that row a stop (its look and its place first).
      if (stop && row.rank !== RANK.stopped) { row.badge = stopBadge(stop); row.rank = RANK.stopped; row.line = n.text; row.state = 'waiting' }
      continue
    }
    // Gone once opened: the server keeps no 「済んだ」 for these (decision ③).
    if (place !== 'done') waiting.push(noticeRow(n, 'waiting', place === 'stop' ? RANK.stopped : RANK.other, badgeOf(n, place)))
    else if (new Date(n.createdAt).getTime() < keepFrom) oldIds.push(n.id)
    else done.push(noticeRow(n, 'done', 0, badgeOf(n, place)))
  }
  const listedUnread = source.available ? source.notices.items.filter(n => !n.read).length : 0
  const unreadNotListed = source.available ? Math.max(0, source.notices.unread - listedUnread) : 0
  const own = [...rows.values(), ...(browser ? browserRows(browser) : [])]
  const working = own.filter(r => r.state === 'working')
  waiting.push(...own.filter(r => r.state === 'waiting'))
  waiting.sort(byNeed)
  done.sort(newestFirst)
  const room = Math.max(0, INBOX_MAX_ROWS - waiting.length)
  const shownDone = done.slice(0, room)
  const waitingNotListed = Math.max(0, turn.total - turn.items.length)
  const waitingCount = waiting.length + waitingNotListed
  const doneCount = done.length + oldIds.length
  return {
    waiting, working, done: shownDone, seenToday, seenBefore, unreadNotListed,
    olderDone: { count: oldIds.length, noticeIds: oldIds },
    waitingNotListed, resting: turn.resting ?? 0, doneLeftOut: done.length - shownDone.length,
    doneNoticeIds: [...done.flatMap(i => i.unreadNoticeIds), ...oldIds],
    counts: { all: waitingCount + working.length + doneCount + unreadNotListed, waiting: waitingCount, working: working.length, done: doneCount },
  }
}

/**
 * 「まとめて確認済みにする」: only できた・未確認 (owner decision ⑦) — the notices of the done rows and the
 * folded older ones. Never a notice of あなた待ち (a stop, a row's own news), and never 「すべて」 on the
 * server: those must be opened one by one.
 */
export function bulkSeenIds(view: InboxView, scope: 'older' | 'done'): string[] {
  if (scope === 'older') return [...view.olderDone.noticeIds]
  return [...view.doneNoticeIds]
}

/** At most this many keys stand for the unread notices the server did not list (one key each, so only growth is news). */
const UNLISTED_NEWS_KEYS = 1000

/**
 * What the title bar's ［受け箱］ dot compares (owner decision ①: the dot = something new since the inbox was
 * last on screen): every waiting / working row by key and state, every unread notice, and one key per unread
 * notice the server counted but did not list. With `filter`, only what that chip shows (what the member saw).
 */
export function inboxNewsKeys(view: InboxView, filter: InboxFilter = 'all'): string[] {
  const keys = new Set<string>()
  const shows = (state: InboxState) => filter === 'all' || filter === state
  for (const i of [...view.waiting, ...view.working]) {
    if (!shows(i.state)) continue
    // By state too: a meeting the AI was reading that now waits for the member is new.
    keys.add(`${i.key}#${i.state}`)
    for (const id of i.unreadNoticeIds) keys.add(`notice:${id}`)
  }
  if (shows('done')) {
    // Every できた・未確認 notice, also one the row limit left out or the 14-day line folded.
    for (const id of view.doneNoticeIds) keys.add(`notice:${id}`)
    for (let k = 1; k <= Math.min(view.unreadNotListed, UNLISTED_NEWS_KEYS); k++) keys.add(`unlisted:${k}`)
  }
  return [...keys]
}

/**
 * What counts as already seen before the inbox was ever on screen in this window: the waiting and working
 * rows (the count says those), never an unread notice — so at the start the dot is the old bell's (something
 * unread on the server, shared by the member's PCs).
 */
export function inboxNewsBaseline(view: InboxView): string[] {
  return [...view.waiting, ...view.working].map(i => `${i.key}#${i.state}`)
}

/** The dot: a key that was not there when the inbox was last on screen. */
export const hasInboxNews = (keys: readonly string[], seen: ReadonlySet<string>) => keys.some(k => !seen.has(k))

/**
 * What counts as seen while the panel shows: exactly what the chosen chip shows now (a row that left and comes
 * back later is new again), plus what was seen before of the rest that is still there (hidden by the chip, so
 * neither newly seen nor forgotten).
 */
export function seenWhileShown(seen: ReadonlySet<string>, all: readonly string[], shown: readonly string[]): Set<string> {
  const next = new Set(shown)
  for (const k of all) if (seen.has(k)) next.add(k)
  return next
}

export const sameKeys = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size === b.size && [...a].every(k => b.has(k))

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
