import { useState, type ReactNode } from 'react'
import { CircleNotch } from '@phosphor-icons/react'
import type { RecordCardView, RecordViewSummary, RemovableLink } from '../../../../shared/record-views'
import { CALM } from '../../../../shared/thing-words'
import { consultationLinks, type LinkedConsultation } from '../../../shared/ui/consultationLinks'
import { LinkedColumn } from '../../../shared/ui/LinkedColumn'
import { SeenBy } from '../../../shared/ui/ThingIcon'
import { Chip, FieldsFold, HistoryFold, RecordPage } from '../../../shared/ui/RecordPage'
import { undoRecordChange, unlinkRecord } from '../api'
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
  /** Consultations whose main topic is this record (this PC's), listed in 「つながっているもの」. */
  consultations?: readonly LinkedConsultation[]
  /** 「相談する」 (the latest about it, else a new one) / 「＋新しい相談」 (`fresh`). */
  onConsult?: (record: { id: string; title: string }, fresh: boolean) => void
  /** A meeting's or a 来た連絡's 案件・プロジェクト field (［変える］［外す］［〇〇につなぐ］), drawn by the screen. */
  renderBundleField?: (field: BundleFieldContext) => ReactNode
}

/** What the screen's 案件・プロジェクト field gets: the record, its current one, and how to say what changed. */
export interface BundleFieldContext {
  record: RecordViewSummary
  version: number
  bundle: RecordViewSummary | null
  /** Taking the current one off (absent when its link cannot be removed by hand). */
  removable: RemovableLink | null
  /** After a change: the card reads again and says `text`, with 取り消す of `undo` when given. */
  onChanged: (text: string, undo: { recordId: string; version: number } | null) => void
}

/**
 * The card a record opens in when it has no screen of its own (read only), with a meeting's, a
 * 来た連絡's and a 案件・プロジェクト's own parts: what it is, its body, fields and 経緯 folded, the AI
 * working on it, and 「つながっているもの」.
 */
export function RecordCard({ companyId, rootPath, recordId, renderSections, renderSource, onLoaded, renderApproval, consultations = [], onConsult, renderBundleField }: Props) {
  const { result, reload } = useRecordCard(companyId, recordId, onLoaded)
  const [notice, setNotice] = useState<{ text: string; undo: { recordId: string; version: number } | null } | null>(null)
  const [error, setError] = useState<string | null>(null)
  if (result === null) {
    return <div className="h-full flex items-center justify-center gap-2 text-xs text-gray-400"><CircleNotch size={14} className="animate-spin" />{CALM.loading}</div>
  }
  if (!result.success) {
    return <div className="h-full flex items-center justify-center px-6 text-center text-sm text-gray-500 dark:text-zinc-400" role="alert">{result.error}</div>
  }
  const changed = (text: string, undo: { recordId: string; version: number } | null) => { setError(null); setNotice({ text, undo }); reload() }
  const unlink = async (link: RemovableLink, label: string) => {
    const r = await unlinkRecord(companyId, link)
    if (!r.success) { setError(r.error); return }
    changed(`「${label}」とのつながりを外しました`, r.entryVersion ? { recordId: link.source, version: r.entryVersion } : null)
  }
  const undo = async (target: { recordId: string; version: number }) => {
    const r = await undoRecordChange(companyId, target.recordId, target.version)
    if (r.success) changed('取り消しました', null)
    else setError(r.error)
  }
  const card = result.card
  const bundleLink = card.links.find(l => l.bundle && l.record)
  const field = renderBundleField && (card.detail?.kind === 'meeting' || card.detail?.kind === 'incoming') && card.version !== undefined
    ? renderBundleField({ record: card.record, version: card.version, bundle: bundleLink?.record ?? null, removable: bundleLink?.removable ?? null, onChanged: changed })
    : null
  const notes = <>
    {error && <p role="alert" className="text-[11.5px] text-red-600 dark:text-red-400">{error}</p>}
    {notice && (
      <p role="status" className="flex flex-wrap items-center gap-2 rounded-md bg-gray-100 px-2 py-1 text-[11.5px] dark:bg-zinc-800">
        {notice.text}
        {notice.undo && <button type="button" onClick={() => void undo(notice.undo!)} className="text-accent hover:underline">取り消す</button>}
      </p>
    )}
  </>
  return <CardBody card={card} rootPath={rootPath} sections={renderSections?.(card.record)} source={renderSource?.(card.record)} renderApproval={renderApproval}
    field={field} notes={notes} onUnlink={(link, label) => void unlink(link, label)}
    consult={consultationLinks(consultations, onConsult && (fresh => onConsult({ id: card.record.id, title: card.record.title }, fresh)))} />
}

function CardBody({ card, rootPath, sections, source, renderApproval, consult, field, notes, onUnlink }: {
  card: RecordCardView; rootPath: string; sections?: ReactNode; source?: ReactNode; renderApproval?: (approvalId: string) => ReactNode
  consult: ReturnType<typeof consultationLinks>; field: ReactNode; notes: ReactNode; onUnlink: (link: RemovableLink, label: string) => void
}) {
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
  // The 案件 shown at the head is not repeated on the right; where it came from (fixed) has no 「…」.
  const removable = new Map(card.links.flatMap(l => (l.record && l.removable ? [[l.record.id, l.removable] as const] : [])))
  const shownAtHead = field ? new Set(card.links.filter(l => l.bundle && l.record).map(l => l.record!.id)) : new Set<string>()
  const rows = [...linkRows(card.links, rootPath).filter(r => !shownAtHead.has(r.key)).map(r => ({
    ...(turns.has(r.key) ? { ...r, sub: turns.get(r.key) ?? undefined } : r),
    ...(removable.has(r.key) ? { menu: [{ label: 'つながりを外す', hint: '相手の記録は消えません', onClick: () => onUnlink(removable.get(r.key)!, r.label) }] } : {}),
  })), ...consult.rows]
  return (
    <RecordPage testId="record-card" kind={record.thing} name={record.typeLabel} title={record.title} chips={chips} from={from} actions={actions}
      seenBy={card.viewers && <SeenBy who={card.viewers.text} />}
      top={card.ai && <AiBand ai={card.ai} />}
      bottom={<><HistoryFold lines={card.history} /><FieldsFold fields={card.fields} /></>}
      links={<LinkedColumn rows={rows} notice={notes} extras={consult.extra ? [consult.extra] : []} first={record.thing === 'bundle' ? 'task' : undefined} />}>
      {field}
      {body}
      {source}
      {sections}
    </RecordPage>
  )
}
