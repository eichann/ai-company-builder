/**
 * The state engine's ledger (stage 4-3, 「消さない台帳」) and replaying a
 * record's past (「記録の過去の版を再生できること」, decision record §13.11):
 * every change through the engine is one entry holding, for the state and
 * every server-sourced field it changed, the value before and after; the
 * record's version goes up by one per entry. So the record as it was at
 * version N is the fold of entries 1..N — which is what lets a decision cite
 * "record X at version N" as material.
 *
 * Pure (shared/core): the server answers with it, the app can show it.
 */

export type LedgerValue = string | number | boolean | null

/** `state` is the record's state; any other name is a server field. */
export interface LedgerChange {
  field: string
  before: LedgerValue
  after: LedgerValue
}

export type ActorKind = 'human' | 'ai' | 'external'

/** A file attached to an action: the version handed over (0.18-1). */
export interface LedgerAttachment {
  link: string
  path: string
  commit: string
}

/** Material a decision rests on: a file at a commit, or a record at a version (§13.5). */
export type DecisionMaterial =
  | { kind: 'file'; path: string; commit: string }
  | { kind: 'record'; id: string; version: number }

/** The thick ledger entry of a decision (§13.2 案 Y): the container; most of it is filled in later stages. */
export interface LedgerDecision {
  reason: string
  materials: DecisionMaterial[]
  /** The version of the rule / policy followed, when there is one. */
  policyVersion: string | null
  /** Earlier decisions taken as precedents: `<record id>@<version>`. */
  precedents: string[]
  /** The decision this one replaces: `<record id>@<version>`. */
  supersedes: string | null
}

export interface LedgerEntry {
  recordId: string
  /** The record's version after this entry (1 = created). */
  version: number
  /** The action's name; `create` and `undo` are the engine's own. */
  action: string
  fromState: string | null
  toState: string | null
  actorId: string
  actorKind: ActorKind
  /** For an AI: which one (claude…); for an outside system: its name. */
  actorSource: string | null
  at: string
  note: string
  changes: LedgerChange[]
  attachments: LedgerAttachment[]
  decision: LedgerDecision | null
  /** The action is marked `decision: true` in its type (or the entry carries a decision). */
  isDecision: boolean
  typeVersion: number | null
  /** For an undo: the version whose changes it reverses. */
  reversesVersion: number | null
  /**
   * Provenance, informational only — never used to decide anything (the
   * member's app reports it; nothing checks it): `ai` when a person
   * confirmed an action their AI suggested (actor kind stays `human`).
   */
  proposedBy: 'ai' | null
  /** The consultation it came from: the AI's token's for AI actions, the app's word for a person's. */
  conversationId: string | null
  /**
   * 「外の受領書」 (milestone 3): what an outside system was told or showed —
   * on entries written by a connector plugin (a change read from the outside
   * system, or one the plugin wrote there). Absent / null otherwise.
   */
  receipt?: ExternalReceipt | null
}

/** Evidence of an exchange with an outside system, kept on the ledger entry it explains. */
export interface ExternalReceipt {
  /** The plugin and the version / fingerprint of its package used. */
  plugin: string
  pluginVersion: string
  fingerprint: string
  mappingVersion: number
  /** The connection and the outside account (HubSpot's portal id). */
  connectionId: string
  accountId: string
  /** The outside object (`deal`) and its id there. */
  object: string
  externalId: string
  /** The outside system's last-modified time of the object as read, when it says. */
  externalUpdatedAt: string | null
  /** The operation record of a write (P6), null for an observed change. */
  operationId: string | null
  /**
   * observed: a change seen in the outside system (who made it is not known);
   * written: ACB's own write, confirmed by the outside system's answer.
   */
  kind: 'observed' | 'written'
  /**
   * Milestone 4: the person who approved the write (the actor stays the member
   * or AI it was requested for; the entry's decision holds the approver's reason).
   */
  approvedBy?: string | null
}

export interface ReplayedState {
  version: number
  state: string | null
  fields: Record<string, LedgerValue>
}

/** Who made a version, and where it came from (the entry that produced it; informational provenance included). */
export interface VersionOrigin {
  action: string
  actorId: string
  actorKind: ActorKind
  at: string
  proposedBy: 'ai' | null
  conversationId: string | null
}

/**
 * The record's server-side values at `version` (0 = before anything), from
 * its ledger entries. Throws when the ledger has a gap or the version does
 * not exist yet — a replay must never silently describe a different version.
 */
export function replayRecordState(entries: LedgerEntry[], version: number): ReplayedState {
  if (!Number.isInteger(version) || version < 0) throw new Error('replay: version must be a whole number ≥ 0')
  const sorted = [...entries].sort((a, b) => a.version - b.version)
  const out: ReplayedState = { version: 0, state: null, fields: {} }
  for (const e of sorted) {
    if (e.version > version) break
    if (e.version !== out.version + 1) throw new Error(`replay: the ledger skips from version ${out.version} to ${e.version}`)
    for (const c of e.changes) {
      if (c.field === 'state') out.state = typeof c.after === 'string' ? c.after : null
      else out.fields[c.field] = c.after
    }
    out.version = e.version
  }
  if (out.version !== version) throw new Error(`replay: version ${version} does not exist (latest ${out.version})`)
  return out
}
