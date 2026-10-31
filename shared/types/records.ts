/**
 * API contract of the company map (light ontology, stage 4-2;
 * `.claude/rules/records.md`). Mounted at /api/companies/:companyId.
 *
 *   GET  /records/settings   owner/admin   → RecordSettings
 *   PUT  /records/settings   owner/admin   { enabled: boolean } → RecordSettings
 *   GET  /records/problems   owner/admin   → { problems: RecordIndexProblem[] }
 *   POST /records/reindex    owner/admin   { full: true } → { scheduled: true }   (index rebuilt from the files)
 *   GET  /records/types      any member    → { types: RecordTypeView[] }
 *   POST /records/query      any member    RecordQuery → RecordQueryResult
 *   GET  /records/item/:recordId  any member  → RecordDetail
 *   GET  /records/my-turn    any member    → RecordQueryResult (「あなたの番」, 4-4)
 *   POST /records/item       any member    CreateRecordRequest → 201 { record, entry } (server-only record)
 *   POST /records/item/:recordId/actions/:action   ActionRequest → { record, entry }
 *   POST /records/item/:recordId/undo              UndoRequest → { record, entry }
 *   GET  /records/item/:recordId/history           → { entries: LedgerEntry[] }
 *   GET  /records/item/:recordId/versions/:version → ReplayedState
 *
 * The state engine's refusals carry a `code`: VERSION_CONFLICT (409, with the
 * current `version`), ACTION_NOT_ALLOWED_IN_STATE (409), NOT_ALLOWED (403),
 * NOTE_REQUIRED / ARG_REQUIRED / BAD_VALUE / BAD_ATTACHMENT / BAD_MATERIAL
 * (400), ATTACHMENT_NOT_SYNCED (409: push the file first), CHANGED_SINCE (409, undo).
 *
 * While the feature is off for the company, every route but the settings
 * answers 404 `RECORDS_DISABLED`. Answers, counts and link lists hold only
 * records the caller may read: a record in a private folder they cannot read
 * is exactly a record that does not exist.
 */
import type { TypeDefinition } from '../core/record-types'
import type { DecisionMaterial } from '../core/record-ledger'

export interface RecordSettings {
  enabled: boolean
  updatedAt: string | null
}

export interface RecordIndexProblem {
  /** 'company' or 'scope:<scope id>'. */
  repo: string
  path: string
  /** duplicate_id, invalid_record, invalid_type, type_version, breaking_type_change, type_file_removed, unknown_type, ignored_keys, blocked_link, moved_across_folders */
  kind: string
  detail: string
  foundAt: string
}

export interface RecordTypeView {
  /** The version in force. */
  definition: TypeDefinition
  source: 'file' | 'core'
  /** Every stored version, oldest first. */
  versions: number[]
}

export type RecordFieldValue = string | number | boolean | null

export interface RecordQuery {
  type?: string
  /** Records of every type implementing this interface (e.g. `request`). */
  implements?: string
  state?: string[]
  /** Server-sourced field → one value or several (`{ in: [...] }`). */
  fields?: Record<string, RecordFieldValue | { in: RecordFieldValue[] }>
  /** Records linked to this one (either direction), up to `hops` (1 or 2, default 1). */
  linkedTo?: { id: string; hops?: 1 | 2 }
  /** Substring of the title or summary (0.23-1: not the full text). */
  text?: string
  /** 1–200, default 50. */
  limit?: number
  /** 0–10000. */
  offset?: number
  /** Only `total`. */
  countOnly?: boolean
}

export interface RecordSummary {
  id: string
  type: string
  typeVersion: number | null
  title: string
  summary: string
  /** Company path of the record's file; null = it lives on the server only. */
  path: string | null
  state: string | null
  /** Server-sourced field values. */
  fields: Record<string, RecordFieldValue>
  /** Changes made through the state engine (0 = none yet). */
  version: number
  updatedAt: string
}

export interface RecordQueryResult {
  /** Every match the caller may read (not only this page). */
  total: number
  records: RecordSummary[]
}

export interface RecordLinkView {
  name: string
  /** out = written in this record; in = another record names this one. */
  direction: 'out' | 'in'
  record?: RecordSummary
  /** A file of the company folder (outgoing file links). */
  path?: string
}

export interface RecordDetail {
  record: RecordSummary
  links: RecordLinkView[]
}

/**
 * The agents whose record tokens may act (create / run actions); any other
 * agent gets a `read` token whatever it asks for (owner decision 0.3-3:
 * Codex reads only). Server-side defence in depth: the agent name is the
 * app's word, and the app restricts the same way (its registry's
 * `recordActions`, pinned to this list by client/tests/records-tools.test.ts).
 */
export const RECORD_ACTION_AGENTS: readonly string[] = ['claude-code']

/** Who acts: the member by hand (default) or the member's AI. */
export interface RecordActor {
  kind: 'human' | 'ai'
  /** For an AI: which one (e.g. `claude`). */
  source?: string
}

export interface CreateRecordRequest {
  type: string
  title: string
  summary?: string
  /** The folder whose readers may see it (none = everyone in the company); not inside a private folder. */
  folder?: string
  /** Server-field values (requested_by defaults to the creator for request types). */
  fields?: Record<string, RecordFieldValue>
  links?: Record<string, string | string[]>
  actor?: RecordActor
}

export interface ActionRequest {
  /** The record version the caller saw (optimistic concurrency). */
  expectedVersion: number
  note?: string
  /** The action's arguments: each sets the server field of the same name. */
  args?: Record<string, RecordFieldValue>
  /** Files (of the action's `attach` links) handed over, at the commit that was pushed. */
  attachments?: Array<{ link: string; path: string; commit: string }>
  /**
   * Provenance, informational only (never authorizes; the server records what
   * the app says): `ai` when the member confirms an action their AI suggested
   * in a consultation, and that consultation's id. Ignored on the AI's routes.
   */
  proposedBy?: 'ai'
  conversationId?: string
  /** Only for actions marked `decision`: what the decision rests on (references, never copies). */
  decision?: { materials?: DecisionMaterial[]; policyVersion?: string; precedents?: string[]; supersedes?: string }
  actor?: RecordActor
}

export interface UndoRequest {
  /** The ledger entry (record version) to reverse. */
  version: number
  expectedVersion: number
  note?: string
  actor?: RecordActor
}
