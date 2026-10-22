// Sparse checkout exclusions, shared by git:sync's reconcile step, first
// setup and the git:sparse* IPC handlers in main.ts.

import fs from 'fs'
import path from 'path'
import type { SimpleGit } from 'simple-git'
import { normalizeExclusions, parseSparsePatterns, pathKey, sparsePatterns } from '../../shared/sparse-paths'
import { ensurePromisorConfig } from './remote'

// --- Sparse Checkout ---
//
// Model: the member's choice is stored as an EXCLUSION list — folders they
// opted out of downloading, at any depth ('営業部', 'コンテンツ/動画') —
// persisted in .git/acb-sparse-config.json (local, never committed).
// Everything else is downloaded: the sparse checkout is NON-CONE, `/*` plus
// one `!/<folder>/` per exclusion (../../shared/sparse-paths.ts), so a folder
// a teammate creates later downloads automatically wherever it is, and a
// folder the member creates is always inside the checkout. Cone mode cannot
// say "everything except コンテンツ/動画" without listing every sibling at
// every level, a list that goes stale the moment a teammate adds a folder.
//
// Existing members were on cone mode with department-level exclusions. The
// same list as non-cone patterns selects exactly the same files, so the
// first reconcile switches the mode without downloading or deleting anything.

export interface SparseConfig {
  /** Folders (repository-relative, any depth) the member opted out of downloading. */
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
    return { excluded: Array.isArray(parsed.excluded) ? normalizeExclusions(parsed.excluded.filter((x: unknown) => typeof x === 'string')) : [] }
  } catch {
    return { excluded: [] }
  }
}

export function writeSparseConfig(repoPath: string, cfg: SparseConfig): void {
  const p = sparseConfigPath(repoPath)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify({ excluded: normalizeExclusions(cfg.excluded) }, null, 2))
}

/** The sparse-checkout pattern file git reads. */
function sparseFilePath(repoPath: string): string {
  return path.join(repoPath, '.git', 'info', 'sparse-checkout')
}

async function configFlag(git: SimpleGit, key: string): Promise<boolean> {
  return (await git.raw(['config', '--get', key]).catch(() => '')).trim() === 'true'
}

/**
 * The folders that are not checked out right now: in the persisted
 * exclusion list AND excluded by the applied sparse patterns. Both, so a
 * reconcile that failed (config rolled back) or a full checkout never counts
 * as "not downloaded". A repository still on the old cone mode (department
 * exclusions, before its first reconcile) is read the old way: root folders
 * of the list that are not in the cone.
 */
export async function appliedExclusions(git: SimpleGit, repoPath: string): Promise<string[]> {
  const excluded = readSparseConfig(repoPath).excluded
  if (excluded.length === 0) return []
  if (!(await configFlag(git, 'core.sparseCheckout'))) return []
  if (await configFlag(git, 'core.sparseCheckoutCone')) {
    const cone = (await git.raw(['sparse-checkout', 'list']).catch(() => '')).split('\n').map(l => l.trim()).filter(Boolean)
    return excluded.filter(f => !f.includes('/') && !cone.includes(f))
  }
  let applied: string[] | null = null
  try { applied = parseSparsePatterns(fs.readFileSync(sparseFilePath(repoPath), 'utf-8')) } catch { /* no file */ }
  if (!applied) return []
  const appliedKeys = new Set(applied.map(pathKey))
  return excluded.filter(e => appliedKeys.has(pathKey(e)))
}

// List ALL root-level directories in the tree, INCLUDING dotfolders (first
// setup tells the departments apart from what the whole company shares).
export async function listAllRootDirs(git: SimpleGit): Promise<string[]> {
  try {
    const raw = await git.raw(['ls-tree', '-d', '--name-only', 'origin/main'])
    return raw.split('\n').filter(Boolean)
  } catch {
    return []
  }
}

/**
 * Exclusions whose folder exists neither on the server's main nor in HEAD
 * (a teammate deleted or renamed it). Sync's reconcile drops them: an
 * exclusion of a path nobody has would otherwise hold back — and block
 * writes to — a folder the member creates there later. null when no tree
 * could be read (then nothing is dropped).
 */
export async function staleExclusions(git: SimpleGit, excluded: string[]): Promise<string[] | null> {
  if (excluded.length === 0) return []
  const dirs = new Set<string>()
  let readAny = false
  for (const rev of ['origin/main', 'HEAD']) {
    try {
      const raw = await git.raw(['ls-tree', '-r', '-d', '-z', '--name-only', rev])
      readAny = true
      for (const d of raw.split('\0')) if (d) dirs.add(pathKey(d))
    } catch { /* unborn HEAD, no origin/main */ }
  }
  if (!readAny) return null
  return excluded.filter(e => !dirs.has(pathKey(e)))
}

// --- Partial clone ---
//
// A member setting up a company for the first time with departments picked
// gets a partial clone (--filter=blob:none, ./first-setup.ts): blobs outside
// the checkout were never downloaded, and git fetches them lazily (with the
// app's auth, inherited from createGit's environment) when something needs
// them. Downloading a folder is therefore a download, which needs the network.

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

// Reconcile the on-disk sparse checkout to the persisted exclusion list.
// excluded empty → full checkout (sparse disabled). Otherwise the non-cone
// patterns `/*` + `!/<folder>/`. Safe: sparse-checkout never deletes data
// from the index/server, only what is materialised in the worktree, and it
// leaves files with local changes in place.
//
// If git fails (in a partial clone: a folder that has to be downloaded while
// offline), the previous exclusion list is written back. `sparse-checkout
// set` / `disable` roll their own patterns back on failure, so config,
// patterns and worktree stay as they were and the next sync does not retry a
// choice that was never applied.
export async function applySparseSelection(git: SimpleGit, repoPath: string, excluded: string[]): Promise<void> {
  // Downloading a folder in a partial clone needs origin to be a promisor
  // remote: repair a clone that lost the config (./remote.ts).
  await ensurePromisorConfig(git).catch(e => console.warn('Git sparse: promisor config check failed:', e))
  const cleanExcluded = normalizeExclusions(excluded)
  const configExisted = fs.existsSync(sparseConfigPath(repoPath))
  const previous = readSparseConfig(repoPath)
  writeSparseConfig(repoPath, { excluded: cleanExcluded })
  try {
    await reconcilePatterns(git, repoPath, cleanExcluded)
  } catch (error) {
    if (configExisted) writeSparseConfig(repoPath, previous)
    else fs.rmSync(sparseConfigPath(repoPath), { force: true })
    throw error
  }
}

async function reconcilePatterns(git: SimpleGit, repoPath: string, cleanExcluded: string[]): Promise<void> {
  if (cleanExcluded.length === 0) {
    // Nothing excluded → make sure we are on a full checkout.
    if (await configFlag(git, 'core.sparseCheckout')) {
      restoreKept(repoPath) // a crash between moving out and back
      await git.raw(['sparse-checkout', 'disable'])
    }
    return
  }
  // One command (never `init` + `set`): a failed `set` rolls its own
  // patterns back, so the worktree is never left half-narrowed. `--no-cone`
  // also switches a repository still on the old cone mode (migration): the
  // same department list selects the same files, nothing is downloaded or
  // removed.
  await keepIgnoredInExcluded(git, repoPath, cleanExcluded,
    () => git.raw(['sparse-checkout', 'set', '--no-cone', ...sparsePatterns(cleanExcluded)]))
}

// --- Ignored files in excluded folders ---
//
// In cone mode, `sparse-checkout set` deletes every ignored file in a tracked
// directory that leaves the cone (documented git behaviour): a member's
// .personal/ notes, .env files or auto-ignored large files inside an
// excluded department — local only, never on the server — were deleted at
// every sync. Non-cone patterns do not do that (the clean-up is cone-only),
// but a git that behaves differently still could, so for the duration of
// every `set` the ignored files inside the excluded folders are moved into
// .git/ and put back.

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
 * Run a `sparse-checkout set` with the ignored files inside every folder it
 * leaves excluded moved out of git's reach, and put them back after — also
 * when the command fails. (Folders that become downloaded lose nothing.)
 */
async function keepIgnoredInExcluded<T>(git: SimpleGit, repoPath: string, excluded: string[], fn: () => Promise<T>): Promise<T> {
  restoreKept(repoPath) // a crash between moving out and back
  const present = excluded.filter(d => fs.existsSync(path.join(repoPath, d)))
  if (present.length === 0) return fn()
  const args = ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--', ...present.map(d => `:(literal)${d}/`)]
  let raw: string
  try {
    raw = await git.raw([...args.slice(0, 5), '--directory', ...args.slice(5)])
  } catch (error) {
    // git refuses `--directory` with a pathspec below a folder that is
    // ignored as a whole ("directory entry not superset of prefix"; e.g. a
    // department excluded as a nested repository, found by the soak): list
    // the files one by one instead, and if even that fails go on without —
    // non-cone patterns do not delete ignored files.
    raw = await git.raw(args).catch(() => {
      console.warn('Git sparse: could not list ignored files in excluded folders:', error)
      return ''
    })
  }
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

/**
 * Files inside `folders` with changes that are not committed yet (edited,
 * new, deleted), sorted. Excluding such a folder does not lose them — git
 * leaves an edited or new file on disk and the next sync moves it to
 * .backups/<ts>_outside_checkout/ (./outside-checkout.ts) — but they are not
 * shared, so the settings panel asks first.
 */
export async function uncommittedChangesIn(git: SimpleGit, folders: string[]): Promise<string[]> {
  const clean = normalizeExclusions(folders)
  if (clean.length === 0) return []
  const raw = await git.raw(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--',
    ...clean.map(f => `:(literal,icase)${f}/`)])
  const records = raw.split('\0')
  const files = new Set<string>()
  for (let i = 0; i < records.length; i++) {
    const rec = records[i]
    if (rec.length < 4) continue
    const xy = rec.slice(0, 2)
    files.add(rec.slice(3))
    if (xy[0] === 'R' || xy[0] === 'C') i++ // the source path follows
  }
  return [...files].sort()
}

export type SparseExclusionsResult =
  | { success: true; enabled: boolean; excluded: string[] }
  | { success: false; error: string; offline?: boolean }

/**
 * Settings panel: set the exclusion list and reconcile the worktree.
 * Downloading a folder in a partial clone fetches its files; offline,
 * nothing changes and the member is told it can be downloaded once online.
 */
export async function setSparseExclusions(git: SimpleGit, repoPath: string, excluded: string[]): Promise<SparseExclusionsResult> {
  try {
    await applySparseSelection(git, repoPath, excluded)
    const enabled = await configFlag(git, 'core.sparseCheckout')
    return { success: true, enabled, excluded: readSparseConfig(repoPath).excluded }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    if ((await isPartialClone(git)) && isDownloadFailure(msg)) {
      return { success: false, offline: true, error: DOWNLOAD_NEEDS_NETWORK_MESSAGE }
    }
    return { success: false, error: msg }
  }
}
