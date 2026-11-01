/**
 * Whose turn a record is, read back from its ledger (records.md "Whose turn it
 * was", owner decision 2026-11-01 「流れを測れる記録」). Pure: the server and the
 * app fold the same entries the same way.
 *
 * A record of a type implementing `request` waits for one person: its
 * `next_actor`, or — nobody next — its `assignee`, while its state is neither
 * final nor the AI's turn (the rule of 「あなたの番」). Every change of those
 * values or of the state is a ledger entry, so the ledger alone says when the
 * turn became whose. An absence does not change the holder: the delegate is
 * found for that moment from the absence periods the company knew then
 * (shared/core/absences.ts `delegationAsOf`).
 */
import type { LedgerEntry, LedgerValue } from './record-ledger'
import { aiTurnStates, type TypeDefinition } from './record-types'

/** One stretch of the record's life during which the same person (or nobody) held the turn. */
export interface TurnStretch {
  /** The member whose turn it is, or null (final, the AI's turn, nobody named). */
  holder: string | null
  /** The record's version that began it (the ledger entry that made it so). */
  sinceVersion: number
  /** When that entry was written. */
  since: string
}

/** Whose turn a record with these values is: next_actor, else assignee, unless the state waits for nobody. */
export function turnHolder(def: TypeDefinition, state: string | null, fields: Record<string, LedgerValue | undefined>): string | null {
  if (!def.implements.includes('request')) return null
  if (state === null || def.final.includes(state) || aiTurnStates(def).has(state)) return null
  const who = typeof fields.next_actor === 'string' ? fields.next_actor : fields.assignee
  return typeof who === 'string' && who.length > 0 ? who : null
}

/**
 * The record's turns, oldest first, folded from its ledger entries (in
 * version order; a stretch begins at each entry that changes the holder). The
 * last one is the current turn.
 */
export function turnsOf(def: TypeDefinition, entries: readonly LedgerEntry[]): TurnStretch[] {
  const sorted = [...entries].sort((a, b) => a.version - b.version)
  const out: TurnStretch[] = []
  let state: string | null = null
  const fields: Record<string, LedgerValue> = {}
  for (const e of sorted) {
    for (const c of e.changes) {
      if (c.field === 'state') state = typeof c.after === 'string' ? c.after : null
      else fields[c.field] = c.after
    }
    const holder = turnHolder(def, state, fields)
    if (out.length === 0 || out[out.length - 1].holder !== holder) out.push({ holder, sinceVersion: e.version, since: e.at })
  }
  return out
}
