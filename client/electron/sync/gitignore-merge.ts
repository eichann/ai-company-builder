// .gitignore files are merged line by line (git's built-in `union` driver)
// instead of by "server wins".
//
// Sync appends lines to .gitignore itself (nested-repo and large-file
// exclusions, the essential patterns). When two members change .gitignore at
// the same time the rebase conflicts on it, and "server wins" threw away the
// member's side — including the lines sync had just added — so the member was
// asked about the same nested repository again at the next sync, and a team
// syncing concurrently did not converge. With `merge=union` both sides' lines
// survive and the file never stops the rebase. Every other file keeps
// "server wins".
//
// The attribute is declared in the repository-local `.git/info/attributes`:
// - it is never committed, so sync does not change the company repository
//   on the member's behalf (a committed .gitattributes would be a change
//   every member pushes and anyone can edit or delete);
// - it does not depend on the member's global git config;
// - it has the highest precedence of all attribute sources, so a committed
//   .gitattributes cannot switch it off by accident;
// - it is read by every merge git runs in this repository — each pick of
//   `pull --rebase` and of every `rebase --continue` — without having to
//   thread a `-c` option through each invocation;
// - a pattern without a slash matches the basename at any depth, so the
//   .gitignore files in department folders (and .personal/) are covered too.
//
// Trade-offs of union:
// - It keeps *both* sides of a conflicting hunk, so a line one side deleted
//   comes back when the other side changed the lines around it. For a
//   .gitignore that means a file stays ignored that someone wanted shared
//   again — nothing is lost, and the line can be removed again. Deletions
//   that do not overlap another change still merge normally.
// - Both sides adding the same line in different places duplicates it.
//   dropUnionDuplicates() removes those copies after the rebase (only the
//   copies the merge added, and only where dropping them cannot change what
//   is ignored).

import fs from 'fs'
import path from 'path'
import type { SimpleGit } from 'simple-git'
import type { SyncLogger } from './types'

export const GITIGNORE_UNION_ATTRIBUTE = '.gitignore merge=union'

/**
 * Declare `.gitignore merge=union` in `<gitDir>/info/attributes` unless it is
 * already there. Returns true when the file was changed.
 */
export function ensureGitignoreUnionMerge(gitDir: string): boolean {
  const file = path.join(gitDir, 'info', 'attributes')
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : ''
  if (current.split(/\r?\n/).some(line => line.trim() === GITIGNORE_UNION_ATTRIBUTE)) return false
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const separator = current === '' || current.endsWith('\n') ? '' : '\n'
  fs.writeFileSync(file, `${current}${separator}# Added by AI Company Builder sync: keep both sides' lines when .gitignore files are merged\n${GITIGNORE_UNION_ATTRIBUTE}\n`)
  return true
}

type Kind = 'blank' | 'comment' | 'negation' | 'pattern'

function kindOf(line: string): Kind {
  if (line.trim() === '') return 'blank'
  if (line.startsWith('#')) return 'comment'
  if (line.startsWith('!')) return 'negation'
  return 'pattern'
}

function countLines(text: string): Map<string, number> {
  const counts = new Map<string, number>()
  for (const line of text.split('\n')) {
    const key = line.replace(/\r$/, '')
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

/**
 * Remove the duplicate lines a union merge of `server` and `local` added to
 * `merged`. A line is dropped only when `merged` holds more copies of it than
 * either side did (duplicates someone wrote on purpose stay), and a pattern
 * only when no line of the opposite kind (a `!` negation for a pattern, a
 * pattern for a negation) lies between it and the copy that is kept — the
 * last matching line decides, so that is exactly when the copy is redundant.
 * Blank lines are left alone.
 */
export function dropUnionDuplicates(merged: string, server: string, local: string): string {
  const serverCounts = countLines(server)
  const localCounts = countLines(local)
  const lines = merged.split('\n')
  const kept: string[] = []
  const keptCount = new Map<string, number>()
  // Index (in `kept`) of the last kept copy of each line.
  const lastKept = new Map<string, number>()
  for (const line of lines) {
    const key = line.replace(/\r$/, '')
    const kind = kindOf(key)
    const allowed = Math.max(serverCounts.get(key) ?? 0, localCounts.get(key) ?? 0)
    const seen = keptCount.get(key) ?? 0
    let drop = kind !== 'blank' && allowed > 0 && seen >= allowed
    if (drop && (kind === 'pattern' || kind === 'negation')) {
      const opposite: Kind = kind === 'pattern' ? 'negation' : 'pattern'
      const from = lastKept.get(key) ?? -1
      for (let i = from + 1; i < kept.length; i++) {
        if (kindOf(kept[i].replace(/\r$/, '')) === opposite) { drop = false; break }
      }
    }
    if (drop) continue
    kept.push(line)
    keptCount.set(key, seen + 1)
    lastKept.set(key, kept.length - 1)
  }
  return kept.join('\n')
}

/**
 * After a rebase replayed local commits onto new server commits, remove the
 * duplicates union merging left in the .gitignore files this sync is about to
 * push, and commit the result. Returns the paths that were tidied.
 */
export async function tidyMergedGitignores(opts: {
  git: SimpleGit
  repoPath: string
  localHash: string
  log: SyncLogger
}): Promise<string[]> {
  const { git, repoPath, localHash, log } = opts
  const head = (await git.revparse(['HEAD'])).trim()
  if (head === localHash) return [] // nothing was replayed, nothing was merged
  const changed = (await git.raw(['diff', '--name-only', '-z', 'origin/main', 'HEAD']))
    .split('\0')
    .filter(f => f === '.gitignore' || f.endsWith('/.gitignore'))
  const blob = (spec: string) => git.raw(['cat-file', '-p', spec]).catch(() => '')
  const tidied: string[] = []
  for (const file of changed) {
    const full = path.join(repoPath, file)
    if (!fs.existsSync(full)) continue // outside the sparse checkout
    const merged = fs.readFileSync(full, 'utf-8')
    if (merged !== (await blob(`HEAD:${file}`))) continue // not the committed merge result
    const result = dropUnionDuplicates(merged, await blob(`origin/main:${file}`), await blob(`${localHash}:${file}`))
    if (result === merged) continue
    fs.writeFileSync(full, result)
    tidied.push(file)
  }
  if (tidied.length > 0) {
    await git.raw(['add', '--sparse', '--', ...tidied])
    await git.commit(`Remove duplicate lines from ${tidied.join(', ')} after merging`)
    log.log('Git sync: Removed duplicate .gitignore lines left by merging:', tidied)
  }
  return tidied
}
