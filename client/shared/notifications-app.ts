/**
 * The title bar's 「あなたの番 N」 and the bell (知らせ) in the app (stage 2 S5,
 * `.claude/rules/notifications.md` "The app"). Pure: main (the watcher) and
 * the renderer use it. Both are drawn by the core app only; a plugin never
 * draws a notice.
 */
import type { NotificationItem, NotificationKind, NotificationList } from '../../shared/types/notifications'

/** One record waiting for the member (「あなたの番」: `GET /records/my-turn`). */
export interface TurnItem {
  id: string
  type: string
  title: string
  state: string | null
  /** `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM`, or null. */
  due: string | null
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

/**
 * Opening a record from 「あなたの番」 or the bell while the app has no card
 * screen yet: a new consultation titled after the record, with this text in
 * its input (nothing is sent; the AI looks the record up by its id).
 */
export function consultationDraftFor(target: NoticeTarget): { title: string; draft: string } {
  const title = target.title.slice(0, 100) || '記録について'
  return { title, draft: `「${title}」（${target.recordId}）について、` }
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
  return next.filter(i => !before.has(i.id))
}

/** The Mac notification's words for one new item (the app's own words; no other content). */
export function desktopNoticeFor(item: TurnItem): { title: string; body: string } {
  return item.type === 'approval'
    ? { title: '承認のお願いが来ました', body: item.title }
    : { title: 'あなたの番に新しく来ました', body: item.title }
}

export type { NotificationItem, NotificationKind, NotificationList }
