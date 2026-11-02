import type { ReactNode } from 'react'
import { CircleNotch } from '@phosphor-icons/react'
import type { RecordCardView, RecordViewSummary } from '../../../../shared/record-views'
import { CALM } from '../../../../shared/thing-words'
import { LinkedColumn } from '../../../shared/ui/LinkedColumn'
import { Chip, FieldsFold, HistoryFold, RecordPage } from '../../../shared/ui/RecordPage'
import { useRecordCard } from '../hooks/useRecordCard'
import { AiBand, BundleBody } from './BundleBody'
import { linkRows } from './linkRows'
import { IncomingBody, IncomingLine, MeetingBody, MeetingLine, OpenButton } from './RecordDetails'
import { RecordMarks } from './RecordRows'

interface Props {
  companyId: string
  rootPath: string
  /** The caller keys this component by it. */
  recordId: string
  /** Business plugins' sections for the record's type (plugin-frame.md "The four slots"), drawn by the screen. */
  renderSections?: (record: { id: string; type: string }) => ReactNode
  /** A 来た連絡's thread around it and the reply draft (`app/recordSource.tsx`), drawn by the screen. */
  renderSource?: (record: RecordViewSummary) => ReactNode
  /** Read: its title and kind, for its tab in the middle. */
  onLoaded?: (record: RecordViewSummary) => void
  /** A bundle's approval request still waiting, drawn by the screen with the approval card. */
  renderApproval?: (approvalId: string) => ReactNode
}

/**
 * The card a record opens in when it has no screen of its own (read only), with a meeting's, a
 * 来た連絡's and a 案件・プロジェクト's own parts: what it is, its body, fields and 経緯 folded, the AI
 * working on it, and 「つながっているもの」.
 */
export function RecordCard({ companyId, rootPath, recordId, renderSections, renderSource, onLoaded, renderApproval }: Props) {
  const result = useRecordCard(companyId, recordId, onLoaded)
  if (result === null) {
    return <div className="h-full flex items-center justify-center gap-2 text-xs text-gray-400"><CircleNotch size={14} className="animate-spin" />{CALM.loading}</div>
  }
  if (!result.success) {
    return <div className="h-full flex items-center justify-center px-6 text-center text-sm text-gray-500 dark:text-zinc-400" role="alert">{result.error}</div>
  }
  return <CardBody card={result.card} rootPath={rootPath} sections={renderSections?.(result.card.record)} source={renderSource?.(result.card.record)} renderApproval={renderApproval} />
}

function CardBody({ card, rootPath, sections, source, renderApproval }: { card: RecordCardView; rootPath: string; sections?: ReactNode; source?: ReactNode; renderApproval?: (approvalId: string) => ReactNode }) {
  const { record, detail } = card
  const linked = card.links.flatMap(l => (l.record ? [l.record] : []))
  const chips = <>
    {record.stateLabel && <Chip tone="accent">{record.stateLabel}</Chip>}
    {detail?.kind === 'incoming' && detail.needsReply && <Chip tone="amber">返事が要る</Chip>}
    <RecordMarks record={record} />
  </>
  let from: ReactNode = null
  let actions: ReactNode = null
  let body: ReactNode = record.summary ? <p className="whitespace-pre-wrap text-[14px] leading-relaxed">{record.summary}</p> : null
  if (detail?.kind === 'meeting') {
    from = <MeetingLine m={detail} />
    body = <MeetingBody m={detail} decisions={linked.filter(r => r.thing === 'decision')} homework={linked.filter(r => r.thing === 'task')} />
  } else if (detail?.kind === 'incoming') {
    from = <IncomingLine m={detail} />
    actions = detail.open && <OpenButton link={detail.open} />
    body = <IncomingBody m={detail} />
  } else if (detail?.kind === 'bundle') {
    body = <BundleBody b={detail} renderApproval={renderApproval} />
  }
  // A bundle's やること say whose turn they are on the right too.
  const turns = new Map(detail?.kind === 'bundle' ? detail.groups.flatMap(g => g.tasks.map(t => [t.id, t.turn] as const)) : [])
  const rows = linkRows(card.links, rootPath).map(r => (turns.has(r.key) ? { ...r, sub: turns.get(r.key) ?? undefined } : r))
  return (
    <RecordPage testId="record-card" kind={record.thing} name={record.typeLabel} title={record.title} chips={chips} from={from} actions={actions}
      top={card.ai && <AiBand ai={card.ai} />}
      bottom={<><HistoryFold lines={card.history} /><FieldsFold fields={card.fields} /></>}
      links={<LinkedColumn rows={rows} first={record.thing === 'bundle' ? 'task' : undefined} />}>
      {body}
      {source}
      {sections}
    </RecordPage>
  )
}
