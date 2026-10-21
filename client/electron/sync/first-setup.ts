// First setup of a company the member has picked departments for: download
// only those departments plus what the whole company shares.
//
// Used by main.ts's git:setupCompanyRemote for a fresh folder (no local
// commits) when the member chose departments in the setup screen, and by the
// sync harness for its partial-clone members. Existing clones never come
// through here.
//
//   1. fetch --filter=blob:none   commits and trees only, no file contents
//   2. persist the exclusions and set the sparse cone  (./sparse.ts)
//   3. check out                  git downloads just the blobs in the cone,
//                                 in one batch
//
// The cone is the persisted-exclusions model every sparse checkout uses:
// (all root folders, dotfolders such as .claude included) − (the departments
// not picked). Root-level files and non-department folders stay in. A folder
// added later in settings is downloaded then (git fetches the missing blobs
// lazily, with the app's auth); anything outside the cone that git needs
// meanwhile — a teammate's rename during a rebase, `git log -p` — is fetched
// the same way.

import type { SimpleGit } from 'simple-git'
import { applySparseSelection, listAllRootDirs } from './sparse'
import type { SyncLogger } from './types'

export interface FirstSetupOptions {
  git: SimpleGit
  repoPath: string
  /** Remote branch to check out (the server pins main). */
  branch: string
  /**
   * Every department folder the company has (top-level folders), or null
   * when the list is unavailable: then every non-dot, non-`_` root folder
   * counts as a department, as in the setup screen.
   */
  departments: string[] | null
  /** The departments the member picked. */
  selected: string[]
  log: SyncLogger
}

export interface FirstSetupResult {
  /** Department folders left out of the download (the sparse exclusions). */
  excluded: string[]
  /** Picked departments that exist on the server. */
  included: string[]
}

/** Clone into an initialised repository with an `origin`, downloading only the chosen departments. */
export async function checkoutSelectedDepartments(options: FirstSetupOptions): Promise<FirstSetupResult> {
  const { git, repoPath, branch, log } = options

  // 1. History without file contents. git registers origin as a promisor
  //    remote (remote.origin.promisor / partialclonefilter), so later fetches
  //    keep the filter and missing blobs are fetched on demand. A server that
  //    does not support filtering sends everything, which still works.
  await git.fetch(['--progress', '--filter=blob:none', 'origin'])

  const rootDirs = await listAllRootDirs(git)
  const isDepartmentLike = (d: string) => !d.startsWith('.') && !d.startsWith('_')
  const departments = (options.departments ?? rootDirs.filter(isDepartmentLike))
    .filter(d => rootDirs.includes(d))
  const included = [...new Set(options.selected)].filter(d => rootDirs.includes(d))
  const excluded = [...new Set(departments)].filter(d => !included.includes(d))

  // 2. The cone, before anything is checked out. Persisting the exclusions
  //    is what keeps the choice across syncs (sync's step 7 reconciles to it).
  await applySparseSelection(git, repoPath, excluded)

  // 3. Checkout fetches the cone's blobs in one batch before writing files,
  //    so a dropped connection leaves nothing half-written: retrying setup
  //    resumes from here.
  await git.checkout(['-b', branch, `origin/${branch}`])
  log.log(`Git setup: Partial clone — downloaded ${included.length > 0 ? included.join(', ') : '(no department)'}; ` +
    `not downloaded: ${excluded.length > 0 ? excluded.join(', ') : '(none)'}`)
  return { excluded, included }
}
