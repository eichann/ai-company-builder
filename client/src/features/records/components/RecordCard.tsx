import type { ReactNode } from 'react'
import { CircleNotch } from '@phosphor-icons/react'
import type { RecordCardView, RecordViewSummary } from '../../../../shared/record-views'
import { useRecordCard } from '../hooks/useRecordCard'
import { LinkedColumn } from '../../../shared/ui/LinkedColumn'
import { linkRows } from './linkRows'
import { Chip, FieldsFold, HistoryFold, RecordPage } from '../../../shared/ui/RecordPage'
import { RecordMarks } from './RecordRows'

interface Props {
  companyId: string
  rootPath: string
  /** The caller keys this component by it. */
  recordId: string
  /** Business plugins' sections for the record's type (plugin-frame.md "The four slots"), drawn by the screen. */
  renderSections?: (record: { id: string; type: string }) => ReactNode
  /** Read: its title and kind, for its tab in the middle. */
  onLoaded?: (record: RecordViewSummary) => void
}

/**
 * The card a record opens in when it has no screen of its own, read only: what it is, its
 * summary, fields and 経緯 folded, and 「つながっているもの」 to follow.
 */
export function RecordCard({ companyId, rootPath, recordId, renderSections, onLoaded }: Props) {
  const result = useRecordCard(companyId, recordId, onLoaded)
  if (result === null) {
    return <div className="h-full flex items-center justify-center gap-2 text-xs text-gray-400"><CircleNotch size={14} className="animate-spin" />読み込んでいます</div>
  }
  if (!result.success) {
    return <div className="h-full flex items-center justify-center px-6 text-center text-sm text-gray-500 dark:text-zinc-400" role="alert">{result.error}</div>
  }
  return <CardBody card={result.card} rootPath={rootPath} sections={renderSections?.(result.card.record)} />
}

function CardBody({ card, rootPath, sections }: { card: RecordCardView; rootPath: string; sections?: ReactNode }) {
  const { record } = card
  return (
    <RecordPage testId="record-card" kind={record.thing} name={record.typeLabel} title={record.title}
      chips={<>{record.stateLabel && <Chip tone="accent">{record.stateLabel}</Chip>}<RecordMarks record={record} /></>}
      bottom={<><HistoryFold lines={card.history} /><FieldsFold fields={card.fields} /></>}
      links={<LinkedColumn rows={linkRows(card.links, rootPath)} first={record.thing === 'bundle' ? 'task' : undefined} />}>
      {record.summary && <p className="whitespace-pre-wrap text-[14px] leading-relaxed">{record.summary}</p>}
      {sections}
    </RecordPage>
  )
}
