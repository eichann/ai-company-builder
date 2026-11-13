import { FEATURE_OFF_DETAIL, FEATURE_OFF_NOTE } from '../../../../../shared/core/features'
import { useState, type ReactNode } from 'react'
import { CircleNotch } from '@phosphor-icons/react'
import type { RecordCardView, RecordViewSummary, RemovableLink } from '../../../../shared/record-views'
import { CALM, ONLY_YOU } from '../../../../shared/thing-words'
import { bundleDoneWords, meetingSeenWords, type BundleAction } from '../../../../shared/record-details'
import { consultationLinks, type LinkedConsultation } from '../../../shared/ui/consultationLinks'
import { LinkedColumn, type LinkedDrop } from '../../../shared/ui/LinkedColumn'
import { LinkDropNotice } from '../../../shared/ui/LinkDropNotice'
import { useLinkDrop } from '../../../shared/hooks/useLinkDrop'
import { SeenBy } from '../../../shared/ui/ThingIcon'
import { Chip, FieldsFold, HistoryFold, RecordPage } from '../../../shared/ui/RecordPage'
import { ProjectParticipants } from './ProjectParticipants'
import { actOnRecord, undoRecordChange, unlinkRecord } from '../api'
import { useRecordCard } from '../hooks/useRecordCard'
import { AiBand, BundleBody } from './BundleBody'
import { BundleActions, type BundleActInput } from './BundleActions'
import { linkRows, meetingOpenRows, type NotDownloadedFolderOf } from './linkRows'
import { IncomingActions, IncomingBody, IncomingLine, MeetingLine, MeetingOutputs, MeetingSummary, OpenButton, ReplyRequestActions } from './RecordDetails'
import { RecordMarks } from './RecordRows'
import { useDriveLinking } from '../../../shared/hooks/useDriveLinking'
import { DriveLinkAction } from '../../../shared/ui/DriveLinkAction'
import { driveFileRows } from '../../../shared/ui/driveFileRows'
import { unlinkTypedFile } from '../../../shared/ipc/drive-links'
import { droppedText, driveFilesNote, mayCarryLink } from '../../../../shared/drive-links'
import type { TaskDriveLinkOptions } from '../../../../shared/tasks'
import type { LinkedGroupExtra, LinkedRow } from '../../../shared/ui/LinkedColumn'

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
  /** The not-downloaded folder holding a path (a linked folder left out on this computer is marked). */
  notDownloadedFolderOf?: NotDownloadedFolderOf
  /** A meeting's middle in its order: the card's parts with its own buttons and proposals (minutes.md "Meetings for their attendees"), drawn by the screen. */
  renderMeeting?: (record: RecordViewSummary, parts: MeetingCardParts) => ReactNode
  /**
   * The member ended it here — a 来た連絡's ［済んだ］, a 返事のお願い's ［終わりにする］ / ［もう返した］ (owner FB
   * #29), a 案件・プロジェクト's ［終える］ / ［やめる］ (owner FB #30): AppShell closes its tab in the middle and its
   * automatic consultations. Not ［取り込まない］, not ［もう一度始める］.
   */
  onEnded?: (recordId: string) => void
}

/** The card's parts the screen places around a meeting's own buttons and proposals. */
export interface MeetingCardParts {
  summary: ReactNode
  /** 決めたこと and やること as plain lists, where the screen has no proposals to show. */
  outputs: ReactNode
  /** The 案件・プロジェクト field. */
  bundle: ReactNode
  /** The tasks its reading made, proposals and tasks alike (not its 「議事録を確認する」). */
  tasks: RecordViewSummary[]
  /** Something it shows changed: the card reads again. */
  onChanged: () => void
}

/** What the screen's 案件・プロジェクト field gets: the record, its current one, and how to say what changed. */
export interface BundleFieldContext {
  record: RecordViewSummary
  version: number
  bundle: RecordViewSummary | null
  /** Taking the current one off (absent when its link cannot be removed by hand). */
  removable: RemovableLink | null
  /** The record's 相手 (its `counterpart` link), for a new one's 相手. */
  counterpart: { id: string; title: string } | null
  /** A meeting's 宿題: the tasks made from it, at their versions (to put into a new one). */
  homework: Array<{ id: string; version: number }>
  /** After a change: the card reads again and says `text`, with 取り消す of `undo` when given. */
  onChanged: (text: string, undo: { recordId: string; version: number } | null) => void
}

/**
 * The card a record opens in when it has no screen of its own (read only), with a meeting's, a
 * 来た連絡's and a 案件・プロジェクト's own parts: what it is, its body, fields and 経緯 folded, the AI
 * working on it, and 「つながっているもの」.
 */
export function RecordCard({ companyId, rootPath, recordId, renderSections, renderSource, onLoaded, renderApproval, consultations = [], onConsult, renderBundleField, notDownloadedFolderOf, renderMeeting, onEnded }: Props) {
  const { result, reload } = useRecordCard(companyId, recordId, onLoaded)
  const [notice, setNotice] = useState<{ text: string; undo: { recordId: string; version: number } | null } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // A file, folder, record or consultation dropped on 「つながっているもの」 is linked (owner decision 2026-11-03).
  const linkDrop = useLinkDrop({ companyId, rootPath, targetWord: result?.success ? result.card.record.typeLabel : '記録', onChanged: reload })
  // A 案件・プロジェクト with a file link: ［Google Drive のファイルをつなぐ］ as on the task card (owner decision 2026-11-13).
  const driveOn = result?.success === true && result.card.driveLink === true
  const drive = useDriveLinking(companyId, driveOn)
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
  // A 来た連絡's ［済んだ］ / ［取り込まない］, a 返事のお願い's ［終わりにする］ / ［もう返した］, at the version
  // shown (a run of the AI that wrote meanwhile makes it refused: the card reads again); 取り消す undoes that one entry.
  const DONE_WORDS = { settle: '済んだにしました', drop: 'やることにしなかった一覧に移しました', close: '終わりにしました', replied_elsewhere: '「もう返した」で終わりにしました' } as const
  // The ones that end it (its tab and automatic consultations close); 取り込まない only moves it aside.
  const ENDING_ACTIONS = new Set<keyof typeof DONE_WORDS>(['settle', 'close', 'replied_elsewhere'])
  const act = async (action: keyof typeof DONE_WORDS) => {
    if (card.version === undefined) return
    setBusy(true)
    const r = await actOnRecord(companyId, card.record.id, action, card.version)
    setBusy(false)
    if (!r.success) { setError(r.error); reload(); return }
    // 「もう返した」 also put its drafts away (the inbox's follow-up): taking the close back would not bring them back.
    changed(DONE_WORDS[action], action === 'replied_elsewhere' ? null : { recordId: card.record.id, version: card.version + 1 })
    if (ENDING_ACTIONS.has(action)) onEnded?.(card.record.id)
  }
  // A 案件・プロジェクト's buttons (owner FB #30), at the version shown; one that ends it (into a final state of
  // its type: 終える, やめる) also ends it on the screen, like ENDING_ACTIONS. 取り消す undoes that one entry.
  const actBundle = async (a: BundleAction, input: BundleActInput): Promise<string | null> => {
    if (card.version === undefined) return null
    setBusy(true)
    const r = await actOnRecord(companyId, card.record.id, a.action, card.version, input)
    setBusy(false)
    // The refusal is said where it was pressed (its window, or beside the buttons); the card reads again.
    if (!r.success) { reload(); return r.error }
    changed(bundleDoneWords(a, card.record.type), { recordId: card.record.id, version: card.version + 1 })
    if (a.ends) onEnded?.(card.record.id)
    return null
  }
  const unsettle = async () => {
    if (card.version === undefined) return
    setBusy(true)
    await undo({ recordId: card.record.id, version: card.version })
    setBusy(false)
  }
  // 「見るだけ」 (its feature is off, records.md "Features on and off"): nothing to press on this card.
  const viewOnly = card.featureOff === true
  const incoming = viewOnly ? null : card.detail?.kind === 'incoming' && card.version !== undefined
    ? <IncomingActions m={card.detail} busy={busy} onAct={a => void act(a)} onUndo={() => void unsettle()}
      openReplies={card.links.filter(l => l.record?.type === 'reply_request' && !l.record.finished).length} />
    : card.detail?.kind === 'reply' && card.version !== undefined
      ? <ReplyRequestActions m={card.detail} busy={busy} onAct={a => void act(a)} />
      : card.detail?.kind === 'bundle' && card.detail.actions && card.version !== undefined
        ? <BundleActions actions={card.detail.actions} busy={busy} onAct={actBundle} />
        : null
  const bundleLink = card.links.find(l => l.bundle && l.record)
  const field = !viewOnly && renderBundleField && (card.detail?.kind === 'meeting' || card.detail?.kind === 'incoming') && card.version !== undefined
    ? renderBundleField({
      record: card.record, version: card.version, bundle: bundleLink?.record ?? null, removable: bundleLink?.removable ?? null, onChanged: changed,
      counterpart: card.links.flatMap(l => (l.counterpart && l.record ? [{ id: l.record.id, title: l.record.title }] : []))[0] ?? null,
      homework: card.detail?.kind === 'meeting' ? card.links.flatMap(l => (l.record?.thing === 'task' && !l.record.minutesReview && l.recordVersion !== undefined && !l.record.finished ? [{ id: l.record.id, version: l.recordVersion }] : [])) : [],
    })
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
  // Google Drive files (records.md "Drive and PC file links"): the member's own list or Google's chooser, a pasted /
  // dropped link opening the chooser on that file; each linked at the version the previous one moved to.
  const linkDrive = async (options?: TaskDriveLinkOptions): Promise<string | null> => {
    if (card.version === undefined) return null
    setBusy(true)
    setError(null)
    let r: Awaited<ReturnType<typeof drive.link>>
    try {
      r = await drive.link(card.record.id, card.version, options)
    } finally {
      setBusy(false)
    }
    if (r.done) changed(r.done, null)
    else reload()
    return r.error
  }
  const linkDriveText = (text: string) => {
    // While the chooser is open (busy), another link would open a second chooser window.
    if (busy) return
    const read = drive.fromText(text)
    if ('options' in read) void linkDrive(read.options).then(e => { if (e) setError(e) })
    else setError(read.error)
  }
  const unlinkDrive = async (fileId: string, label: string) => {
    if (card.version === undefined) return
    setBusy(true)
    let r: Awaited<ReturnType<typeof unlinkTypedFile>>
    try {
      r = await unlinkTypedFile(companyId, card.record.id, { kind: 'drive', fileId }, card.version)
    } finally {
      setBusy(false)
    }
    if (!r.success) { setError(r.error); reload(); return }
    // Linked again through the chooser, not 取り消す (as on the task card).
    changed(`「${label}」とのつながりを外しました`, null)
  }
  const driveRows = driveFileRows(card.driveFiles ?? [], busy, viewOnly ? undefined : (fileId, label) => void unlinkDrive(fileId, label))
  const driveExtra: LinkedGroupExtra | null = driveOn && !viewOnly ? {
    name: 'ファイル', kind: 'file',
    action: <DriveLinkAction companyId={companyId} linked={(card.driveFiles ?? []).map(f => f.fileId)} busy={busy} usable={drive.usable} note={drive.note} hint={drive.hint}
      onLink={chosen => linkDrive(chosen ? { chosen } : undefined)} onLinkText={linkDriveText} />,
    note: driveFilesNote(card.record.typeLabel),
  } : null
  const participants = card.privateFolder && card.participants
    ? <ProjectParticipants companyId={companyId} card={{ privateFolder: card.privateFolder, participants: card.participants, viewers: card.viewers, record: card.record }} onChanged={reload} />
    : null
  return <CardBody participants={participants} card={card} rootPath={rootPath} incoming={incoming} renderMeeting={viewOnly ? undefined : renderMeeting} onReload={reload} sections={renderSections?.(card.record)} source={renderSource?.(card.record)} renderApproval={renderApproval}
    field={field} notes={notes} notDownloadedFolderOf={notDownloadedFolderOf} driveRows={driveRows} driveExtra={driveExtra}
    drop={{ label: `ファイル・フォルダ・${driveExtra ? 'Drive のリンク・' : ''}やること・相談`,
      // A Drive link dragged from the browser is linked too, where the card offers Drive.
      accepts: e => linkDrop.accepts(e) || (!!driveExtra && !busy && mayCarryLink(e.dataTransfer)),
      onDrop: e => { if (linkDrop.accepts(e) || !driveExtra) linkDrop.drop(card.record.id, e); else linkDriveText(droppedText(e.dataTransfer)) },
      notice: <LinkDropNotice notice={linkDrop.notice} busy={linkDrop.busy} /> }} onUnlink={(link, label) => void unlink(link, label)}
    consult={consultationLinks(consultations, onConsult && (fresh => onConsult({ id: card.record.id, title: card.record.title }, fresh)))} />
}

function CardBody({ card, rootPath, incoming, renderMeeting, onReload, sections, source, renderApproval, consult, field, notes, drop, notDownloadedFolderOf, onUnlink, participants, driveRows, driveExtra }: {
  /** Linked Google Drive files' rows, and ［Google Drive のファイルをつなぐ］ where the card offers it. */
  driveRows: LinkedRow[]
  driveExtra: LinkedGroupExtra | null
  /** A 非公開 案件・プロジェクト's 参加者 (`ProjectParticipants`). */
  participants?: ReactNode
  drop: LinkedDrop
  /** A 来た連絡's ［済んだ］ and its 「…」 (`IncomingActions`), a 返事のお願い's ［終わりにする］, or a 案件・プロジェクト's ［終える］ (`BundleActions`), beside the title. */
  incoming: ReactNode
  renderMeeting?: Props['renderMeeting']
  onReload: () => void
  notDownloadedFolderOf?: NotDownloadedFolderOf
  card: RecordCardView; rootPath: string; sections?: ReactNode; source?: ReactNode; renderApproval?: (approvalId: string) => ReactNode
  consult: ReturnType<typeof consultationLinks>; field: ReactNode; notes: ReactNode; onUnlink: (link: RemovableLink, label: string) => void
}) {
  const { record, detail } = card
  const [historyOpen, setHistoryOpen] = useState(false)
  const linked = card.links.flatMap(l => (l.record ? [l.record] : []))
  const chips = <>
    {record.stateLabel && <Chip tone="accent">{record.stateLabel}</Chip>}
    {detail?.kind === 'incoming' && detail.needsReply && <Chip tone="amber">返事が要る</Chip>}
    <RecordMarks record={record} personal={false} />
  </>
  let from: ReactNode = null
  let actions: ReactNode = null
  let body: ReactNode = record.summary ? <p className="whitespace-pre-wrap text-[14px] leading-relaxed">{record.summary}</p> : null
  if (detail?.kind === 'meeting') {
    from = <MeetingLine m={detail} />
    const decisions = linked.filter(r => r.thing === 'decision')
    const tasks = linked.filter(r => r.thing === 'task' && !r.minutesReview)
    const summary = <MeetingSummary m={detail} />
    const outputs = <MeetingOutputs decisions={decisions} tasks={tasks} />
    body = renderMeeting ? renderMeeting(record, { summary, outputs, bundle: field, tasks, onChanged: onReload }) : <>{summary}{outputs}{field}</>
  } else if (detail?.kind === 'incoming') {
    from = <IncomingLine m={detail} />
    actions = <>{incoming}{detail.open && <OpenButton link={detail.open} />}</>
    body = <IncomingBody m={detail} />
  } else if (detail?.kind === 'bundle') {
    actions = incoming
    body = <>{participants}<BundleBody b={detail} renderApproval={renderApproval} /></>
  } else if (detail?.kind === 'reply') {
    actions = incoming
  }
  // A bundle's やること say whose turn they are on the right too.
  const turns = new Map(detail?.kind === 'bundle' ? detail.groups.flatMap(g => g.tasks.map(t => [t.id, t.turn] as const)) : [])
  // The 案件 shown at the head is not repeated on the right; where it came from (fixed) has no 「…」.
  const removable = new Map(card.links.flatMap(l => (l.record && l.removable ? [[l.record.id, l.removable] as const] : [])))
  const shownAtHead = field ? new Set(card.links.filter(l => l.bundle && l.record).map(l => l.record!.id)) : new Set<string>()
  const rows = [...linkRows(card.links, rootPath, notDownloadedFolderOf).filter(r => !shownAtHead.has(r.key)).map(r => ({
    ...(turns.has(r.key) ? { ...r, sub: turns.get(r.key) ?? undefined } : r),
    ...(removable.has(r.key) ? { menu: [{ label: 'つながりを外す', hint: '相手の記録は消えません', onClick: () => onUnlink(removable.get(r.key)!, r.label) }] } : {}),
  })), ...driveRows, ...(detail?.kind === 'meeting' ? meetingOpenRows(detail) : []), ...consult.rows]
  // A meeting's chip says the AI has read it: the band stays only while the AI works.
  const ai = detail?.kind === 'meeting' && !card.ai?.working ? null : card.ai
  return (
    <RecordPage testId="record-card" kind={record.thing} name={record.typeLabel} title={record.title} chips={chips} from={from} actions={actions}
      seenBy={card.viewers ? <SeenBy who={detail?.kind === 'meeting' ? meetingSeenWords(detail.attendees.length, card.viewers) : card.viewers.text} /> : record.personal ? <SeenBy who={ONLY_YOU} /> : null}
      top={card.featureOff || ai ? <>{card.featureOff && <FeatureOffBand />}{ai && <AiBand ai={ai} onShowHistory={() => setHistoryOpen(true)} />}</> : null}
      bottomLast={detail?.kind === 'meeting'}
      bottom={<><HistoryFold lines={card.history} open={historyOpen} onToggle={setHistoryOpen} /><FieldsFold fields={card.fields} /></>}
      links={<LinkedColumn rows={rows} notice={notes} drop={drop} extras={[...(driveExtra ? [driveExtra] : []), ...(consult.extra ? [consult.extra] : [])]} first={record.thing === 'bundle' ? 'task' : undefined} />}>
      {detail?.kind !== 'meeting' && field}
      {body}
      {source}
      {sections}
    </RecordPage>
  )
}

/** 「この機能は今オフです」: the record stays to read; the company turned its feature off (owner decision 2026-11-07). */
function FeatureOffBand() {
  return (
    <p data-testid="feature-off" role="note" className="mb-3 rounded-md bg-gray-100 px-3 py-2 text-[12.5px] leading-relaxed text-gray-700 dark:bg-zinc-800 dark:text-zinc-300">
      <span className="font-medium">{FEATURE_OFF_NOTE}</span>
      <span className="block text-[11.5px] text-gray-500 dark:text-zinc-400">{FEATURE_OFF_DETAIL}</span>
    </p>
  )
}
