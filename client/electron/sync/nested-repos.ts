import fs from 'fs'
import path from 'path'
import type { SimpleGit } from 'simple-git'
import { diskKey } from '../../../shared/core/paths'
import { readExcludeBlock, writeExcludeBlock, type ExcludeBlock } from './local-excludes'

/** Paths per `git check-ignore` call (the argument list stays far below any OS limit). */
const CHECK_IGNORE_BATCH = 200

/**
 * Which of `dirs` (folders on disk, repository-relative) a **shared** ignore
 * rule ignores, as `diskKey`s (git prints NFC; a Mac's readdir may give NFD).
 * git decides (`check-ignore -v`: every `.gitignore`, `.git/info/exclude`,
 * global excludes, negations honoured), and only a folder whose deciding line
 * is in a `.gitignore` the repository tracks counts: teammates have that rule
 * too, so none of their apps shares files there. A folder ignored only on this
 * computer (an `info/exclude` line, a global exclude, a `.gitignore` not
 * shared yet) is still searched and asked about as before — a teammate may
 * share files at that path, and the pull would overwrite this computer's
 * ignored copies without the nested-repository backup.
 *
 * A folder that holds a tracked file is never ignored for check-ignore
 * (without `--no-index`): a stray `.git` in a shared folder is still found. A
 * name git would quote (`"`, `\`, control characters) is not asked and counts
 * as not ignored. A batch git cannot answer counts as not ignored too (exit 1
 * also means "none ignored"): walking and asking is the safe side.
 */
async function sharedIgnoredAmong(git: SimpleGit, dirs: readonly string[]): Promise<Set<string>> {
  // eslint-disable-next-line no-control-regex
  const askable = dirs.filter(d => !/["\\\u0000-\u001f\u007f]/.test(d))
  const decided: Array<{ source: string; dir: string }> = []
  for (let i = 0; i < askable.length; i += CHECK_IGNORE_BATCH) {
    const batch = askable.slice(i, i + CHECK_IGNORE_BATCH)
    let listed = ''
    try {
      listed = await git.raw(['-c', 'core.quotePath=false', 'check-ignore', '-v', '--', ...batch])
    } catch {
      continue
    }
    // `<source>:<line>:<pattern>\t<path>`; with -v a path whose deciding
    // line is a negation (`!…`) is listed too, and it is not ignored.
    for (const line of listed.split('\n')) {
      const tab = line.lastIndexOf('\t')
      const m = tab === -1 ? null : /^(.*?):\d+:(.*)$/.exec(line.slice(0, tab))
      if (!m || m[2].startsWith('!')) continue
      const source = m[1]
      if (path.posix.basename(source) !== '.gitignore' || source.startsWith('/') || source.startsWith('"')) continue
      decided.push({ source, dir: line.slice(tab + 1) })
    }
  }
  if (decided.length === 0) return new Set()
  const sources = [...new Set(decided.map(d => d.source))]
  let tracked: Set<string>
  try {
    const listed = await git.raw(['ls-files', '-z', '--', ...sources.map(s => `:(literal)${s}`)])
    tracked = new Set(listed.split('\0').filter(Boolean).map(diskKey))
  } catch {
    return new Set()
  }
  return new Set(decided.filter(d => tracked.has(diskKey(d.source))).map(d => diskKey(d.dir)))
}

async function hasDotGit(dir: string): Promise<boolean> {
  try {
    // Either a .git directory (real repo) or a .git file (worktree/submodule pointer).
    await fs.promises.access(path.join(dir, '.git'))
    return true
  } catch {
    return false
  }
}

/** Every segment of `rel` under `root` is a real directory (no symlink on the way). */
function realDirectoryPath(root: string, rel: string): boolean {
  let dir = root
  for (const segment of rel.split('/')) {
    if (!segment || segment === '.' || segment === '..' || segment === '.git') return false
    dir = path.join(dir, segment)
    try {
      if (!fs.lstatSync(dir).isDirectory()) return false
    } catch {
      return false
    }
  }
  return true
}

/**
 * Walk the repo tree and return relative paths of any nested Git repositories
 * (i.e. directories that contain their own .git/ — either a directory or a "gitdir" file for worktrees).
 * Excludes the root repo itself, common heavy/irrelevant dirs, and stops descending into a nested repo
 * once found (so deeply-nested external repos are reported only at their topmost level).
 * Symlinked folders are not followed. Walked level by level, so git is asked once per level.
 *
 * With `git`, folders a shared (tracked) `.gitignore` ignores are neither
 * reported nor walked (2026-11-22: a clone inside `.personal/`, which is never
 * shared, stopped sync with a question, and every sync walked the whole
 * ignored tree): no member's `git add` records anything there, so there is
 * nothing to ask and nothing a teammate can put over it. Folders ignored only
 * on this computer are searched as before (sharedIgnoredAmong). A folder that
 * holds a tracked file still counts as shared (git says so), so a stray `.git`
 * there is still found and asked about. Folders in `known` (the member's own
 * exclusions, legacy shared lines included; later steps still need them) are
 * reported whenever they still have their `.git`. `onIgnored` hears each
 * skipped folder (topmost only): a shared rule this computer has may not be on
 * the server yet, so sync still backs up what the pull would overwrite there.
 */
export async function findNestedGitRepos(rootPath: string, options: { git?: SimpleGit; known?: readonly string[]; onIgnored?: (folder: string) => void } = {}): Promise<string[]> {
  const SKIP_DIRS = new Set(['node_modules', '.backups', '.next', '.nuxt', 'dist', '__pycache__', '.venv', 'venv', '.workspace'])
  const { git } = options
  const results: string[] = []
  const known = new Set((options.known ?? []).map(diskKey))

  let level: string[] = ['']
  while (level.length > 0) {
    // The sub-folders of this level, in readdir order.
    const children: string[] = []
    for (const rel of level) {
      let entries: fs.Dirent[]
      try {
        entries = await fs.promises.readdir(path.join(rootPath, rel), { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (SKIP_DIRS.has(entry.name)) continue
        // Skip the root repo's own .git
        if (rel === '' && entry.name === '.git') continue
        children.push(rel ? `${rel}/${entry.name}` : entry.name)
      }
    }
    const ignored = git && children.length > 0 ? await sharedIgnoredAmong(git, children) : new Set<string>()
    const next: string[] = []
    for (const rel of children) {
      const key = diskKey(rel)
      if (ignored.has(key) && !known.has(key)) {
        options.onIgnored?.(rel)
        continue
      }
      if (await hasDotGit(path.join(rootPath, rel))) results.push(rel)
      else next.push(rel)
    }
    level = next
  }

  // A known exclusion inside an ignored folder is not reached by the walk.
  const found = results.map(diskKey)
  for (const repo of options.known ?? []) {
    const key = diskKey(repo)
    if (found.some(r => key === r || key.startsWith(`${r}/`))) continue
    if (realDirectoryPath(rootPath, repo) && await hasDotGit(path.join(rootPath, repo))) {
      results.push(repo)
      found.push(key)
    }
  }
  return results
}

// ---------------------------------------------------------------------------
// Local exclusions (owner decision 2026-10-24)
// ---------------------------------------------------------------------------
//
// A nested repository the member chose not to share is excluded in this
// repository's own .git/info/exclude (a managed block, NFC and NFD), never in
// the shared .gitignore: a line there applied one member's choice to every
// teammate (a teammate's folder at the same path stopped syncing) and showed
// the folder's name to the whole company. Lines older apps wrote into the
// shared .gitignore (`/<path>/` under "# Auto-ignored: nested Git
// repositories") are left alone — removing one would start sharing that
// folder for everyone — and still count as "already excluded".

const NESTED_REPO_EXCLUDES: ExcludeBlock = {
  begin: '# >>> ACB nested Git repositories (managed by the app, local only) >>>',
  end: '# <<< ACB nested Git repositories <<<',
}

/** The nested repositories this member excluded locally (NFC). */
export function readNestedRepoExcludes(repoPath: string): string[] {
  return readExcludeBlock(repoPath, NESTED_REPO_EXCLUDES)
}

/** Make the local block list exactly `paths`. Returns true when the file changed. */
export function writeNestedRepoExcludes(repoPath: string, paths: readonly string[]): boolean {
  return writeExcludeBlock(repoPath, NESTED_REPO_EXCLUDES, [...new Set(paths.map(p => p.normalize('NFC')))].sort())
}

/** The folders named by `/<path>/` lines of a shared .gitignore (how older apps excluded nested repositories), NFC. */
export function legacySharedExclusions(gitignoreText: string): Set<string> {
  const out = new Set<string>()
  for (const raw of gitignoreText.split('\n')) {
    const m = /^\/(.+)\/$/.exec(raw.trim())
    if (m) out.add(m[1].normalize('NFC'))
  }
  return out
}

/**
 * Gitlink entries (mode 160000) at or under `repo` in the index. Only these
 * are untracked for an excluded nested repository: a teammate's ordinary
 * files at the same path are theirs to share, and untracking them would
 * delete them for everyone.
 */
export async function gitlinksUnder(git: SimpleGit, repo: string): Promise<string[]> {
  const listed = await git.raw(['ls-files', '-s', '-z', '--', `:(literal)${repo}`]).catch(() => '')
  const out: string[] = []
  for (const entry of listed.split('\0')) {
    const tab = entry.indexOf('\t')
    if (tab === -1) continue
    if (entry.slice(0, tab).split(' ')[0] === '160000') out.push(entry.slice(tab + 1))
  }
  return out
}

// The sync result when the member (or 自動で送る) did not answer the question
// about a nested repository. Plain words, no Git terms; it names the folder
// and the way out. Must start with 「同期を中止しました」 (isCancelled, the
// renderer's autoSyncSchedule: a stop the member chose).

/** A new folder managed apart from the app (not shared yet). */
export function externalNestedRepoStopMessage(repo: string): string {
  return `同期を中止しました（「${repo}」は、このアプリとは別に管理されているフォルダです。共有せずにこのPCだけに置くこともできます。「サーバーと同期」を押すと選べます）`
}

/** A shared folder that picked up a stray `.git`. */
export function sharedNestedRepoStopMessage(repo: string): string {
  return `同期を中止しました（共有中のフォルダ「${repo}」に、このアプリとは別に管理するための情報が入っています。このPCで増えたファイルだけ共有しないこともできます。「サーバーと同期」を押すと選べます）`
}

export const NESTED_REPO_OVERWRITE_REASON = 'nested_repo_overwrite'
/** A large file kept on this computer (sync/local-ignores.ts) that a teammate shared at the same path. */
export const LARGE_FILE_OVERWRITE_REASON = 'large_file_overwrite'

export interface NestedRepoOverwriteResult {
  /** Paths whose local version was copied to the backup (company-relative for a private folder). */
  files: string[]
  /** The excluded nested repositories they are in (same spelling). */
  repos: string[]
  backupPath: string
}

/** What the member is told when a large file kept here was backed up (appended to the sync message). */
export function largeFileOverwriteMessage(result: Pick<NestedRepoOverwriteResult, 'files'>): string {
  return `このPCだけに置いていた大きなファイルと同じ名前のファイルを、ほかのメンバーが共有したため、このPCにあった版を .backups に保存しました（${result.files.length}件）。`
}

/** What the member is told (appended to the sync message). */
export function nestedRepoOverwriteMessage(result: Pick<NestedRepoOverwriteResult, 'files' | 'repos'>): string {
  return `共有していないフォルダ（${result.repos.join('、')}）に、ほかのメンバーが同じ名前のファイルを共有したため、このPCにあった版を .backups に保存しました（${result.files.length}件）。`
}

/**
 * A folder the member excluded locally is not excluded for teammates: one of
 * them may share files at the same path. Pulling them overwrites the
 * member's own files there (ignored, so expendable to git) without a word.
 * Before the pull, copy every such file that differs from the server's to
 * `backupPath` (with _metadata.json); the files stay where they are. The
 * server's tree is read without its blobs (no lazy fetch in a partial clone).
 * A teammate pushing between this check and the pull is not covered.
 */
export async function backUpBeforeServerOverwrite(options: {
  git: SimpleGit
  repoPath: string
  repos: readonly string[]
  backupPath: string
  /** Prefix for paths laid out and listed in the backup (a private folder's path). */
  backupPrefix?: string
  now: Date
  log: Pick<Console, 'log' | 'warn'>
  /**
   * `repos` are files kept on this computer (large files), not folders.
   * Recorded with reason LARGE_FILE_OVERWRITE_REASON instead.
   */
  files?: boolean
}): Promise<NestedRepoOverwriteResult | null> {
  const { git, repoPath, backupPath, log } = options
  const prefix = options.backupPrefix ? `${options.backupPrefix}/` : ''
  const candidates: Array<{ file: string; oid: string; repo: string; link: boolean }> = []
  const spec = (repo: string) => (options.files ? repo : `${repo}/`)
  for (const repo of options.repos) {
    const incoming = await git.raw(['ls-tree', '-r', '-z', 'origin/main', '--', spec(repo)]).catch(() => '')
    if (!incoming) continue
    const tracked = new Set((await git.raw(['ls-files', '-z', '--', `:(literal)${spec(repo)}`]).catch(() => '')).split('\0').filter(Boolean))
    for (const entry of incoming.split('\0')) {
      const tab = entry.indexOf('\t')
      if (tab === -1) continue
      const [mode, , oid] = entry.slice(0, tab).split(' ')
      const file = entry.slice(tab + 1)
      if (options.files && file !== repo) continue
      // A tracked path is an ordinary shared file: the rebase handles it.
      if (tracked.has(file) || mode === '160000') continue
      let st: fs.Stats
      try { st = fs.lstatSync(path.join(repoPath, file)) } catch { continue }
      if (!st.isFile() && !st.isSymbolicLink()) continue
      candidates.push({ file, oid, repo, link: st.isSymbolicLink() })
    }
  }
  if (candidates.length === 0) return null
  // A symlink where the server has something is always kept aside.
  const differing = candidates.filter(c => c.link)
  const regular = candidates.filter(c => !c.link)
  for (let i = 0; i < regular.length; i += 200) {
    const group = regular.slice(i, i + 200)
    // With the path, hash-object applies the filters `git add` would.
    const ids = (await git.raw(['hash-object', '--', ...group.map(c => c.file)])).split('\n').map(l => l.trim()).filter(Boolean)
    group.forEach((c, k) => { if (ids[k] !== c.oid) differing.push(c) })
  }
  if (differing.length === 0) return null
  const files = differing.map(c => c.file).sort()
  const repos = [...new Set(differing.map(c => c.repo))].sort()
  // Metadata first: a crash halfway still leaves a listed backup.
  fs.mkdirSync(backupPath, { recursive: true })
  fs.writeFileSync(path.join(backupPath, '_metadata.json'), JSON.stringify({
    timestamp: options.now.toISOString(),
    reason: options.files ? LARGE_FILE_OVERWRITE_REASON : NESTED_REPO_OVERWRITE_REASON,
    ...(options.files ? {} : { repos: repos.map(r => `${prefix}${r}`) }),
    files: files.map(f => `${prefix}${f}`),
    note: options.files
      ? 'this computer\'s version of large files kept on this computer only; a teammate shared files at the same paths'
      : 'this computer\'s version of files in a nested repository the member does not share; a teammate shared files at the same paths',
  }, null, 2))
  for (const file of files) {
    const dest = path.join(backupPath, prefix, file)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.cpSync(path.join(repoPath, file), dest, { verbatimSymlinks: true })
  }
  log.log(`Git sync: Backed up ${files.length} ${options.files ? 'large file(s) kept on this computer' : 'file(s) of excluded nested repositories'} before a teammate's version replaces them: ${backupPath}`)
  return { files: files.map(f => `${prefix}${f}`), repos: repos.map(r => `${prefix}${r}`), backupPath }
}
