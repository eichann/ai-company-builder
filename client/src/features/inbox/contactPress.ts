// A press on 「連絡」1枚 and its ［取り消す］ (inbox.md "One contact"): one request, then the card reads the contact again —
// answered, refused or not reached alike. Bound to the company era it started in (shared/lib/companyEra.ts): an answer that
// comes back after a company change or a sign-out says nothing and reads nothing (the request itself was the last
// company's and stays so). Pure TypeScript: the card hands in its ports and what it shows.
import type { ContactFinishAnswer, ContactFinishRequest, ContactReplyEnd, ContactUndoAnswer, ContactUndoRequest } from '../../../shared/contact-card'
import { finishedWords, refusalWords, undoneWords, undoRequestOf } from './contactModel'
import { SCREEN_ERA, type EraPort } from './contactStore'

/** What the card says after a press: the words, whether it was refused, and what ［取り消す］ would send. */
export interface ContactSaid { text: string; refused: boolean; undo: ContactUndoRequest | null }

interface PressDeps {
  era?: EraPort
  /** Shown on the card (only while the era holds). */
  say: (said: ContactSaid) => void
  /** The contact read again (only while the era holds). */
  reread: () => void
}

export async function pressFinish(
  send: (request: ContactFinishRequest) => Promise<ContactFinishAnswer>, request: ContactFinishRequest, end: ContactReplyEnd, hadDrafts: boolean, deps: PressDeps,
): Promise<void> {
  const era = deps.era ?? SCREEN_ERA
  const started = era.now()
  const r = await send(request)
  if (!era.holds(started)) return
  deps.say(r.success
    ? { text: finishedWords(end, r.result, hadDrafts), refused: false, undo: undoRequestOf(r.result) }
    : { text: refusalWords(r, 'finish'), refused: true, undo: null })
  deps.reread()
}

export async function pressUndo(send: (request: ContactUndoRequest) => Promise<ContactUndoAnswer>, request: ContactUndoRequest, deps: PressDeps): Promise<void> {
  const era = deps.era ?? SCREEN_ERA
  const started = era.now()
  const r = await send(request)
  if (!era.holds(started)) return
  // A refused undo keeps nothing to undo: the card reads again and offers what is true now.
  deps.say(r.success ? { text: undoneWords(r.result), refused: false, undo: null } : { text: refusalWords(r, 'undo'), refused: true, undo: null })
  deps.reread()
}
