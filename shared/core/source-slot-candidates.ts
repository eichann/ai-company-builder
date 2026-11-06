/**
 * The source's slot (出どころの枠, owner decision 2026-11-06 §10): when an AI makes something shared
 * from a source (a meeting's homework, its decisions), it is a **candidate** in that source's slot —
 * one slot per (source record, kind) — never a record of its own making. What a person does is free.
 *
 * The pure half (the server's half is `server/src/services/source-slot-candidates.ts`): how a
 * candidate's identity is read from its basis quote, when two titles are close, and the words the AI
 * and the person get. Named and shaped (source record id + kind + key) so it can join its sibling
 * `source-slots.ts` (a source's outside acts: one send, one pending create) later.
 */
import { MINUTES_QUOTE_MAX, MINUTES_QUOTE_MIN } from './minutes'
import { outputTitleKey } from './meeting-outputs'

/** The basis quote as given (NFC, spacing folded), or null when it is too short or too long to be one. */
export function slotQuote(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const q = raw.normalize('NFC').replace(/[\s　]+/g, ' ').trim()
  if (q.length < MINUTES_QUOTE_MIN || q.length > MINUTES_QUOTE_MAX) return null
  return slotQuoteKey(q) === '' ? null : q
}

/**
 * A quote compared for 「the same basis」: the title rule (`outputTitleKey`: NFKC, A–Z folded, no
 * spaces, brackets or punctuation — 【】 and 〔〕 alike), so a quote copied with other spacing or
 * punctuation is the same basis.
 */
export function slotQuoteKey(quote: string): string {
  return outputTitleKey(quote.normalize('NFC'))
}

/**
 * Whether two candidates' titles are close enough to ask a person (「似ている案があります」): the
 * same after `outputTitleKey`, or one contained in the other (the shorter at least 2 characters).
 * Kept simple on purpose: it only asks, it never merges.
 */
export function slotTitlesClose(a: string, b: string): boolean {
  const x = outputTitleKey(a)
  const y = outputTitleKey(b)
  if (!x || !y) return false
  if (x === y) return true
  const [short, long] = x.length <= y.length ? [x, y] : [y, x]
  return short.length >= 2 && long.includes(short)
}

/** What the AI (and through it the member) is told when the same basis already has a candidate it can read. */
export function slotSameBasisNote(title: string): string {
  return `同じ根拠の案がもうあります（${title}）。新しくは作らず、それを返しました。もう一度作らないでください。` +
    ` / A candidate with the same basis already exists ("${title}"): it was returned, nothing new was made. Do not create it again.`
}

/** What the AI is told when its new candidate's title is close to an earlier one's (both kept). */
export function slotSimilarNote(title: string): string {
  return `件名が似ている案（${title}）があります。両方を残し、「似ている案があります」として人に確かめてもらいます。` +
    ` / A candidate with a similar title exists ("${title}"): both are kept and a person decides whether they are the same.`
}

/** The note of 「同じ」 on a similar candidate: the newer one is put away (要らない), the older kept. */
export function slotSameAsNote(title: string): string {
  return `「${title}」と同じ案のため`
}

/**
 * The note of ［まとめる］ on a person's new item that is close to an earlier one (「似ているやることが
 * あります」, §10 step 4): the new one is put away with it, the earlier one kept.
 */
export function slotMergedNote(title: string): string {
  return `「${title}」とまとめたため`
}
