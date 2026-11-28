// A press on 「連絡」1枚 and its ［取り消す］ (inbox.md "One contact"): one request, then the card reads the contact again —
// answered, refused or not reached alike. Bound to the company era it started in (shared/lib/companyEra.ts): an answer that
// comes back after a company change or a sign-out says nothing and reads nothing (the request itself was the last
// company's and stays so). Pure TypeScript: the card hands in its ports and what it shows.
import { STILL_ARCHIVED_TEXT, type ContactFinishAnswer, type ContactFinishRequest, type ContactReplyEnd, type ContactUndoAnswer, type ContactUndoRequest } from '../../../shared/contact-card'
import { finishedWords, refusalWords, undoneWords, undoRequestOf } from './contactModel'
import { SCREEN_ERA, type EraPort } from './contactStore'

/** A finish to send again exactly as it was: its answer was lost, and it may have been written. */
export interface ContactResend { request: ContactFinishRequest; end: ContactReplyEnd; hadDrafts: boolean }

/**
 * What the card says after a press: the words, whether it was refused, what ［取り消す］ would send, and — when the press
 * did not reach the server, or its answer was lost — the same press to send again (the server answers `already` for a
 * part it wrote then, with the entry to take back).
 */
export interface ContactSaid { text: string; refused: boolean; undo: ContactUndoRequest | null; resend?: ContactResend }

interface PressDeps {
  era?: EraPort
  /** Shown on the card (only while the era holds). */
  say: (said: ContactSaid) => void
  /** The contact read again (only while the era holds). */
  reread: () => void
}

export async function pressFinish(send: (request: ContactFinishRequest) => Promise<ContactFinishAnswer>, press: ContactResend, deps: PressDeps): Promise<void> {
  const era = deps.era ?? SCREEN_ERA
  const started = era.now()
  const r = await send(press.request)
  if (!era.holds(started)) return
  deps.say(r.success
    ? { text: finishedWords(press.end, r.result, press.hadDrafts), refused: false, undo: undoRequestOf(r.result) }
    : { text: refusalWords(r, 'finish'), refused: true, undo: null, ...(r.offline ? { resend: press } : {}) })
  deps.reread()
}

/**
 * `stillArchived`: after the contact's own part came back, whether its mail stays archived in Gmail (the server's
 * ledger: ACB's archive note after the finish) — then the words say so (owner decision 2026-11-29: Gmail is not put back).
 */
export async function pressUndo(send: (request: ContactUndoRequest) => Promise<ContactUndoAnswer>, request: ContactUndoRequest,
  deps: PressDeps & { stillArchived?: (afterVersion: number) => Promise<boolean> }): Promise<void> {
  const era = deps.era ?? SCREEN_ERA
  const started = era.now()
  const r = await send(request)
  if (!era.holds(started)) return
  const after = r.success && r.result.interaction && request.interaction ? request.interaction.version : null
  if (after !== null && deps.stillArchived && await deps.stillArchived(after)) {
    if (!era.holds(started)) return
    deps.say({ text: `${undoneWords((r as Extract<ContactUndoAnswer, { success: true }>).result)}。${STILL_ARCHIVED_TEXT}`, refused: false, undo: null })
    deps.reread()
    return
  }
  // A refused undo keeps nothing to undo (the card reads again and offers what is true now); one that did not reach the
  // server keeps ［取り消す］ to press again (the server answers `already` for a part taken back meanwhile).
  deps.say(r.success ? { text: undoneWords(r.result), refused: false, undo: null } : { text: refusalWords(r, 'undo'), refused: true, undo: r.offline ? request : null })
  deps.reread()
}
