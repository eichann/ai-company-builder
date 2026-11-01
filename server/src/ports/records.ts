/**
 * The company map of the light ontology (stage 4-2, `.claude/rules/records.md`):
 * the feature switch, type definitions (every version), the record index,
 * links, server-sourced state, and the indexer's bookkeeping. Reached only
 * through a company handle (ports/company-data.ts): no method takes a
 * company, and every statement is limited to the handle's company.
 */

import type { LedgerEntry } from '../../shared/core/record-ledger'

/** A repository the index reads: the company repository, or one private folder's (by scope id). */
export type RecordRepoKey = 'company' | `scope:${string}`

export interface RecordSettingsRow {
  enabled: boolean
  updatedAt: string | null
  updatedBy: string | null
}

export interface RecordTypeRow {
  name: string
  version: number
  /** JSON of shared/core TypeDefinition. */
  definition: string
  source: 'file' | 'core' | 'plugin'
  commitSha: string | null
  createdAt: string
}

export interface RecordRow {
  id: string
  type: string
  typeVersion: number | null
  /** The private folder (scope id) holding the file; null = company repository or server only. */
  scopeId: string | null
  /** Company path of the record's file; null = the record lives on the server only. */
  path: string | null
  /** Server-only record: the folder whose readers may see it (null = everyone in the company). */
  folder: string | null
  /**
   * Owner-only record (「持ち主だけ」, records.md "Owner-only records"): the one member who
   * may see it — nobody else, owners and admins included. null = visibility by `folder`.
   * Written on insert and by `setPlace` only (an upsert of an existing row keeps it).
   */
  personalOwner: string | null
  title: string
  summary: string
  createdAt: string
  updatedAt: string
  removedAt: string | null
}

export interface RecordStateRow {
  recordId: string
  state: string | null
  /** JSON object of server-sourced field values. */
  fields: string
  version: number
  updatedAt: string
}

export interface RecordLinkRow {
  sourceId: string
  name: string
  position: number
  targetId: string | null
  targetPath: string | null
}

export interface RecordProblemRow {
  repo: RecordRepoKey
  path: string
  kind: string
  detail: string
  foundAt: string
}

/** SQL-level narrowing of a map query (the viewer's read access is applied by the service afterwards). */
export interface RecordCandidateFilter {
  types?: string[]
  states?: string[]
  /** Server field (validated name) → accepted values (JSON scalars). */
  fields?: Array<{ name: string; values: Array<string | number | boolean | null> }>
  /** Tags field (kind `tags`, validated name) → a tag the stored list must hold (already normalized). */
  contains?: Array<{ name: string; tag: string }>
  /** Matched against title and summary (substring, A–Z case-insensitive). */
  text?: string
  ids?: string[]
  /** Server field (validated name; date / datetime / number) → `gte` ≤ value < `lt` (compared as stored). */
  ranges?: Array<{ name: string; gte?: string | number; lt?: string | number }>
  /** Order by a server field (validated name), empty values last, then most recently changed. Default: most recently changed. */
  sort?: { field: string; order: 'asc' | 'desc' }
  /** In one of these (type, state) pairs, entered (a ledger entry into it from another state) at or after `since`. */
  finishedSince?: { since: string; finals: Array<{ type: string; state: string }> }
  /** An outgoing record link `name` holds `id`. */
  link?: { name: string; id: string }
}

/** The columns read access is decided from. */
export interface RecordAccessRow {
  id: string
  type: string
  scopeId: string | null
  path: string | null
  folder: string | null
  personalOwner: string | null
}

/** The AI's credential for the company map (only the digest of its value). */
export interface RecordAiTokenRow {
  id: string
  userId: string
  tokenHash: string
  scope: 'read' | 'act'
  agent: string
  conversationId: string
  createdAt: string
  expiresAt: string
  revokedAt: string | null
  /** The execution run the token is bound to and its claim generation (S10b); absent / null for a consultation's token. */
  runId?: string | null
  runGeneration?: number | null
}

export interface RecordRepository {
  settings(): RecordSettingsRow
  setEnabled(enabled: boolean, by: string, at: string): void
  /** The company's minutes folder (milestone 4, minutes.md): a department folder, or null when not chosen. */
  minutesFolder(): string | null
  setMinutesFolder(folder: string | null, by: string, at: string): void
  /** Which meetings the intake reads (minutes.md "Which meetings"): the stored value, null = the default. */
  meetingIntake(): string | null
  setMeetingIntake(value: string, by: string, at: string): void

  /** Every stored version of every type, oldest first per name. */
  typeVersions(): RecordTypeRow[]
  insertTypeVersion(row: RecordTypeRow): void

  find(id: string): RecordRow | null
  /** The live (not removed) record whose file is at `path`. */
  findByPath(path: string): RecordRow | null
  /** Live records whose file is in one repository (`scopeId` null = the company repository). */
  fileRecordsIn(scopeId: string | null): RecordRow[]
  upsert(row: RecordRow): void
  markRemoved(id: string, at: string): void
  /** Who may see a server-only record: an owner-only record shared to a folder (records.md "Owner-only records"). */
  setPlace(id: string, place: { folder: string | null; personalOwner: string | null }, at: string): void

  linksFrom(ids: string[]): RecordLinkRow[]
  /** Links whose target is a file at exactly one of `paths` (company paths). */
  fileLinksTo(paths: string[]): RecordLinkRow[]
  /** Point these links (source, name, position) at another file path. */
  retargetFileLinks(links: Array<{ sourceId: string; name: string; position: number; targetPath: string }>): void
  /**
   * A department folder renamed by the server (services/departments.ts): records whose readers'
   * folder is at or under `from`, links to files at or under it, and the minutes folder move to `to`.
   */
  moveFolder(from: string, to: string): void
  /** Links naming any of `ids` as their target. */
  linksTo(ids: string[]): RecordLinkRow[]
  replaceLinks(sourceId: string, links: RecordLinkRow[]): void

  states(ids: string[]): RecordStateRow[]
  /**
   * Write a record's server state if its version is still `expectedVersion`
   * (0 = no state yet). false = someone changed it first (nothing written).
   */
  writeState(row: RecordStateRow, expectedVersion: number): boolean

  /** The record's ledger, oldest first. */
  ledger(recordId: string): LedgerEntry[]
  appendLedger(entry: LedgerEntry): void

  /** Live records matching the filter, with only the access columns (bounded by `limit`). */
  candidates(filter: RecordCandidateFilter, limit: number): RecordAccessRow[]
  /** Full rows of live records, any order. */
  byIds(ids: string[]): RecordRow[]

  head(repo: RecordRepoKey): string | null
  setHead(repo: RecordRepoKey, commitSha: string, at: string): void
  /** Forget every head: the next index run reads every repository in full. */
  clearHeads(): void

  insertAiToken(row: RecordAiTokenRow): void
  /** The token of this company with this digest (another company's never matches). */
  aiTokenByHash(tokenHash: string): RecordAiTokenRow | null
  /** End one of the member's tokens; false when it is not theirs (or already ended). */
  revokeAiToken(userId: string, tokenId: string, at: string): boolean
  liveAiTokens(userId: string, now: string): number
  /** Forget tokens that expired before `before`. */
  pruneAiTokens(before: string): void

  problems(limit: number): RecordProblemRow[]
  /** Replace the problems of these paths in one repository (all of its problems when `paths` is null). */
  replaceProblems(repo: RecordRepoKey, paths: string[] | null, problems: RecordProblemRow[]): void
}
