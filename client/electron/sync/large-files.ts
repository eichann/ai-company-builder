// Step 4 of git:sync: files over 100 MB are kept out of what sync shares by
// a line in the root .gitignore (CLAUDE.md, "Architecture: Client Sync").
//
// The scan used to walk and stat the whole company folder — .workspace/, app
// bundles and other ignored trees included — pruned by a substring test on
// the .gitignore text: an entry was skipped whenever its path occurred
// anywhere in the file. That made it fast on the owner's folder (682 of
// 18,184 entries visited) only because it was wrong: a line
// `社長直下/…/video.mp4` hid every file in 社長直下 (and コンテンツ the same
// way), so a new large file there was shared, and an unrelated line
// containing a path (a comment, `x/a.mp4` vs a root `a.mp4`) counted as
// ignoring it. Walking everything correctly costs 0.4–0.8 s per sync.
//
// Now git says which files exist for it: `ls-files --cached` (index entries)
// and `ls-files --others --exclude-standard` (untracked files no rule
// ignores), run at once; no blob is read, so a partial clone never fetches
// anything. Only those are stat'ed. What the old walk covered and git lists
// differently:
//
//  - Tracked files, changed or not, are stat'ed as before: a tracked file over
//    the limit still gets its line (it stays tracked — that is what the old
//    scan did too).
//  - An untracked nested repository is one `dir/` entry, and so is a tracked
//    gitlink (a directory on disk): their contents are walked like the old
//    scan did (skipping .git / .backups / node_modules), because "keep
//    sharing" in the nested-repository step drops the inner .git right after
//    this step and would otherwise stage a large file inside.
//  - Ignored untracked files are not listed: git would never stage them.
//
// "Already ignored" is asked of git (`check-ignore --no-index`, one call per
// candidate — candidates are rare), and the line written is the path as a
// literal, anchored gitignore pattern (largeFilePattern).

import fs from 'fs'
import path from 'path'
import type { SimpleGit } from 'simple-git'
import { isLocalOnlyPath } from '../protected-config'

export const LARGE_FILE_THRESHOLD = 100 * 1024 * 1024 // 100MB

/**
 * Folder names the scan never enters, at any depth: the old walk's `.git`,
 * `.backups`, `node_modules`, and `.workspace` (local-only like `.backups`;
 * sync unstages both whatever the .gitignore says).
 */
const SKIPPED_NAMES = new Set(['.git', 'node_modules'])

export interface LargeFileScanOptions {
  /** Bytes; files strictly larger are reported. Default LARGE_FILE_THRESHOLD. */
  threshold?: number
  /**
   * Repository-relative paths never reported (and never entered): the
   * readable private folders' clones and the local-only folders. A large file
   * there must not be named in the shared .gitignore.
   */
  skip?: (relPath: string) => boolean
}

function skippedBySegment(rel: string): boolean {
  return rel.split('/').some(seg => SKIPPED_NAMES.has(seg)) || isLocalOnlyPath(`${rel}/`)
}

/**
 * Files over the threshold that sync would otherwise stage or keep tracking
 * and that no ignore rule covers yet, repository-relative with `/`, in git's
 * spelling (NFC on macOS), sorted.
 */
export async function findLargeFiles(git: SimpleGit, repoPath: string, opts: LargeFileScanOptions = {}): Promise<string[]> {
  const threshold = opts.threshold ?? LARGE_FILE_THRESHOLD
  const skip = (rel: string) => skippedBySegment(rel) || (opts.skip?.(rel) ?? false)

  const candidates: string[] = []
  const statAll = async (rels: string[]) => {
    const dirs: string[] = []
    for (let i = 0; i < rels.length; i += 256) {
      const stats = await Promise.all(rels.slice(i, i + 256).map(rel =>
        fs.promises.stat(path.join(repoPath, rel)).then(st => ({ rel, st }), () => null)))
      for (const s of stats) {
        if (!s) continue // not on disk (sparse checkout, deleted) or unreadable
        if (s.st.isDirectory()) {
          // Never through a symlink: git does not stage what it points at
          // (and a link to a parent would loop).
          const link = await fs.promises.lstat(path.join(repoPath, s.rel)).then(l => l.isSymbolicLink(), () => true)
          if (!link) dirs.push(s.rel)
        } else if (s.st.isFile() && s.st.size > threshold) {
          candidates.push(s.rel)
        }
      }
    }
    return dirs
  }
  // Index entries and untracked files are listed by two git processes at
  // once: the tracked files are stat'ed while git is still looking for
  // untracked ones (the slower listing). An entry ending in `/` is an
  // untracked nested repository.
  const list = (args: string[]) => git.raw(['ls-files', '-z', ...args]).then(out =>
    [...new Set(out.split('\0').filter(Boolean).map(e => e.replace(/\/$/, '')))].filter(e => !skip(e)))
  const [trackedDirs, untracked] = await Promise.all([
    list(['--cached']).then(statAll),
    list(['--others', '--exclude-standard']),
  ])
  // Nested repositories and gitlinks: walk their contents like the old scan.
  let dirs = [...trackedDirs, ...(await statAll(untracked))]
  while (dirs.length > 0) {
    const children: string[] = []
    for (const dir of dirs) {
      let items: string[]
      try { items = await fs.promises.readdir(path.join(repoPath, dir)) } catch { continue }
      for (const item of items) {
        const rel = `${dir}/${item}`
        if (!skip(rel)) children.push(rel)
      }
    }
    dirs = await statAll(children)
  }

  const result: string[] = []
  for (const rel of [...new Set(candidates)].sort()) {
    if (rel.includes('\n') || rel.includes('\r')) continue // a .gitignore line cannot name it
    if (!(await isIgnored(git, rel))) result.push(rel)
  }
  return result
}

/**
 * Does an ignore rule (any .gitignore, .git/info/exclude, core.excludesFile)
 * cover `rel`, tracked or not? `--no-index` so a tracked file is judged by
 * the patterns alone. Exit 1 (not ignored) prints nothing and is not an
 * error for simple-git; an ignored path is printed. A failing check counts
 * as "not ignored": an extra line is harmless, a large file shared is not.
 */
async function isIgnored(git: SimpleGit, rel: string): Promise<boolean> {
  try {
    return (await git.raw(['check-ignore', '--no-index', '--', rel])).trim().length > 0
  } catch {
    return false
  }
}

/**
 * The .gitignore line that ignores exactly `rel` (repository-relative, `/`):
 * glob characters and backslashes escaped, a leading `#` / `!` escaped,
 * trailing spaces kept, and anchored to the root — a path with a `/` in it
 * already is (gitignore anchors any pattern with a slash before its end);
 * one without gets a leading `/`, so `big.mov` at the root does not ignore
 * every `big.mov` below it.
 */
export function largeFilePattern(rel: string): string {
  let p = rel.replace(/[\\*?[]/g, c => `\\${c}`)
  if (p.startsWith('#') || p.startsWith('!')) p = `\\${p}`
  p = p.replace(/ +$/, spaces => spaces.replace(/ /g, '\\ '))
  return rel.includes('/') ? p : `/${p}`
}
