// Sparse checkout exclusions, shared by git:sync's reconcile step and the
// git:sparse* IPC handlers in main.ts.

import fs from 'fs'
import path from 'path'
import type { SimpleGit } from 'simple-git'

// --- Sparse Checkout ---
//
// Model: the user's choice is stored as an EXCLUSION list (folders they opted
// out of), persisted in .git/acb-sparse-config.json (local, never committed).
// The actual sparse cone is always derived as (all root dirs) minus (excluded).
// This makes exclusions survive syncs and makes newly-created folders appear
// automatically — the previous code re-added every DB department on each sync,
// which silently undid the user's exclusions.

export interface SparseConfig {
  /** Top-level folders the user explicitly opted out of syncing locally. */
  excluded: string[]
}

// Persist inside .git/, NOT the worktree. The worktree is exactly what sparse
// checkout reshapes, so a config stored there (e.g. under .workspace/) gets
// deleted the moment `sparse-checkout set` runs without that folder in the
// cone — which silently wiped the config and reset exclusions. .git/ is never
// touched by sparse checkout and is inherently local (not committed/synced),
// which is the right scope for a per-machine exclusion list.
export function sparseConfigPath(repoPath: string): string {
  return path.join(repoPath, '.git', 'acb-sparse-config.json')
}

export function readSparseConfig(repoPath: string): SparseConfig {
  try {
    const raw = fs.readFileSync(sparseConfigPath(repoPath), 'utf-8')
    const parsed = JSON.parse(raw)
    return { excluded: Array.isArray(parsed.excluded) ? parsed.excluded.filter((x: unknown) => typeof x === 'string') : [] }
  } catch {
    return { excluded: [] }
  }
}

export function writeSparseConfig(repoPath: string, cfg: SparseConfig): void {
  const p = sparseConfigPath(repoPath)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2))
}

// List ALL root-level directories in the tree, INCLUDING dotfolders. Cone-mode
// `sparse-checkout set` removes every top-level directory not in its argument
// list, so the cone MUST include dotfolders like .claude (skills!), .agents,
// and .workspace — otherwise enabling sparse checkout would strip them from
// the worktree and break skills. Only the user's excluded departments are
// dropped from the cone.
export async function listAllRootDirs(git: SimpleGit): Promise<string[]> {
  try {
    const raw = await git.raw(['ls-tree', '-d', '--name-only', 'origin/main'])
    return raw.split('\n').filter(Boolean)
  } catch {
    return []
  }
}

// --- Partial clone ---
//
// A member setting up a company for the first time with departments picked
// gets a partial clone (--filter=blob:none, ./first-setup.ts): blobs outside
// the cone were never downloaded, and git fetches them lazily (with the
// app's auth, inherited from createGit's environment) when something needs
// them. Widening the cone is therefore a download, which needs the network.

/** True for a partial clone (origin is a promisor remote). */
export async function isPartialClone(git: SimpleGit): Promise<boolean> {
  return (await git.raw(['config', '--get', 'remote.origin.promisor']).catch(() => '')).trim() === 'true'
}

/** What the member is told when a folder could not be downloaded (offline, server unreachable). */
export const DOWNLOAD_NEEDS_NETWORK_MESSAGE = 'インターネットにつながっているときにダウンロードできます'

/**
 * Whether a git error is a failed download (a lazy fetch or fetch that could
 * not reach the server), as opposed to e.g. a local file problem.
 */
export function isDownloadFailure(message: string): boolean {
  return /from promisor remote|could not fetch|unable to access|could not resolve host|failed to connect|could not read from remote repository|does not appear to be a git repository|connection (refused|timed out|reset)|operation timed out|network is unreachable|authentication failed|could not read username/i.test(message)
}

// Reconcile the on-disk sparse cone to match the persisted exclusion list.
// excluded empty → full checkout (sparse disabled). Otherwise the cone is
// (remote root folders − excluded). Safe: sparse-checkout never deletes data
// from the index/server, only what is materialised in the worktree.
//
// If git fails (in a partial clone: a folder that has to be downloaded while
// offline), the previous exclusion list is written back. `sparse-checkout
// set` / `disable` roll their own patterns back on failure, so config, cone
// and worktree stay as they were and the next sync does not retry a choice
// that was never applied.
export async function applySparseSelection(git: SimpleGit, repoPath: string, excluded: string[]): Promise<void> {
  const cleanExcluded = [...new Set(excluded.filter(Boolean))]
  const configExisted = fs.existsSync(sparseConfigPath(repoPath))
  const previous = readSparseConfig(repoPath)
  writeSparseConfig(repoPath, { excluded: cleanExcluded })
  try {
    await reconcileCone(git, repoPath, cleanExcluded)
  } catch (error) {
    if (configExisted) writeSparseConfig(repoPath, previous)
    else fs.rmSync(sparseConfigPath(repoPath), { force: true })
    throw error
  }
}

async function reconcileCone(git: SimpleGit, repoPath: string, cleanExcluded: string[]): Promise<void> {
  if (cleanExcluded.length === 0) {
    // Nothing excluded → make sure we are on a full checkout.
    const isSparse = (await git.raw(['config', '--get', 'core.sparseCheckout']).catch(() => '')).trim() === 'true'
    if (isSparse) await git.raw(['sparse-checkout', 'disable'])
    return
  }

  const allDirs = await listAllRootDirs(git)
  // Cone = every root directory (dotfolders included) minus the user's
  // excluded departments. If enumeration failed (empty), do NOT touch the
  // worktree — resetting here is what wiped exclusions before.
  if (allDirs.length === 0) {
    console.warn('Git sparse: could not enumerate root dirs; leaving worktree untouched')
    return
  }
  const desired = allDirs.filter(f => !cleanExcluded.includes(f))
  if (desired.length === 0) {
    if (await isPartialClone(git)) {
      // A full checkout of a partial clone downloads every folder — the
      // opposite of excluding them all. Keep just the root files.
      await keepIgnoredOutsideCone(git, repoPath, [], () => git.raw(['sparse-checkout', 'set', '--cone']))
      return
    }
    // User excluded literally everything → fall back to a full checkout.
    await git.raw(['sparse-checkout', 'disable']).catch(() => {})
    writeSparseConfig(repoPath, { excluded: [] })
    return
  }
  // One command, not `init --cone` + `set`: init alone narrows the cone to
  // the root files, and if `set` then failed (a download while offline) the
  // worktree would be left without its folders.
  await keepIgnoredOutsideCone(git, repoPath, desired, () => git.raw(['sparse-checkout', 'set', '--cone', ...desired]))
}

// --- Ignored files outside the cone ---
//
// In cone mode, `sparse-checkout set` deletes every ignored file in a tracked
// directory outside the cone that has no tracked or non-ignored untracked
// file left (documented git behaviour). Sync runs `set` on every press, so a
// member's .personal/ notes, .env files or auto-ignored large files inside an
// excluded department — never on the server, local only — were deleted at
// the next sync, and excluding a department in settings deleted them at once.
// They are moved into .git/ for the duration of the command and put back.

const KEEP_DIR = 'acb-sparse-keep'

function keepPaths(repoPath: string) {
  const root = path.join(repoPath, '.git', KEEP_DIR)
  return { root, files: path.join(root, 'files'), manifest: path.join(root, 'manifest.json') }
}

/** Move kept entries back. Left in place (never deleted) when something now occupies the path. */
function restoreKept(repoPath: string): void {
  const keep = keepPaths(repoPath)
  if (!fs.existsSync(keep.manifest)) return
  let entries: string[] = []
  try { entries = JSON.parse(fs.readFileSync(keep.manifest, 'utf-8')) } catch { return }
  const leftOver: string[] = []
  for (const entry of entries) {
    const src = path.join(keep.files, entry)
    const dest = path.join(repoPath, entry)
    if (!fs.existsSync(src)) continue
    if (fs.existsSync(dest)) {
      console.warn(`Git sparse: ${entry} exists again; the kept copy stays in .git/${KEEP_DIR}/files`)
      leftOver.push(entry)
      continue
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.renameSync(src, dest)
  }
  if (leftOver.length > 0) fs.writeFileSync(keep.manifest, JSON.stringify(leftOver))
  else fs.rmSync(keep.root, { recursive: true, force: true })
}

/**
 * Run a `sparse-checkout set` with the ignored files of every tracked root
 * folder outside `cone` moved out of git's reach, and put them back after.
 */
async function keepIgnoredOutsideCone<T>(git: SimpleGit, repoPath: string, cone: string[], fn: () => Promise<T>): Promise<T> {
  restoreKept(repoPath) // a crash between moving out and back
  const tracked = new Set<string>()
  for (const rev of ['HEAD', 'origin/main']) {
    const raw = await git.raw(['ls-tree', '-d', '-z', '--name-only', rev]).catch(() => '')
    for (const d of raw.split('\0')) if (d) tracked.add(d)
  }
  const outside = [...tracked].filter(d => !cone.includes(d) && fs.existsSync(path.join(repoPath, d)))
  if (outside.length === 0) return fn()
  const raw = await git.raw(['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory', '--',
    ...outside.map(d => `:(literal)${d}/`)])
  // --directory can list a folder and files inside it: move the outermost only.
  const listed = [...new Set(raw.split('\0').filter(Boolean).map(e => e.replace(/\/$/, '')))].sort()
  const entries = listed.filter(e => !listed.some(o => o !== e && e.startsWith(`${o}/`)))
  if (entries.length === 0) return fn()
  const keep = keepPaths(repoPath)
  fs.mkdirSync(keep.files, { recursive: true })
  fs.writeFileSync(keep.manifest, JSON.stringify(entries))
  try {
    for (const entry of entries) {
      const dest = path.join(keep.files, entry)
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.renameSync(path.join(repoPath, entry), dest)
    }
    return await fn()
  } finally {
    restoreKept(repoPath)
  }
}

export type SparseExclusionsResult =
  | { success: true; enabled: boolean; excluded: string[] }
  | { success: false; error: string; offline?: boolean }

/**
 * Settings panel: set the exclusion list and reconcile the worktree. Adding a
 * department to a partial clone downloads it; offline, nothing changes and
 * the member is told it can be downloaded once online.
 */
export async function setSparseExclusions(git: SimpleGit, repoPath: string, excluded: string[]): Promise<SparseExclusionsResult> {
  try {
    await applySparseSelection(git, repoPath, excluded)
    const enabled = (await git.raw(['config', '--get', 'core.sparseCheckout']).catch(() => '')).trim() === 'true'
    return { success: true, enabled, excluded: readSparseConfig(repoPath).excluded }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    if ((await isPartialClone(git)) && isDownloadFailure(msg)) {
      return { success: false, offline: true, error: DOWNLOAD_NEEDS_NETWORK_MESSAGE }
    }
    return { success: false, error: msg }
  }
}
