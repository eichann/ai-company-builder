// Dependencies git:sync needs from its host. main.ts supplies the Electron
// implementations; tests/sync-harness supplies scripted ones. Nothing in
// client/electron/sync/ imports electron.

import type { SimpleGit } from 'simple-git'

/** The questions sync asks the member. */
export interface SyncDialog {
  /**
   * False when there is no window to ask in. Sync then takes its no-UI path:
   * nested repos are excluded silently, deletions sync without a warning,
   * and a protected-config rejection is reported without recovery.
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
}

/** Server calls sync makes. Network failures throw; sync logs and moves on. */
export interface SyncServerApi {
  /** GET /api/git/repos/:companyId → data.httpsUrl (undefined when unavailable). */
  getRepoHttpsUrl(companyId: string): Promise<string | undefined>
  /** GET /api/me → data (null when signed out or unavailable). */
  getCurrentUser(): Promise<{ name?: string | null; email?: string } | null>
  /** GET /api/companies/:companyId/departments → data (null when the response was not ok). */
  getDepartments(companyId: string): Promise<Array<{ folder?: string }> | null>
}

export type SyncLogger = Pick<Console, 'log' | 'warn' | 'error'>

export interface SyncDeps {
  /** SimpleGit configured like the app's createGit (sync/git-factory.ts). */
  createGit(repoPath: string): SimpleGit
  /** Binary used for the binary-safe `git cat-file` backups. */
  gitBinary(): string
  dialog: SyncDialog
  api: SyncServerApi
  /** AI commit message for the staged changes, or null to use the default. */
  generateCommitMessage(repoPath: string): Promise<string | null>
  /** Clock for backup folder names, metadata and retention. */
  now(): Date
  /** Decides whether a failed pull is a transient Windows file lock. */
  platform: NodeJS.Platform
  log: SyncLogger
}
