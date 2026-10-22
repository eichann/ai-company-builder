/**
 * Private folders (permission plan stage 3a — the server side).
 *
 * A private folder is created private from the start (no carve-out of an
 * existing folder). The server
 *   1. creates a scope repository for it (lib/git-server/scope-repo.ts),
 *   2. stores a scope at its company path with repo_id → scope_repos.id, and
 *      the rules: `everyone: no read, no write` + one user rule per viewer
 *      (`read`, and `write` for editors),
 * all under the company lock. From then on
 *   - git-http serves the scope repository at
 *     /api/git-http/<companyId>/scopes/<scopeId>.git — fetch needs READ of the
 *     scope, push needs WRITE somewhere in it (the hook checks each path);
 *   - its path is reserved in the company repository: every push adding or
 *     changing something at or under it is refused with [RESERVED_PATH], for
 *     everyone (owner included) — push-check/policy.ts reservedPathsFor;
 *   - members who cannot read it never learn its name: APIs return it only
 *     to readers (and to those who manage it); the client gets salted hashes
 *     (reservedHashes) to recognise the reserved paths.
 *
 * Folders created inside a private folder are in the same scope repository,
 * i.e. private too. Private folders do not nest.
 *
 * "公開に戻す" (makePrivateFolderPublic, owner/admin) is the only way a scope
 * repository is removed: its current tree is written into the company
 * repository at the same path (one commit, no history — the scope's history
 * stays private), the rules become readable for everyone (editors keep
 * editing; nobody gains write), and the scope repository is deleted.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type Database from 'better-sqlite3'
import {
  createScopeRepo,
  gitAsync,
  removeScopeRepo,
  scopeRepoPath,
  SERVER_GIT_IDENTITY,
} from './git-server'
import { listScopesWithRules } from './permission-store'
import {
  FULL_ACCESS_ROLES,
  canReadPrivateScope,
  isSameOrAncestorPath,
  resolveAccess,
  type PermissionRepository,
  type ScopeRule,
  type ScopeWithRules,
} from './permissions'
import { foldAsciiCase } from './push-check/rules'

type Conn = Database.Database

const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), 'data')
export const REPOS_DIR = process.env.REPOS_DIR || join(DATA_DIR, 'repos')

/**
 * Where a private folder's repository is archived (git bundle) before it is
 * deleted or made public. Server-side only: never served by any route, the
 * directories are 0700 and the files 0600. PRIVATE_FOLDER_ARCHIVE_DIR
 * overrides the default <DATA_DIR>/backups/private-folders.
 */
export function privateFolderArchiveDir(): string {
  return process.env.PRIVATE_FOLDER_ARCHIVE_DIR || join(DATA_DIR, 'backups', 'private-folders')
}

export function companyRepoPath(companyId: string): string {
  return join(REPOS_DIR, `${companyId.replace(/[^a-zA-Z0-9_-]/g, '')}.git`)
}

export function privateRepoPath(companyId: string, repoId: string): string {
  return scopeRepoPath(REPOS_DIR, companyId, repoId)
}

/** NFC + A–Z folded: how paths are compared everywhere (push check, conflicts). */
export function pathKey(path: string): string {
  return foldAsciiCase(path.normalize('NFC').split('/').filter(Boolean).join('/'))
}

/** Same or ancestor, compared as pathKey()s. */
function overlaps(a: string, b: string): boolean {
  const ka = pathKey(a)
  const kb = pathKey(b)
  return isSameOrAncestorPath(ka, kb) || isSameOrAncestorPath(kb, ka)
}

// ----------------------------------------------------------------------------
// Reads
// ----------------------------------------------------------------------------

export interface PrivateFolderRecord {
  scope: ScopeWithRules
  repoId: string
  createdAt: string
  createdBy: string | null
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

/**
 * May this member put something at `path` (POST /paths/check)? false exactly
 * when the path is at or under a private folder they cannot read — what a
 * push of theirs there would be refused with ([RESERVED_PATH]). A reader's
 * paths inside a private folder are usable (they go to its own repository).
 * Every private folder is compared, whatever the outcome, so the answer
 * takes the same work for every path.
 */
export function isPathUsable(scopes: ScopeWithRules[], userId: string, role: string, path: string): boolean {
  const key = pathKey(path)
  let usable = true
  for (const s of scopes) {
    if (s.repoId === null) continue
    const inside = isSameOrAncestorPath(pathKey(s.path), key)
    const readable = canReadPrivateScope(s, userId, role)
    if (inside && !readable) usable = false
  }
  return usable
}

// ----------------------------------------------------------------------------
// Company repository lookups (bare repository, shared branch)
// ----------------------------------------------------------------------------

async function sharedBranch(bare: string): Promise<string | null> {
  for (const branch of ['main', 'master']) {
    try {
      const sha = (await gitAsync(['-C', bare, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`])).trim()
      if (sha) return `refs/heads/${branch}`
    } catch {
      // next
    }
  }
  return null
}

/** Names (as stored) of every entry — files, folders, hidden ones — of `dir` on the shared branch; null when it is not a folder. */
async function entriesOf(bare: string, ref: string, dir: string): Promise<string[] | null> {
  const target = dir === '' ? ref : `${ref}:${dir}`
  try {
    if (dir !== '' && (await gitAsync(['-C', bare, 'cat-file', '-t', target])).trim() !== 'tree') return null
    return (await gitAsync(['-C', bare, 'ls-tree', '-z', '--name-only', target])).split('\0').filter(Boolean)
  } catch {
    return null
  }
}

/**
 * Resolve `path` against the company repository segment by segment (names
 * compared as pathKey: NFC, A–Z folded). Returns the stored spelling of the
 * longest existing prefix and how many segments matched.
 */
export async function resolveInCompanyRepo(companyId: string, path: string): Promise<{ stored: string; matched: number; total: number }> {
  const segments = path.split('/').filter(Boolean)
  const bare = companyRepoPath(companyId)
  const ref = existsSync(bare) ? await sharedBranch(bare) : null
  let stored = ''
  let matched = 0
  if (!ref) return { stored, matched, total: segments.length }
  for (const seg of segments) {
    const entries = await entriesOf(bare, ref, stored)
    const hit = entries?.find(e => pathKey(e) === pathKey(seg))
    if (hit === undefined) break
    stored = stored ? `${stored}/${hit}` : hit
    matched++
  }
  return { stored, matched, total: segments.length }
}

/** True when anything (file or folder, any case/normalisation) exists at `path` in the company repository. */
export async function existsInCompanyRepo(companyId: string, path: string): Promise<boolean> {
  const r = await resolveInCompanyRepo(companyId, path)
  return r.total > 0 && r.matched === r.total
}

// ----------------------------------------------------------------------------
// Create
// ----------------------------------------------------------------------------

export interface PrivateRuleSet {
  viewers: string[]
  editors: string[]
}

export function privateRules(set: PrivateRuleSet): Array<Omit<ScopeRule, 'id'>> {
  const editors = new Set(set.editors)
  return [
    { subjectType: 'everyone', subjectId: null, canRead: false, canWrite: false },
    ...set.viewers.map(id => ({ subjectType: 'user' as const, subjectId: id, canRead: true, canWrite: editors.has(id) })),
  ]
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

// ----------------------------------------------------------------------------
// Pushes in flight to the company repository (creation waits for them)
// ----------------------------------------------------------------------------

const COMPANY_PUSH_WAIT_MS = 60_000
const companyPushes = new Map<string, Set<symbol>>()

/**
 * git-http: a receive-pack to the company repository starts — call BEFORE
 * taking its permission snapshot. Returns the function to call when the
 * request has ended (idempotent).
 */
export function beginCompanyPush(companyId: string): () => void {
  const token = Symbol('push')
  let set = companyPushes.get(companyId)
  if (!set) {
    set = new Set()
    companyPushes.set(companyId, set)
  }
  set.add(token)
  return () => {
    const s = companyPushes.get(companyId)
    if (!s) return
    s.delete(token)
    if (s.size === 0) companyPushes.delete(companyId)
  }
}

/** For tests: receive-packs to the company repository running now. */
export function companyPushesInFlight(companyId: string): number {
  return companyPushes.get(companyId)?.size ?? 0
}

async function waitForCompanyPushes(companyId: string, tokens: symbol[], timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs
  while (tokens.some(t => companyPushes.get(companyId)?.has(t))) {
    if (Date.now() > until) return false
    await new Promise(r => setTimeout(r, 50))
  }
  return true
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
        conn.prepare(`
          INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at, created_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(crypto.randomUUID(), scopeId, r.subjectType, r.subjectId, r.canRead ? 1 : 0, r.canWrite ? 1 : 0, ts, input.createdBy)
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
  const before = [...(companyPushes.get(companyId) ?? [])]
  if (!(await waitForCompanyPushes(companyId, before, COMPANY_PUSH_WAIT_MS))) {
    deletePrivateFolderRows(conn, scopeId, repoId)
    await removeScopeRepo(repo)
    throw new PrivateFolderBusyError()
  }
  if (await existsInCompanyRepo(companyId, path)) {
    deletePrivateFolderRows(conn, scopeId, repoId)
    await removeScopeRepo(repo)
    throw new PathUnavailableError()
  }
  return { scopeId, repoId }
}

function deletePrivateFolderRows(conn: Conn, scopeId: string, repoId: string): void {
  conn.transaction(() => {
    conn.prepare(`DELETE FROM scope_rules WHERE scope_id = ?`).run(scopeId)
    conn.prepare(`DELETE FROM scopes WHERE id = ?`).run(scopeId)
    conn.prepare(`DELETE FROM scope_repos WHERE id = ?`).run(repoId)
  })()
}

/** Replace the viewers/editors of a private folder (its own rule set). */
export function replacePrivateFolderRules(conn: Conn, scopeId: string, rules: PrivateRuleSet, by: string): void {
  const ts = new Date().toISOString()
  conn.transaction(() => {
    conn.prepare(`DELETE FROM scope_rules WHERE scope_id = ?`).run(scopeId)
    for (const r of privateRules(rules)) {
      conn.prepare(`
        INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(crypto.randomUUID(), scopeId, r.subjectType, r.subjectId, r.canRead ? 1 : 0, r.canWrite ? 1 : 0, ts, by)
    }
  })()
}

// ----------------------------------------------------------------------------
// Who can read / write (for the overview and the members list)
// ----------------------------------------------------------------------------

export interface FolderAccess {
  userId: string
  role: string
  read: boolean
  write: boolean
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

/** Private folders this member may read (owner/admin: all). */
export function readablePrivateFolders(conn: Conn, companyId: string, userId: string, role: string, scopes = listScopesWithRules(conn, companyId)): PrivateFolderRecord[] {
  return listPrivateFolders(conn, companyId, scopes).filter(p => canReadPrivateScope(p.scope, userId, role))
}

/** May the member push to this private folder's repository at all (write somewhere in it)? */
export function canWriteInPrivateFolder(scopes: ScopeWithRules[], folder: ScopeWithRules, companyId: string, userId: string, role: string): boolean {
  if (FULL_ACCESS_ROLES.has(role)) return true
  const repo: PermissionRepository = { getMemberRole: () => role, listScopes: () => scopes }
  return scopes
    .filter(s => isSameOrAncestorPath(folder.path, s.path))
    .some(s => resolveAccess(companyId, userId, s.path, repo).write)
}

// ----------------------------------------------------------------------------
// Pushes in flight to scope repositories (make-public waits for them)
// ----------------------------------------------------------------------------

const activePushes = new Map<string, number>()
const closing = new Set<string>()

/** git-http: a receive-pack to `scopeId` starts. Returns false while it is being made public. */
export function beginScopePush(scopeId: string): boolean {
  if (closing.has(scopeId)) return false
  activePushes.set(scopeId, (activePushes.get(scopeId) ?? 0) + 1)
  return true
}

export function endScopePush(scopeId: string): void {
  const n = (activePushes.get(scopeId) ?? 1) - 1
  if (n <= 0) activePushes.delete(scopeId)
  else activePushes.set(scopeId, n)
}

export function isScopeClosing(scopeId: string): boolean {
  return closing.has(scopeId)
}

async function waitForPushes(scopeId: string, timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs
  while ((activePushes.get(scopeId) ?? 0) > 0) {
    if (Date.now() > until) return false
    await new Promise(r => setTimeout(r, 100))
  }
  return true
}

// ----------------------------------------------------------------------------
// Make public
// ----------------------------------------------------------------------------

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
  closing.add(scopeId)
  try {
    if (!(await waitForPushes(scopeId, 30_000))) {
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
      for (const s of subtree) conn.prepare(`UPDATE scope_rules SET can_read = 1 WHERE scope_id = ?`).run(s.id)
      conn.prepare(`UPDATE scopes SET repo_id = NULL WHERE id = ?`).run(scopeId)
      conn.prepare(`DELETE FROM scope_repos WHERE id = ?`).run(folder.repoId)
    })()
    await removeScopeRepo(scopeRepo)
    return { path: folder.scope.path, commit }
  } finally {
    closing.delete(scopeId)
  }
}

// ----------------------------------------------------------------------------
// Archive and delete
// ----------------------------------------------------------------------------

export type PrivateFolderArchiveAction = 'delete' | 'make-public'

/**
 * Write the scope repository — every ref, whole history — as a git bundle
 * into the archive directory (privateFolderArchiveDir()/<companyId>/, 0700;
 * files 0600), with a JSON sidecar saying what it was, who removed it and
 * when, and record it in `private_folder_archives`. Restoring is an
 * operator's job (`git clone <bundle>`); nothing serves these files.
 * Throws when the archive cannot be written: the caller must then not
 * delete anything.
 */
export async function archivePrivateFolder(
  conn: Conn,
  companyId: string,
  folder: PrivateFolderRecord,
  action: PrivateFolderArchiveAction,
  by: string | null,
): Promise<{ id: string; file: string }> {
  const scopeRepo = privateRepoPath(companyId, folder.repoId)
  const base = privateFolderArchiveDir()
  const dir = join(base, companyId.replace(/[^a-zA-Z0-9_-]/g, ''))
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(base, 0o700)
  chmodSync(dir, 0o700)
  const at = new Date().toISOString()
  const id = crypto.randomUUID()
  const name = `${at.replace(/[:.]/g, '-')}_${action}_${folder.scope.id}`
  const file = join(dir, `${name}.bundle`)
  const head = (await gitAsync(['-C', scopeRepo, 'rev-parse', 'refs/heads/main'])).trim()
  await gitAsync(['-C', scopeRepo, 'bundle', 'create', '--quiet', file, '--all'])
  chmodSync(file, 0o600)
  writeFileSync(join(dir, `${name}.json`), JSON.stringify({
    id,
    action,
    companyId,
    scopeId: folder.scope.id,
    repoId: folder.repoId,
    path: folder.scope.path,
    head,
    rules: folder.scope.rules,
    createdAt: folder.createdAt,
    createdBy: folder.createdBy,
    archivedAt: at,
    archivedBy: by,
  }, null, 2) + '\n', { mode: 0o600 })
  conn.prepare(`
    INSERT INTO private_folder_archives (id, company_id, scope_id, path, action, file, head, created_at, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, companyId, folder.scope.id, folder.scope.path, action, `${name}.bundle`, head, at, by)
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
  closing.add(scopeId)
  try {
    if (!(await waitForPushes(scopeId, 30_000))) {
      throw new MakePublicError('BUSY', 'A push to this folder is still running; try again in a moment')
    }
    await archivePrivateFolder(conn, companyId, folder, 'delete', by)
    conn.transaction(() => {
      const subtree = (conn.prepare(`SELECT id, path FROM scopes WHERE company_id = ?`).all(companyId) as Array<{ id: string; path: string }>)
        .filter(s => isSameOrAncestorPath(folder.scope.path, s.path))
      for (const s of subtree) {
        conn.prepare(`DELETE FROM scope_rules WHERE scope_id = ?`).run(s.id)
        conn.prepare(`DELETE FROM scopes WHERE id = ?`).run(s.id)
      }
      conn.prepare(`DELETE FROM scope_repos WHERE id = ?`).run(folder.repoId)
    })()
    await removeScopeRepo(privateRepoPath(companyId, folder.repoId))
    return { path: folder.scope.path }
  } finally {
    closing.delete(scopeId)
  }
}

// ----------------------------------------------------------------------------
// Folders inside a private folder (the permission editor's browser)
// ----------------------------------------------------------------------------

/**
 * Sub-folder names (NFC, non-hidden, sorted) of `path`, which is the private
 * folder itself or a folder inside it, read from its scope repository; null
 * when it does not exist there. Callers authorise first.
 */
export async function listPrivateSubfolders(companyId: string, folder: PrivateFolderRecord, path: string): Promise<string[] | null> {
  const repo = privateRepoPath(companyId, folder.repoId)
  if (!existsSync(repo)) return null
  const rel = path === folder.scope.path ? '' : path.slice(folder.scope.path.length + 1)
  let stored = ''
  for (const seg of rel.split('/').filter(Boolean)) {
    const entries = await treeEntries(repo, stored)
    const hit = entries?.find(e => e.type === 'tree' && e.name.normalize('NFC') === seg.normalize('NFC'))
    if (!hit) return null
    stored = stored ? `${stored}/${hit.name}` : hit.name
  }
  const entries = await treeEntries(repo, stored)
  if (!entries) return null
  return entries.filter(e => e.type === 'tree' && !e.name.startsWith('.')).map(e => e.name.normalize('NFC')).sort((a, b) => a.localeCompare(b, 'ja'))
}

async function treeEntries(repo: string, dir: string): Promise<Array<{ type: string; name: string }> | null> {
  const target = dir === '' ? 'refs/heads/main^{tree}' : `refs/heads/main:${dir}`
  try {
    if ((await gitAsync(['-C', repo, 'cat-file', '-t', target])).trim() !== 'tree') return null
    return (await gitAsync(['-C', repo, 'ls-tree', '-z', target])).split('\0').filter(Boolean).map(r => {
      const tab = r.indexOf('\t')
      return { type: r.slice(0, tab).split(' ')[1], name: r.slice(tab + 1) }
    })
  } catch {
    return null
  }
}
