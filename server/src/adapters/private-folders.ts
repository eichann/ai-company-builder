/**
 * Private folders' storage (private-folders.md): the scope_repos rows, the
 * scopes and rules of each private folder, and the steps that change a scope
 * repository together with them — create, make public, delete — under the
 * company lock the service takes. Git, files and the pushes in flight are
 * lib/private-folders.ts; refusals become results at the port.
 */
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type Database from 'better-sqlite3'
import type { PrivateFolderRecord, PrivateFolderRepository, PrivateRuleSet, FolderAccess } from '../ports/private-folders'
import { createScopeRepo, removeScopeRepo, SERVER_GIT_IDENTITY } from '../lib/git-server'
import { gitAsync } from '../lib/git-exec'
import { companyRepoPath } from '../lib/config'
import { listScopesWithRules } from './sqlite/permission-store'
import {
  closeScope,
  companyPushesRunning,
  existsInCompanyRepo,
  privateRepoPath,
  privateRules,
  reopenScope,
  resolveInCompanyRepo,
  waitForCompanyPushes,
  waitForScopePushes,
  writePrivateFolderArchive,
  type PrivateFolderArchiveAction,
} from '../lib/private-folders'
import { isSameOrAncestorPath, resolveAccess, type PermissionRepository } from '../../shared/core/permissions'
import { pathKey } from '../../shared/core/paths'

type Conn = Database.Database

/** Same or ancestor, compared as pathKey()s. */
function overlaps(a: string, b: string): boolean {
  const ka = pathKey(a)
  const kb = pathKey(b)
  return isSameOrAncestorPath(ka, kb) || isSameOrAncestorPath(kb, ka)
}

export function listPrivateFolders(conn: Conn, companyId: string, scopes = listScopesWithRules(conn, companyId)): PrivateFolderRecord[] {
  const rows = conn.prepare(`SELECT id, scope_id, created_at, created_by FROM scope_repos WHERE company_id = ?`)
    .all(companyId) as Array<{ id: string; scope_id: string; created_at: string; created_by: string | null }>
  const byScope = new Map(rows.map(r => [r.scope_id, r]))
  const out: PrivateFolderRecord[] = []
  for (const s of scopes) {
    if (s.repoId === null) continue
    const row = byScope.get(s.id)
    out.push({ scope: s, repoId: s.repoId, createdAt: row?.created_at ?? '', createdBy: row?.created_by ?? null })
  }
  return out.sort((a, b) => (a.scope.path < b.scope.path ? -1 : a.scope.path > b.scope.path ? 1 : 0))
}

export function getPrivateFolder(conn: Conn, companyId: string, scopeId: string): PrivateFolderRecord | null {
  return listPrivateFolders(conn, companyId).find(p => p.scope.id === scopeId) ?? null
}

/** Is `path` (company path, NFC) free for a new private folder? Uniform answer for every kind of conflict. */
export async function isPathAvailable(conn: Conn, companyId: string, path: string): Promise<boolean> {
  const scopes = listScopesWithRules(conn, companyId)
  // Any private folder at, above or below it.
  if (scopes.some(s => s.repoId !== null && overlaps(s.path, path))) return false
  // A scope row at or below it (rules on a folder that is gone, a department scope).
  if (scopes.some(s => s.path !== '' && isSameOrAncestorPath(pathKey(path), pathKey(s.path)))) return false
  // Anything in the company repository at that path.
  return !(await existsInCompanyRepo(companyId, path))
}

export class PathUnavailableError extends Error {
  constructor() {
    super('FOLDER_NAME_UNAVAILABLE')
  }
}

/** A push to the company repository did not finish in time; nothing was created. */
export class PrivateFolderBusyError extends Error {
  constructor() {
    super('BUSY')
  }
}

/**
 * Create the scope repository, scope, rules and reservation. Call under the
 * company lock, after validation and authorisation. Throws
 * PathUnavailableError when the path is (or became) taken; leaves nothing
 * behind on any failure.
 */
export async function createPrivateFolder(
  conn: Conn,
  input: { companyId: string; path: string; rules: PrivateRuleSet; createdBy: string },
): Promise<{ scopeId: string; repoId: string }> {
  const { companyId, path } = input
  if (!(await isPathAvailable(conn, companyId, path))) throw new PathUnavailableError()
  const scopeId = crypto.randomUUID()
  const repoId = crypto.randomUUID()
  const repo = privateRepoPath(companyId, repoId)
  await createScopeRepo(repo, `Create private folder ${path}`)
  const ts = new Date().toISOString()
  try {
    conn.transaction(() => {
      conn.prepare(`
        INSERT INTO scopes (id, company_id, path, kind, department_id, repo_id, created_at, created_by)
        VALUES (?, ?, ?, 'folder', NULL, ?, ?, ?)
      `).run(scopeId, companyId, path, repoId, ts, input.createdBy)
      for (const r of privateRules(input.rules)) {
        insertPrivateRule(conn, companyId, scopeId, r, ts, input.createdBy)
      }
      conn.prepare(`INSERT INTO scope_repos (id, company_id, scope_id, created_at, created_by) VALUES (?, ?, ?, ?, ?)`)
        .run(repoId, companyId, scopeId, ts, input.createdBy)
    })()
  } catch (err) {
    await removeScopeRepo(repo)
    throw err
  }
  // A push to the company repository that took its permission snapshot
  // before the reservation existed is checked against that snapshot, so it
  // could still land at the path — even after the check below, if its hook
  // ran before and its ref update after it. Wait for every such push to end
  // (pushes starting from now on see the reservation), then check: undo
  // rather than leave public content inside a "private" folder.
  const before = companyPushesRunning(companyId)
  if (!(await waitForCompanyPushes(companyId, before))) {
    deletePrivateFolderRows(conn, companyId, scopeId, repoId)
    await removeScopeRepo(repo)
    throw new PrivateFolderBusyError()
  }
  if (await existsInCompanyRepo(companyId, path)) {
    deletePrivateFolderRows(conn, companyId, scopeId, repoId)
    await removeScopeRepo(repo)
    throw new PathUnavailableError()
  }
  return { scopeId, repoId }
}

/** A rule on a scope of the company (a scope of another company: the insert trigger refuses it). */
function insertPrivateRule(conn: Conn, companyId: string, scopeId: string, r: ReturnType<typeof privateRules>[number], ts: string, by: string): void {
  conn.prepare(`
    INSERT INTO scope_rules (id, company_id, scope_id, subject_type, subject_id, can_read, can_write, created_at, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(crypto.randomUUID(), companyId, scopeId, r.subjectType, r.subjectId, r.canRead ? 1 : 0, r.canWrite ? 1 : 0, ts, by)
}

/** Remove a scope of the company with its rules. */
function deleteScopeAndRules(conn: Conn, companyId: string, scopeId: string): void {
  conn.prepare(`DELETE FROM scope_rules WHERE scope_id = ? AND company_id = ?`).run(scopeId, companyId)
  conn.prepare(`DELETE FROM scopes WHERE id = ? AND company_id = ?`).run(scopeId, companyId)
}

function deletePrivateFolderRows(conn: Conn, companyId: string, scopeId: string, repoId: string): void {
  conn.transaction(() => {
    deleteScopeAndRules(conn, companyId, scopeId)
    conn.prepare(`DELETE FROM scope_repos WHERE id = ? AND company_id = ?`).run(repoId, companyId)
  })()
}

/** Replace the viewers/editors of a private folder of the company (its own rule set). */
export function replacePrivateFolderRules(conn: Conn, companyId: string, scopeId: string, rules: PrivateRuleSet, by: string): void {
  const ts = new Date().toISOString()
  conn.transaction(() => {
    conn.prepare(`DELETE FROM scope_rules WHERE scope_id = ? AND company_id = ?`).run(scopeId, companyId)
    for (const r of privateRules(rules)) insertPrivateRule(conn, companyId, scopeId, r, ts, by)
  })()
}

export function folderAccess(conn: Conn, companyId: string, path: string, scopes = listScopesWithRules(conn, companyId)): FolderAccess[] {
  const members = conn.prepare(`SELECT user_id, role FROM memberships WHERE company_id = ? ORDER BY created_at ASC`)
    .all(companyId) as Array<{ user_id: string; role: string }>
  const roles = new Map(members.map(m => [m.user_id, m.role]))
  const repo: PermissionRepository = { getMemberRole: (_c, u) => roles.get(u) ?? null, listScopes: () => scopes }
  return members.map(m => {
    const a = resolveAccess(companyId, m.user_id, path, repo)
    return { userId: m.user_id, role: m.role, read: a.read, write: a.write }
  })
}

export class MakePublicError extends Error {
  constructor(readonly code: 'BUSY' | 'PATH_OCCUPIED' | 'CONCURRENT_UPDATES', message: string) {
    super(message)
  }
}

/**
 * Put the private folder's current contents into the company repository at
 * its path and turn it into an ordinary folder. Call under the company lock.
 *
 * Order (each step safe to repeat if a later one fails):
 *   1. refuse new pushes to the scope repository, wait for running ones;
 *      archive the scope repository (archivePrivateFolder: its whole
 *      history, which the company repository will not receive);
 *   2. write the scope's tree into the company repository's main as one
 *      commit (no history), with a compare-and-swap ref update — retried when
 *      a member pushed meanwhile; if the path already holds exactly that tree
 *      (a previous attempt got this far), nothing is written;
 *   3. in one transaction: rules readable for everyone (write unchanged),
 *      repo_id cleared, scope_repos row removed;
 *   4. delete the scope repository.
 */
export async function makePrivateFolderPublic(conn: Conn, companyId: string, folder: PrivateFolderRecord, by: string | null = null): Promise<{ path: string; commit: string }> {
  const scopeId = folder.scope.id
  const scopeRepo = privateRepoPath(companyId, folder.repoId)
  const bare = companyRepoPath(companyId)
  closeScope(scopeId)
  try {
    if (!(await waitForScopePushes(scopeId, 30_000))) {
      throw new MakePublicError('BUSY', 'A push to this folder is still running; try again in a moment')
    }
    await archivePrivateFolder(conn, companyId, folder, 'make-public', by)
    const tree = (await gitAsync(['-C', scopeRepo, 'rev-parse', 'refs/heads/main^{tree}'])).trim()
    // Carry only that tree over (a parentless commit), never the scope's history.
    const exportCommit = (await gitAsync(['-C', scopeRepo, 'commit-tree', tree, '-m', 'export'], { env: SERVER_GIT_IDENTITY })).trim()
    const exportRef = `refs/acb/export-${scopeId}`
    await gitAsync(['-C', scopeRepo, 'update-ref', exportRef, exportCommit])
    const importRef = `refs/acb/import-${scopeId}`
    let commit = ''
    try {
      await gitAsync(['-C', bare, 'fetch', '--no-tags', '--quiet', scopeRepo, `+${exportRef}:${importRef}`])
      // The folders above keep the spelling the company repository uses (a
      // Mac commits Japanese names in NFD); the new last segment is NFC.
      const resolved = await resolveInCompanyRepo(companyId, folder.scope.path)
      const segments = folder.scope.path.split('/')
      const keep = Math.min(resolved.matched, segments.length - 1)
      const storedSegments = resolved.stored ? resolved.stored.split('/') : []
      const prefix = [...storedSegments.slice(0, keep), ...segments.slice(keep)].join('/')
      const tmp = mkdtempSync(join(tmpdir(), 'acb-make-public-'))
      try {
        for (let attempt = 0; attempt < 5 && !commit; attempt++) {
          const head = (await gitAsync(['-C', bare, 'rev-parse', 'refs/heads/main'])).trim()
          if (resolved.matched === resolved.total) {
            // Already there: done before (identical) or taken (refuse).
            const existing = (await gitAsync(['-C', bare, 'rev-parse', `${head}:${resolved.stored}`]).catch(() => '')).trim()
            if (existing === tree) {
              commit = head
              break
            }
            throw new MakePublicError('PATH_OCCUPIED', 'Something already exists at this path in the company repository')
          }
          const env = { ...SERVER_GIT_IDENTITY, GIT_INDEX_FILE: join(tmp, `index-${attempt}`) }
          await gitAsync(['-C', bare, 'read-tree', head], { env })
          // --prefix insists on a work tree; an empty one is never touched (no -u).
          await gitAsync([`--git-dir=${bare}`, `--work-tree=${tmp}`, 'read-tree', `--prefix=${prefix}/`, `${importRef}^{tree}`], { env })
          const newTree = (await gitAsync(['-C', bare, 'write-tree'], { env })).trim()
          const newCommit = (await gitAsync(['-C', bare, 'commit-tree', newTree, '-p', head, '-m', `Make private folder public: ${folder.scope.path}`], { env })).trim()
          try {
            await gitAsync(['-C', bare, 'update-ref', 'refs/heads/main', newCommit, head])
            commit = newCommit
          } catch {
            // a member pushed in between: rebuild on the new head
          }
        }
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
      if (!commit) throw new MakePublicError('CONCURRENT_UPDATES', 'The company repository kept changing; try again')
    } finally {
      await gitAsync(['-C', bare, 'update-ref', '-d', importRef]).catch(() => '')
      await gitAsync(['-C', scopeRepo, 'update-ref', '-d', exportRef]).catch(() => '')
    }

    conn.transaction(() => {
      const subtree = (conn.prepare(`SELECT id, path FROM scopes WHERE company_id = ?`).all(companyId) as Array<{ id: string; path: string }>)
        .filter(s => isSameOrAncestorPath(folder.scope.path, s.path))
      for (const s of subtree) {
        conn.prepare(`UPDATE scope_rules SET can_read = 1 WHERE scope_id = ? AND company_id = ?`).run(s.id, companyId)
      }
      conn.prepare(`UPDATE scopes SET repo_id = NULL WHERE id = ? AND company_id = ?`).run(scopeId, companyId)
      conn.prepare(`DELETE FROM scope_repos WHERE id = ? AND company_id = ?`).run(folder.repoId, companyId)
    })()
    await removeScopeRepo(scopeRepo)
    return { path: folder.scope.path, commit }
  } finally {
    reopenScope(scopeId)
  }
}

/**
 * Archive the scope repository (lib/private-folders.ts writePrivateFolderArchive:
 * bundle + sidecar) and record it in `private_folder_archives`. Throws when the
 * archive cannot be written: the caller must then not delete anything.
 */
async function archivePrivateFolder(
  conn: Conn,
  companyId: string,
  folder: PrivateFolderRecord,
  action: PrivateFolderArchiveAction,
  by: string | null,
): Promise<{ id: string; file: string }> {
  const { id, file, name, head, at } = await writePrivateFolderArchive(companyId, folder, action, by)
  conn.prepare(`
    INSERT INTO private_folder_archives (id, company_id, scope_id, path, action, file, head, created_at, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, companyId, folder.scope.id, folder.scope.path, action, name, head, at, by)
  return { id, file }
}

/**
 * Delete a private folder for good (owner/admin, after typing its name).
 * Call under the company lock. Order:
 *   1. refuse new pushes to its repository and wait for running ones;
 *   2. archive the repository (archivePrivateFolder) — nothing is deleted
 *      if that fails;
 *   3. in one transaction: the rules and scopes at and under its path, the
 *      scope_repos row (= the reservation in the company repository);
 *   4. delete the scope repository.
 * Members who could read it see it disappear like losing access (their app
 * keeps nothing it can still sync to).
 */
export async function deletePrivateFolder(conn: Conn, companyId: string, folder: PrivateFolderRecord, by: string): Promise<{ path: string }> {
  const scopeId = folder.scope.id
  closeScope(scopeId)
  try {
    if (!(await waitForScopePushes(scopeId, 30_000))) {
      throw new MakePublicError('BUSY', 'A push to this folder is still running; try again in a moment')
    }
    await archivePrivateFolder(conn, companyId, folder, 'delete', by)
    conn.transaction(() => {
      const subtree = (conn.prepare(`SELECT id, path FROM scopes WHERE company_id = ?`).all(companyId) as Array<{ id: string; path: string }>)
        .filter(s => isSameOrAncestorPath(folder.scope.path, s.path))
      for (const s of subtree) deleteScopeAndRules(conn, companyId, s.id)
      conn.prepare(`DELETE FROM scope_repos WHERE id = ? AND company_id = ?`).run(folder.repoId, companyId)
    })()
    await removeScopeRepo(privateRepoPath(companyId, folder.repoId))
    return { path: folder.scope.path }
  } finally {
    reopenScope(scopeId)
  }
}

/**
 * The port for one company (built only by its handle, sqlite/company-data.ts):
 * rows, scope repositories, the race protections. Refusals become results;
 * any other error propagates.
 */
export function sqlitePrivateFolderRepository(conn: Database.Database, companyId: string): PrivateFolderRepository {
  return {
    list: scopes => listPrivateFolders(conn, companyId, scopes),
    get: scopeId => getPrivateFolder(conn, companyId, scopeId),
    paths: () => listPrivateFolders(conn, companyId).map(p => p.scope.path),
    access: (path, scopes) => folderAccess(conn, companyId, path, scopes),

    async create(input) {
      try {
        const { scopeId } = await createPrivateFolder(conn, { ...input, companyId })
        return { ok: true, scopeId }
      } catch (err) {
        if (err instanceof PathUnavailableError) return { ok: false, reason: 'unavailable' }
        if (err instanceof PrivateFolderBusyError) {
          return { ok: false, reason: 'BUSY', message: 'Someone is still pushing to the company repository; try again in a moment' }
        }
        throw err
      }
    },

    replaceRules: (scopeId, rules, by) => replacePrivateFolderRules(conn, companyId, scopeId, rules, by),

    async makePublic(folder, by) {
      try {
        return { ok: true, value: await makePrivateFolderPublic(conn, companyId, folder, by) }
      } catch (err) {
        if (err instanceof MakePublicError) return { ok: false, reason: err.code, message: err.message }
        throw err
      }
    },

    async delete(folder, by) {
      try {
        return { ok: true, value: await deletePrivateFolder(conn, companyId, folder, by) }
      } catch (err) {
        if (err instanceof MakePublicError) return { ok: false, reason: err.code, message: err.message }
        throw err
      }
    },
  }
}
