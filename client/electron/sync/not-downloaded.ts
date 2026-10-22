// Which folders of a company checkout are not downloaded right now — read
// straight from the files under .git/ (no git process), so the app's file
// operations and the chat write guard can ask on every write.
//
// "Not downloaded" = in the member's exclusion list (.git/acb-sparse-config.json)
// AND excluded by the applied sparse patterns (.git/info/sparse-checkout, with
// core.sparseCheckout on) — the same answer as appliedExclusions() in
// ./sparse.ts, which sync uses. A repository still on the old cone mode
// (before its first reconcile) is read the old way: excluded root folders
// that are not in the cone.

import fs from 'fs'
import path from 'path'
import { normalizeExclusions, parseSparsePatterns, pathKey } from '../../shared/sparse-paths'

interface Cached { stamp: string; folders: string[] }
const cache = new Map<string, Cached>()

function mtime(p: string): string {
  try { return String(fs.statSync(p).mtimeMs) } catch { return '-' }
}

/**
 * core.<key> from the repository's config files, the last one winning as in
 * git (plain `key = true` lines; enough for what git itself writes).
 * `sparse-checkout` writes its settings to config.worktree (it turns on
 * extensions.worktreeConfig), older versions to config.
 */
function coreFlag(configText: string, key: string): boolean {
  let inCore = false
  let value = false
  for (const raw of configText.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('[')) { inCore = /^\[core\]$/i.test(line); continue }
    if (!inCore) continue
    const m = /^([A-Za-z]+)\s*=\s*(\S+)/.exec(line)
    if (m && m[1].toLowerCase() === key.toLowerCase()) value = m[2].toLowerCase() === 'true'
  }
  return value
}

/** Root folders a cone-mode pattern file includes (`/dir/` lines). */
function coneRoots(text: string): string[] {
  return text.split('\n').map(l => /^\/([^/*!][^/]*)\/$/.exec(l.trim())?.[1]).filter((x): x is string => !!x)
}

/** The folders (repository-relative) not downloaded in the checkout at `repoPath`. */
export function notDownloadedFolders(repoPath: string): string[] {
  const gitDir = path.join(repoPath, '.git')
  const files = [path.join(gitDir, 'acb-sparse-config.json'), path.join(gitDir, 'info', 'sparse-checkout'), path.join(gitDir, 'config'), path.join(gitDir, 'config.worktree')]
  const stamp = files.map(mtime).join('|')
  const hit = cache.get(repoPath)
  if (hit && hit.stamp === stamp) return hit.folders
  let folders: string[] = []
  try {
    const parsed = JSON.parse(fs.readFileSync(files[0], 'utf-8'))
    const excluded = normalizeExclusions(Array.isArray(parsed.excluded) ? parsed.excluded.filter((x: unknown) => typeof x === 'string') : [])
    let config = fs.readFileSync(files[2], 'utf-8')
    try { config += `\n${fs.readFileSync(files[3], 'utf-8')}` } catch { /* no worktree config */ }
    if (excluded.length > 0 && coreFlag(config, 'sparseCheckout')) {
      const patterns = fs.readFileSync(files[1], 'utf-8')
      if (coreFlag(config, 'sparseCheckoutCone')) {
        const cone = coneRoots(patterns)
        folders = excluded.filter(f => !f.includes('/') && !cone.includes(f))
      } else {
        const applied = new Set((parseSparsePatterns(patterns) ?? []).map(pathKey))
        folders = excluded.filter(e => applied.has(pathKey(e)))
      }
    }
  } catch {
    folders = []
  }
  cache.set(repoPath, { stamp, folders })
  return folders
}

/**
 * The company checkout containing `absPath`: the nearest ancestor (or the
 * path itself) with a .git directory that has a sparse config. null when
 * there is none (nothing is excluded anywhere above).
 */
export function checkoutRootOf(absPath: string): string | null {
  let dir = path.resolve(absPath)
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git', 'acb-sparse-config.json'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * The not-downloaded folder an absolute path lies in (repository-relative,
 * '/'-separated), or null. Used by the app's file operations.
 */
export function notDownloadedFolderFor(absPath: string): string | null {
  const root = checkoutRootOf(path.dirname(path.resolve(absPath)))
  if (!root) return null
  const folders = notDownloadedFolders(root)
  if (folders.length === 0) return null
  const rel = path.relative(root, path.resolve(absPath)).split(path.sep).join('/')
  if (!rel || rel.startsWith('..')) return null
  const key = pathKey(rel)
  return folders.find(f => key === pathKey(f) || key.startsWith(`${pathKey(f)}/`)) ?? null
}
