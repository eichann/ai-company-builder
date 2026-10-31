/**
 * Rules left behind by a folder that is no longer there.
 *
 * Renaming or deleting a department through the API moves or drops its scopes
 * (moveScopeSubtree / deleteDepartmentScopes). But an owner can also rename or
 * delete a folder in the desktop app and sync: the push goes through, and the
 * scope keeps its old path. Its rules then match nothing, and the place they
 * restricted silently falls back to the parent's rules — under the new name
 * everyone the parent lets edit may edit again.
 *
 * Nothing follows renames automatically (a rename and a delete + new folder
 * look the same to git, and guessing wrong would restrict the wrong folder).
 * Instead such scopes are reported — GET /permissions (orphanedScopes) and the
 * overview — so an owner can move the rules to the new place or delete them.
 *
 * "Missing" = some segment of the scope's path is not a folder (tree or
 * gitlink) on the shared branch, comparing names in NFC and with A–Z folded:
 * a Mac commits Japanese names in NFD, and macOS / Windows check out
 * "Sales/x.md" into an existing "sales/" folder, which is why the push check
 * also matches scopes case-insensitively (push-check/policy.ts). A scope that
 * still matches that way is not reported.
 *
 * When it runs:
 * - after every accepted push (git-http, scheduleOrphanedScopeCheck): deferred
 *   with setImmediate and asynchronous, so it never delays the push response;
 * - on GET /permissions and GET /overview (findOrphanedScopes).
 * Results are cached per company keyed by the branch's commit id and the set
 * of scopes with rules, so repeated reads cost one `git rev-parse`.
 * When a scope was first seen missing is kept in orphaned_scopes (since).
 *
 * The adapter behind OrphanedScopeReader: it reads the company repository
 * (git) and the scopes, and keeps the orphaned_scopes table.
 */
import { existsSync } from 'fs'
import type Database from 'better-sqlite3'
import { now } from '../db'
import { companyRepoPath } from '../lib/config'
import { gitAsync } from '../lib/git-exec'
import { listScopesWithRules } from './sqlite/permission-store'
import type { ScopeWithRules } from '../../shared/core/permissions'
import { nameKey } from '../../shared/core/paths'
import type { OrphanedScope, OrphanedScopeReader } from '../ports/orphaned-scopes'

// Output limit of the git calls here (rev-parse, one directory's ls-tree).
const GIT_OPTS = { maxBuffer: 64 * 1024 * 1024 }

/** The commit of the shared branch (main, or master for old repos); null when there is none. */
async function sharedBranchCommit(bare: string): Promise<string | null> {
  for (const branch of ['main', 'master']) {
    try {
      const out = (await gitAsync(['-C', bare, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`], GIT_OPTS)).trim()
      if (/^[0-9a-f]{40,64}$/.test(out)) return out
    } catch {
      // try the next name
    }
  }
  return null
}

/** How names are compared: NFC, A–Z folded. */
export const folderMatchKey = nameKey

/**
 * The scope paths (of `paths`) that do not resolve to a folder at `commit`.
 * Each directory is listed at most once.
 */
async function missingPaths(bare: string, commit: string, paths: string[]): Promise<Set<string>> {
  // stored repo path ('' = root) -> match key -> stored child name + type.
  // A failing ls-tree rejects (and fails the whole check) rather than
  // reporting the folder missing: only trees found here are listed.
  const listings = new Map<string, Promise<Map<string, { name: string; gitlink: boolean }>>>()
  const list = (dir: string) => {
    let p = listings.get(dir)
    if (!p) {
      p = gitAsync(['-C', bare, 'ls-tree', '-z', dir === '' ? commit : `${commit}:${dir}`], GIT_OPTS).then(out => {
        const children = new Map<string, { name: string; gitlink: boolean }>()
        for (const record of out.split('\0')) {
          if (!record) continue
          const tab = record.indexOf('\t')
          const type = record.slice(0, tab).split(' ')[1]
          if (type !== 'tree' && type !== 'commit') continue
          const name = record.slice(tab + 1)
          const key = folderMatchKey(name)
          if (!children.has(key)) children.set(key, { name, gitlink: type === 'commit' })
        }
        return children
      })
      listings.set(dir, p)
    }
    return p
  }

  const missing = new Set<string>()
  for (const path of paths) {
    let stored = ''
    for (const segment of path.split('/')) {
      const match = (await list(stored)).get(folderMatchKey(segment))
      if (match === undefined) {
        missing.add(path)
        break
      }
      // Inside a gitlink (a nested repository) there is nothing to look at.
      if (match.gitlink) break
      stored = stored ? `${stored}/${match.name}` : match.name
    }
  }
  return missing
}

interface CacheEntry {
  key: string
  orphanIds: string[]
}

const cache = new Map<string, CacheEntry>()
const inflight = new Map<string, Promise<OrphanedScope[]>>()

/** Test hook. */
export function resetOrphanedScopeCache(): void {
  cache.clear()
}

function withSince(db: Database.Database, companyId: string, scopes: ScopeWithRules[], ids: string[]): OrphanedScope[] {
  if (ids.length === 0) return []
  const since = new Map((db.prepare(`SELECT scope_id, detected_at FROM orphaned_scopes WHERE company_id = ?`)
    .all(companyId) as Array<{ scope_id: string; detected_at: string }>).map(r => [r.scope_id, r.detected_at]))
  const byId = new Map(scopes.map(s => [s.id, s]))
  return ids
    .map(id => byId.get(id))
    .filter((s): s is ScopeWithRules => !!s)
    .map(scope => ({ scope, since: since.get(scope.id) ?? now() }))
}

/**
 * Scopes judged against the company repository: rules, not the root, and not
 * a private folder or anything inside one (those live in their own scope
 * repository and never appear in the company repository).
 */
function isCandidate(s: ScopeWithRules, all: ScopeWithRules[]): boolean {
  if (s.path === '' || s.rules.length === 0 || s.repoId !== null) return false
  return !all.some(p => p.repoId !== null && (s.path === p.path || s.path.startsWith(`${p.path}/`)))
}

async function compute(db: Database.Database, companyId: string): Promise<OrphanedScope[]> {
  const bare = companyRepoPath(companyId)
  if (!existsSync(bare)) return []
  const commit = await sharedBranchCommit(bare)
  const scopes = listScopesWithRules(db, companyId)
  // An empty repository has no folders yet; nothing can be judged missing.
  if (!commit) return []
  const candidates = scopes.filter(s => isCandidate(s, scopes))
  const key = `${commit}\u0000${candidates.map(s => `${s.id}=${s.path}`).sort().join('\u0000')}`

  const cached = cache.get(companyId)
  if (cached && cached.key === key) return withSince(db, companyId, scopes, cached.orphanIds)

  const missing = await missingPaths(bare, commit, candidates.map(s => s.path))
  // The scopes may have changed while git ran; judge only those still current.
  const current = listScopesWithRules(db, companyId)
  const stillCandidates = new Map(current.filter(s => isCandidate(s, current)).map(s => [s.id, s.path]))
  const orphanIds = candidates.filter(s => missing.has(s.path) && stillCandidates.get(s.id) === s.path).map(s => s.id)

  const ts = now()
  db.transaction(() => {
    const keep = new Set(orphanIds)
    const rows = db.prepare(`SELECT scope_id FROM orphaned_scopes WHERE company_id = ?`).all(companyId) as Array<{ scope_id: string }>
    for (const r of rows) {
      if (!keep.has(r.scope_id)) db.prepare(`DELETE FROM orphaned_scopes WHERE scope_id = ?`).run(r.scope_id)
    }
    for (const id of orphanIds) {
      db.prepare(`
        INSERT INTO orphaned_scopes (scope_id, company_id, detected_at, commit_id) VALUES (?, ?, ?, ?)
        ON CONFLICT(scope_id) DO UPDATE SET commit_id = excluded.commit_id
      `).run(id, companyId, ts, commit)
    }
  })()
  cache.set(companyId, { key, orphanIds })
  return withSince(db, companyId, current, orphanIds)
}

/**
 * Scopes with rules whose folder is missing on the shared branch. Never
 * throws: on any failure it logs and returns [] (a read must not break over a
 * warning).
 */
async function findOrphanedScopes(db: Database.Database, companyId: string): Promise<OrphanedScope[]> {
  const running = inflight.get(companyId)
  if (running) {
    // Join a check in progress, then re-check (cheap on a cache hit): the
    // scopes may have changed since it started.
    await running.catch(() => {})
  }
  const p = compute(db, companyId).catch((err: unknown) => {
    console.error(`[orphaned-scopes] check failed for ${companyId}:`, err)
    return [] as OrphanedScope[]
  })
  inflight.set(companyId, p)
  try {
    return await p
  } finally {
    if (inflight.get(companyId) === p) inflight.delete(companyId)
  }
}

export function gitOrphanedScopeReader(conn: Database.Database): OrphanedScopeReader {
  return {
    find: companyId => findOrphanedScopes(conn, companyId),
    scheduleCheck(companyId) {
      setImmediate(() => {
        void findOrphanedScopes(conn, companyId)
      })
    },
  }
}
