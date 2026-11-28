// Working through the inbox (UX 点検 11, owner decisions 2026-11-28; notifications.md "Working through the inbox"): which
// rows a look shows — the chip (あなた待ち / 新着 / 確認したもの), the kind (止まった・承認・連絡・メール・知らせ), the 新着 opened in
// this look kept in their place, 15 rows first and the rest as the member goes down — and which rows open beside the list.
// Pure: no React, no IPC. It only narrows what `inboxView` built (model.ts); it never decides a row's place or a count's
// rule, and never shows a row the server's answers did not hold.
import type { InboxFilter, InboxItem, InboxView } from './model'

/** Rows first shown, and how many more each time the member reaches the end (owner decision 11番-4). */
export const INBOX_PAGE = 15

/** The kinds the list narrows to (one chip each, 「すべて」 first). */
export type InboxKind = 'all' | 'stop' | 'approval' | 'contact' | 'notice'

export const INBOX_KINDS: ReadonlyArray<{ id: InboxKind; label: string }> = [
  { id: 'all', label: 'すべて' },
  { id: 'stop', label: '止まった' },
  { id: 'approval', label: '承認' },
  { id: 'contact', label: '連絡・メール' },
  { id: 'notice', label: '知らせ' },
]

/** A 来た連絡, its 返事のお願い and a mail to send or sent: 「連絡・メール」 (also before the contact was read). */
const CONTACT_THINGS: ReadonlySet<InboxItem['thing']> = new Set(['incoming', 'reply_request', 'outbound', 'sent'])

/** What a row is about, for the kind chips: a stop first, then by what it opens or is. */
export function kindOf(item: InboxItem): Exclude<InboxKind, 'all'> {
  if (item.stop) return 'stop'
  if (item.action.kind === 'openContact' || item.action.kind === 'openMailDraft' || CONTACT_THINGS.has(item.thing)) return 'contact'
  if (item.thing === 'approval') return 'approval'
  return 'notice'
}

/** The sections one look draws, in order (a section the chip does not show is empty). */
export interface InboxSections {
  waiting: InboxItem[]
  news: InboxItem[]
  moving: InboxItem[]
  seen: InboxItem[]
}

const allRows = (s: InboxSections) => [...s.waiting, ...s.news, ...s.moving, ...s.seen]

const newestFirst = (a: InboxItem, b: InboxItem) => (b.at ?? '').localeCompare(a.at ?? '')

/**
 * 新着 with the rows opened in this look kept where they were (decision 11番-3): a row the member opened is read on the
 * server and leaves `view.news` for `view.seen`; until the chips change it stays in 新着's order, without its dot and
 * uncounted — drawn from the server's row of now (`view.seen`), never from memory: a row the server no longer lists (gone,
 * or no longer theirs to read) is not kept. A kept row that is now あなた待ち (a stop came about it) is that row only.
 */
export function withLingering(view: InboxView, lingering: ReadonlySet<string>): InboxItem[] {
  if (lingering.size === 0) return view.news
  const kept = view.seen.filter(i => lingering.has(i.key)).map(i => ({ ...i, section: 'new' as const, seenHere: true as const }))
  return [...view.news, ...kept].sort(newestFirst)
}

/** The sections of a chip, before the kind narrows them: 「新着」 shows あなた待ち, 新着 and what moves on by itself. */
export function sectionsOf(view: InboxView, filter: InboxFilter, lingering: ReadonlySet<string>): InboxSections {
  const none: InboxItem[] = []
  if (filter === 'seen') return { waiting: none, news: none, moving: none, seen: view.seen }
  if (filter === 'waiting') return { waiting: view.waiting, news: none, moving: none, seen: none }
  return { waiting: view.waiting, news: withLingering(view, lingering), moving: view.moving, seen: none }
}

/**
 * Each kind's count over the sections a chip shows (「すべて」 = all of them), counted as the headings count: never what moves
 * on by itself nor a 新着 opened in this look (they are shown, never counted).
 */
export function kindCounts(sections: InboxSections): Record<InboxKind, number> {
  const counts: Record<InboxKind, number> = { all: 0, stop: 0, approval: 0, contact: 0, notice: 0 }
  for (const item of [...sections.waiting, ...sections.news, ...sections.seen]) {
    if (item.seenHere) continue
    counts.all++
    counts[kindOf(item)]++
  }
  return counts
}

/**
 * Whether the kind chips show (owner decision 2026-11-28, 20番-8): not while the look has nothing at all (a first day's
 * row of zeros says nothing). A chosen kind other than 「すべて」 keeps them, so the member can always go back.
 */
export function showsKindChips(kind: InboxKind, sections: InboxSections): boolean {
  return kind !== 'all' || allRows(sections).length > 0
}

export function narrowed(sections: InboxSections, kind: InboxKind): InboxSections {
  if (kind === 'all') return sections
  const keep = (rows: InboxItem[]) => rows.filter(i => kindOf(i) === kind)
  return { waiting: keep(sections.waiting), news: keep(sections.news), moving: keep(sections.moving), seen: keep(sections.seen) }
}

/** The order the list shows, top to bottom (what ↑ ↓ go over and 「3 / 11」 counts): every row, drawn or still to come. */
export const orderOf = (sections: InboxSections): string[] => allRows(sections).map(i => i.key)

/** The first `limit` rows across the sections, in order, and how many are left for the member going down. */
export function paged(sections: InboxSections, limit: number): { sections: InboxSections; left: number } {
  let room = limit
  const take = (rows: InboxItem[]) => { const out = rows.slice(0, Math.max(0, room)); room -= out.length; return out }
  const out = { waiting: take(sections.waiting), news: take(sections.news), moving: take(sections.moving), seen: take(sections.seen) }
  return { sections: out, left: allRows(sections).length - allRows(out).length }
}

/** The rows to draw so that `key` is among them (a ↓ past the last drawn row): the next page boundary at or after it. */
export function limitShowing(order: readonly string[], key: string, limit: number): number {
  const i = order.indexOf(key)
  return i < limit ? limit : Math.ceil((i + 1) / INBOX_PAGE) * INBOX_PAGE
}

/**
 * The kind chips on one line (decision 11番-6): when they do not fit, 「すべて」 and the first two stay and the rest go
 * under 「その他」, which names the chosen one when it is among them.
 */
export function foldKinds(narrow: boolean): { shown: InboxKind[]; folded: InboxKind[] } {
  const ids = INBOX_KINDS.map(k => k.id)
  return narrow ? { shown: ids.slice(0, 3), folded: ids.slice(3) } : { shown: ids, folded: [] }
}

/** A row whose card opens beside the list (the card's own buttons act; nothing from the row). */
export type BesideCard =
  | { kind: 'approval'; id: string }
  | { kind: 'mail'; id: string }
  | { kind: 'browser'; id: string }
  | { kind: 'contact'; id: string }

export function besideCardOf(item: InboxItem): BesideCard | null {
  const a = item.action
  if (a.kind === 'openApprovalCard') return { kind: 'approval', id: a.approvalId }
  if (a.kind === 'openMailDraft') return { kind: 'mail', id: a.messageId }
  if (a.kind === 'openBrowserPlan') return { kind: 'browser', id: a.planId }
  if (a.kind === 'openContact') return { kind: 'contact', id: a.contactId }
  return null
}
