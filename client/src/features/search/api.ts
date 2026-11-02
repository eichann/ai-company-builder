// Search's access to the main process, as one small port over the IPC contract
// (src/shared/ipc/electron-api.ts). Every function takes its port as the last
// parameter, defaulting to window.electronAPI.
import type { ElectronPort } from '../../shared/ipc/electron-api'

/**
 * Reading on this computer: the file names of a folder and a content search
 * (main runs git grep locally, capped, stopped by the next search).
 */
export type CompanySearchReads = ElectronPort<'gitListFiles' | 'gitGrep'>

/** Company-relative paths under `departmentFolder` ('' = the whole company), downloaded folders only. */
export function listCompanyFiles(rootPath: string, departmentFolder: string, reads: CompanySearchReads = window.electronAPI) {
  return reads.gitListFiles(rootPath, departmentFolder)
}

/** Lines containing `query`; a new search from this window stops the previous one. */
export function searchFileContents(rootPath: string, query: string, departmentFolder: string, reads: CompanySearchReads = window.electronAPI) {
  return reads.gitGrep(rootPath, query, departmentFolder)
}

/** Records (やること・会議の記録・決めたこと・案件…) whose title or summary holds the words: asked of the company server. */
export type RecordSearchOutbound = ElectronPort<'searchRecords'>

export function searchRecords(companyId: string, text: string, outbound: RecordSearchOutbound = window.electronAPI) {
  return outbound.searchRecords(companyId, text)
}
