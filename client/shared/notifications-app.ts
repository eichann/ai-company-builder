/**
 * The title bar's 「あなたの番 N」 and the bell (知らせ) in the app (stage 2 S5,
 * `.claude/rules/notifications.md` "The app"). Pure: main (the watcher) and
 * the renderer use it. Both are drawn by the core app only; a plugin never
 * draws a notice.
 */
import type { NotificationItem, NotificationKind, NotificationList } from '../../shared/types/notifications'
import type { AiTurnItemView } from './ai-turns'
import { MEETING_NEEDS_BUNDLE_TEXT, meetingBundleWords, meetingSuggestedBundleText, type TaskListItem } from './tasks'
import { thingKindOf, thingName, TURN_ASKS, turnGroupLine, type ThingKind } from './thing-words'

/** One record waiting for the member (「あなたの番」: `GET /records/my-turn`). */
export interface TurnItem {
  id: string
  type: string
  title: string
  state: string | null
  /** `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM`, or null. */
  due: string | null
  /** The server clock gave it back: its 返事の見込み passed (`waitCameBack`, task version 12). */
  waitCameBack?: true
  /**
   * Not this week's (shared/core/turn-timing.ts): a task not started, nothing to press, due after
   * this week (`later`) or with no due (`someday`). Absent = this week's turn (counted).
   */
  timing?: 'later' | 'someday'
}

/**
 * The title bar's 「あなたの番」 from the server's whole turn: only this week's items, counted (the
 * server's morning summary counts the same); `resting` = those left for the list's 「先のこと」 /
 * 「いつか」. Items past the server's first 200 are counted as this week's (never hidden).
 */
export function thisWeeksTurn(items: readonly TurnItem[], total: number): NoticesState['myTurn'] {
  const week = items.filter(i => !i.timing)
  const resting = items.length - week.length
  return { total: week.length + Math.max(0, total - items.length), items: week, ...(resting > 0 ? { resting } : {}) }
}

/**
 * What 「new in あなたの番」 compares: the record, and whether its wait came back — a 返事待ち task
 * was already in the list while it waited, so coming back is news of its own (one notice).
 */
export function turnItemKey(item: TurnItem): string {
  return item.waitCameBack ? `${item.id}#back` : item.id
}

/** 「あなたの番」 by kind (I.2): 「承認のお願い 3件 — 承認してください」 and its items, in the order first met. */
export interface TurnGroup {
  kind: ThingKind
  /** The kind's plain name and count, with what to do (`turnGroupLine`). */
  line: string
  items: TurnItem[]
}

export function turnGroups(items: readonly TurnItem[]): TurnGroup[] {
  const groups = new Map<string, { kind: ThingKind; name: string; items: TurnItem[] }>()
  for (const i of items) {
    const r = { type: i.type, state: i.state }
    const name = thingName(r)
    const g = groups.get(name) ?? { kind: thingKindOf(r), name, items: [] }
    g.items.push(i)
    groups.set(name, g)
  }
  return [...groups.values()].map(g => ({ kind: g.kind, line: turnGroupLine(g.name, g.items.length, TURN_ASKS[g.kind]), items: g.items }))
}

/** What main answers the renderer for one company. */
export interface NoticesState {
  /** false: the company's records are off (or nothing could be read yet) — no title bar parts. */
  available: boolean
  /** This week's turn (`thisWeeksTurn`): what the title bar lists and counts. */
  myTurn: { total: number; items: TurnItem[]; resting?: number }
  notices: NotificationList
}

export const NO_NOTICES: NoticesState = {
  available: false,
  myTurn: { total: 0, items: [] },
  notices: { available: false, unread: 0, items: [] },
}

export type NoticesActionResult = { success: true } | { success: false; error: string }

export const NOTICES_OFFLINE_TEXT = 'サーバーにつながりませんでした。少し待ってからもう一度お試しください。'

/** A record the member opens from the lists. */
export interface NoticeTarget {
  recordId: string
  title: string
}

/** `2026-11-05` → 11/5, `2026-11-05T15:00` → 11/5 15:00. */
export function shortDue(due: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}:\d{2}))?$/.exec(due)
  return m ? `${Number(m[2])}/${Number(m[3])}${m[4] ? ` ${m[4]}` : ''}` : due
}

/**
 * The Mac notifications (E-27): only an approval request or a new item in
 * 「あなたの番」 — the items in `next` that were not in `before`. The first
 * look at a company (`before` null) notifies nothing: what was already waiting
 * is not news.
 */
export function newTurnItems(before: ReadonlySet<string> | null, next: TurnItem[]): TurnItem[] {
  if (before === null) return []
  return next.filter(i => !before.has(turnItemKey(i)))
}

/** The Mac notification's words for one new item (the app's own words; no other content). */
export function desktopNoticeFor(item: TurnItem): { title: string; body: string } {
  return item.type === 'approval'
    ? { title: '承認のお願いが来ました', body: item.title }
    : item.waitCameBack
      ? { title: '返事の見込みを過ぎました（あなたの番に戻りました）', body: item.title }
      : { title: 'あなたの番に新しく来ました', body: item.title }
}

/** What clicking a Mac notification opens: the task list (the morning summary), else just the app. */
export type DesktopTarget = 'tasks' | 'app'

export interface DesktopNotice {
  /** The notice's id (kept as shown on this PC), or `turn:<item key>` for a new item in あなたの番. */
  key: string
  title: string
  body: string
  target: DesktopTarget
}

/** At most this many Mac notifications per check. */
export const DESKTOP_NOTICES_PER_CHECK = 3

/**
 * The Mac notifications of one check (E-27, owner decision 2026-11-03), all
 * from what the server answered (never from a signal):
 * - the server's fresh notices (`desktop`: 「今日のあなたの番」, 「明日が期限」,
 *   「〇〇さんから頼まれました」) not yet shown on this PC (`shown`, kept across
 *   restarts) — also on the first look, since the server decides freshness;
 * - the items new in 「あなたの番」 (`newTurnItems`: never on the first look),
 *   except a record whose `asked` notice speaks for it — one notification for
 *   one request, in the asker's words.
 */
export function desktopNoticesOf(before: ReadonlySet<string> | null, turn: TurnItem[], notices: readonly NotificationItem[], shown: ReadonlySet<string>): DesktopNotice[] {
  const fresh = notices.filter(n => n.desktop && !n.read)
  const askedFor = new Set(fresh.filter(n => n.kind === 'asked').map(n => n.recordId))
  const out: DesktopNotice[] = fresh.filter(n => !shown.has(n.id)).map(n => ({
    key: n.id, title: n.desktop!.title, body: n.desktop!.body, target: n.kind === 'morning_summary' ? 'tasks' as const : 'app' as const,
  }))
  for (const item of newTurnItems(before, turn)) {
    if (askedFor.has(item.id) && !item.waitCameBack) continue
    out.push({ key: `turn:${turnItemKey(item)}`, ...desktopNoticeFor(item), target: 'app' })
  }
  return out.slice(0, DESKTOP_NOTICES_PER_CHECK)
}

/**
 * What the task list would show about meetings, for a department that does not show the list
 * (tasks-ui.md "Minutes and AI turns"): the title bar carries it instead, so nothing waits
 * unseen. `minutes`: a received meeting in 「AI の番」, with where the AI stands; `bundle`:
 * 「どのまとまりの会議ですか？」. `needsPerson`: it waits for the member (counted in 「あなたの番」,
 * the bell's dot) — a まとまり to choose, or minutes the AI will not read by itself (stopped,
 * handed over, cannot start here, or nothing heard from the runner).
 */
export interface MeetingTurn {
  id: string
  title: string
  kind: 'minutes' | 'bundle'
  /** In plain Japanese: what it is and where it stands. */
  text: string
  needsPerson: boolean
  ai: AiTurnItemView | null
  /** `bundle` only: the server's one suggested まとまり (はい links it). */
  suggestedBundle?: { id: string; title: string }
}

const AI_WORDS: Record<AiTurnItemView['state'], string> = {
  running: 'AI が読み取っています',
  waiting: 'AI が読み取る予定です',
  'not-allowed': 'AI では読み取れません',
  failed: 'AI が読み取れませんでした',
  handed: 'あなたに渡されました',
}

/** `word`: the department's kind's name (「案件」), so the question never says 「まとまり」. */
export function meetingTurns(items: readonly TaskListItem[], ai: readonly AiTurnItemView[], word?: string): MeetingTurn[] {
  const out: MeetingTurn[] = []
  const ask = word ? meetingBundleWords(word).ask : MEETING_NEEDS_BUNDLE_TEXT
  for (const i of items) {
    if (i.needsBundle) {
      const s = i.suggestedBundle
      out.push({ id: i.id, title: i.title, kind: 'bundle', text: s ? meetingSuggestedBundleText(s.title) : ask, needsPerson: true, ai: null, ...(s ? { suggestedBundle: s } : {}) })
    } else if (i.type === 'meeting' && i.turn === 'ai') {
      const view = ai.find(a => a.recordId === i.id) ?? null
      const words = view ? (view.reason ? `${AI_WORDS[view.state]}：${view.reason}` : AI_WORDS[view.state]) : '議事録が届きました'
      out.push({ id: i.id, title: i.title, kind: 'minutes', text: words, needsPerson: !view || (view.state !== 'running' && view.state !== 'waiting'), ai: view })
    }
  }
  return out
}

export type { NotificationItem, NotificationKind, NotificationList }
