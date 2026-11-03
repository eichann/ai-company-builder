// A file's earlier versions (「前の版」) through the main process (src/shared/ipc/electron-api.ts):
// read from the company folder's git on this computer (a private folder's own clone for a
// file inside one); nothing is fetched. Every function takes its port last (default window.electronAPI).
import type { ElectronPort } from '../../shared/ipc/electron-api'

export type FileVersionReads = ElectronPort<'gitLog'>

/** The newest versions of one file (`companyPath`: its path inside the company folder). */
export function getFileVersions(rootPath: string, companyPath: string, limit: number, reads: FileVersionReads = window.electronAPI) {
  return reads.gitLog(rootPath, companyPath, limit)
}
