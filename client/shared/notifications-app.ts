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
  myTurn: { total: number; items: TurnItem[] }
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
