/**
 * 出どころ (the source of shared work): the one thing a piece of work came from, so the server can
 * tell when two people (or their AIs) are about to do the same outside act twice. Pure: the
 * server's `services/source-slots.ts` reads records and applies the reader; the app may use the
 * words. Generic on purpose: a source is a record id and a kind — no business type is named.
 *
 * The order (owner decision 2026-11-06, `outbound-mail.md` "One send per source"):
 *   1. `follow-up` — a waiting record (a 返事のお願い, a task) the clock gave back for a nudge, per
 *      round of waiting (`<record id>@<version of the clock's entry>`), so a nudge never meets the
 *      thank-you mail or the reply it follows up;
 *   2. `meeting`   — the meeting it is about;
 *   3. `thread`    — the 連絡 it answers (one thread).
 * Nothing of these: no source (exempt from every per-source rule). A まとまり (a 案件, a プロジェクト)
 * is **not** a source (owner decision 2026-11-06): on one deal people send many different things
 * (a proposal, a quote another day), so "already sent for this deal" would stop every one of them.
 */

export const SOURCE_KINDS = ['follow-up', 'meeting', 'thread'] as const
export type SourceKind = typeof SOURCE_KINDS[number]

export interface Source {
  kind: SourceKind
  /** A record id; for `follow-up` `<record id>@<round>` (the round is the clock entry's version). */
  id: string
}

/** What a piece of work links to; each a record id or nothing (a まとまり link is not one: see above). */
export interface SourceLinks {
  followUp?: string | null
  meeting?: string | null
  interaction?: string | null
}

/** The source of a piece of work, by the order above; null when it has none. */
export function resolveSource(links: SourceLinks): Source | null {
  if (links.followUp) return { kind: 'follow-up', id: links.followUp }
  if (links.meeting) return { kind: 'meeting', id: links.meeting }
  if (links.interaction) return { kind: 'thread', id: links.interaction }
  return null

}

/** The stored form: `<kind>:<id>`. */
export const sourceKey = (s: Source): string => `${s.kind}:${s.id}`

export function parseSourceKey(key: string | null | undefined): Source | null {
  if (typeof key !== 'string') return null
  const at = key.indexOf(':')
  const kind = key.slice(0, at) as SourceKind
  const id = key.slice(at + 1)
  return at > 0 && id !== '' && (SOURCE_KINDS as readonly string[]).includes(kind) ? { kind, id } : null
}

/** The record a source is (a follow-up's round taken off): whoever cannot read it is never told of the source. */
export function sourceRecordId(s: Source): string {
  if (s.kind !== 'follow-up') return s.id
  const at = s.id.lastIndexOf('@')
  return at > 0 ? s.id.slice(0, at) : s.id
}

export const followUpSourceId = (recordId: string, round: number): string => `${recordId}@${round}`
