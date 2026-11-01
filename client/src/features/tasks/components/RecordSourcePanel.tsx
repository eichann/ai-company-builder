import type { RecordViewSummary } from '../../../../shared/record-views'

/**
 * Where a task's source shows — the original mail or Slack thread and the reply draft — once a
 * connector provides it (stage 3). Empty and hidden until then: the place is kept so the card's
 * order is fixed.
 */
export function RecordSourcePanel({ record }: { record: RecordViewSummary }) {
  return <div hidden data-slot="record-source" data-record-id={record.id} />
}
