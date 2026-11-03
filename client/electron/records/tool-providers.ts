// The connectors whose tools ride on a consultation's record token (`chat-and-agents.md`): one
// provider each, made per turn here and merged by `createRecordTools` (tools.ts). A connector adds
// its provider file and one line under its lane's marker; tools.ts itself does not change. An
// unattended 「AI の番」 still gets only what its step names (`client/shared/ai-turn-steps/`).
import { createDriveTools, type DrivePicking } from '../features/google/drive'
import { createInboxTools } from '../features/inbox/tools'
import { createTaskWaitTools } from '../features/ai-turns/task-wait-tools'
import type { PathGuard } from '../features/ports'
import type { PrivateFolderGuards } from '../features/private-folders/guards'
import { notDownloadedFolders } from '../sync/not-downloaded'
import type { RecordToolProvider } from './tools'

export interface RecordToolProviderDeps {
  /** Google Drive (google-drive.md): only where the app can show Google Picker. */
  drivePicking?: Pick<DrivePicking, 'pick'>
  paths?: PathGuard
  privateFolders: Pick<PrivateFolderGuards, 'readable'>
}

/** The turn the tools are for: its company and the consultation's company folder. */
export interface RecordToolTurn {
  companyId: string
  companyRoot: string | null
}

export function recordToolProviders(deps: RecordToolProviderDeps, turn: RecordToolTurn): RecordToolProvider[] {
  const providers: RecordToolProvider[] = []
  const { drivePicking, paths } = deps
  // Google Drive's tools (google-drive.md); each turn asks the server whether Drive is set up for the company.
  if (drivePicking && paths) {
    providers.push((access, signal) => createDriveTools(access, {
      picking: drivePicking, companyId: turn.companyId, companyRoot: turn.companyRoot,
      local: { pathGuard: paths, notDownloaded: notDownloadedFolders, privateFolders: () => deps.privateFolders.readable(turn.companyId) },
    }, signal))
  }
  // Lanes (ipc-and-main-process.md "Lane markers"): add only right under your lane's ▼.
  // lane A ▼
  // lane A ▲
  // lane B ▼
  // The inbox (来た連絡, inbox.md): read a message's thread on demand, record the judgement (B4).
  providers.push((access, signal) => createInboxTools(access, signal))
  // lane B ▲
  // lane C ▼
  // A task's wait that is over (ai-turns.md): the wait-over step's one read of its task.
  providers.push((access, signal) => createTaskWaitTools(access, signal))
  // lane C ▲
  return providers
}
