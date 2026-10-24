import fs from 'fs'
import path from 'path'
import type { SimpleGit } from 'simple-git'
import { readExcludeBlock, writeExcludeBlock, type ExcludeBlock } from './local-excludes'

/**
 * Walk the repo tree and return relative paths of any nested Git repositories
 * (i.e. directories that contain their own .git/ — either a directory or a "gitdir" file for worktrees).
 * Excludes the root repo itself, common heavy/irrelevant dirs, and stops descending into a nested repo
 * once found (so deeply-nested external repos are reported only at their topmost level).
 */
export async function findNestedGitRepos(rootPath: string): Promise<string[]> {
  const SKIP_DIRS = new Set(['node_modules', '.backups', '.next', '.nuxt', 'dist', '__pycache__', '.venv', 'venv', '.workspace'])
  const results: string[] = []

  async function walk(dir: string, relativePath: string): Promise<void> {
    if (relativePath !== '') {
      const dotGitPath = path.join(dir, '.git')
      try {
        await fs.promises.access(dotGitPath)
        // Either a .git directory (real repo) or a .git file (worktree/submodule pointer).
        results.push(relativePath)
        return
      } catch {
        // not a nested repo, continue walking
      }
    }

    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (SKIP_DIRS.has(entry.name)) continue
      // Skip the root repo's own .git
      if (relativePath === '' && entry.name === '.git') continue

      const childDir = path.join(dir, entry.name)
      const childRel = relativePath ? `${relativePath}/${entry.name}` : entry.name
      await walk(childDir, childRel)
    }
  }

  await walk(rootPath, '')
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

export const NESTED_REPO_OVERWRITE_REASON = 'nested_repo_overwrite'

export interface NestedRepoOverwriteResult {
  /** Paths whose local version was copied to the backup (company-relative for a private folder). */
  files: string[]
  /** The excluded nested repositories they are in (same spelling). */
  repos: string[]
  backupPath: string
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
}): Promise<NestedRepoOverwriteResult | null> {
  const { git, repoPath, backupPath, log } = options
  const prefix = options.backupPrefix ? `${options.backupPrefix}/` : ''
  const candidates: Array<{ file: string; oid: string; repo: string; link: boolean }> = []
  for (const repo of options.repos) {
    const incoming = await git.raw(['ls-tree', '-r', '-z', 'origin/main', '--', `${repo}/`]).catch(() => '')
    if (!incoming) continue
    const tracked = new Set((await git.raw(['ls-files', '-z', '--', `:(literal)${repo}/`]).catch(() => '')).split('\0').filter(Boolean))
    for (const entry of incoming.split('\0')) {
      const tab = entry.indexOf('\t')
      if (tab === -1) continue
      const [mode, , oid] = entry.slice(0, tab).split(' ')
      const file = entry.slice(tab + 1)
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
    reason: NESTED_REPO_OVERWRITE_REASON,
    repos: repos.map(r => `${prefix}${r}`),
    files: files.map(f => `${prefix}${f}`),
    note: 'this computer\'s version of files in a nested repository the member does not share; a teammate shared files at the same paths',
  }, null, 2))
  for (const file of files) {
    const dest = path.join(backupPath, prefix, file)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.cpSync(path.join(repoPath, file), dest, { verbatimSymlinks: true })
  }
  log.log(`Git sync: Backed up ${files.length} file(s) of excluded nested repositories before a teammate's version replaces them: ${backupPath}`)
  return { files: files.map(f => `${prefix}${f}`), repos: repos.map(r => `${prefix}${r}`), backupPath }
}
