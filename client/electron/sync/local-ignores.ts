// Ignore lines the app writes for one member live on that member's computer
// (.git/info/exclude, managed blocks), never in the shared .gitignore
// (.claude/rules/sync-guards.md "Shared files"):
//
//  - files over the size limit (sync step 4, ./large-files.ts);
//  - a skill kept private while it is being written (skills:makePrivate).
//
// A line in the shared .gitignore applied one member's file to everyone —
// a teammate's file at the same path silently stopped syncing — and kept
// the shared .gitignore something every member's app had to write, so it
// could not be limited to owners and admins.
//
// Lines older apps wrote there are moved by the member they belong to
// (moveOwnLinesToLocal, every sync before anything is staged): a large-file
// line whose file is on this computer and over the limit, a private-skill
// line whose folder is here and not shared. The local line is written
// before the shared one is removed, so the file never stops being ignored.
// Lines for files this computer does not have are someone else's and stay.
//
// Why the move is safe for a teammate who has a file at the same path: the
// line disappears from their disk only when they pull, and every sync runs
// this move (and the large-file scan) before its pull, so their own sync has
// already copied the line while it was still there. An older app does not
// move anything: its large file gets the shared line again at its next scan
// (before staging, as always); a private skill an older app keeps at
// exactly the same path as a teammate's would start syncing once that
// teammate's line is gone (both made one with the same name in the same
// department) — accepted, see the rule file.

import fs from 'fs'
import path from 'path'
import type { SimpleGit } from 'simple-git'
import { readExcludeLines, writeExcludeLines, type ExcludeBlock } from './local-excludes'
import { largeFilePattern } from './large-files'

export const LARGE_FILE_EXCLUDES: ExcludeBlock = {
  begin: '# >>> ACB large files (managed by the app, local only) >>>',
  end: '# <<< ACB large files <<<',
}

export const PRIVATE_SKILL_EXCLUDES: ExcludeBlock = {
  begin: '# >>> ACB private skills (managed by the app, local only) >>>',
  end: '# <<< ACB private skills <<<',
}

/** The headers older apps wrote above these lines in the shared .gitignore. */
export const LEGACY_LARGE_FILES_HEADER = '# Auto-ignored: Large files (>100MB)'
export const LEGACY_PRIVATE_SKILLS_HEADER = '# Private skills'

/** A private-skill line: `<folder>/.claude/skills/<name>/` (company-wide: `.claude/skills/<name>/`). */
export const SKILL_LINE_RE = /^(?:[^/]+\/)*\.claude\/skills\/[^/]+\/$/

/** The path a largeFilePattern line names (its inverse); null for a blank or comment line. */
export function largeFilePathOf(line: string): string | null {
  const l = line.replace(/\r$/, '')
  if (l === '' || l.startsWith('#')) return null
  const p = (l.startsWith('/') ? l.slice(1) : l).replace(/\\(.)/g, '$1')
  return p === '' ? null : p
}

/** The large files this computer keeps out of sync (repository-relative). */
export function readLocalLargeFiles(repoPath: string): string[] {
  return readExcludeLines(repoPath, LARGE_FILE_EXCLUDES).map(largeFilePathOf).filter((p): p is string => p !== null)
}

/** Make the local block list exactly `rels`. Returns true when the file changed. */
export function writeLocalLargeFiles(repoPath: string, rels: readonly string[]): boolean {
  return writeExcludeLines(repoPath, LARGE_FILE_EXCLUDES, [...new Set(rels)].sort().map(largeFilePattern))
}

/** The private-skill lines of this computer (`<folder>/.claude/skills/<name>/`). */
export function readLocalPrivateSkills(repoPath: string): string[] {
  return readExcludeLines(repoPath, PRIVATE_SKILL_EXCLUDES)
}

/** Add or remove one private-skill line. Returns true when the file changed. */
export function setLocalPrivateSkill(repoPath: string, entry: string, isPrivate: boolean): boolean {
  const current = readLocalPrivateSkills(repoPath)
  const next = isPrivate ? [...new Set([...current, entry])].sort() : current.filter(l => l !== entry)
  return writeExcludeLines(repoPath, PRIVATE_SKILL_EXCLUDES, next)
}

/**
 * Remove `entries` from shared .gitignore lines, and with them a legacy header
 * no line of its kind follows any more (with the blank line before it).
 */
export function removeSharedLines(lines: readonly string[], entries: ReadonlySet<string>): string[] {
  const kept = lines.filter(l => !entries.has(l.replace(/\r$/, '')))
  const out: string[] = []
  for (let i = 0; i < kept.length; i++) {
    const line = kept[i].replace(/\r$/, '')
    if (line === LEGACY_LARGE_FILES_HEADER || line === LEGACY_PRIVATE_SKILLS_HEADER) {
      const next = kept[i + 1]?.replace(/\r$/, '')
      const belongs = line === LEGACY_PRIVATE_SKILLS_HEADER
        ? next !== undefined && SKILL_LINE_RE.test(next)
        : next !== undefined && largeFilePathOf(next) !== null
      if (!belongs) {
        if (out.length > 0 && out[out.length - 1].trim() === '') out.pop()
        continue
      }
    }
    out.push(kept[i])
  }
  return out
}

/** Tracked here, or on the server's branch as of the last fetch (never downloads a blob). */
export async function trackedOrOnServer(git: SimpleGit, rel: string): Promise<boolean> {
  const spec = `:(literal)${rel}`
  try {
    if ((await git.raw(['ls-files', '--', spec])).trim() !== '') return true
  } catch {
    return false // not a repository: nothing is shared
  }
  try {
    return (await git.raw(['ls-tree', '-r', '--name-only', 'origin/main', '--', spec])).trim() !== ''
  } catch {
    return false // no origin/main yet
  }
}

export interface MovedLines {
  largeFiles: string[]
  skills: string[]
}

/**
 * Move this member's lines from the shared .gitignore at the repository root
 * to .git/info/exclude (see the top of this file). `skills`: look at
 * private-skill lines too (the company repository only).
 */
export async function moveOwnLinesToLocal(git: SimpleGit, repoPath: string, opts: { threshold: number; skills: boolean }): Promise<MovedLines> {
  const moved: MovedLines = { largeFiles: [], skills: [] }
  const gitignorePath = path.join(repoPath, '.gitignore')
  let text: string
  try { text = fs.readFileSync(gitignorePath, 'utf-8') } catch { return moved }
  const lines = text.split('\n')
  const removed = new Set<string>()

  // Large files: the lines under a legacy header, up to a blank or comment line.
  let inLargeSection = false
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '')
    if (line === LEGACY_LARGE_FILES_HEADER) { inLargeSection = true; continue }
    const rel = inLargeSection ? largeFilePathOf(line) : null
    if (rel === null) { inLargeSection = false; continue }
    try {
      const st = fs.lstatSync(path.join(repoPath, rel))
      if (st.isFile() && st.size > opts.threshold) {
        moved.largeFiles.push(rel)
        removed.add(line)
      }
    } catch { /* not on this computer: someone else's */ }
  }

  if (opts.skills) {
    for (const raw of lines) {
      const line = raw.replace(/\r$/, '')
      if (!SKILL_LINE_RE.test(line) || removed.has(line)) continue
      let isDir = false
      try { isDir = fs.lstatSync(path.join(repoPath, line)).isDirectory() } catch { /* not here */ }
      if (!isDir || await trackedOrOnServer(git, line)) continue
      moved.skills.push(line)
      removed.add(line)
    }
  }

  if (removed.size === 0) return moved
  // Local first: the files stay ignored whatever happens to the shared file next.
  if (moved.largeFiles.length > 0) writeLocalLargeFiles(repoPath, [...readLocalLargeFiles(repoPath), ...moved.largeFiles])
  for (const entry of moved.skills) setLocalPrivateSkill(repoPath, entry, true)
  fs.writeFileSync(gitignorePath, removeSharedLines(lines, removed).join('\n'))
  return moved
}
