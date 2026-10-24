// The sync button (electron/sync/git-sync.ts, built in main.ts with the
// app's git, dialogs and server API) and the per-folder write access it
// refreshes (閲覧のみ badges, the chat write guard).
//   git:sync, writeAccess:get

import type { IpcRegistrar } from '../../ipc/registrar'
import type { GitSync } from '../../sync/git-sync'
import type { WriteAccessStore } from '../../write-access-store'
import type { PathGuard } from '../ports'

export interface SyncDeps {
  paths: PathGuard
  gitSync: GitSync
  writeAccess: WriteAccessStore
}

export function registerSyncIpc(ipc: IpcRegistrar, { paths, gitSync, writeAccess }: SyncDeps): void {
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

  ipc.handle('writeAccess:get', async (_, companyId: string, refresh?: boolean) => {
    if (typeof companyId !== 'string' || !companyId) return null
    const cached = writeAccess.get(companyId)
    if (cached && !refresh) return cached
    return (await writeAccess.refresh(companyId)) ?? null
  })
}
