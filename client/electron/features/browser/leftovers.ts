// A site's login is kept on disk only as a kept login (agent-browser.md "Keeping a login on disk":
// `acb-browser-keep-<u>-<c>-<h>`, `kept-logins.ts`). Any other `acb-browser-*` folder under
// <userData>/Partitions — a `persist:` session of an earlier build, of a later one rolled back, or a name
// that is not exactly a kept login's — is removed at start, before any browser session exists. A kept
// login's folder stays: whose it is and whether it may stay is decided by the policy answers, the
// sign-in and the AI turns (`controller.ts`), from the disk.
import fs from 'node:fs'
import path from 'node:path'
import { KEPT_LOGIN_FOLDER_RE } from './kept-logins'

/** The folder names browser sessions get on disk (Electron names a `persist:<name>` partition's folder `<name>`). */
export const BROWSER_PARTITION_FOLDER_RE = /^acb-browser-/i

/** Removes every browser session folder under <userData>/Partitions but kept logins; returns how many. Never follows a link. */
export function removeLeftoverBrowserPartitions(userDataDir: string, log: Pick<Console, 'warn'> = console): number {
  const dir = path.join(userDataDir, 'Partitions')
  let names: string[]
  try { names = fs.readdirSync(dir) } catch { return 0 }
  let removed = 0
  for (const name of names) {
    if (!BROWSER_PARTITION_FOLDER_RE.test(name) || KEPT_LOGIN_FOLDER_RE.test(name)) continue
    const target = path.join(dir, name)
    try {
      if (!fs.lstatSync(target).isDirectory()) continue
      fs.rmSync(target, { recursive: true, force: true })
      removed++
    } catch (error) {
      log.warn(`[browser] a stored browser session could not be removed (${error instanceof Error ? error.message : 'unknown'})`)
    }
  }
  return removed
}
