/**
 * Builds the company map's index from the files (stage 4-2,
 * `.claude/rules/records.md`): type definitions (`.acb/types/<name>.md`, the
 * company repository only) and record files (frontmatter id / type / links)
 * of the company repository and of every private folder's repository.
 *
 * Runs after an accepted push (and when the feature is turned on, or an
 * owner asks for a rebuild), per company, one run at a time; pushes that
 * arrive meanwhile are folded into one more run. Each repository is read from
 * the commit indexed last (its diff), or in full.
 *
 * What the server refuses here is only what concerns safety (owner decision,
 * 4-1); everything else is reported for the app / an admin to fix:
 * - id hijack: a file claiming an id that another live record has keeps
 *   nothing of it (state, history): it is not indexed (`duplicate_id`) — the
 *   app gives the copy a new id. A move (the old file gone in the same push)
 *   keeps the record. A record never moves between a private folder and
 *   anywhere else this way.
 * - type of a record cannot change (`type_changed`).
 * - links from outside a private folder into it are stored but never shown
 *   or followed (services/record-access.ts linkAllowed).
 * Removed files mark their record removed; its server state is kept (it is
 * not rebuildable), and the same file coming back revives it.
 */
import { coreTypeDefinitions } from '../../shared/core/core-types'
import { isSameOrAncestorPath } from '../../shared/core/paths'
import {
  canonicalTypeJson, compareTypeDefinitions, parseTypeFile, storedTypeDefinition, typeNameOfPath, type TypeDefinition,
} from '../../shared/core/record-types'
import { fileLinkPath, parseRecordFile, RECORD_ID_RE, type ParsedRecordFile } from '../../shared/core/records'
import type { ScopeWithRules } from '../../shared/core/permissions'
import type { Clock } from '../ports/clock'
import type { CompanyDataSource } from '../ports/company-data'
import type { RecordFileChange, RecordFileSource } from '../ports/record-files'
import type { RecordLinkRow, RecordProblemRow, RecordRepoKey, RecordRepository, RecordRow } from '../ports/records'
import type { Transactions } from '../ports/transactions'
import { logError } from '../lib/error-log'

export interface CurrentType {
  version: number
  definition: TypeDefinition
  source: 'file' | 'core'
}

/** The version in force of every type (the highest stored). */
export function currentTypes(records: RecordRepository): Map<string, CurrentType> {
  const out = new Map<string, CurrentType>()
  for (const row of records.typeVersions()) {
    const prev = out.get(row.name)
    if (!prev || row.version > prev.version) {
      out.set(row.name, { version: row.version, definition: storedTypeDefinition(row.definition), source: row.source })
    }
  }
  return out
}

/**
 * Store the core types (task, interaction; shared/core/core-types.ts) for a
 * company, source `core`, unless a version at least as new is stored (a
 * company's own `.acb/types/task.md` may extend one with a higher version).
 */
export function ensureCoreTypes(records: RecordRepository, at: string): void {
  const stored = new Map<string, number>()
  for (const row of records.typeVersions()) stored.set(row.name, Math.max(stored.get(row.name) ?? 0, row.version))
  for (const def of coreTypeDefinitions()) {
    if ((stored.get(def.name) ?? 0) >= def.version) continue
    records.insertTypeVersion({ name: def.name, version: def.version, definition: canonicalTypeJson(def), source: 'core', commitSha: null, createdAt: at })
  }
}

export interface ApplyInput {
  repoKey: RecordRepoKey
  /** The private folder whose repository this is; null = the company repository. */
  scopeId: string | null
  /** Company path of the repository's root ('' for the company repository). */
  prefix: string
  full: boolean
  tip: string
  at: string
  changes: RecordFileChange[]
  /** Every scope of the company (to tell a folder made public from one deleted). */
  scopes: ScopeWithRules[]
}

const PROBLEM_TEXT = {
  duplicate_id: 'この id はほかの記録が使っています（コピーしたファイルなど）。アプリが新しい id を付け直します',
  moved_across_folders: 'この id の記録は別の場所（非公開のフォルダの中と外）にあります。アプリが新しい id を付け直します',
  type_changed: '記録の型は変えられません。いまの型のままにしています',
  unknown_type: 'この型の定義がありません（.acb/types/ に定義を置いてください）',
  type_file_removed: '定義のファイルが消えました。いまの定義をそのまま使います',
}

/**
 * Apply one repository's changes to the index. Synchronous: run it inside
 * one transaction (the indexer does).
 */
export function applyRecordChanges(records: RecordRepository, input: ApplyInput): void {
  const { scopeId, prefix, at } = input
  const problems: RecordProblemRow[] = []
  const touched = new Set<string>()
  const problem = (path: string, kind: string, detail: string) => problems.push({ repo: input.repoKey, path, kind, detail, foundAt: at })
  const companyPath = (p: string) => (prefix ? `${prefix}/${p}` : p)

  // 1. Type definitions (company repository only), before the records that use them.
  const types = currentTypes(records)
  const recordChanges: RecordFileChange[] = []
  for (const c of input.changes) {
    const name = scopeId === null ? typeNameOfPath(c.path) : null
    if (name === null) { recordChanges.push(c); continue }
    touched.add(c.path)
    const cur = types.get(name)
    if (c.text === null) {
      if (cur) problem(c.path, 'type_file_removed', PROBLEM_TEXT.type_file_removed)
      continue
    }
    const parsed = parseTypeFile(name, c.text)
    if (!parsed.ok) { problem(c.path, 'invalid_type', parsed.errors.slice(0, 5).join(' / ')); continue }
    const def = parsed.definition
    if (cur) {
      const change = compareTypeDefinitions(cur.definition, def)
      if (change.breaking.length > 0) {
        problem(c.path, 'breaking_type_change', `消す・名前を変える変更はまだできません: ${change.breaking.slice(0, 5).join(' / ')}`)
        continue
      }
      if (change.versionProblem) { problem(c.path, 'type_version', change.versionProblem); continue }
      if (def.version === cur.version) continue
    }
    records.insertTypeVersion({ name, version: def.version, definition: canonicalTypeJson(def), source: 'file', commitSha: input.tip, createdAt: at })
    types.set(name, { version: def.version, definition: def, source: 'file' })
  }

  // 2. Record files.
  const vacating = new Map<string, RecordRow>()
  const vacate = (path: string) => {
    const row = records.findByPath(path)
    if (row && row.scopeId === scopeId) vacating.set(row.id, row)
  }
  const parsed: Array<{ path: string; rec: ParsedRecordFile }> = []
  for (const c of recordChanges) {
    const path = companyPath(c.path)
    touched.add(path)
    if (c.text === null) { vacate(path); continue }
    const r = parseRecordFile(path, c.text)
    if (r.kind === 'record') {
      parsed.push({ path, rec: r.record })
      const existing = records.findByPath(path)
      if (existing && existing.id !== r.record.id && existing.scopeId === scopeId) vacating.set(existing.id, existing)
    } else {
      vacate(path)
      if (r.kind === 'invalid') problem(path, 'invalid_record', r.problems.join(' / '))
    }
  }
  if (input.full) {
    const present = new Set(parsed.map(p => p.path))
    for (const row of records.fileRecordsIn(scopeId)) if (row.path !== null && !present.has(row.path)) vacating.set(row.id, row)
  }

  const scopeById = new Map(input.scopes.map(s => [s.id, s]))
  const claimed = new Set<string>()
  parsed.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  for (const { path, rec } of parsed) {
    if (claimed.has(rec.id)) { problem(path, 'duplicate_id', PROBLEM_TEXT.duplicate_id); continue }
    const row = records.find(rec.id)
    let ok = false
    if (!row) ok = true
    else if (row.removedAt === null && row.path === path && row.scopeId === scopeId) ok = true
    else if (row.removedAt === null && vacating.has(rec.id) && row.scopeId === scopeId) ok = true // moved
    else if (row.removedAt !== null && row.scopeId === scopeId) ok = true // came back
    else if (row.removedAt === null && row.path === null && scopeId === null && (row.folder === null || isSameOrAncestorPath(row.folder, path))) ok = true // a server-only record gets its file
    else if (row.scopeId !== null && scopeId === null) {
      // The private folder was made public: its records now live in the company repository.
      const s = scopeById.get(row.scopeId)
      ok = !!s && s.repoId === null && isSameOrAncestorPath(s.path, path)
    }
    if (!ok) {
      problem(path, row && (row.scopeId === null) !== (scopeId === null) ? 'moved_across_folders' : 'duplicate_id',
        row && (row.scopeId === null) !== (scopeId === null) ? PROBLEM_TEXT.moved_across_folders : PROBLEM_TEXT.duplicate_id)
      continue
    }
    if (row && row.type !== rec.type) { problem(path, 'type_changed', PROBLEM_TEXT.type_changed); continue }
    claimed.add(rec.id)
    vacating.delete(rec.id)
    const typeDef = types.get(rec.type)
    if (!typeDef) problem(path, 'unknown_type', PROBLEM_TEXT.unknown_type)
    if (rec.problems.length > 0) problem(path, 'ignored_keys', rec.problems.slice(0, 5).join(' / '))
    records.upsert({
      id: rec.id,
      type: rec.type,
      typeVersion: row?.typeVersion ?? typeDef?.version ?? null,
      scopeId,
      path,
      folder: null,
      title: rec.title,
      summary: rec.summary,
      createdAt: row?.createdAt ?? at,
      updatedAt: at,
      removedAt: null,
    })
    const links: RecordLinkRow[] = []
    let position = 0
    for (const [name, targets] of Object.entries(rec.links)) {
      const declared = typeDef?.definition.links[name]
      for (const t of targets) {
        const asFile = declared ? declared.target === 'file' : !RECORD_ID_RE.test(t)
        if (asFile) {
          const p = fileLinkPath(t)
          if (p !== null) links.push({ sourceId: rec.id, name, position: position++, targetId: null, targetPath: p })
        } else if (RECORD_ID_RE.test(t)) {
          links.push({ sourceId: rec.id, name, position: position++, targetId: t, targetPath: null })
        }
      }
    }
    records.replaceLinks(rec.id, links)
  }
  for (const id of vacating.keys()) records.markRemoved(id, at)

  records.replaceProblems(input.repoKey, input.full ? null : [...touched], problems)
  records.setHead(input.repoKey, input.tip, at)
}

export interface RecordIndexerDeps {
  companyData: CompanyDataSource
  transactions: Transactions
  clock: Clock
  recordFiles: RecordFileSource
}

export function createRecordIndexer({ companyData, transactions, clock, recordFiles }: RecordIndexerDeps) {
  const runs = new Map<string, { again: boolean; done: Promise<void> }>()

  async function indexCompany(companyId: string): Promise<void> {
    const handle = companyData.forCompany(companyId)
    if (!handle.records.settings().enabled) return
    transactions.run(() => ensureCoreTypes(handle.records, clock.now()))
    const scopes = handle.scopes.listWithRules()
    const repos: Array<{ key: RecordRepoKey; scopeId: string | null; prefix: string; repo: Parameters<RecordFileSource['read']>[1] }> = [
      { key: 'company', scopeId: null, prefix: '', repo: { kind: 'company' } },
      ...scopes.filter(s => s.repoId !== null).map(s => ({
        key: `scope:${s.id}` as RecordRepoKey, scopeId: s.id, prefix: s.path, repo: { kind: 'scope' as const, repoId: s.repoId as string },
      })),
    ]
    for (const r of repos) {
      const read = await recordFiles.read(companyId, r.repo, handle.records.head(r.key))
      if (read.tip === null || (read.changes.length === 0 && !read.full && read.tip === handle.records.head(r.key))) continue
      const tip = read.tip
      transactions.run(() => applyRecordChanges(handle.records, {
        repoKey: r.key, scopeId: r.scopeId, prefix: r.prefix, full: read.full, tip, at: clock.now(), changes: read.changes, scopes,
      }))
    }
  }

  /**
   * Index the company now (if the feature is on). Calls while a run is going
   * share one more run after it. Never rejects: a failure is logged and the
   * next push retries from the last commit indexed.
   */
  function schedule(companyId: string): Promise<void> {
    const running = runs.get(companyId)
    if (running) { running.again = true; return running.done }
    const state = { again: false, done: Promise.resolve() }
    state.done = (async () => {
      try {
        do {
          state.again = false
          try {
            await indexCompany(companyId)
          } catch (err) {
            logError('records', 'Indexing the company map failed', err, { company: companyId })
          }
        } while (state.again)
      } finally {
        runs.delete(companyId)
      }
    })()
    runs.set(companyId, state)
    return state.done
  }

  return { schedule }
}

export type RecordIndexer = ReturnType<typeof createRecordIndexer>
