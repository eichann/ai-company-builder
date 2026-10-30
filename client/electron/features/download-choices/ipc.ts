// What this computer downloads (.claude/rules/download-choices.md):
// the persisted exclusions, applying them (a download in a partial clone,
// reported as sparse:progress; readable private folders follow at once),
// uncommitted changes in folders about to be left out, and folder sizes for
// the settings tree (server sizes; local names offline; private folders
// listed without a size). Exclusions model and helpers: sync/sparse.ts.
//   git:sparseGetExclusions, git:sparseSetExclusions,
//   git:sparseUncommittedChanges, git:folderSizes

import type { IpcRegistrar } from '../../ipc/registrar'
import type { AppGit } from '../../services/app-git'
import type { Session } from '../../services/session'
import { watchPackBytes } from '../../sync/company-folder'
import { folderSizesView, serverFolderSizes } from '../../sync/folder-sizes'
import type { GitSync } from '../../sync/git-sync'
import { readPrivateScopesCache } from '../../sync/private-folders'
import { readSparseConfig, setSparseExclusions, uncommittedChangesIn } from '../../sync/sparse'
import type { PathGuard } from '../ports'
import type { SyncActivity } from '../../services/sync-activity'

export interface DownloadChoicesDeps {
  paths: PathGuard
  appGit: AppGit
  session: Session
  serverUrl: () => string
  /** Download / retire private-folder clones after a change (runs under the sync lock). */
  privateFolders: Pick<GitSync, 'applyPrivateFolderChoices'>
  /** Automatic sync waits while a change is applied. */
  activity: Pick<SyncActivity, 'during'>
}

export function registerDownloadChoicesIpc(ipc: IpcRegistrar, { paths, appGit, session, serverUrl, privateFolders, activity }: DownloadChoicesDeps): void {


  // Read the persisted exclusion list for a repo.
  ipc.handle('git:sparseGetExclusions', async (_, repoPath: string) => {
    try {
      const safe = paths.validate(repoPath)
      return { success: true, excluded: readSparseConfig(safe).excluded }
    } catch (error) {
      return { success: false, excluded: [], error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  // Set the exclusion list and reconcile the worktree to match. In a partial
  // clone (first setup with departments picked), adding a department downloads
  // it; offline nothing changes and the result says so (offline: true).
  //
  // While it runs, the bytes arriving in .git/objects/pack (a download in a
  // partial clone) are reported to the window as 'sparse:progress' events, so
  // the panel can show the download moving.
  ipc.handle('git:sparseSetExclusions', (event, repoPath: string, excluded: string[]) => activity.during('download-choices', async () => {
    let stopProgress: (() => void) | null = null
    try {
      const safe = paths.validate(repoPath)
      stopProgress = watchPackBytes(safe, receivedBytes => {
        if (!event.sender.isDestroyed()) event.sender.send('sparse:progress', { repoPath, receivedBytes })
      })
      const result = await setSparseExclusions(appGit.create(safe), safe, Array.isArray(excluded) ? excluded : [])
      if (!result.success) console.error('Sparse set exclusions error:', result.error)
      // Private folders are their own repositories: download one that is no
      // longer left out, retire the clone of one that now is (after syncing it).
      const cache = result.success ? readPrivateScopesCache(safe) : null
      if (cache && cache.scopes.length > 0) {
        const reports = await privateFolders.applyPrivateFolderChoices(safe, cache.companyId).catch((e: unknown) => {
          console.warn('Private folders: could not apply download choices:', e)
          return []
        })
        const failed = reports.filter(r => !r.success)
        if (failed.length > 0) return { ...result, privateFolderErrors: failed.map(r => `『${r.path}』: ${r.error ?? ''}`) }
      }
      return result
    } catch (error) {
      console.error('Sparse set exclusions error:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    } finally {
      stopProgress?.()
    }
  }))

  // Files inside these folders with changes not committed yet: the settings
  // panel asks before leaving such a folder out (the next sync would move them
  // to .backups/ instead of sharing them).
  ipc.handle('git:sparseUncommittedChanges', async (_, repoPath: string, folders: string[]) => {
    try {
      const safe = paths.validate(repoPath)
      return { success: true, files: await uncommittedChangesIn(appGit.create(safe), Array.isArray(folders) ? folders : []) }
    } catch (error) {
      return { success: false, files: [], error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  // One level of the company's folder tree with sizes, for the settings panel
  // (server sizes; local names only when the server cannot be reached).
  ipc.handle('git:folderSizes', async (_, repoPath: string, companyId: string, folder: string, measure: string[]) => {
    try {
      const safe = paths.validate(repoPath)
      const fetchSizes = companyId ? serverFolderSizes({ baseUrl: serverUrl(), companyId, cookies: session.cookies() }) : null
      const listed = typeof folder === 'string' ? folder : ''
      const view = await folderSizesView(appGit.create(safe), fetchSizes, listed, Array.isArray(measure) ? measure : [])
      // Readable private folders are not in the company repository: list them
      // where they live (no size — the company's folder sizes cannot see them).
      const cache = readPrivateScopesCache(safe)
      const parentOf = (p: string) => p.split('/').slice(0, -1).join('/')
      const privateNodes = (cache?.scopes ?? [])
        .filter(s => parentOf(s.path).normalize('NFC') === listed.normalize('NFC') && !view.folders.some(f => f.path.normalize('NFC') === s.path))
        .map(s => ({ name: s.path.split('/').pop() ?? s.path, path: s.path, size: null, files: null, hasChildren: false, private: true }))
      return { success: true, ...view, folders: [...view.folders, ...privateNodes] }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })
}
