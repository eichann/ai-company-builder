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

/** When a found file last changed, for 探す's period (fs:stat; an unreadable one has no time). */
export type FileTimeReads = ElectronPort<'getStats'>

export async function fileTimes(rootPath: string, paths: readonly string[], reads: FileTimeReads = window.electronAPI): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  await Promise.all(paths.map(async p => {
    const r = await reads.getStats(`${rootPath}/${p}`).catch(() => null)
    if (r?.success && r.data?.mtime) out[p] = r.data.mtime
  }))
  return out
}

/**
 * 探す's records, asked of the company server: those holding the words (with department, 「自分」,
 * 案件 and the summaries of matching 相手 / 案件), and with nothing typed the member's own.
 */
export type RecordFindOutbound = ElectronPort<'findRecords' | 'findRecordsHome'>

export function findRecords(companyId: string, text: string, today: string, outbound: RecordFindOutbound = window.electronAPI) {
  return outbound.findRecords(companyId, text, today)
}

export function findRecordsHome(companyId: string, today: string, from: string, to: string, outbound: RecordFindOutbound = window.electronAPI) {
  return outbound.findRecordsHome(companyId, today, from, to)
}
