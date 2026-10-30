// The sync button (electron/sync/git-sync.ts, built in main.ts with the
// app's git, dialogs and server API), automatic sync while the app is open
// (electron/sync/auto-sync.ts), and the per-folder write access sync
// refreshes (閲覧のみ badges, the chat write guard).
//   git:sync, git:autoSync, writeAccess:get

import type { IpcRegistrar } from '../../ipc/registrar'
import type { GitSync } from '../../sync/git-sync'
import { runAutoSync } from '../../sync/auto-sync'
import type { SyncActivity } from '../../services/sync-activity'
import type { WriteAccessStore } from '../../write-access-store'
import type { PathGuard } from '../ports'
import type { AutoSyncMode, AutoSyncRendererState } from '../../../shared/auto-sync'

export interface SyncDeps {
  paths: PathGuard
  gitSync: GitSync
  writeAccess: WriteAccessStore
  /** Download-choice changes and private-folder creation (automatic sync waits for them). */
  activity: Pick<SyncActivity, 'current'>
  /** An AI turn is running in some chat. */
  aiRunning: () => boolean
}

export function registerSyncIpc(ipc: IpcRegistrar, { paths, gitSync, writeAccess, activity, aiRunning }: SyncDeps): void {
  ipc.handle('git:sync', async (_, repoPath: string, companyId: string, commitMessage: string) => {
    try {
      repoPath = paths.validate(repoPath)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error), errorType: 'unknown' as const }
    }
    const result = await gitSync(repoPath, companyId, commitMessage)
    // Rules may have changed since the last look: refresh the chat guard / badges.
    if (result.success && companyId) void writeAccess.refresh(companyId)
    return result
  })

  // 「自動で受け取る」 / 「自動で送る」, started by the renderer's timer; main
  // decides whether it may run now. A refused path is a failed send, never a run.
  ipc.handle('git:autoSync', async (_, repoPath: string, companyId: string, mode: AutoSyncMode, state: AutoSyncRendererState) => {
    try {
      repoPath = paths.validate(repoPath)
    } catch (error) {
      return { status: 'sent' as const, result: { success: false, error: error instanceof Error ? error.message : String(error), errorType: 'unknown' as const } }
    }
    const answer = await runAutoSync({ gitSync, aiRunning, activity: () => activity.current() }, repoPath, companyId, mode, state)
    if (answer.status === 'sent' && answer.result.success && companyId) void writeAccess.refresh(companyId)
    return answer
  })

  ipc.handle('writeAccess:get', async (_, companyId: string, refresh?: boolean) => {
    if (typeof companyId !== 'string' || !companyId) return null
    const cached = writeAccess.get(companyId)
    if (cached && !refresh) return cached
    return (await writeAccess.refresh(companyId)) ?? null
  })
}
