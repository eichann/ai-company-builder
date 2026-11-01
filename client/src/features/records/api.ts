// Records' access to the main process (src/shared/ipc/electron-api.ts): reading only.
// Main asks the company server with the member's session; the server answers only what
// the member may read.
import type { ElectronPort } from '../../shared/ipc/electron-api'

/** A record's card, and the records linked to a file (both read from the company server). */
export type RecordReads = ElectronPort<'getRecordCard' | 'getRecordsForFile'>

export function getRecordCard(companyId: string, recordId: string, reads: RecordReads = window.electronAPI) {
  return reads.getRecordCard(companyId, recordId)
}

/** `companyPath`: the file's path inside the company folder (`営業部/見積.md`). */
export function getRecordsForFile(companyId: string, companyPath: string, reads: RecordReads = window.electronAPI) {
  return reads.getRecordsForFile(companyId, companyPath)
}
