// The private-folder steps of git:sync around the company repository's own
// sync (git-sync.ts drives them in this order; see
// .claude/rules/private-folders-client.md):
//
//   preparePrivateFolders  (before the company sync)
//     /me/scopes → compare with the cached answer:
//       access lost  (no longer listed, still reserved) → delete the clone
//                    without a backup (owner decision Q1) + notice
//       made public  (no longer listed, not reserved, and the company
//                    repository has the folder) → back up unsynced edits,
//                    drop the inner .git and the scope's files, so the
//                    company sync checks the public version out
//     write .git/info/exclude (every readable private path), save the cache
//   [company sync]
//   placePrivateFolders + per-scope sync (after it)
//     not excluded: clone when missing (an existing folder at the path is
//                   moved to .backups first, never overwritten), then sync it
//     excluded:     sync a clone one last time (its edits are pushed), then
//                   remove it; a stray folder there goes to .backups
//
// Nothing here imports Electron; the host's git, dialog and server API come
// in through SyncDeps.

import fs from 'fs'
import path from 'path'
import type { SimpleGit } from 'simple-git'
import type { SyncDeps, SyncDialog } from './types'
import type { PathChecker } from './path-check'
import {
  cloneStateOf,
  cloneUrlAllowed,
  privateBackupsDir,
  safeScopeDir,
  localChangesInClone,
  moveInto,
  pruneEmptyUp,
  readPrivateScopesCache,
  writePrivateExcludes,
  writePrivateScopesCache,
  type MyPrivateScope,
  type PrivateScopesCache,
} from './private-folders'
import { readSparseConfig } from './sparse'
import { isNotDownloaded, pathKey } from '../../shared/sparse-paths'

export interface PrivatePrep {
  /** The answer in effect for this sync (fresh, or the cached one when the server could not be asked). */
  cache: PrivateScopesCache | null
  /** True when /me/scopes answered during this sync. */
  fresh: boolean
  /** Folders deleted because the member lost access. */
  lost: string[]
  /** Folders handed to the company repository (made public). */
  madePublic: string[]
  /** Unsynced edits of made-public folders, saved here. */
  madePublicBackup: { path: string; files: string[] } | null
}

function stampNow(deps: Pick<SyncDeps, 'now'>): string {
  return deps.now().toISOString().replace(/[:.]/g, '-').slice(0, 23)
}

/** Remove the copies of `<folder>` kept in the private backups (and any older ones in .backups/): a folder the member may no longer read. */
function removeBackupCopies(repoPath: string, folder: string): void {
  for (const root of [privateBackupsDir(repoPath), path.join(repoPath, '.backups')]) {
    let entries: string[] = []
    try { entries = fs.readdirSync(root) } catch { continue }
    for (const e of entries) {
      const target = path.join(root, e, ...folder.split('/'))
      // lstat: never follow a link out of the backup folder.
      try { fs.lstatSync(target) } catch { continue }
      fs.rmSync(target, { recursive: true, force: true })
    }
  }
}

async function treeExists(git: SimpleGit, rev: string, folder: string): Promise<boolean> {
  const out = (await git.raw(['cat-file', '-t', `${rev}:${folder}`]).catch(() => '')).trim()
  return out === 'tree'
}

/**
 * Hand a clone of a folder that was made public over to the company
 * repository: save the member's unsynced edits (they could not be pushed
 * anywhere — the scope repository is gone), then remove the inner .git and
 * every file the scope tracked or the member added (ignored local files such
 * as .personal/ stay), so the company sync checks out the server's version.
 */
async function releaseMadePublic(deps: SyncDeps, dir: string, scope: MyPrivateScope, backupPath: string): Promise<string[]> {
  const git = deps.createGit(dir)
  const changed = await localChangesInClone(git, dir)
  const saved: string[] = []
  for (const file of changed) {
    const dest = path.join(backupPath, scope.path, file)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.cpSync(path.join(dir, file), dest, { verbatimSymlinks: true })
    saved.push(`${scope.path}/${file}`)
  }
  const tracked = (await git.raw(['ls-files', '-z']).catch(() => '')).split('\0').filter(Boolean)
  fs.rmSync(path.join(dir, '.git'), { recursive: true, force: true })
  for (const file of [...tracked, ...changed]) {
    const full = path.join(dir, file)
    fs.rmSync(full, { force: true })
    pruneEmptyUp(path.dirname(full), dir)
  }
  return saved
}

/**
 * Ask the server which private folders the member may read, react to what
 * changed since the last answer, and keep the company repository blind to
 * every readable private path. Never throws: without an answer the cached
 * one is used and nothing is deleted or handed over.
 */
export async function preparePrivateFolders(deps: SyncDeps, repoPath: string, companyId: string, checker: PathChecker): Promise<PrivatePrep> {
  const log = deps.log
  const previousRaw = readPrivateScopesCache(repoPath)
  const previous = previousRaw && previousRaw.companyId === companyId ? previousRaw : null
  const prep: PrivatePrep = { cache: previous, fresh: false, lost: [], madePublic: [], madePublicBackup: null }

  let answer = null as { version: string; scopes: MyPrivateScope[] } | null
  if (companyId) {
    try {
      const response = await deps.api.getMyScopes(companyId)
      // "Not a member of this company" is an answer only while the session
      // itself is known to be good — a transient auth problem must never
      // delete anything. Then every private folder is gone for this member
      // (Q1), and the last known reserved names keep holding.
      if (response === 'not-member') {
        const me = await deps.api.getCurrentUser().catch(() => null)
        answer = me && previous ? { version: 'not-member', scopes: [] } : null
        if (answer) log.warn('Git sync: The server says this account is no longer a member of the company')
      } else {
        answer = response
      }
    } catch (error) {
      if (previous) log.warn('Git sync: Could not ask the server for private folders; using the last answer:', error)
    }
  }

  if (answer) {
    prep.fresh = true
    const listed = new Set(answer.scopes.map(s => s.scopeId))
    const gone = [...(previous?.scopes ?? []), ...(previous?.pendingPublic ?? [])].filter(s => !listed.has(s.scopeId))
    const pendingPublic: MyPrivateScope[] = []
    let companyFetched = false
    let companyFetchOk = false
    const companyGit = deps.createGit(repoPath)
    const stamp = stampNow(deps)
    for (const scope of gone) {
      // Never follow a symlinked ancestor out of the company folder.
      const dir = safeScopeDir(repoPath, scope.path)
      // Gone from the list: made public (the company repository has it now —
      // the server writes it there before it stops listing the scope), or
      // the member lost access (the name is still not usable for them).
      // Anything undecided waits for a later sync: nothing is deleted on a
      // guess.
      let lost = answer.version === 'not-member'
      if (!lost) {
        if (!companyFetched) {
          companyFetchOk = await companyGit.fetch(['--progress', 'origin']).then(() => true, (e: unknown) => {
            log.warn('Git sync: Fetch failed (may be offline):', e)
            return false
          })
          companyFetched = true
        }
        if (!companyFetchOk) { pendingPublic.push(scope); continue }
        if (!(await treeExists(companyGit, 'origin/main', scope.path))) {
          const usable = (await checker.usable(companyId, [scope.path])).get(scope.path)
          if (usable !== false) {
            pendingPublic.push(scope)
            log.log(`Git sync: Private folder "${scope.path}" is no longer listed; waiting until its state is known`)
            continue
          }
          lost = true
        }
      }
      if (lost) {
        // Access lost (Q1): delete without a backup — the member may no
        // longer read this folder, and nothing could be pushed from here.
        const state = dir ? await cloneStateOf(deps.createGit, dir, scope) : 'absent'
        if (dir && state === 'clone') {
          fs.rmSync(dir, { recursive: true, force: true })
          pruneEmptyUp(path.dirname(dir), repoPath)
          prep.lost.push(scope.path)
          log.log(`Git sync: Removed private folder "${scope.path}" (no longer readable)`)
        }
        removeBackupCopies(repoPath, scope.path)
        continue
      }
      // Made public: hand the clone over to the company repository.
      const state = dir ? await cloneStateOf(deps.createGit, dir, scope) : 'absent'
      if (dir && state === 'clone') {
        const backupPath = path.join(privateBackupsDir(repoPath), `${stamp}_made_public`)
        const saved = await releaseMadePublic(deps, dir, scope, backupPath)
        if (saved.length > 0) {
          const files = [...(prep.madePublicBackup?.files ?? []), ...saved]
          prep.madePublicBackup = { path: backupPath, files }
          fs.writeFileSync(path.join(backupPath, '_metadata.json'), JSON.stringify({
            timestamp: deps.now().toISOString(),
            reason: 'made_public',
            folders: [...prep.madePublic, scope.path],
            files,
            note: 'edits not synced before the private folder was made public; the folder now syncs with the company folder',
          }, null, 2))
        }
        log.log(`Git sync: Private folder "${scope.path}" was made public; it now syncs with the company repository`)
      }
      prep.madePublic.push(scope.path)
    }
    prep.cache = {
      companyId,
      version: answer.version,
      fetchedAt: deps.now().toISOString(),
      scopes: answer.scopes,
      pendingPublic,
    }
    try {
      writePrivateScopesCache(repoPath, prep.cache)
    } catch (error) {
      log.warn('Git sync: Could not save the private folder list:', error)
    }
  }

  // The company repository never tracks private content (plan §1.3 D2):
  // local, unshared excludes for every readable private path — never the
  // shared .gitignore, which an agent or a merge can change, and which would
  // show the names to everyone.
  if (prep.cache) {
    const paths = [...prep.cache.scopes, ...(prep.cache.pendingPublic ?? [])].map(s => s.path)
    try {
      if (writePrivateExcludes(repoPath, paths)) log.log(`Git sync: Private folders excluded from the company repository: ${paths.length}`)
    } catch (error) {
      log.warn('Git sync: Could not write .git/info/exclude:', error)
    }
  }
  return prep
}

/** What happened to one readable private folder's place on disk. */
export type Placement =
  | { kind: 'sync'; scope: MyPrivateScope; dir: string; cloned: boolean; movedAside?: string }
  | { kind: 'excluded'; scope: MyPrivateScope; dir: string; clone: boolean; movedAside?: string }
  | { kind: 'failed'; scope: MyPrivateScope; error: string }

/**
 * Make each readable private folder's place match the member's choice:
 * cloned (downloaded) or absent (excluded in settings). A folder already at
 * the path that is not this scope's clone is moved to .backups first.
 */
export async function placePrivateFolders(deps: SyncDeps, repoPath: string, scopes: readonly MyPrivateScope[]): Promise<Placement[]> {
  const out: Placement[] = []
  const excluded = readSparseConfig(repoPath).excluded
  const stamp = stampNow(deps)
  const companyOrigin = (await deps.createGit(repoPath).raw(['config', '--get', 'remote.origin.url']).catch(() => '')).trim()
  for (const scope of scopes) {
    // Every existing segment must be a real directory inside the company
    // folder: a teammate can replace an ancestor with a symlink, and
    // following it would put private content (or a deletion) outside.
    const dir = safeScopeDir(repoPath, scope.path)
    if (!dir) {
      deps.log.warn(`Git sync: Not placing private folder "${scope.path}": a folder on its path is a link or a file`)
      out.push({ kind: 'failed', scope, error: `『${scope.path}』の途中のフォルダがリンクかファイルに置き換わっているため、このフォルダを置けません。管理者に連絡してください。` })
      continue
    }
    try {
      const state = await cloneStateOf(deps.createGit, dir, scope)
      if (isNotDownloaded(excluded, scope.path)) {
        let movedAside: string | undefined
        if (state === 'other') {
          movedAside = moveAside(deps, repoPath, scope.path, `${stamp}_outside_checkout`, 'outside_checkout')
        } else if (state === 'empty') {
          fs.rmSync(dir, { recursive: true, force: true })
        }
        out.push({ kind: 'excluded', scope, dir, clone: state === 'clone', movedAside })
        continue
      }
      let movedAside: string | undefined
      if (state === 'other') movedAside = moveAside(deps, repoPath, scope.path, `${stamp}_private_folder_existing`, 'private_folder_existing')
      let cloned = false
      if (state !== 'clone') {
        if (!cloneUrlAllowed(scope, companyOrigin)) {
          throw new Error(`unexpected clone URL for "${scope.path}"`)
        }
        if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true }) // empty (OS files only)
        fs.mkdirSync(path.dirname(dir), { recursive: true })
        deps.log.log(`Git sync: Downloading private folder "${scope.path}"...`)
        await deps.createGit(repoPath).raw(['clone', '--progress', '--', scope.cloneUrl, dir])
        cloned = true
      }
      out.push({ kind: 'sync', scope, dir, cloned, movedAside })
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      deps.log.warn(`Git sync: Could not place private folder "${scope.path}":`, msg)
      // A failed clone must not leave a half-made folder that the next sync
      // would treat as the member's own files.
      try {
        if (fs.existsSync(path.join(dir, '.git')) && (await cloneStateOf(deps.createGit, dir, scope)) !== 'clone') {
          fs.rmSync(dir, { recursive: true, force: true })
        }
      } catch { /* best effort */ }
      out.push({ kind: 'failed', scope, error: msg })
    }
  }
  return out
}

function moveAside(deps: SyncDeps, repoPath: string, folder: string, backupName: string, reason: string): string {
  // Kept inside .git: whatever sits at a private folder's path is handled
  // like private content (never in the working tree, never staged).
  const backupPath = path.join(privateBackupsDir(repoPath), backupName)
  const files: string[] = []
  const walk = (dir: string, rel: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory() && e.name !== '.git') walk(path.join(dir, e.name), r)
      else files.push(r)
    }
  }
  walk(path.join(repoPath, folder), folder)
  let metadata: { files?: string[]; folders?: string[] } = {}
  try { metadata = JSON.parse(fs.readFileSync(path.join(backupPath, '_metadata.json'), 'utf-8')) } catch { /* new */ }
  fs.mkdirSync(backupPath, { recursive: true })
  fs.writeFileSync(path.join(backupPath, '_metadata.json'), JSON.stringify({
    timestamp: deps.now().toISOString(),
    reason,
    folders: [...(metadata.folders ?? []), folder],
    files: [...(metadata.files ?? []), ...files],
    note: reason === 'outside_checkout'
      ? 'found at the place of a private folder that is not downloaded on this computer; not shared'
      : 'found at the place of a private folder before it was downloaded; not shared',
  }, null, 2))
  moveInto(path.join(repoPath, folder), path.join(backupPath, folder))
  deps.log.log(`Git sync: Moved "${folder}" to ${backupPath} before placing the private folder`)
  return backupPath
}

/** Remove the clone of an excluded private folder once nothing in it is unsynced. Returns true when removed. */
export async function removeExcludedClone(deps: SyncDeps, repoPath: string, dir: string): Promise<boolean> {
  const git = deps.createGit(dir)
  const changes = await localChangesInClone(git, dir)
  if (changes.length > 0) return false
  const ahead = Number((await git.raw(['rev-list', '--count', 'origin/main..HEAD']).catch(() => '1')).trim()) || 0
  if (ahead > 0) return false
  fs.rmSync(dir, { recursive: true, force: true })
  pruneEmptyUp(path.dirname(dir), repoPath)
  return true
}

/** A dialog whose file lists name company-relative paths (the scope's prefix added). */
export function prefixedDialog(dialog: SyncDialog, prefix: string): SyncDialog {
  const p = (files: string[]) => files.map(f => `${prefix}/${f}`)
  return {
    canAsk: () => dialog.canAsk(),
    confirmSharedNestedRepo: repo => dialog.confirmSharedNestedRepo(`${prefix}/${repo}`),
    confirmExternalNestedRepo: repo => dialog.confirmExternalNestedRepo(`${prefix}/${repo}`),
    confirmDeletedFiles: files => dialog.confirmDeletedFiles(p(files)),
    confirmProtectedConfigRestore: files => dialog.confirmProtectedConfigRestore(p(files)),
    confirmWriteDeniedRestore: files => dialog.confirmWriteDeniedRestore(p(files)),
  }
}

export interface ReadOnlySyncResult {
  success: boolean
  message?: string
  error?: string
  errorType?: string
  writeDeniedFiles?: string[]
  restoredWriteDeniedFiles?: string[]
  writeDeniedBackupPath?: string
}

/**
 * Sync of a private folder the member may read but not edit (canWrite
 * false). The server refuses such a push outright (403), so nothing is ever
 * committed here: local edits are offered back like a WRITE_DENIED rejection
 * (same dialog; the member's version goes to .backups/<ts>_write_denied/),
 * then the clone is moved to the server's version.
 */
export async function syncReadOnlyScope(deps: SyncDeps, repoPath: string, scope: MyPrivateScope, dir: string): Promise<ReadOnlySyncResult> {
  const git = deps.createGit(dir)
  const gitDir = path.join(dir, '.git')
  try {
    if (fs.existsSync(path.join(gitDir, 'rebase-merge')) || fs.existsSync(path.join(gitDir, 'rebase-apply'))) {
      await git.rebase(['--abort']).catch(() => {})
    }
    try {
      await git.fetch(['--progress', 'origin'])
    } catch (fetchError) {
      const msg = fetchError instanceof Error ? fetchError.message : String(fetchError)
      return { success: false, errorType: 'network', error: `サーバーに接続できませんでした。\n${msg}` }
    }
    const changes = await localChangesInClone(git, dir)
    const shown = changes.map(f => `${scope.path}/${f}`)
    let backupPath: string | undefined
    if (changes.length > 0) {
      const rejected = {
        success: false,
        errorType: 'write_denied',
        writeDeniedFiles: shown,
        error: `編集できないファイルがあります。\n次のファイルは、閲覧だけが許可された非公開フォルダにあるため、変更を共有できません。\n\n${shown.map(f => `・${f}`).join('\n')}`,
      }
      if (!deps.dialog.canAsk()) return rejected
      const choice = await deps.dialog.confirmWriteDeniedRestore(shown)
      if (choice === 'cancel') return { ...rejected, error: `同期を中止しました。\n\n${rejected.error}` }
      backupPath = path.join(privateBackupsDir(repoPath), `${stampNow(deps)}_write_denied`)
      for (const file of changes) {
        const dest = path.join(backupPath, scope.path, file)
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        fs.cpSync(path.join(dir, file), dest, { verbatimSymlinks: true })
      }
      fs.writeFileSync(path.join(backupPath, '_metadata.json'), JSON.stringify({
        timestamp: deps.now().toISOString(),
        reason: 'write_denied',
        writeDeniedFiles: shown,
        backedUpFiles: shown,
        note: 'edits in a private folder this member may only read; put back to the server version',
      }, null, 2))
    }
    const serverFiles = new Set((await git.raw(['ls-tree', '-r', '-z', '--name-only', 'origin/main'])).split('\0').filter(Boolean))
    await git.raw(['reset', '--hard', '--quiet', 'origin/main'])
    for (const file of changes) {
      if (serverFiles.has(file)) continue
      const full = path.join(dir, file)
      fs.rmSync(full, { force: true })
      pruneEmptyUp(path.dirname(full), dir)
    }
    if (fs.existsSync(path.join(gitDir, 'PENDING_PUSH'))) fs.rmSync(path.join(gitDir, 'PENDING_PUSH'), { force: true })
    if (changes.length === 0) return { success: true, message: '同期が完了しました' }
    return {
      success: true,
      message: `閲覧だけが許可された非公開フォルダのファイル（${changes.length}件）は元に戻しました。あなたが編集した版は非公開フォルダのバックアップに保存してあります。`,
      restoredWriteDeniedFiles: shown,
      writeDeniedBackupPath: backupPath,
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return { success: false, errorType: 'unknown', error: msg }
  }
}

/** True when `p` lies at or under one of `folders` (NFC + A–Z folded). */
export function isUnderAny(folders: readonly string[], p: string): boolean {
  const k = pathKey(p)
  return folders.some(f => k === pathKey(f) || k.startsWith(`${pathKey(f)}/`))
}
