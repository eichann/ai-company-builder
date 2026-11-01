/**
 * API contract of the company map (light ontology, stage 4-2;
 * `.claude/rules/records.md`). Mounted at /api/companies/:companyId.
 *
 *   GET  /records/settings   owner/admin   → RecordSettings
 *   PUT  /records/settings   owner/admin   { enabled: boolean } → RecordSettings
 *   GET  /records/problems   owner/admin   → { problems: RecordIndexProblem[] }
 *   POST /records/reindex    owner/admin   { full: true } → { scheduled: true }   (index rebuilt from the files)
 *   GET  /records/types      any member    → { types: RecordTypeView[] }
 *   POST /records/query      any member    RecordQuery → RecordQueryResult (records of an old connection only with includeOldConnection)
 *   GET  /records/item/:recordId  any member  → RecordDetail
 *   GET  /records/my-turn    any member    → RecordQueryResult (「あなたの番」, 4-4)
 *   POST /records/item       any member    CreateRecordRequest → 201 { record, entry } (server-only record)
 *   POST /records/item/:recordId/actions/:action   ActionRequest → { record, entry }
 *   POST /records/item/:recordId/undo              UndoRequest → { record, entry }
 *   POST /records/item/:recordId/file-links        FileLinkRequest → FileLinkResult (link a file later)
 *   POST /records/item/:recordId/file-links/remove FileLinkRequest → FileLinkResult (remove that link)
 *   POST /records/item/:recordId/share             ShareRecordRequest → { record, entry } (owner-only → a folder; session only)
 *   GET  /records/item/:recordId/history           → { entries: LedgerEntry[] }
 *   GET  /records/item/:recordId/versions/:version → ReplayedState
 *
 * The state engine's refusals carry a `code`: VERSION_CONFLICT (409, with the
 * current `version`), ACTION_NOT_ALLOWED_IN_STATE (409), NOT_ALLOWED (403),
 * NOTE_REQUIRED / ARG_REQUIRED / BAD_VALUE / BAD_ATTACHMENT / BAD_MATERIAL
 * (400), ATTACHMENT_NOT_SYNCED (409: push the file first), CHANGED_SINCE (409, undo),
 * FILE_NOT_LINKABLE (400: a file the caller cannot read, or one the record may
 * not reach — never says which or where), LINK_NOT_FOUND (404, removing).
 *
 * While the feature is off for the company, every route but the settings
 * answers 404 `RECORDS_DISABLED`. Answers, counts and link lists hold only
 * records the caller may read: a record in a private folder they cannot read,
 * and another member's owner-only record (owners and admins included), is
 * exactly a record that does not exist.
 */
import type { TypeDefinition } from '../core/record-types'
import type { DecisionMaterial, LedgerEntry } from '../core/record-ledger'

export interface RecordSettings {
  enabled: boolean
  updatedAt: string | null
}

export interface RecordIndexProblem {
  /** 'company' or 'scope:<scope id>'. */
  repo: string
  path: string
  /** duplicate_id, invalid_record, invalid_type, type_version, breaking_type_change, type_file_removed, unknown_type, ignored_keys, blocked_link, moved_across_folders, server_only_type */
  kind: string
  detail: string
  foundAt: string
}

export interface RecordTypeView {
  /** The version in force. */
  definition: TypeDefinition
  source: 'file' | 'core' | 'plugin'
  /** Every stored version, oldest first. */
  versions: number[]
}

export type RecordFieldValue = string | number | boolean | null

export interface RecordQuery {
  type?: string
  /** Records of every type implementing this interface (e.g. `request`). */
  implements?: string
  state?: string[]
  /**
   * Server-sourced field → one value or several (`{ in: [...] }`); a field of
   * kind `tags` → `{ contains: tag }` (records whose tags hold it, normalized
   * as stored; only types where that field holds tags are searched).
   */
  fields?: Record<string, RecordFieldValue | { in: RecordFieldValue[] } | { contains: string }>
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
  /**
   * Also records imported through an earlier connection of an outside system
   * (`fromOldConnection`); left out by default (and never in 「あなたの番」).
   */
  includeOldConnection?: boolean
}

/** What a record imported through an earlier connection is called on screen and for the AI. */
export const OLD_CONNECTION_LABEL = '前のつなぎ先から取り込んだもの（いまは使われていません）'

export interface RecordSummary {
  id: string
  type: string
  typeVersion: number | null
  title: string
  summary: string
  /** Company path of the record's file; null = it lives on the server only. */
  path: string | null
  state: string | null
  /**
   * Server-sourced field values. A field of kind `tags` holds the JSON text
   * of its list (`["急ぎ","見積"]`, null = none): `parseTagsValue` in
   * `shared/core/record-types.ts` reads it.
   */
  fields: Record<string, RecordFieldValue>
  /** Changes made through the state engine (0 = none yet). */
  version: number
  updatedAt: string
  /**
   * Imported through an earlier connection of an outside system (an owner /
   * admin started a new one with 「新しいつなぎ先として始める」): kept as it
   * was, but no longer brought up to date and no operation runs on it.
   * Absent for every other record.
   */
  fromOldConnection?: true
  /** With `fromOldConnection`: `OLD_CONNECTION_LABEL`, to show as is. */
  notice?: string
  /**
   * Owner-only (「持ち主だけ」, records.md "Owner-only records"): only the member
   * reading it sees it — it reaches nobody else, owners and admins included.
   * Absent for every other record.
   */
  personal?: true
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
  /**
   * With `path`: true when no file or folder is at that path now (deleted, or
   * moved where the link could not follow) — 「つながりが切れています」. Absent
   * when the server could not tell.
   */
  broken?: boolean
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
  /**
   * Owner-only (「持ち主だけ」: 自分用のやること): only the creator sees it — not owners or admins
   * either. Never with `folder` (400 PERSONAL_WITH_FOLDER); an assignee other than the creator
   * cannot read it (400 ASSIGNEE_CANNOT_READ). Shown to a folder later with ShareRecordRequest.
   */
  personal?: boolean
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

/**
 * Link a file to a record after it was made, or remove that link (any type
 * with a `file` link; records.md "Linking files later").
 */
export interface FileLinkRequest {
  /** Company path of the file or folder (as in the company folder, e.g. `営業部/提案書/見積.md`). */
  path: string
  /** The link's name; may be left out when the type has one file link (task: `files`). */
  link?: string
  expectedVersion: number
  note?: string
  proposedBy?: 'ai'
  conversationId?: string
}

/**
 * 「部署に出す／案件につなぐ」: the owner makes their owner-only record visible to
 * the readers of `folder` (a folder they read, not a private one; for a deal,
 * the deal's folder). Ledger action `share` (`place.personal_owner`,
 * `place.folder`), never undone. Not personal any more → 409 NOT_PERSONAL;
 * anyone but the owner cannot find the record (404 RECORD_NOT_FOUND).
 */
export interface ShareRecordRequest {
  folder: string
  expectedVersion: number
  note?: string
  proposedBy?: 'ai'
  conversationId?: string
}

export interface FileLinkResult {
  record: RecordSummary
  /** The ledger entry (`link_file` / `unlink_file`); null when nothing changed (already linked). */
  entry: LedgerEntry | null
  changed: boolean
}
