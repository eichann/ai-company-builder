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

import type { AiRunProcedure } from './ai-runs'
import type { SkillUse } from './skill-uses'

export type LedgerValue = string | number | boolean | null

/** `state` is the record's state; any other name is a server field. */
export interface LedgerChange {
  field: string
  before: LedgerValue
  after: LedgerValue
}

export type ActorKind = 'human' | 'ai' | 'external'

/**
 * A file attached to an action: the version handed over (0.18-1) — a company file at a commit, or
 * (a company without the shared folder) a Google Drive file linked to the record, at the revision
 * and with the fingerprint of the content ACB read when it was linked.
 */
export type LedgerAttachment =
  | { link: string; path: string; commit: string }
  | { link: string; kind: 'drive'; fileId: string; revisionId: string; sha256: string }

/**
 * Material a decision rests on (§13.5): a file at a commit, a record at a version, or a Google Drive
 * file linked to the record at its revision with its fingerprint (a company without the shared
 * folder). A file only on one member's PC is never material: nobody else could check it.
 */
export type DecisionMaterial =
  | { kind: 'file'; path: string; commit: string }
  | { kind: 'record'; id: string; version: number }
  | { kind: 'drive'; fileId: string; revisionId: string; sha256: string }

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
  /**
   * 「代わりに（本来は X）」 (absence and the delegate, stage 2 S4): the absent
   * member the actor stood in for — set only when the actor could do it only
   * as that member's delegate. Absent / null otherwise.
   */
  onBehalfOf?: string | null

  /**
   * The execution run (S10b, `shared/core/ai-runs.ts`) the AI acted in: set
   * when the AI's record token was bound to a run — an automated run under the
   * member's authority, not a consultation the member was typing in. Absent /
   * null otherwise.
   */
  runId?: string | null

  /**
   * Which procedure the run used (`shared/core/ai-runs.ts` AiRunProcedure):
   * copied from the run when the entry is written, so a later re-claim under
   * another app build or plugin version never rewrites it. Only on entries
   * with a `runId`; absent / null otherwise (a person, a consultation).
   */
  procedure?: AiRunProcedure | null

  /**
   * Which company Skills the consultation had used when the AI wrote this
   * entry (`shared/core/skill-uses.ts`; records.md "Which Skill"): name, git
   * tree id of the skill folder, dirty, first use — copied when the entry is
   * written, so a Skill used later in the consultation never rewrites it. Only
   * on the AI's entries whose consultation reported one; absent otherwise.
   */
  skills?: SkillUse[] | null

  /**
   * The plugin screen the change came through (plan 4b B6, the bridge;
   * `.claude/rules/plugin-frame.md`): the business plugin and the package
   * version whose screen the person used. Set by the server from the bridge
   * route, never from a request body. Absent / null otherwise (the core's
   * screens, a consultation, a run).
   */
  via?: LedgerVia | null
}

/** A change made through a plugin's screen (its bridge): which plugin, which version of its package. */
export interface LedgerVia {
  plugin: string
  version: string
}

/**
 * Who caused a change (owner decision 2026-11-01): a person's click, the
 * member's AI in a consultation, an automated run under the person's authority,
 * a plugin's screen the person used (its bridge, plan 4b B6: the person's own
 * authority, the plugin's button), the server itself (its clock) or an outside
 * system (seen there).
 */
export type LedgerCause = 'person' | 'ai' | 'run' | 'plugin' | 'system' | 'outside'

/** The server's own actors (the server clock): `acb:` ids never belong to a member or an outside system. */
export const SYSTEM_ACTOR_PREFIX = 'acb:'

export function ledgerCause(entry: Pick<LedgerEntry, 'actorKind' | 'actorId' | 'runId' | 'via'>): LedgerCause {
  if (entry.actorKind === 'human') return entry.via ? 'plugin' : 'person'
  if (entry.actorKind === 'ai') return entry.runId ? 'run' : 'ai'
  return entry.actorId.startsWith(SYSTEM_ACTOR_PREFIX) ? 'system' : 'outside'
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
