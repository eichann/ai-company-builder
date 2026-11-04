// What a sync finds when the last run never finished: a rebase, merge or
// cherry-pick that stopped half-way, or lock files nobody holds any more
// (.claude/rules/sync.md step 1, sync-guards.md "Repository state").
//
// A run stops half-way when the app quits or crashes, or git is killed. The
// member (or the AI) can then see conflict markers, edit those files, even
// commit, and the clean-up would throw that work away. So whatever it can touch
// is kept first, in a new folder per try: an abort or reset that fails can leave
// files half rewritten, and a copy of those must never replace an earlier copy.
// A copy that fails stops the sync with the repository as it is; once the copy
// exists the clean-up gets through (git's own abort, else a hard reset): members
// cannot repair this. Nothing here runs while something may still be working in
// the folder.

import fs from 'fs'
import path from 'path'
import type { SimpleGit } from 'simple-git'
import { pathKey } from '../../shared/sparse-paths'
import { gitRunningIn } from './live-git'
import type { SyncLogger } from './types'

/**
 * A lock older than this with no git on the repository is a crash's leftover.
 * Longer than the git watchdog (5 min of silence, git-factory.ts): an app git
 * that holds a lock this long is printing progress, and those (sparse-checkout,
 * private-folder setup) are `otherGitRunning`.
 */
export const INDEX_LOCK_STALE_MS = 6 * 60 * 1000

/** What a crash can leave behind and a later abort, commit or fetch stops on. */
const LEFTOVER_LOCKS = ['index.lock', 'HEAD.lock', 'ORIG_HEAD.lock', 'refs/heads/main.lock', 'refs/remotes/origin/main.lock']

/** Shown when a lock is there and may still be in use. Automatic runs simply try again. */
export const REPOSITORY_BUSY_MESSAGE = '別の処理がこのフォルダを使っているため、同期できませんでした。変更はこのPCに残っています。数分待ってから、もう一度同期してください。しばらくたっても同じときは、パソコンを再起動してから同期してください。それでも直らないときは、管理者に連絡してください。'

/** Git could not update its own records, for a reason waiting does not fix by itself. */
export const REPOSITORY_RECORD_MESSAGE = '同期の記録を更新できなかったため、同期できませんでした。変更はこのPCに残っています。もう一度同期しても直らないときは、管理者に連絡してください。'

/** Even the hard reset failed; the state is still there, and some files may already be back. */
export const RECOVERY_FAILED_MESSAGE = '前回の同期が途中で止まったままになっていて、元に戻しきれませんでした。止まっていた間のファイルは .backups に保存してあります。もう一度同期しても直らないときは、管理者に連絡してください。'

/** The state could not even be read, so nothing could be kept: nothing was touched. */
export const RECOVERY_UNREADABLE_MESSAGE = '前回の同期が途中で止まっていましたが、変わっていたファイルを調べられなかったため、同期を中止しました。ファイルはどれも今のまま残っています。もう一度同期しても直らないときは、管理者に連絡してください。'

/** Going back would replace a folder with its own `.git` by a file: nothing was touched. */
export function nestedRepoInTheWayMessage(folder: string): string {
  return `前回の同期が途中で止まっていましたが、『${folder}』の場所に別の場所から取り込んだフォルダがあるため、同期を中止しました。ファイルはどれも今のまま残っています。このフォルダを会社のフォルダの外へ移してから、もう一度同期してください。`
}

/** The sentence for a git failure about a lock, or null when it is about something else (a file named yarn.lock). */
export function lockFailureMessage(gitError: string): string | null {
  if (/unable to create .*\.lock/i.test(gitError)) return REPOSITORY_BUSY_MESSAGE
  return /(?<![.\w-])lock\b/i.test(gitError) ? REPOSITORY_RECORD_MESSAGE : null
}

const DISK_FULL = new Set(['ENOSPC', 'EDQUOT'])

/** The disk is named only when it is the disk: a locked or unreadable file needs something else from the member. */
export function isDiskFull(error: unknown): boolean {
  return DISK_FULL.has((error as NodeJS.ErrnoException | null)?.code ?? '')
}

/** The copy before the clean-up failed: nothing was aborted. */
export function recoveryBackupFailedMessage(file: string, error: unknown): string {
  const start = '前回の同期が途中で止まっていましたが、'
  const end = 'ファイルはどれも今のまま残っています。'
  if (isDiskFull(error)) return `${start}ディスクの空きが足りず、変わっていたファイルをバックアップに保存できなかったため、同期を中止しました。${end}空きを増やしてから、もう一度同期してください。`
  return `${start}『${file}』をバックアップに保存できなかったため、同期を中止しました。${end}このファイルをほかのアプリで開いていたら閉じて、もう一度同期してください。`
}

export type LockState = 'free' | 'removed' | 'busy'

/** The file system's own "now": a lock and this come from one clock, whatever the computer's says after sleep or on a network drive. */
function folderClockMs(gitDir: string): number | null {
  const probe = path.join(gitDir, 'acb-lock-clock')
  try {
    fs.writeFileSync(probe, '')
    const at = fs.statSync(probe).mtimeMs
    fs.rmSync(probe, { force: true })
    return at
  } catch {
    return null
  }
}

/**
 * Remove leftover lock files. Call it holding the repository's sync lock, which
 * is what proves no sync or receive of this repository is running;
 * `otherGitRunning` covers the app's long git outside that lock and the AI's.
 * 'busy': some lock may be in use, or could not be removed. A lock that may be
 * live always stays.
 */
export async function clearStaleLocks(repoPath: string, options: { otherGitRunning: boolean; log: SyncLogger }): Promise<LockState> {
  const gitDir = path.join(repoPath, '.git')
  const found: Array<{ file: string; mtimeMs: number }> = []
  for (const name of LEFTOVER_LOCKS) {
    const file = path.join(gitDir, name)
    try { found.push({ file, mtimeMs: fs.lstatSync(file).mtimeMs }) } catch { /* not there */ }
  }
  if (found.length === 0) return 'free'
  if (options.otherGitRunning) return 'busy'
  const now = folderClockMs(gitDir)
  if (now === null || found.some(lock => now - lock.mtimeMs < INDEX_LOCK_STALE_MS)) return 'busy'
  if (await gitRunningIn(repoPath) !== 'no') return 'busy'
  try {
    for (const { file } of found) fs.rmSync(file)
  } catch (error) {
    options.log.warn('Git sync: Could not remove a leftover lock:', error)
    return 'busy'
  }
  options.log.warn(`Git sync: Removed ${found.length} leftover lock(s)`)
  return 'removed'
}

/** What the member's disk held before an interrupted operation was cleaned up. */
export interface KeptBeforeRecovery {
  /** Company-relative paths. */
  files: string[]
  /** The first try's folder: what the member really had. */
  backupPath: string
  /** Folders in all, when several tries each made one. */
  folders?: number
}

export function recoveryNote(kept: KeptBeforeRecovery): string {
  const shown = kept.files.slice(0, 3).map(f => `『${f}』`).join('、')
  const more = kept.files.length > 3 ? `ほか${kept.files.length - 3}件` : ''
  const several = (kept.folders ?? 1) > 1 ? `やり直すのに${kept.folders}回かかったため、保存先も${kept.folders}か所あります。「履歴を見る」で確かめてください。` : ''
  return `前回の同期が途中で止まっていたため、やり直しました。止まっていた間のファイル（${shown}${more}）は、やり直す前の内容を .backups に保存しました。${several}`
}

/** Copies an earlier try made, until the member has been told: for telling only, nothing is ever copied by it. */
const PENDING_RECORD = 'acb-recovery-pending.json'

function readPending(gitDir: string): KeptBeforeRecovery[] {
  try {
    const list = JSON.parse(fs.readFileSync(path.join(gitDir, PENDING_RECORD), 'utf-8')) as KeptBeforeRecovery[]
    return list.filter(kept => Array.isArray(kept.files) && fs.existsSync(kept.backupPath))
  } catch {
    return []
  }
}

/** One report for several tries: the first folder holds what the member really had. */
function together(list: KeptBeforeRecovery[]): KeptBeforeRecovery | null {
  if (list.length === 0) return null
  return { files: [...new Set(list.flatMap(kept => kept.files))], backupPath: list[0].backupPath, folders: list.length }
}

/** The branch an interrupted rebase came from; everywhere else HEAD is already on it. */
function branchOf(gitDir: string): string {
  for (const state of ['rebase-merge', 'rebase-apply']) {
    try {
      const name = fs.readFileSync(path.join(gitDir, state, 'head-name'), 'utf-8').trim()
      if (name.startsWith('refs/heads/')) return name
    } catch { /* unreadable: sync only ever works on main */ }
  }
  return 'refs/heads/main'
}

class CopyFailed extends Error {
  constructor(readonly file: string, readonly reason: unknown) { super(file) }
}

class NestedRepoInTheWay extends Error {
  constructor(readonly folder: string) { super(folder) }
}

/** `a/b/c` → `a`, `a/b`, `a/b/c`. */
function pathsTo(file: string): string[] {
  const segments = file.split('/')
  return segments.map((_, i) => segments.slice(0, i + 1).join('/'))
}

/** Where a file goes: a member's own root `_metadata.json` must not meet the backup's. */
function copyName(file: string, prefix: string): string {
  return !prefix && file === '_metadata.json' ? '_metadata (member).json' : file
}

async function commitOf(git: SimpleGit, spec: string): Promise<string> {
  return (await git.raw(['rev-parse', '--verify', '--quiet', `${spec}^{commit}`]).catch(() => '')).trim()
}

/** The commits the clean-up returns to or passes over. */
interface Tips {
  head: string
  branch: string
  /** Where git's abort goes back to. */
  abortTo: string
}

async function readTips(git: SimpleGit, gitDir: string, rebasing: boolean): Promise<Tips> {
  const head = await commitOf(git, 'HEAD')
  const branch = rebasing ? (await commitOf(git, branchOf(gitDir))) || head : head
  let abortTo = branch
  if (rebasing) {
    for (const state of ['rebase-merge', 'rebase-apply']) {
      try {
        abortTo = (await commitOf(git, fs.readFileSync(path.join(gitDir, state, 'orig-head'), 'utf-8').trim())) || abortTo
      } catch { /* not this kind of rebase, or unreadable */ }
    }
  }
  if (!abortTo) throw new Error('no commit to go back to')
  return { head, branch, abortTo }
}

interface PlannedCopy {
  /** Company-relative name told to the member. */
  shown: string
  /** Inside the backup folder. */
  dest: string
  /** A file on disk, or else `blob`: a version git holds. */
  disk?: string
  blob?: string
}

/**
 * Everything the clean-up can take away:
 * - tracked and conflicted files that differ on disk;
 * - a version only git holds: staged and then changed or removed on disk, or
 *   committed during the stop (those commits also stay under refs/acb-recovery/);
 * - whatever is at a path of a version it returns to and git does not track,
 *   ignored files included: a file, or a whole folder where that version has a
 *   file, or a file where it has a folder.
 * Any other untracked file stays on disk untouched, so it is not copied.
 */
async function planCopies(options: RecoveryOptions, tips: Tips): Promise<PlannedCopy[]> {
  const { git, repoPath, backupPrefix = '', skip } = options
  const shownName = (file: string) => `${backupPrefix ? `${backupPrefix}/` : ''}${file}`
  const destName = (file: string) => path.join(backupPrefix, copyName(file, backupPrefix))
  const lstats = new Map<string, fs.Stats | null>()
  const lstat = (file: string): fs.Stats | null => {
    if (!lstats.has(file)) {
      let stat: fs.Stats | null = null
      try {
        stat = fs.lstatSync(path.join(repoPath, file))
      } catch (error) {
        // ENOTDIR: a folder on the way was replaced by a file of the same name.
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'ENOENT' && code !== 'ENOTDIR') throw new CopyFailed(shownName(file), error)
      }
      lstats.set(file, stat)
    }
    return lstats.get(file) ?? null
  }

  const copies: PlannedCopy[] = []
  const taken = new Set<string>()
  const addFromDisk = (file: string) => {
    if (skip?.(file) || taken.has(pathKey(file))) return
    // Nested repositories are listed as folders, and a link holds nothing of the member's.
    if (!lstat(file)?.isFile()) return
    taken.add(pathKey(file))
    copies.push({ shown: shownName(file), dest: destName(file), disk: path.join(repoPath, file) })
  }
  const addFromGit = async (file: string, blob: string, label: string) => {
    if (skip?.(file)) return
    // Only file contents: at that version the path can be a folder, or gone.
    if ((await git.raw(['cat-file', '-t', blob]).catch(() => '')).trim() !== 'blob') return
    const name = taken.has(pathKey(file)) ? `${file}.${label}` : file
    if (taken.has(pathKey(name))) return
    taken.add(pathKey(name))
    copies.push({ shown: shownName(file), dest: destName(name), blob })
  }
  const addFolder = (folder: string, top: string) => {
    for (const entry of fs.readdirSync(path.join(repoPath, folder), { withFileTypes: true })) {
      if (entry.name === '.git') throw new NestedRepoInTheWay(shownName(top))
      const file = `${folder}/${entry.name}`
      if (entry.isDirectory()) addFolder(file, top)
      else addFromDisk(file)
    }
  }

  const entries = (await git.raw(['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames']))
    .split('\0').filter(entry => entry.length >= 4)
  for (const entry of entries) {
    if (!entry.startsWith('??')) addFromDisk(entry.slice(3))
  }

  const tracked = new Set((await git.raw(['ls-files', '-z'])).split('\0').filter(Boolean).map(pathKey))
  for (const tip of new Set([tips.abortTo, tips.branch])) {
    const targetFiles = (await git.raw(['ls-tree', '-r', '-z', '--name-only', tip])).split('\0').filter(Boolean)
    for (const file of targetFiles) {
      const parents = pathsTo(file).slice(0, -1)
      const inTheWay = parents.find(parent => { const stat = lstat(parent); return !stat || !stat.isDirectory() })
      if (inTheWay !== undefined) {
        if (lstat(inTheWay) && !tracked.has(pathKey(inTheWay))) addFromDisk(inTheWay)
        continue
      }
      const stat = lstat(file)
      if (stat?.isDirectory()) addFolder(file, file)
      else if (stat && !tracked.has(pathKey(file))) addFromDisk(file)
    }
  }

  for (const entry of entries) {
    const [staged, onDisk, file] = [entry[0], entry[1], entry.slice(3)]
    if ('AMT'.includes(staged) && 'MDT'.includes(onDisk)) await addFromGit(file, `:0:${file}`, 'staged-version')
  }

  const upstream = await commitOf(git, 'origin/main')
  for (const tip of new Set([tips.head, tips.branch])) {
    if (!tip || tip === tips.abortTo) continue
    // What the rebase replayed has its twin on the left; the rest was made during the stop.
    const commits = (await git.raw(['rev-list', '--cherry-pick', '--right-only', '--no-merges', `${tips.abortTo}...${tip}`, ...(upstream ? [`^${upstream}`] : [])]))
      .split('\n').filter(Boolean)
    for (const commit of commits) {
      const changed = await git.raw(['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', '--root', commit])
      // Newest first, so a path gets its latest version, also when a later commit removed it.
      for (const file of changed.split('\0').filter(Boolean)) await addFromGit(file, `${commit}:${file}`, 'committed-version')
    }
  }
  return copies
}

/** `p` and `p/q.md` can both be in a plan (a file and a folder that swapped): the backup cannot hold both as they are. */
const NAME_CLASHES = new Set(['EEXIST', 'ENOTDIR', 'EISDIR'])

/** Write at `dest`, or under a folder of its own when the name is in use. Never over anything. */
async function placeCopy(backupPath: string, dest: string, write: (target: string) => Promise<void>): Promise<void> {
  for (let n = 0; ; n++) {
    const target = n === 0 ? path.join(backupPath, dest) : path.join(backupPath, `_same-name-${n}`, dest)
    try {
      await fs.promises.mkdir(path.dirname(target), { recursive: true })
      await write(target)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? ''
      if (!NAME_CLASHES.has(code) || n >= 50) throw error
    }
  }
}

/** A new folder for every try: nothing an earlier try saved is ever replaced. */
function freshFolder(backupPath: string): string {
  let folder = backupPath
  for (let n = 2; fs.existsSync(folder); n++) folder = backupPath.replace(/_before_recovery$/, `-${n}_before_recovery`)
  return folder
}

async function keepChangedFiles(options: RecoveryOptions, plan: PlannedCopy[]): Promise<KeptBeforeRecovery | null> {
  const { git, now } = options
  if (plan.length === 0) return null
  const backupPath = freshFolder(options.backupPath)
  const files: string[] = []
  try {
    for (const copy of plan) {
      try {
        const { disk, blob } = copy
        if (disk) {
          await placeCopy(backupPath, copy.dest, target => fs.promises.copyFile(disk, target, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE))
        } else {
          // Read first: a version that cannot be read must leave no empty folder in the way of another copy.
          // (A commit's version stays under refs/acb-recovery/ anyway.)
          const content = await git.binaryCatFile(['-p', blob as string]).catch(() => null)
          if (!content) continue
          await placeCopy(backupPath, copy.dest, target => fs.promises.writeFile(target, content, { flag: 'wx' }))
        }
      } catch (error) {
        throw new CopyFailed(copy.shown, error)
      }
      if (!files.includes(copy.shown)) files.push(copy.shown)
    }
    if (files.length === 0) return null
    await fs.promises.writeFile(path.join(backupPath, '_metadata.json'), JSON.stringify({
      timestamp: now.toISOString(),
      reason: 'before_recovery',
      files,
      note: 'on disk when sync cleaned up an operation that had stopped half-way',
    }, null, 2))
  } catch (error) {
    // Half a copy is no backup and only takes space.
    await fs.promises.rm(backupPath, { recursive: true, force: true }).catch(() => {})
    throw error
  }
  return { files, backupPath }
}

/** git's abort refused (a staged file was edited, its state is unreadable): the copy exists, so go back by force. */
async function forceCleanUp(git: SimpleGit, gitDir: string, rebasing: boolean, log: SyncLogger): Promise<void> {
  log.warn('Git sync: Abort did not finish, resetting to the local version')
  if (rebasing) {
    const branch = branchOf(gitDir)
    if (await commitOf(git, branch)) await git.raw(['symbolic-ref', 'HEAD', branch])
  }
  await git.raw(['reset', '--hard', '--quiet', 'HEAD'])
  for (const state of ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'MERGE_MSG', 'MERGE_MODE', 'CHERRY_PICK_HEAD', 'sequencer', 'AUTO_MERGE']) {
    fs.rmSync(path.join(gitDir, state), { recursive: true, force: true })
  }
}

interface RecoveryOptions {
  git: SimpleGit
  repoPath: string
  /** Where the copies go: `<backups>/<ts>_before_recovery`. */
  backupPath: string
  /** A private folder's company-relative path (backups are laid out company-relative). */
  backupPrefix?: string
  /** Paths sync keeps on this computer anyway (.backups/, private clones). */
  skip?: (file: string) => boolean
  /** The app's long git or an AI turn may be working here: nothing is touched. */
  otherGitRunning?: boolean
  now: Date
  log: SyncLogger
}

export type RecoveryResult =
  | { ok: true; kept: KeptBeforeRecovery | null }
  | { ok: false; errorType: 'conflict' | 'locked'; error: string; kept: KeptBeforeRecovery | null }

/** Refs go with their backup folder (30 days): one whose folder is gone holds nothing anyone can reach. */
export async function pruneRecoveryRefs(git: SimpleGit, backupsDir: string, log: SyncLogger): Promise<void> {
  const refs = (await git.raw(['for-each-ref', '--format=%(refname)', 'refs/acb-recovery/'])).split('\n').filter(Boolean)
  for (const ref of refs) {
    const folder = ref.split('/')[2]
    if (folder && fs.existsSync(path.join(backupsDir, folder))) continue
    await git.raw(['update-ref', '-d', ref])
    log.log(`Git sync: Deleted recovery ref of an old backup: ${folder}`)
  }
}

/** The commits as they are, for anyone who needs them later: a clean-up moves past them. */
async function pinTips(git: SimpleGit, backupPath: string, tips: Tips): Promise<void> {
  const name = `refs/acb-recovery/${path.basename(backupPath)}`
  if (tips.head) await git.raw(['update-ref', `${name}/head`, tips.head])
  if (tips.branch) await git.raw(['update-ref', `${name}/branch`, tips.branch])
}

/**
 * Clean up a rebase, merge or cherry-pick left by an earlier run, after
 * keeping what is on disk. Rebase detection uses the rebase-merge /
 * rebase-apply directories: REBASE_HEAD can linger after a finished rebase.
 */
export async function recoverInterruptedState(options: RecoveryOptions): Promise<RecoveryResult> {
  const { git, repoPath, log } = options
  const gitDir = path.join(repoPath, '.git')
  const record = path.join(gitDir, PENDING_RECORD)
  const present = (name: string) => fs.existsSync(path.join(gitDir, name))
  const rebasing = () => present('rebase-merge') || present('rebase-apply')
  const stopped = () => rebasing() || present('MERGE_HEAD') || present('CHERRY_PICK_HEAD')
  const pending = readPending(gitDir)
  if (!stopped()) {
    // Someone else finished it after a try of ours: the member still hears of that copy.
    fs.rmSync(record, { force: true })
    return { ok: true, kept: together(pending) }
  }
  const stop = (errorType: 'conflict' | 'locked', error: string) => ({ ok: false as const, errorType, error, kept: together(pending) })

  // A process that was cut off can live on after the app (or the AI can be at it): it may yet finish.
  if (options.otherGitRunning || await gitRunningIn(repoPath) !== 'no') return stop('locked', REPOSITORY_BUSY_MESSAGE)

  const wasRebasing = rebasing()
  try {
    const tips = await readTips(git, gitDir, wasRebasing)
    const kept = await keepChangedFiles(options, await planCopies(options, tips))
    if (kept) {
      pending.push(kept)
      await pinTips(git, kept.backupPath, tips)
      log.warn(`Git sync: Kept ${kept.files.length} file(s) before cleaning up a stopped operation`)
      // Without this record a failure below only costs the note, never the copy.
      try { fs.writeFileSync(record, JSON.stringify(pending)) } catch { /* see above */ }
    }
  } catch (backupError) {
    if (backupError instanceof NestedRepoInTheWay) return stop('conflict', nestedRepoInTheWayMessage(backupError.folder))
    log.error('Git sync: Could not back up files before cleaning up a stopped operation:', backupError instanceof CopyFailed ? backupError.reason : backupError)
    return stop('conflict', backupError instanceof CopyFailed ? recoveryBackupFailedMessage(backupError.file, backupError.reason) : RECOVERY_UNREADABLE_MESSAGE)
  }

  if (wasRebasing) {
    log.log('Git sync: Detected stale rebase, aborting...')
    await git.rebase(['--abort']).catch((abortError: unknown) => log.warn('Git sync: Failed to abort rebase:', abortError))
  }
  if (present('MERGE_HEAD')) {
    log.log('Git sync: Detected stale MERGE_HEAD, aborting...')
    await git.merge(['--abort']).catch((abortError: unknown) => log.warn('Git sync: Failed to abort MERGE_HEAD:', abortError))
  }
  if (present('CHERRY_PICK_HEAD')) {
    log.log('Git sync: Detected stale CHERRY_PICK_HEAD, aborting...')
    await git.raw(['cherry-pick', '--abort']).catch((abortError: unknown) => log.warn('Git sync: Failed to abort CHERRY_PICK_HEAD:', abortError))
  }
  if (stopped()) {
    await forceCleanUp(git, gitDir, wasRebasing, log).catch((resetError: unknown) => log.error('Git sync: Could not reset a stopped operation:', resetError))
  }
  if (stopped()) return stop('conflict', RECOVERY_FAILED_MESSAGE)
  fs.rmSync(record, { force: true })
  return { ok: true, kept: together(pending) }
}
