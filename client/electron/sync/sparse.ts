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

// Reconcile the on-disk sparse cone to match the persisted exclusion list.
// excluded empty → full checkout (sparse disabled). Otherwise the cone is
// (remote root folders − excluded). Safe: sparse-checkout never deletes data
// from the index/server, only what is materialised in the worktree.
export async function applySparseSelection(git: SimpleGit, repoPath: string, excluded: string[]): Promise<void> {
  const cleanExcluded = [...new Set(excluded.filter(Boolean))]
  writeSparseConfig(repoPath, { excluded: cleanExcluded })

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
    // User excluded literally everything → fall back to a full checkout.
    await git.raw(['sparse-checkout', 'disable']).catch(() => {})
    writeSparseConfig(repoPath, { excluded: [] })
    return
  }
  await git.raw(['sparse-checkout', 'init', '--cone'])
  await git.raw(['sparse-checkout', 'set', ...desired])
}
