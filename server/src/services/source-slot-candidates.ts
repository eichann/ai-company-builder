/**
 * The source's slot for what an AI makes shared (出どころの枠, owner decision 2026-11-06 §10;
 * `.claude/rules/minutes.md` "Outputs made once"): **the one place** that decides whether an AI's
 * create from a source (today: a task or a decision linked to its meeting) is a new candidate or one
 * that is already there. Every AI path that makes a meeting-linked task or decision goes through
 * `decideSlot` (`server/tests/unit/source-slot-one-place.test.ts`). Generic in its shape — a source
 * record id, a kind (the record type) and a key — so it can merge later with its sibling
 * `source-slots.ts`, which holds the outside acts of a source (one send per source, one pending
 * create per source). Pure over the repository (synchronous: the caller's create
 * follows in the same stretch, so two calls at once make one).
 *
 * Identity of a candidate = (source, kind, key):
 * - **with a basis quote** (the AI cites the minutes): key `quote:<digest of the quote key>`. The id is
 *   derived from it, so the same quote is the same candidate, whoever's AI gives it, in any reading.
 *   Found and readable by the caller (and not someone's 「あなただけ」) → that one is the answer, with
 *   「同じ根拠の案がもうあります（…）」. Found but not readable → a new candidate under a fresh id,
 *   nothing said (the caller must not learn it exists).
 * - **without a quote** (an older app: only the AI's serial key `task:1`, or nothing): never the same
 *   as another reading's item. The serial key counts only inside the same run or consultation
 *   (key `key:<run or conversation>:<serial>`), and so does the exact-title match; anything else is a
 *   new candidate. Nothing is lost; at worst a person sees two and presses ［同じ］.
 * - A new candidate whose title is close to a live candidate the caller reads (`slotTitlesClose`) is
 *   marked `similarTo` the oldest such: both are kept, a person decides. Never merged on title alone.
 *
 * Compared and answered only within what the caller reads; owner-only records (「あなただけ」) are never
 * compared or mentioned — an owner-only create does not come here at all (the person's own, free).
 */
import { outputTitleKey } from '../../shared/core/meeting-outputs'
import { newRecordId } from '../../shared/core/records'
import { slotQuoteKey, slotSameBasisNote, slotSimilarNote, slotTitlesClose } from '../../shared/core/source-slot-candidates'
import type { TokenDigest } from '../ports/key-broker'
import type { RecordRepository, RecordRow } from '../ports/records'

/** The slot: the source record (its id and the link that names it) and the kind of what it holds. */
export interface SlotRef {
  sourceId: string
  /** The link of the candidate that names its source (`meeting`). */
  linkName: string
  /** The record type of the candidates (`task`, `decision`). */
  kind: string
}

export interface SlotRequest {
  slot: SlotRef
  title: string
  /** The basis quote, already checked (`slotQuote`), or null. */
  quote: string | null
  /** An older app's serial key (`task:1`), or null. Ignored when a quote is given. */
  serialKey: string | null
  /** The run (else the consultation) the AI works in: where a serial key or an exact title still counts. */
  scope: string | null
}

export type SlotDecision =
  | { kind: 'existing'; row: RecordRow; note: string }
  | {
    kind: 'new'
    /** The candidate's id (from its key), or null for a fresh one the caller picks. */
    id: string | null
    /** The identity kept with it (a decision's `source_key`), or null. */
    key: string | null
    /** An earlier live candidate the caller reads whose title is close, or null. */
    similarTo: { id: string; title: string } | null
    note: string | null
  }

/** States a candidate no longer counts in for 「似ている案」 (put away, cancelled, retracted…). */
const GONE_STATES = new Set(['cancelled', 'retracted', 'discarded', 'dismissed'])
/** At most this many candidates of one slot are compared (a meeting makes a handful). */
const SLOT_MAX = 500

/** The record id a slot key gives (its kind's prefix): one record per source, kind and key. */
export function slotCandidateId(digest: TokenDigest, slot: SlotRef, key: string): string {
  return newRecordId(slot.kind, digest.digest(`source-slot:${slot.sourceId}:${slot.kind}:${key}`).slice(0, 24))
}

/** The slot key of a basis quote. */
export function quoteSlotKey(digest: TokenDigest, quote: string): string {
  return `quote:${digest.digest(`slot-quote:${slotQuoteKey(quote)}`).slice(0, 32)}`
}

/**
 * Decide a create in the slot. `readable`: the caller's reader. Without a digest no id is derived
 * (every candidate is new; the title rules still apply).
 */
export function decideSlot(records: RecordRepository, readable: (r: RecordRow) => boolean, digest: TokenDigest | undefined, q: SlotRequest): SlotDecision {
  // The candidates the caller may be told about: readable, live, never someone's 「あなただけ」.
  const seen = (r: RecordRow) => r.removedAt === null && r.personalOwner === null && readable(r)
  const linked = records.candidates({ types: [q.slot.kind], link: { name: q.slot.linkName, id: q.slot.sourceId } }, SLOT_MAX)
  const rows = records.byIds(linked.map(r => r.id)).filter(seen)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1))

  let key: string | null = null
  if (q.quote !== null) key = digest ? quoteSlotKey(digest, q.quote) : null
  else if (q.serialKey !== null) key = `key:${q.scope ?? 'none'}:${q.serialKey}`
  let id = key !== null && digest ? slotCandidateId(digest, q.slot, key) : null
  if (id !== null) {
    const there = records.byIds([id]).find(r => r.removedAt === null)
    if (there && seen(there)) return { kind: 'existing', row: there, note: slotSameBasisNote(there.title) }
    // Someone's record the caller does not read holds the key: a candidate of their own, never named.
    if (there) id = null
  }

  // Without a quote, the exact title counts only inside the same run or consultation (a retry there).
  if (q.quote === null && q.scope !== null) {
    const want = outputTitleKey(q.title)
    const same = want ? rows.find(r => outputTitleKey(r.title) === want && scopeOf(records, r.id) === q.scope) : undefined
    if (same) return { kind: 'existing', row: same, note: slotSameBasisNote(same.title) }
  }

  const states = new Map(records.states(rows.map(r => r.id)).map(s => [s.recordId, s.state]))
  const close = rows.find(r => !GONE_STATES.has(states.get(r.id) ?? '') && slotTitlesClose(r.title, q.title))
  return {
    kind: 'new', id, key,
    similarTo: close ? { id: close.id, title: close.title } : null,
    note: close ? slotSimilarNote(close.title) : null,
  }
}

/** The run (else the consultation) a record was made in, from its create entry. */
function scopeOf(records: RecordRepository, id: string): string | null {
  const created = records.ledger(id).find(e => e.action === 'create')
  return created ? created.runId ?? created.conversationId ?? null : null
}

/** The scope of an AI's call: its run, else its consultation. */
export function slotScope(actor: { runId?: string | null; conversationId?: string | null }): string | null {
  return actor.runId ?? actor.conversationId ?? null
}
