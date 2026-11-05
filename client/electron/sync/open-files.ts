// Files another app (Excel, Word, PowerPoint, LibreOffice) has open, among the
// paths a teammate changed (sync-guards.md "Files open in another app").
//
// Replacing an open file with the server's version loses work: the app keeps
// its own copy in memory and later saves it over the teammate's version (and
// on Windows Office holds the file, so git cannot replace it at all). The
// owner file the app writes next to it (`~$<name>`, `.~lock.<name>#`,
// client/shared/office-lock-files.ts) is the signal: cheap, the same on Mac and
// Windows, and it needs no process listing. Apps that leave no such file
// (Numbers, Preview, a text editor) are not seen.
//
// A lock file the company repository itself holds unchanged (an older app
// shared a teammate's) is not this computer's app: it does not count.

import fs from 'fs'
import path from 'path'
import type { SimpleGit } from 'simple-git'
import { lockNameKey, lockNamesFor } from '../../shared/office-lock-files'

/** Lock files in `dir` (names), keyed the way the disk compares them. */
function lockFilesIn(dir: string): Map<string, string> {
  const out = new Map<string, string>()
  let names: string[]
  try { names = fs.readdirSync(dir) } catch { return out }
  for (const name of names) {
    if (name.startsWith('~$') || name.startsWith('.~lock.')) out.set(lockNameKey(name), name)
  }
  return out
}

/** Lock files git has, unchanged: someone else's, shared by an older app. */
async function sharedUnchanged(git: SimpleGit, locks: string[]): Promise<Set<string>> {
  if (locks.length === 0) return new Set()
  const specs = locks.map(l => `:(literal)${l}`)
  // A failed answer counts every lock as this computer's (the safe side: the update waits).
  const tracked = (await git.raw(['ls-files', '-z', '--', ...specs]).catch(() => '')).split('\0').filter(Boolean)
  if (tracked.length === 0) return new Set()
  const changed = (await git.raw(['diff', '--name-only', '-z', '--no-renames', 'HEAD', '--', ...tracked.map(l => `:(literal)${l}`)]).catch(() => null))
  if (changed === null) return new Set()
  const changedSet = new Set(changed.split('\0').filter(Boolean))
  return new Set(tracked.filter(l => !changedSet.has(l)))
}

/**
 * The paths (repository-relative, as given) that have an office lock file
 * next to them on this computer. Reads only the folders of the given paths.
 */
export async function openFilesAmong(git: SimpleGit, repoPath: string, paths: readonly string[]): Promise<string[]> {
  const byDir = new Map<string, string[]>()
  for (const p of paths) {
    const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''
    const list = byDir.get(dir)
    if (list) list.push(p)
    else byDir.set(dir, [p])
  }
  const candidates: Array<{ file: string; lock: string }> = []
  for (const [dir, files] of byDir) {
    const locks = lockFilesIn(path.join(repoPath, ...dir.split('/').filter(Boolean)))
    if (locks.size === 0) continue
    for (const file of files) {
      const name = file.slice(file.lastIndexOf('/') + 1)
      for (const lockName of lockNamesFor(name)) {
        const found = locks.get(lockNameKey(lockName))
        if (found) {
          candidates.push({ file, lock: dir ? `${dir}/${found}` : found })
          break
        }
      }
    }
  }
  if (candidates.length === 0) return []
  const notOurs = await sharedUnchanged(git, [...new Set(candidates.map(c => c.lock))])
  return [...new Set(candidates.filter(c => !notOurs.has(c.lock)).map(c => c.file))]
}

/** The list shown to the member (at most 10 names). */
export function openFilesList(files: readonly string[]): string {
  return files.length <= 10 ? files.join('\n') : `${files.slice(0, 10).join('\n')}\n... 他 ${files.length - 10} ファイル`
}

/** A sync that stopped so an open file is not replaced. Starts like every stop the member chose (「同期を中止しました」). */
export function openFilesStoppedMessage(files: readonly string[]): string {
  return `同期を中止しました。ほかの人が変更したファイルを、Excel などのアプリで開いたままにしているため、最新の内容に置き換えませんでした。ファイルを閉じてから、もう一度同期してください。変更はこのPCに残っています。\n\n${openFilesList(files)}`
}
