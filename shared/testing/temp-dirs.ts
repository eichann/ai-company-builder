/**
 * Temporary folders for tests and test harnesses (client, server, sync / IPC harnesses).
 *
 * 2026-11-28: tests that were killed, timed out or failed left ~8,500 `acb-*` folders (50 GB+, Chromium profiles
 * of the real-Electron tests among them) in the system temp folder and the development Mac ran out of disk. So:
 *
 * - `makeTempDir(prefix)` makes the folder and removes it when the process ends — normally, after a failure or an
 *   uncaught exception (`exit`), or on SIGINT / SIGTERM / SIGHUP (e.g. `pkill`), then re-raises the signal.
 * - Only SIGKILL (and a crash of the machine) can still leave one: the first `makeTempDir` of a prefix in a process
 *   first removes that prefix's folders older than `STALE_TEMP_DIR_MS` (another test run that is still going is
 *   younger than that, so it is never touched).
 *
 * Tests still remove their folders as soon as they are done (`after` / `t.after` / `finally`); this is the net
 * under that. Uses Node only (not `shared/core`, which depends on nothing). Rule: `.claude/rules/testing.md`
 * "Temporary folders".
 */
import type { ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Every test folder's name starts with this, so a person (or a sweep) can tell them apart. */
export const TEST_TEMP_DIR_START = 'acb-'
/** Folders of a prefix older than this are an earlier run's leftovers (no test runs this long). */
export const STALE_TEMP_DIR_MS = 6 * 60 * 60 * 1000

/** What mkdtemp adds to the prefix: exactly six letters or digits. */
const MKDTEMP_SUFFIX = /^[A-Za-z0-9]{6}$/

function checkPrefix(prefix: string): void {
  if (!prefix.startsWith(TEST_TEMP_DIR_START) || prefix.length <= TEST_TEMP_DIR_START.length || /[/\\]/.test(prefix)) {
    throw new Error(`a test temp folder's prefix must start with "${TEST_TEMP_DIR_START}" and name no folder: ${prefix}`)
  }
}

/**
 * Remove the folders `<root>/<prefix>XXXXXX` (exactly mkdtemp's shape: a longer prefix that starts the same is
 * another test's) whose last change is older than `maxAgeMs`. Only real folders: a symbolic link of that name is
 * left alone and never followed (and `rmSync` removes links inside a folder, never their targets). Never throws:
 * a folder that cannot be read or removed is skipped. Returns the names removed.
 */
export function sweepStaleTempDirs(prefix: string, options: { root?: string; now?: number; maxAgeMs?: number } = {}): string[] {
  checkPrefix(prefix)
  const root = options.root ?? os.tmpdir()
  const cutoff = (options.now ?? Date.now()) - (options.maxAgeMs ?? STALE_TEMP_DIR_MS)
  let names: string[]
  try { names = fs.readdirSync(root) } catch { return [] }
  const removed: string[] = []
  for (const name of names) {
    if (!name.startsWith(prefix) || !MKDTEMP_SUFFIX.test(name.slice(prefix.length))) continue
    const full = path.join(root, name)
    try {
      const stat = fs.lstatSync(full)
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue
      if (stat.mtimeMs >= cutoff) continue
      fs.rmSync(full, { recursive: true, force: true })
      removed.push(name)
    } catch { /* gone meanwhile, or not ours to remove: leave it */ }
  }
  return removed
}

const live = new Set<string>()
const children = new Set<ChildProcess>()
const swept = new Set<string>()
let hooked = false

function removeLive(): void {
  // A child still writing in a folder (an Electron harness's Chromium profile) is stopped before its folder goes.
  for (const child of children) {
    try { child.kill('SIGKILL') } catch { /* already gone */ }
  }
  children.clear()
  for (const dir of live) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best effort at exit */ }
  }
  live.clear()
}

function hookProcessEnd(): void {
  if (hooked) return
  hooked = true
  process.on('exit', removeLive)
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    const onSignal = () => {
      removeLive()
      // Ours was the only listener: do what the signal would have done without us.
      process.removeListener(signal, onSignal)
      if (process.listenerCount(signal) === 0) process.kill(process.pid, signal)
    }
    process.on(signal, onSignal)
  }
}

/**
 * A new empty folder `<tmp>/<prefix>XXXXXX`, removed when this process ends (see the top). `keep` (a harness's
 * "keep it to look at" switch) leaves it for the person — the stale sweep still removes it after six hours.
 */
export function makeTempDir(prefix: string, options: { root?: string; keep?: boolean } = {}): string {
  checkPrefix(prefix)
  const root = options.root ?? os.tmpdir()
  const key = `${root}\0${prefix}`
  if (!swept.has(key)) {
    swept.add(key)
    sweepStaleTempDirs(prefix, { root })
  }
  const dir = fs.mkdtempSync(path.join(root, prefix))
  if (!options.keep) {
    live.add(dir)
    hookProcessEnd()
  }
  return dir
}

/**
 * A child process that writes in a temp folder (a real-Electron harness): if this process ends while the child still
 * runs (a failure, an uncaught exception, SIGINT / SIGTERM), the child is killed before the folders are removed, so it
 * does not write them again. On a timeout the test itself kills it and waits for its `close` before failing.
 */
export function stopWithTempDirs(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return
  children.add(child)
  hookProcessEnd()
  child.once('exit', () => children.delete(child))
}

/** Remove a folder from `makeTempDir` now (also fine for one already gone). */
export function removeTempDir(dir: string): void {
  live.delete(dir)
  fs.rmSync(dir, { recursive: true, force: true })
}
