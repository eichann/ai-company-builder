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
  isOsFile,
  readPrivateScopesCache,
  writePrivateExcludes,
  writePrivateScopesCache,
  type MyPrivateScope,
  type PrivateScopesCache,
} from './private-folders'
import { readSparseConfig } from './sparse'
import { isNotDownloaded, pathKey } from '../../shared/sparse-paths'
import { recoverInterruptedState, recoveryNote } from './interrupted'
import { findOpenFiles, openFilesStoppedMessage, removeLockFiles } from './open-files'
import type { BackupReason } from '../../shared/backup-reasons'

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
            reason: 'made_public' satisfies BackupReason,
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

function moveAside(deps: SyncDeps, repoPath: string, folder: string, backupName: string, reason: BackupReason): string {
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

/** The private backups' folder kind for a left-out clone's ignored files: never pruned by age (they are the only copy). */
export const PRIVATE_EXCLUDED_BACKUP = '_private_excluded'

/** A backup folder name of that kind (`<ts>_private_excluded`, `<ts>_private_excluded-2`). */
export function isPrivateExcludedBackup(name: string): boolean {
  return /_private_excluded(?:-\d+)?$/.test(name)
}

const WHERE_KEPT = '（「バックアップ」の一覧で見られます。自動では消えません）'

/** What happened to a left-out private folder's ignored files and its clone (a sentence for the member, or none). */
export function excludedCloneMessage(removal: ExcludedCloneRemoval): string | undefined {
  const why = removal.failure === 'no-space'
    ? 'PC の空き容量が足りませんでした。空きを作ってから、もう一度同期してください。'
    : removal.failure ? '途中でうまくいかないことがありました。次の同期で、もう一度試します。' : '次の同期で、もう一度外してみます。'
  if (removal.saved && removal.removed) {
    return `ダウンロードしない設定にしたため、このフォルダをこの PC から外しました。同期しないファイル（${removal.saved.count}件）は非公開フォルダのバックアップに保存しました${WHERE_KEPT}。`
  }
  if (removal.saved) {
    return `ダウンロードしない設定にしましたが、このフォルダはまだこの PC に残しています。同期しないファイルのうち${removal.saved.count}件は、すでに非公開フォルダのバックアップに保存しました${WHERE_KEPT}。ほかのファイルはフォルダの中にそのままあります。${why}`
  }
  if (removal.failure) {
    return `ダウンロードしない設定にしましたが、このフォルダの中の同期しないファイル（大きなファイルや個人用のメモなど）を非公開フォルダのバックアップに移せなかったため、この PC から削除せずに残しました。何も削除していません。${why}`
  }
  return undefined
}

export interface ExcludedCloneRemoval {
  removed: boolean
  /**
   * What of the member's is in the private backups now (`files`: the
   * company-relative entries moved, folders included; `count`: the files in
   * the backup, counted one by one), whether or not the clone went.
   */
  saved?: { backupPath: string; files: string[]; count: number }
  /** The clone stays because saving failed: the disk is full, or anything else. */
  failure?: 'no-space' | 'failed'
}

function failureOf(error: unknown): 'no-space' | 'failed' {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'ENOSPC' || code === 'EDQUOT' ? 'no-space' : 'failed'
}

/** Files under `dir`, one by one (a link counts as one). */
function countFiles(dir: string): number {
  let st: fs.Stats
  try { st = fs.lstatSync(dir) } catch { return 0 }
  if (!st.isDirectory()) return 1
  try {
    return fs.readdirSync(dir).reduce((n, name) => n + countFiles(path.join(dir, name)), 0)
  } catch {
    return 1
  }
}

/** An entry at `p`, links included (never followed). */
function present(p: string): boolean {
  try { fs.lstatSync(p); return true } catch { return false }
}

/** Anything but folders under `dir` (links and unreadable entries count). */
function hasFiles(dir: string): boolean {
  let st: fs.Stats
  try { st = fs.lstatSync(dir) } catch { return false }
  if (!st.isDirectory()) return true
  try {
    return fs.readdirSync(dir).some(name => hasFiles(path.join(dir, name)))
  } catch {
    return true
  }
}

/** Ignored files and folders in a clone (outermost only; OS files left out), repository-relative. */
async function ignoredInClone(git: SimpleGit): Promise<string[]> {
  const raw = await git.raw(['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'])
  const listed = [...new Set(raw.split('\0').filter(Boolean).map(e => e.replace(/\/$/, '')))].sort()
  return listed
    .filter(e => !listed.some(o => o !== e && e.startsWith(`${o}/`)))
    .filter(e => !isOsFile(path.basename(e)))
}

/** A backup folder made by this call alone (one of the same millisecond gets a suffix): never reused. */
function newBackupFolder(parent: string, name: string): string {
  fs.mkdirSync(parent, { recursive: true })
  for (let n = 1; ; n++) {
    const candidate = path.join(parent, n === 1 ? name : `${name}-${n}`)
    try {
      fs.mkdirSync(candidate)
      return candidate
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || n >= 100) throw error
    }
  }
}

/**
 * Remove the clone of an excluded private folder once nothing in it is
 * unsynced. `git status` does not show ignored files (large files the app
 * ignores, .personal/ notes, .env files), so those move to the private
 * backups (`<ts>_private_excluded/`) first — as sparse.ts keeps them for a
 * department. If one cannot be moved, what moved goes back and the clone
 * stays (`reason`). Nothing in the clone is deleted without a copy.
 */
export async function removeExcludedClone(deps: SyncDeps, repoPath: string, dir: string, folder: string): Promise<ExcludedCloneRemoval> {
  const git = deps.createGit(dir)
  const unsynced = async () => {
    if ((await localChangesInClone(git, dir, { strict: true })).length > 0) return true
    const ahead = Number((await git.raw(['rev-list', '--count', 'origin/main..HEAD']).catch(() => '1')).trim()) || 0
    return ahead > 0
  }
  if (await unsynced()) return { removed: false }
  let ignored: string[]
  try {
    ignored = await ignoredInClone(git)
  } catch (error) {
    deps.log.warn('Git sync: Could not list the ignored files of a left-out private folder; it stays:', error)
    return { removed: false, failure: failureOf(error) }
  }
  let saved: ExcludedCloneRemoval['saved']
  if (ignored.length > 0) {
    const moved: string[] = []
    let backupPath = ''
    try {
      backupPath = newBackupFolder(privateBackupsDir(repoPath), `${stampNow(deps)}${PRIVATE_EXCLUDED_BACKUP}`)
      const files = ignored.map(e => `${folder}/${e}`)
      fs.writeFileSync(path.join(backupPath, '_metadata.json'), JSON.stringify({
        timestamp: deps.now().toISOString(),
        reason: 'private_folder_excluded' satisfies BackupReason,
        folders: [folder],
        files,
        note: 'not synced files of a private folder left out on this computer, saved before its copy here was removed',
      }, null, 2))
      for (const entry of ignored) {
        const dest = path.join(backupPath, folder, entry)
        if (present(dest)) throw new Error('already in the backup')
        // Listed before the move: a copy-and-remove that fails half-way has touched both sides.
        moved.push(entry)
        moveInto(path.join(dir, entry), dest)
      }
      saved = { backupPath, files, count: countFiles(path.join(backupPath, folder)) }
    } catch (error) {
      deps.log.warn('Git sync: Could not save the ignored files of a left-out private folder; it stays:', error)
      // What moved goes back where its place is free; the rest stays in the backup (its metadata lists it).
      for (const entry of moved.reverse()) {
        const kept = path.join(backupPath, folder, entry)
        try {
          if (present(kept) && !present(path.join(dir, entry))) moveInto(kept, path.join(dir, entry))
        } catch { /* stays in the backup */ }
      }
      // The backup goes only when nothing of the member's is left in it; else the member is told it is there.
      const failure = failureOf(error)
      if (!backupPath) return { removed: false, failure }
      if (!hasFiles(path.join(backupPath, folder))) {
        fs.rmSync(backupPath, { recursive: true, force: true })
        return { removed: false, failure }
      }
      return { removed: false, failure, saved: { backupPath, files: ignored.map(e => `${folder}/${e}`), count: countFiles(path.join(backupPath, folder)) } }
    }
  }
  // Checked again right before the removal: something written meanwhile (the AI, another app),
  // or a check that cannot be made, keeps the clone; the next sync tries again.
  try {
    if (await unsynced() || (await ignoredInClone(git)).length > 0) return { removed: false, saved }
  } catch (error) {
    deps.log.warn('Git sync: Could not check a left-out private folder again; it stays:', error)
    return { removed: false, saved, failure: failureOf(error) }
  }
  fs.rmSync(dir, { recursive: true, force: true })
  pruneEmptyUp(path.dirname(dir), repoPath)
  return { removed: true, saved }
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
    confirmOpenFiles: files => dialog.confirmOpenFiles(p(files)),
  }
}

export interface ReadOnlySyncResult {
  success: boolean
  openFiles?: string[]
  message?: string
  error?: string
  errorType?: string
  writeDeniedFiles?: string[]
  restoredWriteDeniedFiles?: string[]
  writeDeniedBackupPath?: string
  recoveredFiles?: string[]
  recoveryBackupPath?: string
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
  // Told on every way out: the clean-up has happened whatever comes after it.
  let recovered: Pick<ReadOnlySyncResult, 'recoveredFiles' | 'recoveryBackupPath'> = {}
  let note = ''
  const withNote = (error: string) => (note ? `${error}\n\n${note}` : error)
  try {
    const recovery = await recoverInterruptedState({
      git, repoPath: dir,
      backupPath: path.join(privateBackupsDir(repoPath), `${stampNow(deps)}_before_recovery`),
      backupPrefix: scope.path,
      otherGitRunning: deps.otherGitRunning?.() ?? false,
      now: deps.now(),
      log: deps.log,
    })
    if (recovery.kept) recovered = { recoveredFiles: recovery.kept.files, recoveryBackupPath: recovery.kept.backupPath }
    if (!recovery.ok) return { success: false, errorType: recovery.errorType, error: recovery.error, ...recovered }
    if (recovery.kept) note = recoveryNote(recovery.kept)
    try {
      await git.fetch(['--progress', 'origin'])
    } catch (fetchError) {
      const msg = fetchError instanceof Error ? fetchError.message : String(fetchError)
      return { success: false, errorType: 'network', error: withNote(`サーバーに接続できませんでした。\n${msg}`), ...recovered }
    }
    // A file a teammate changed that another app has open waits, as in the
    // other repositories (./open-files.ts): the reset below would replace it.
    const head = (await git.raw(['rev-parse', '--verify', '--quiet', 'HEAD']).catch(() => '')).trim()
    const incoming = head
      ? (await git.raw(['diff', '--name-only', '-z', '--no-renames', head, 'origin/main']).catch(() => '')).split('\0').filter(Boolean)
      : []
    const found = incoming.length > 0 ? await findOpenFiles(git, dir, incoming, deps.officeLockProbe) : []
    const open = found.map(o => o.file)
    if (open.length > 0) {
      // The dialog is the folder's own (prefixedDialog): it adds the folder's path itself.
      if (!deps.dialog.canAsk() || await deps.dialog.confirmOpenFiles(open) !== 'continue') {
        const openShown = open.map(f => `${scope.path}/${f}`)
        return { success: false, errorType: 'file_open', openFiles: openShown, error: withNote(openFilesStoppedMessage(openShown)), ...recovered }
      }
      removeLockFiles(dir, found, deps.log)
    }
    const changes = await localChangesInClone(git, dir)
    const shown = changes.map(f => `${scope.path}/${f}`)
    let backupPath: string | undefined
    if (changes.length > 0) {
      const rejected = {
        success: false,
        errorType: 'write_denied',
        writeDeniedFiles: shown,
        error: withNote(`編集できないファイルがあります。\n次のファイルは、閲覧だけが許可された非公開フォルダにあるため、変更を共有できません。\n\n${shown.map(f => `・${f}`).join('\n')}`),
        ...recovered,
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
        reason: 'write_denied' satisfies BackupReason,
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
    if (changes.length === 0) return { success: true, message: note || '同期が完了しました', ...recovered }
    return {
      success: true,
      message: `閲覧だけが許可された非公開フォルダのファイル（${changes.length}件）は元に戻しました。あなたが編集した版は非公開フォルダのバックアップに保存してあります。${note}`,
      restoredWriteDeniedFiles: shown,
      writeDeniedBackupPath: backupPath,
      ...recovered,
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return { success: false, errorType: 'unknown', error: withNote(msg), ...recovered }
  }
}

/** True when `p` lies at or under one of `folders` (NFC + A–Z folded). */
export function isUnderAny(folders: readonly string[], p: string): boolean {
  const k = pathKey(p)
  return folders.some(f => k === pathKey(f) || k.startsWith(`${pathKey(f)}/`))
}
