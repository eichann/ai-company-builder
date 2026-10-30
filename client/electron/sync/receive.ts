// 「自動で受け取る」: bring teammates' changes into one repository without
// committing, pushing or moving anything of the member's (.claude/rules/sync.md
// "Automatic sync").
//
// Only a fast-forward to origin/main, and only when nothing the member has
// touches what teammates changed:
// - no rebase / merge / cherry-pick / other git process in progress;
// - no unpushed commits (HEAD must be an ancestor of origin/main);
// - no changed path is also changed locally (edited, staged, deleted, new);
// - no path the server adds already exists on disk (an ignored file, a
//   private folder's clone, an excluded nested repository, a file in a
//   not-downloaded folder): git would overwrite ignored files silently;
// - no changed path in a not-downloaded folder exists on disk.
// Otherwise the repository is held back unchanged and the next manual sync
// (with its backups and questions) handles it. `merge --ff-only` itself
// refuses atomically to overwrite local changes, a second line behind these.

import fs from 'fs'
import path from 'path'
import type { SimpleGit } from 'simple-git'
import { isNotDownloaded, pathKey } from '../../shared/sparse-paths'
import { previewChanges } from './preview'
import { appliedExclusions } from './sparse'
import type { SyncLogger } from './types'

export type HeldBackReason = 'repository-busy' | 'unpushed' | 'local-changes' | 'in-the-way' | 'refused'

export type RepoReceiveOutcome =
  | { kind: 'up-to-date' }
  | { kind: 'received'; files: number }
  | { kind: 'held-back'; reason: HeldBackReason }
  | { kind: 'offline' }

/** `git diff --name-status -z --no-renames` → [status letter, path] pairs. */
export function parseNameStatus(raw: string): Array<{ status: string; path: string }> {
  const parts = raw.split('\0')
  const out: Array<{ status: string; path: string }> = []
  for (let i = 0; i + 1 < parts.length; i += 2) {
    if (!parts[i]) break
    out.push({ status: parts[i][0], path: parts[i + 1] })
  }
  return out
}

function lstatOrNull(p: string): fs.Stats | null {
  try { return fs.lstatSync(p) } catch { return null }
}

/** The path, or a folder on its way that is a file or link on disk, is in the way of a new server file. */
function inTheWay(repoPath: string, rel: string): boolean {
  if (lstatOrNull(path.join(repoPath, ...rel.split('/')))) return true
  const segments = rel.split('/')
  for (let i = 1; i < segments.length; i++) {
    const st = lstatOrNull(path.join(repoPath, ...segments.slice(0, i)))
    if (!st) return false
    if (!st.isDirectory() || st.isSymbolicLink()) return true
  }
  return false
}

export async function receiveIntoRepo(git: SimpleGit, repoPath: string, log: SyncLogger): Promise<RepoReceiveOutcome> {
  const gitDir = path.join(repoPath, '.git')
  for (const marker of ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'index.lock']) {
    if (fs.existsSync(path.join(gitDir, marker))) return { kind: 'held-back', reason: 'repository-busy' }
  }

  try {
    await git.fetch(['--progress', 'origin'])
  } catch (fetchError) {
    log.warn('Auto receive: fetch failed (may be offline):', fetchError instanceof Error ? fetchError.message : fetchError)
    return { kind: 'offline' }
  }

  const upstream = (await git.raw(['rev-parse', '--verify', '--quiet', 'origin/main']).catch(() => '')).trim()
  if (!upstream) return { kind: 'up-to-date' }
  const head = (await git.raw(['rev-parse', '--verify', '--quiet', 'HEAD']).catch(() => '')).trim()
  if (!head) return { kind: 'held-back', reason: 'repository-busy' }
  if (head === upstream) return { kind: 'up-to-date' }
  // Hashes, not exit codes: simple-git does not reject a silent non-zero exit (--is-ancestor).
  const mergeBase = (await git.raw(['merge-base', head, upstream]).catch(() => '')).trim()
  if (mergeBase === upstream) return { kind: 'up-to-date' }
  if (mergeBase !== head) return { kind: 'held-back', reason: 'unpushed' }

  // Trees only: in a partial clone this downloads no file contents.
  const changes = parseNameStatus(await git.raw(['diff', '--name-status', '-z', '--no-renames', head, upstream]))
  if (changes.length === 0) return { kind: 'up-to-date' }

  const local = await previewChanges(git)
  const localKeys = new Set([...local.added, ...local.modified, ...local.deleted].map(pathKey))
  const notDownloaded = await appliedExclusions(git, repoPath).catch(() => [] as string[])
  for (const change of changes) {
    if (localKeys.has(pathKey(change.path))) return { kind: 'held-back', reason: 'local-changes' }
    if (change.status === 'A' && inTheWay(repoPath, change.path)) return { kind: 'held-back', reason: 'in-the-way' }
    if (isNotDownloaded(notDownloaded, change.path) && lstatOrNull(path.join(repoPath, ...change.path.split('/')))) {
      return { kind: 'held-back', reason: 'in-the-way' }
    }
  }

  try {
    await git.raw(['merge', '--ff-only', '--no-edit', upstream])
  } catch (mergeError) {
    // git checks every path before writing any: nothing changed.
    log.warn('Auto receive: fast-forward refused:', mergeError instanceof Error ? mergeError.message : mergeError)
    return { kind: 'held-back', reason: 'refused' }
  }
  return { kind: 'received', files: changes.length }
}
