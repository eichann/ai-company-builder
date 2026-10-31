// The sync button and its company-folder history views, wired to the app's
// git, the AI commit message, the shell's dialogs and the server API.
// git:sync itself lives in ../../sync/git-sync.ts (testable without Electron:
// tests/sync-harness).
import path from 'path'
import { createGitSync, type SyncDialog } from '../../sync/git-sync'
import { createFetchSyncServerApi } from '../../sync/server-api'
import { createCommitMessages, type CommitMessagesDeps } from '../../services/commit-messages'
import { createSyncActivity } from '../../services/sync-activity'
import type { AppGit } from '../../services/app-git'
import type { Session } from '../../services/session'
import type { WriteAccessStore } from '../../write-access-store'
import type { IpcRegistrar } from '../../ipc/registrar'
import type { PathGuard } from '../ports'
import { registerGitHistoryIpc } from '../git-history/ipc'
import { registerSyncIpc } from './ipc'

export interface SyncWiring extends Omit<CommitMessagesDeps, 'cwd'> {
  paths: PathGuard
  appGit: AppGit
  userDataDir: () => string
  /** Sync's questions to the member (the shell's message boxes). */
  dialog: SyncDialog
  serverUrl: () => string
  session: Pick<Session, 'cookies'>
  writeAccess: WriteAccessStore
  /** An AI turn is running in some chat (automatic sync waits). */
  aiRunning: () => boolean
}

export function wireSync(ipc: IpcRegistrar, { paths, appGit, userDataDir, dialog, serverUrl, session, writeAccess, aiRunning, ...messages }: SyncWiring) {
  const commitMessagesFor = createCommitMessages({ ...messages, cwd: () => path.join(userDataDir(), 'commit-message') })

  // The working tree and its history for the sync preview, the diff views,
  // the search tab and Cmd+P (features/git-history).
  registerGitHistoryIpc(ipc, { paths, git: appGit, commitMessagesFor })

  const gitSync = createGitSync({
    createGit: appGit.create,
    dialog,
    api: createFetchSyncServerApi({ baseUrl: serverUrl, cookies: session.cookies }),
    generateCommitMessage: commitMessagesFor(appGit.create),
    now: () => new Date(),
    platform: process.platform,
    log: console,
  })

  // Download-choice changes and private-folder creation, which automatic sync waits for.
  const activity = createSyncActivity()
  registerSyncIpc(ipc, { paths, gitSync, writeAccess, activity, aiRunning })
  return { gitSync, activity }
}
