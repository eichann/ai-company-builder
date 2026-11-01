// The task card's source slot (tasks-ui.md, RecordSourcePanel): what a connector shows for a record
// — the original mail or Slack thread and the reply draft. The tasks feature never imports the
// feature that draws it, so the screen composes it here; null keeps the slot hidden.
import type { ReactNode } from 'react'
import type { RecordViewSummary } from '../../shared/record-views'

export function renderRecordSource(companyId: string, record: RecordViewSummary): ReactNode {
  void companyId
  void record
  // Lanes (ipc-and-main-process.md "Lane markers"): return your feature's part right under your lane's ▼.
  // lane A ▼
  // lane A ▲
  // lane B ▼
  // lane B ▲
  // lane C ▼
  // lane C ▲
  return null
}
