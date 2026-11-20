// A site's login is never kept on disk (agent-browser.md "The app's window"). A `persist:` browser
// session of an earlier build (or of a later one rolled back) left its cookies under
// <userData>/Partitions/acb-browser-*: removed at start, before any browser session exists.
import fs from 'node:fs'
import path from 'node:path'

/** The folder names browser sessions get on disk (Electron names a `persist:<name>` partition's folder `<name>`). */
export const BROWSER_PARTITION_FOLDER_RE = /^acb-browser-/i

/** Removes every browser session folder under <userData>/Partitions; returns how many. Never follows a link. */
export function removeLeftoverBrowserPartitions(userDataDir: string, log: Pick<Console, 'warn'> = console): number {
  const dir = path.join(userDataDir, 'Partitions')
  let names: string[]
  try { names = fs.readdirSync(dir) } catch { return 0 }
  let removed = 0
  for (const name of names) {
    if (!BROWSER_PARTITION_FOLDER_RE.test(name)) continue
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
