// Search's access to the main process, as one small port over the IPC contract
// (src/shared/ipc/electron-api.ts). Every function takes its port as the last
// parameter, defaulting to window.electronAPI.
import type { ElectronPort } from '../../shared/ipc/electron-api'

/**
 * Reading on this computer: the file names of a folder, a content search
 * (main runs git grep locally, capped, stopped by the next search) and the
 * text of a hit for its preview.
 */
export type CompanySearchReads = ElectronPort<'gitListFiles' | 'gitGrep' | 'readFile'>

/** Company-relative paths under `departmentFolder` ('' = the whole company), downloaded folders only. */
export function listCompanyFiles(rootPath: string, departmentFolder: string, reads: CompanySearchReads = window.electronAPI) {
  return reads.gitListFiles(rootPath, departmentFolder)
}

/** Lines containing `query`; a new search from this window stops the previous one. */
export function searchFileContents(rootPath: string, query: string, departmentFolder: string, reads: CompanySearchReads = window.electronAPI) {
  return reads.gitGrep(rootPath, query, departmentFolder)
}

/** A hit's file text for the preview, or null. */
export function readSearchHit(filePath: string, reads: CompanySearchReads = window.electronAPI) {
  return reads.readFile(filePath)
}
