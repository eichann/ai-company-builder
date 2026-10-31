/**
 * The company map of the light ontology (stage 4-2, `.claude/rules/records.md`):
 * the feature switch, type definitions (every version), the record index,
 * links, server-sourced state, and the indexer's bookkeeping. Reached only
 * through a company handle (ports/company-data.ts): no method takes a
 * company, and every statement is limited to the handle's company.
 */

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
  source: 'file' | 'core'
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
  /** Matched against title and summary (substring, A–Z case-insensitive). */
  text?: string
  ids?: string[]
}

/** The columns read access is decided from. */
export interface RecordAccessRow {
  id: string
  type: string
  scopeId: string | null
  path: string | null
  folder: string | null
}

export interface RecordRepository {
  settings(): RecordSettingsRow
  setEnabled(enabled: boolean, by: string, at: string): void

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

  linksFrom(ids: string[]): RecordLinkRow[]
  /** Links naming any of `ids` as their target. */
  linksTo(ids: string[]): RecordLinkRow[]
  replaceLinks(sourceId: string, links: RecordLinkRow[]): void

  states(ids: string[]): RecordStateRow[]

  /** Live records matching the filter, with only the access columns (bounded by `limit`). */
  candidates(filter: RecordCandidateFilter, limit: number): RecordAccessRow[]
  /** Full rows of live records, any order. */
  byIds(ids: string[]): RecordRow[]

  head(repo: RecordRepoKey): string | null
  setHead(repo: RecordRepoKey, commitSha: string, at: string): void
  /** Forget every head: the next index run reads every repository in full. */
  clearHeads(): void

  problems(limit: number): RecordProblemRow[]
  /** Replace the problems of these paths in one repository (all of its problems when `paths` is null). */
  replaceProblems(repo: RecordRepoKey, paths: string[] | null, problems: RecordProblemRow[]): void
}
