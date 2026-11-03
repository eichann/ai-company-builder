import type { ElectronPort } from '../../shared/ipc/electron-api'

/** Reading a record's original thread from the company server (read only: nothing changes). */
export type ThreadReads = ElectronPort<'getRecordThread'>

export function getRecordThread(companyId: string, recordId: string, reads: ThreadReads = window.electronAPI) {
  return reads.getRecordThread(companyId, recordId)
}
