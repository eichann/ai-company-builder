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
 *
 * This module is the part without the database: paths, the company
 * repository lookups, the archive files, the pushes in flight (in memory) and
 * the folder browser. The rows and the create / make-public / delete steps
 * are adapters/private-folders.ts (behind PrivateFolderRepository).
 */
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { scopeRepoPath } from './git-server'
import { gitAsync } from './git-exec'
import { companyRepoPath, DATA_DIR, REPOS_DIR } from './config'
import { canWriteInPrivateFolder, type ScopeRule } from '../../shared/core/permissions'
import { pathKey } from '../../shared/core/paths'
import type { PrivateFolderRecord, PrivateRuleSet } from '../ports/private-folders'

/**
 * Where a private folder's repository is archived (git bundle) before it is
 * deleted or made public. Server-side only: never served by any route, the
 * directories are 0700 and the files 0600. PRIVATE_FOLDER_ARCHIVE_DIR
 * overrides the default <DATA_DIR>/backups/private-folders.
 */
export function privateFolderArchiveDir(): string {
  return process.env.PRIVATE_FOLDER_ARCHIVE_DIR || join(DATA_DIR, 'backups', 'private-folders')
}

export function privateRepoPath(companyId: string, repoId: string): string {
  return scopeRepoPath(REPOS_DIR, companyId, repoId)
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
// Rules of a private folder
// ----------------------------------------------------------------------------

export function privateRules(set: PrivateRuleSet): Array<Omit<ScopeRule, 'id'>> {
  const editors = new Set(set.editors)
  return [
    { subjectType: 'everyone', subjectId: null, canRead: false, canWrite: false },
    ...set.viewers.map(id => ({ subjectType: 'user' as const, subjectId: id, canRead: true, canWrite: editors.has(id) })),
  ]
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

/** The receive-packs to the company repository running now (to wait for exactly these). */
export function companyPushesRunning(companyId: string): symbol[] {
  return [...(companyPushes.get(companyId) ?? [])]
}

/** Wait until every push in `tokens` has ended; false after `timeoutMs` (default: creation's wait). */
export async function waitForCompanyPushes(companyId: string, tokens: symbol[], timeoutMs = COMPANY_PUSH_WAIT_MS): Promise<boolean> {
  const until = Date.now() + timeoutMs
  while (tokens.some(t => companyPushes.get(companyId)?.has(t))) {
    if (Date.now() > until) return false
    await new Promise(r => setTimeout(r, 50))
  }
  return true
}

/** May the member push to this private folder's repository at all? (shared/core, re-exported for git-http.) */
export { canWriteInPrivateFolder }

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

/** Make-public / delete: refuse new pushes to `scopeId` until reopenScope. */
export function closeScope(scopeId: string): void {
  closing.add(scopeId)
}

export function reopenScope(scopeId: string): void {
  closing.delete(scopeId)
}

/** Wait for the running pushes to `scopeId` to end; false after `timeoutMs`. */
export async function waitForScopePushes(scopeId: string, timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs
  while ((activePushes.get(scopeId) ?? 0) > 0) {
    if (Date.now() > until) return false
    await new Promise(r => setTimeout(r, 100))
  }
  return true
}

// ----------------------------------------------------------------------------
// Archives (before delete / make public)
// ----------------------------------------------------------------------------

export type PrivateFolderArchiveAction = 'delete' | 'make-public'

/** What was archived; the adapter records it in private_folder_archives. */
export interface PrivateFolderArchive {
  id: string
  /** Absolute path of the bundle. */
  file: string
  /** The bundle's file name (as recorded). */
  name: string
  head: string
  at: string
}

/**
 * Write the scope repository — every ref, whole history — as a git bundle
 * into the archive directory (privateFolderArchiveDir()/<companyId>/, 0700;
 * files 0600), with a JSON sidecar saying what it was, who removed it and
 * when (the caller records it in `private_folder_archives`). Restoring is an
 * operator's job (`git clone <bundle>`); nothing serves these files.
 * Throws when the archive cannot be written: the caller must then not
 * delete anything.
 */
export async function writePrivateFolderArchive(
  companyId: string,
  folder: PrivateFolderRecord,
  action: PrivateFolderArchiveAction,
  by: string | null,
): Promise<PrivateFolderArchive> {
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
  return { id, file, name: `${name}.bundle`, head, at }
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
