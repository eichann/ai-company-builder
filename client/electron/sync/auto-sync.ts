// One automatic run (`git:autoSync`): main's last word on whether it may run
// now, then 「受け取る」 (gitSync.receive) or 「送る」 (the normal sync in auto
// mode). Without Electron, so the sync harness runs the same decision.
// .claude/rules/sync.md "Automatic sync".

import { autoSyncSkipReason, type AutoSyncMode, type AutoSyncRendererState, type AutoSyncResult } from '../../shared/auto-sync'
import type { GitSync, GitSyncResult } from './git-sync'

export interface AutoSyncHost {
  gitSync: Pick<GitSync, 'receive' | 'isRunning'> & ((...args: Parameters<GitSync>) => ReturnType<GitSync>)
  /** An AI turn is running in some chat. */
  aiRunning: () => boolean
  /** A download-choice change or private-folder creation in progress. */
  activity: () => 'download-choices' | 'private-folder-setup' | null
}

/** The renderer's part of the skip decision; anything malformed counts as "wait". */
export function rendererState(value: unknown): AutoSyncRendererState {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  return {
    unsavedEdits: v.unsavedEdits !== false,
    needsMember: v.needsMember !== false,
    offline: v.offline !== false,
  }
}

export async function runAutoSync(host: AutoSyncHost, repoPath: string, companyId: string, mode: AutoSyncMode, state: unknown): Promise<AutoSyncResult<GitSyncResult>> {
  const reason = autoSyncSkipReason(rendererState(state), {
    aiRunning: host.aiRunning(),
    syncRunning: host.gitSync.isRunning(),
    activity: host.activity(),
  })
  if (reason) return { status: 'skipped', reason }
  if (mode === 'receive') {
    const result = await host.gitSync.receive(repoPath, companyId)
    if (result.offline) return { status: 'skipped', reason: 'offline' }
    return { status: 'received', result }
  }
  if (mode !== 'send') return { status: 'skipped', reason: 'needs-member' }
  return { status: 'sent', result: await host.gitSync(repoPath, companyId, 'Sync from AI Company Builder', { auto: true }) }
}
