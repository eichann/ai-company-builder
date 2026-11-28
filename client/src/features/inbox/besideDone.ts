// The card beside the inbox's list, and the one way its press reaches the list (notifications.md "Working through the
// inbox"): an approval, a mail draft, a browser plan or a 連絡 finished on its card all hand the list the same `finishBeside`.
// A card is bound to the company era it was opened in (shared/lib/companyEra.ts): a press answered after another company
// or a sign-out moves nothing and says nothing — the last company's 件名 never reaches the next company's list, whatever
// kind the card is. Pure TypeScript: the slot (hooks/useInboxSlot.tsx) hands in what moves the list.
import { currentCompanyEra, inEra, type CompanyEra } from '../../shared/lib/companyEra'
import { endedWords, orderOf, setWorkNotice, undoOfEnded, type WorkUndoAnswer } from '../../shared/lib/workThrough'
import type { BesideCard } from './workModel'

/** The list worked through (tasks-ui.md "Working through a list"): one per screen, like the やること list's. */
export const INBOX_WORK_KEY = 'inbox'

/**
 * The card shown beside the list: the row it belongs to (null: a draft opened from a contact's card), its title, where
 * that row stood when opened (the next one's place if the row leaves the list before the card's press answers), and
 * the company era it was opened in (only `openBeside` makes one, so no card lacks it).
 */
export type Beside = BesideCard & { rowKey: string | null; title: string; readKey: string; at: number; readonly era: CompanyEra }

/** A card opened beside the list now: it answers into this era only. */
export const openBeside = (card: BesideCard, row: { rowKey: string | null; title: string; readKey: string; at: number }): Beside =>
  ({ ...card, ...row, era: currentCompanyEra() })

export interface BesideDoneDeps {
  /** `useWorkThrough.ended`: the next row when the finished one is the row shown. */
  ended: (rowKey: string, title: string, undo?: () => Promise<WorkUndoAnswer>) => 'next' | 'last' | null
  /** `useWorkThrough.show`. */
  show: (rowKey: string) => void
  /** The card beside the list now (it may be another one than the finished card). */
  current: () => Beside | null
  /** The card goes (the last one, or nothing came next). */
  close: () => void
  /** The browser plans read again (a card closed). */
  readPlansAgain: () => void
  /** Whether the era still holds (injected in tests). */
  holds?: (started: CompanyEra) => boolean
}

/**
 * The card `done` was finished there (approved, sent, 済んだ…): the next row takes its place, and the list says so with
 * ［取り消す］ when the press can be taken back (tasks-ui.md "Working through a list"). The last one: the card goes. In
 * another era than the card's, nothing at all.
 */
export function finishBeside(done: Beside, undo: (() => Promise<WorkUndoAnswer>) | undefined, deps: BesideDoneDeps): void {
  if (!(deps.holds ?? inEra)(done.era)) return
  deps.readPlansAgain()
  // `ended` moves on only while that card's row is the one shown; a press answered after the member opened another
  // card changes nothing on screen (that other card stays as it is).
  const next = done.rowKey ? deps.ended(done.rowKey, done.title, undo) : null
  if (next === 'next') return
  const current = deps.current()
  const stillShown = !!current && current.kind === done.kind && current.id === done.id
  // The list read again before the press answered and the row is already gone: the row now in its place comes next.
  const now = orderOf(INBOX_WORK_KEY)
  if (next === null && stillShown && done.rowKey && !now.includes(done.rowKey) && now.length > 0) {
    deps.show(now[Math.min(done.at, now.length - 1)])
    setWorkNotice(INBOX_WORK_KEY, { text: endedWords(done.title, false), undo: undo ? undoOfEnded(INBOX_WORK_KEY, done.rowKey, done.title, undo, deps.show) : null })
    return
  }
  if (stillShown) deps.close()
}
