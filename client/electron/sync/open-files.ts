// Files another app (Excel, Word, PowerPoint, LibreOffice) has open, among the
// paths a teammate changed (sync-guards.md "Files open in another app").
//
// Replacing an open file with the server's version loses work: the app keeps
// its own copy in memory and later saves it over the teammate's version (and
// on Windows Office holds the file, so git cannot replace it at all). The
// owner file the app writes next to it (`~$<name>`, `.~lock.<name>#`,
// client/shared/office-lock-files.ts) is the signal: cheap, the same on Mac and
// Windows. Apps that leave no such file (Numbers, Preview, a text editor) are
// not seen.
//
// What does not count:
// - a lock file the repository holds unchanged (an older app shared a
//   teammate's);
// - a stale lock, left by a crash: written before this computer last started,
//   no Office / LibreOffice app running (Mac, `OfficeLockProbe.appsRunning`),
//   or, on Windows, an Office document no app holds (it opens for writing).
//   Only what proves the app is gone: a document can stay open for days, so
//   age alone never makes a lock stale.

import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFile } from 'child_process'
import type { SimpleGit } from 'simple-git'
import { isOfficeLockFile, lockNameKey, lockNamesFor } from '../../shared/office-lock-files'
import type { SyncLogger } from './types'

/** How sync tells a live lock from one a crash left. Every answer may be "unknown" (null): the lock then counts. */
export interface OfficeLockProbe {
  /** false: no Office / LibreOffice app runs on this computer. */
  appsRunning(): Promise<boolean | null>
  /** true: no app holds this file (it opens for writing). Windows only; elsewhere null. */
  targetFree(absPath: string): boolean | null
  /** When this computer last started (ms since the epoch). */
  bootTimeMs(): number
}

/** Boot time only: what sync can always know. The app wires `systemLockProbe`. */
export const BOOT_TIME_ONLY_PROBE: OfficeLockProbe = {
  appsRunning: async () => null,
  targetFree: () => null,
  bootTimeMs: () => Date.now() - os.uptime() * 1000,
}

/** Is one of the office apps among `ps -A -o comm=` lines? */
export function officeAppIn(psOutput: string): boolean {
  return psOutput.split('\n').some(line => /(^|\/)(Microsoft (Excel|Word|PowerPoint)|soffice(\.bin)?|LibreOffice)\s*$/.test(line.trim()))
}

/** The probe for this computer: the process list on a Mac, the file's own lock on Windows. */
export function systemLockProbe(platform: NodeJS.Platform): OfficeLockProbe {
  return {
    bootTimeMs: BOOT_TIME_ONLY_PROBE.bootTimeMs,
    appsRunning: () => platform !== 'darwin'
      ? Promise.resolve(null)
      : new Promise(resolve => {
        execFile('ps', ['-A', '-o', 'comm='], { timeout: 3000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
          resolve(error ? null : officeAppIn(String(stdout)))
        })
      }),
    targetFree: absPath => {
      if (platform !== 'win32') return null
      try {
        // r+ asks for write access: Office opens a document denying it to others.
        fs.closeSync(fs.openSync(absPath, 'r+'))
        return true
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' ? false : null
      }
    },
  }
}

export interface OpenFile {
  /** Repository-relative path of the open file (as given). */
  file: string
  /** Repository-relative path of its lock file. */
  lock: string
}

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

const abs = (repoPath: string, rel: string) => path.join(repoPath, ...rel.split('/').filter(Boolean))

/**
 * The paths (repository-relative, as given) that have a live office lock file
 * next to them on this computer, with that lock. Reads only the folders of
 * the given paths.
 */
export async function findOpenFiles(git: SimpleGit, repoPath: string, paths: readonly string[], probe: OfficeLockProbe = BOOT_TIME_ONLY_PROBE): Promise<OpenFile[]> {
  const byDir = new Map<string, string[]>()
  for (const p of paths) {
    const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''
    const list = byDir.get(dir)
    if (list) list.push(p)
    else byDir.set(dir, [p])
  }
  const candidates: OpenFile[] = []
  for (const [dir, files] of byDir) {
    const locks = lockFilesIn(abs(repoPath, dir))
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
  const bootTime = probe.bootTimeMs()
  const live = candidates.filter(c => {
    if (notOurs.has(c.lock)) return false
    let mtime: number
    try { mtime = fs.lstatSync(abs(repoPath, c.lock)).mtimeMs } catch { return false }
    if (mtime < bootTime) return false
    // Windows: Office holds its document; LibreOffice may not, so its lock is not judged this way.
    if (path.basename(c.lock).startsWith('~$') && probe.targetFree(abs(repoPath, c.file)) === true) return false
    return true
  })
  if (live.length === 0) return []
  if (await probe.appsRunning() === false) return []
  const seen = new Set<string>()
  return live.filter(c => !seen.has(c.file) && seen.add(c.file))
}

/** The open files' paths only. */
export async function openFilesAmong(git: SimpleGit, repoPath: string, paths: readonly string[], probe?: OfficeLockProbe): Promise<string[]> {
  return (await findOpenFiles(git, repoPath, paths, probe)).map(o => o.file)
}

/**
 * The member said these files are closed (「閉じたので続ける」): their lock
 * files, left by a crash, go, so the same question does not come back at
 * every sync. Only office lock names, only while still there; one that
 * cannot be removed (an app still holds it) stays.
 */
export function removeLockFiles(repoPath: string, open: readonly OpenFile[], log: SyncLogger): void {
  for (const { lock } of open) {
    if (!isOfficeLockFile(lock)) continue
    try {
      fs.unlinkSync(abs(repoPath, lock))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log.warn('Git sync: Could not remove an office lock file:', (error as NodeJS.ErrnoException).code)
    }
  }
}

/** The list shown to the member (at most 10 names). */
export function openFilesList(files: readonly string[]): string {
  return files.length <= 10 ? files.join('\n') : `${files.slice(0, 10).join('\n')}\n... 他 ${files.length - 10} ファイル`
}

/** A sync that stopped so an open file is not replaced. Starts like every stop the member chose (「同期を中止しました」). */
export function openFilesStoppedMessage(files: readonly string[]): string {
  return `同期を中止しました。ほかの人が変更したファイルを、Excel などのアプリで開いたままにしているため、最新の内容に置き換えませんでした。ファイルを閉じてから、もう一度同期してください。変更はこのPCに残っています。\n\n${openFilesList(files)}`
}
