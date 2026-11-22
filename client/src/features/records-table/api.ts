// 「記録の一覧」's one read (src/shared/ipc/electron-api.ts): main asks `POST /records/query` with
// the member's session; the server answers only what the member may read. Nothing is written.
import type { ElectronPort } from '../../shared/ipc/electron-api'
import type { RecordsTablePage, RecordsTableQuery } from '../../../shared/records-table'

export type RecordsTableReads = ElectronPort<'getRecordsTablePage'>

export function readRecordsTablePage(companyId: string, query: RecordsTableQuery, reads: RecordsTableReads = window.electronAPI): Promise<RecordsTablePage> {
  return reads.getRecordsTablePage(companyId, query)
}
