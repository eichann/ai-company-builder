import type { ReactNode } from 'react'
import type { RecordViewSummary } from '../../../../shared/record-views'

/**
 * Where a task's source shows — the original mail or Slack thread and the reply draft. The content
 * comes from `app/recordSource.tsx` (a feature never imports another); hidden while it gives none,
 * the place is kept so the card's order is fixed.
 */
export function RecordSourcePanel({ record, children }: { record: RecordViewSummary; children?: ReactNode }) {
  const empty = children === undefined || children === null || children === false
  if (empty) return <div hidden data-slot="record-source" data-record-id={record.id} />
  return <section aria-label="元のやりとり" data-slot="record-source" data-record-id={record.id}>{children}</section>
}
