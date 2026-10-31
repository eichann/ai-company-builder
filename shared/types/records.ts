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
 *
 * While the feature is off for the company, every route but the settings
 * answers 404 `RECORDS_DISABLED`. Answers, counts and link lists hold only
 * records the caller may read: a record in a private folder they cannot read
 * is exactly a record that does not exist.
 */
import type { TypeDefinition } from '../core/record-types'

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
