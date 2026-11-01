// The task card's source slot (tasks-ui.md, RecordSourcePanel): what a connector shows for a record
// — the original mail or Slack thread and the reply draft. The tasks feature never imports the
// feature that draws it, so the screen composes it here; null keeps the slot hidden.
import type { ReactNode } from 'react'
import type { RecordViewSummary } from '../../shared/record-views'
// lane A ▼
import { PreparedMailCard } from '../features/chat/components/PreparedMailCard'
import { RecordThreadPanel } from '../features/threads/components/RecordThreadPanel'
// lane A ▲

/** Types whose record can come from outside, or link the 連絡 it came from (outbound-mail.md "Replies"). */
const FROM_OUTSIDE = new Set(['interaction', 'reply_request', 'task'])

export function renderRecordSource(companyId: string, record: RecordViewSummary): ReactNode {
  // Lanes (ipc-and-main-process.md "Lane markers"): return your feature's part right under your lane's ▼.
  // lane A ▼
  if (FROM_OUTSIDE.has(record.type)) {
    return <RecordThreadPanel key={record.id} companyId={companyId} recordId={record.id}
      renderReply={draftId => <PreparedMailCard key={draftId} companyId={companyId} messageId={draftId} />} />
  }
  // lane A ▲
  // lane B ▼
  // lane B ▲
  // lane C ▼
  // lane C ▲
  return null
}
