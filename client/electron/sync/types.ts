// Dependencies git:sync needs from its host. main.ts supplies the Electron
// implementations; tests/sync-harness supplies scripted ones. Nothing in
// client/electron/sync/ imports electron.

import type { SimpleGit } from 'simple-git'
import type { MyScopesResponse } from '../../../shared/types/private-folders'
import type { PathCheckResult } from './path-check'

/** The questions sync asks the member. */
export interface SyncDialog {
  /**
   * False when there is no window to ask in. Sync then takes its no-UI path:
   * nested repos are excluded silently, deletions sync without a warning,
   * and a protected-config or write-denied rejection is reported
   * without recovery.
   */
  canAsk(): boolean
  /** A folder that is already shared contains its own .git. */
  confirmSharedNestedRepo(repo: string): Promise<'keep-sharing' | 'exclude' | 'cancel'>
  /** A folder that is not shared yet is its own Git repository. */
  confirmExternalNestedRepo(repo: string): Promise<'exclude' | 'cancel'>
  /** Tracked files were deleted locally. */
  confirmDeletedFiles(files: string[]): Promise<'sync-deletions' | 'restore' | 'cancel'>
  /** The server rejected a change to owner/admin-only config. */
  confirmProtectedConfigRestore(files: string[]): Promise<'restore' | 'cancel'>
  /** The server rejected changes in a folder the member may not edit. */
  confirmWriteDeniedRestore(files: string[]): Promise<'restore' | 'cancel'>
}

/** Server calls sync makes. Network failures throw; sync logs and moves on. */
export interface SyncServerApi {
  /** GET /api/git/repos/:companyId → data.httpsUrl (undefined when unavailable). */
  getRepoHttpsUrl(companyId: string): Promise<string | undefined>
  /** GET /api/me → data (null when signed out or unavailable). */
  getCurrentUser(): Promise<{ name?: string | null; email?: string } | null>
  /** GET /api/companies/:companyId/departments → data (null when the response was not ok). */
  getDepartments(companyId: string): Promise<Array<{ folder?: string }> | null>
  /**
   * GET /api/companies/:companyId/me/scopes → data: the private folders the
   * member may read (path, clone URL, canWrite). 'not-member'
   * when the server says the account is not a member of the company (404
   * "Company not found or access denied"); null when it gives no usable
   * answer (an older server, other errors); throws offline.
   */
  getMyScopes(companyId: string): Promise<MyScopesResponse | 'not-member' | null>
  /**
   * POST /api/companies/:companyId/paths/check { paths } → data: whether each
   * path may be used in the company folder (false: at or under a private
   * folder the member cannot read). null when there is no usable answer.
   */
  checkPaths(companyId: string, paths: string[]): Promise<PathCheckResult[] | null>
}

export type SyncLogger = Pick<Console, 'log' | 'warn' | 'error'>

export interface SyncDeps {
  /** SimpleGit configured like the app's createGit (sync/git-factory.ts). */
  createGit(repoPath: string): SimpleGit
  dialog: SyncDialog
  api: SyncServerApi
  /** AI commit message for the staged changes, or null to use the default. */
  generateCommitMessage(repoPath: string, opts?: { kind?: 'company' | 'scope' }): Promise<string | null>
  /** Clock for backup folder names, metadata and retention. */
  now(): Date
  /** Decides whether a failed pull is a transient Windows file lock. */
  platform: NodeJS.Platform
  log: SyncLogger
  /** Bytes above which a file is auto-ignored (step 4). Default 100 MB; tests lower it. */
  largeFileThreshold?: number
}
