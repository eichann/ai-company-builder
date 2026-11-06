// A task's card in one file: the press's notices (取り消す, 先に変えた) belong to the card that
// holds its version, so the loader and the body stay together.
import { useMemo, useState, type ReactNode } from 'react'
import { CheckCircle, CircleNotch, Plus, Robot, Sparkle, Warning } from '@phosphor-icons/react'
import { fileNameFromTitle } from '../../../../shared/today-folder'
import { InputDialog } from '../../../shared/ui/InputDialog'
import { runCommand } from '../../../shared/commands/commands'
import type { TaskCardData } from '../../../../shared/task-card'
import type { RecordViewSummary, RemovableLink } from '../../../../shared/record-views'
import type { BundleChoice, RecordLinkInput, TaskActInput } from '../../../../shared/tasks'
import type { BundleKind } from '../../../../../shared/types/records'
import { CALM, ONLY_YOU } from '../../../../shared/thing-words'
import { RecordMarks } from '../../records/components/RecordRows'
import { fileRow, pathFacts, recordRow, type NotDownloadedFolderOf } from '../../records/components/linkRows'
import { consultationLinks, type LinkedConsultation } from '../../../shared/ui/consultationLinks'
import { LinkedColumn, type LinkedRow } from '../../../shared/ui/LinkedColumn'
import { SeenBy } from '../../../shared/ui/ThingIcon'
import { Chip, FieldsFold, HistoryFold, RecordPage } from '../../../shared/ui/RecordPage'
import { actOnTask, createBundle, linkFileToTask, reconcileTaskRun, retryTaskRun, setRecordLink, shareTaskToBundle, shareTaskToFolder, undoTaskAction, unlinkFileFromTask } from '../api'
import { useLinkDrop } from '../../../shared/hooks/useLinkDrop'
import { LinkDropNotice } from '../../../shared/ui/LinkDropNotice'
import { useTaskCard, type CardLook } from '../hooks/useTaskCard'
import { whenDoneLine } from '../cardActions'
import { companyNow } from '../model'
import { RecordSourcePanel } from './RecordSourcePanel'
import { ShareToDepartment, type ShareFolder } from './ShareToDepartment'
import { MinutesReview } from './MinutesReview'
import { TaskActions } from './TaskActions'
import { BundleField } from './BundleField'
import { ShowToBundle } from './ShowToBundle'
import type { NewBundlePlaces } from './NewBundleDialog'
import type { BundlePlace } from '../model'
import { ConfirmDialog } from '../../../shared/ui/ConfirmDialog'
import { ConflictNotice, DoneNotice, DueAndTags, OriginLine } from './TaskHead'
import { TaskFiles } from './TaskFiles'
import { TagField } from './TagField'
import { WaitBand } from './WaitParts'

interface Props {
  companyId: string
  rootPath: string
  /** The caller keys this component by it (never by version: a new version updates the card in place). */
  recordId: string
  /** The version the list knows: newer than the card shows → the card reads again (a press in the list). */
  knownVersion?: number
  /** One thing the AI prepared (a mail draft, an approval request), drawn by the screen with its own card. */
  renderPrepared: (record: RecordViewSummary) => ReactNode
  /** The task's source (the original mail or Slack thread), drawn by the screen (`app/recordSource.tsx`). */
  renderSource: (record: RecordViewSummary) => ReactNode
  /** Business plugins' sections for this record's type (plugin-frame.md "The four slots"), drawn by the screen. */
  renderSections?: (record: RecordViewSummary) => ReactNode
  /** The departments the member can write to, offered by 「部署に出す」 on an owner-only task. */
  shareFolders?: ShareFolder[]
  /** 「相談する」: the member's latest consultation about this task, else a new one (AppShell: `chat.consultAbout`). */
  onConsult?: (record: { id: string; title: string }, fresh?: boolean) => void
  /** ［催促の下書きを作る］ on a task whose 返事の見込み passed (AppShell: `chat.consultAbout` with purpose `nudge`). */
  onNudge?: (record: { id: string; title: string }) => void
  /** Consultations whose main topic is this task (this PC's), listed in 「つながっているもの」. */
  consultations?: readonly LinkedConsultation[]
  /** 「…」→「このやることから外す」 on one of them (AppShell: the chat history's topic taken off). */
  onDetachConsultation?: (sessionId: string) => void
  /** Tags in use in the member's list (most used first), for 「タグの候補」. */
  tagsInUse?: string[]
  /** チームの進め方, when the screen decides it; else the company's setting the card read. */
  team?: boolean
  /** The member changed something (the list reads again). */
  onChanged?: () => void
  /** What the department on screen makes as its 案件・プロジェクト (`tasks:bundleKinds`): its name for ［〇〇につなぐ］ and the kind ［新しい〇〇にする］ makes; null until known. */
  bundleKind?: BundleKind | null
  /** The department's folder a new one is put in (全社: none) when `bundlePlaces` is not given. */
  bundleFolder?: string | null
  /** 「新しい〇〇にする」's departments and default (the member's own department, records.md "A task and its 案件・プロジェクト"). */
  bundlePlaces?: NewBundlePlaces
  /** Read: its title and kind, for its tab in the middle. */
  onLoaded?: (look: CardLook) => void
  /**
   * ［＋ 新しいファイル］ on a task only the member sees (owner decision 2026-11-03): the screen makes the
   * empty file in today's folder (`.personal`, this Mac only) and answers its company path, or why not.
   */
  createTodayFile?: (name: string) => Promise<{ path: string } | { error: string }>
  /** The not-downloaded folder holding a path (a linked folder left out on this computer is marked). */
  notDownloadedFolderOf?: NotDownloadedFolderOf
}

/** What the member's last press left on the card. */
type Notice =
  /** `undo`: the ledger entry 取り消す reverses (on this task, or on the other record holding a link). */
  | { kind: 'done'; text: string; undo: { recordId: string; version: number } | null }
  | { kind: 'conflict'; since: number }

/**
 * A task's card (stage 2 S7c, 新しい画面のデモ C): one main action beside the title, the rest
 * behind 「…」; what the AI prepared, the source, 経緯 and 「つながっているもの」. What is offered
 * comes from the type; the server decides every action.
 */
export function TaskCard({ companyId, rootPath, recordId, knownVersion, renderPrepared, renderSource, renderSections, shareFolders = [], onConsult, onNudge, consultations = [], tagsInUse = [], team, onChanged, bundleKind = null, bundleFolder = null, bundlePlaces, onLoaded, createTodayFile, onDetachConsultation, notDownloadedFolderOf }: Props) {
  const { result, reload, personalHere } = useTaskCard(companyId, recordId, onLoaded, rootPath, knownVersion)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  // 「〇〇と同じ人たちだけに見えるようにしますか？」: a task wider than the 案件 it is being linked to.
  const [narrowing, setNarrowing] = useState<{ word: string; answer: (yes: boolean) => void } | null>(null)
  // A file, folder, record or consultation dropped on 「つながっているもの」 is linked (owner decision 2026-11-03).
  const linkDrop = useLinkDrop({ companyId, rootPath, targetWord: 'やること', onChanged: () => { reload(); onChanged?.() } })
  if (result === null) return <div className="flex h-full items-center justify-center gap-2 text-xs text-gray-400"><CircleNotch size={14} className="animate-spin" />{CALM.loading}</div>
  if (!result.success) return <div role="alert" className="flex h-full items-center justify-center px-6 text-center text-sm text-gray-500 dark:text-zinc-400">{result.error}</div>

  const card = result.card
  const version = card.record.version
  const change = async (fn: () => Promise<string | null>): Promise<string | null> => {
    setBusy(true)
    try {
      return await fn()
    } finally {
      setBusy(false)
      reload()
      onChanged?.()
    }
  }
  const runSteps = (steps: Array<Omit<TaskActInput, 'expectedVersion'>>, done?: string) => change(async () => {
    let at = version
    for (const step of steps) {
      const r = await actOnTask(companyId, recordId, { ...step, expectedVersion: at })
      if (!r.success) {
        // Someone changed it first: the card reads the latest and says what changed (plan H).
        if (r.code === 'VERSION_CONFLICT') { setNotice({ kind: 'conflict', since: at }); return '' }
        return r.error
      }
      at += 1
    }
    // Only a one-step press is undone in one step.
    setNotice(done ? { kind: 'done', text: done, undo: steps.length === 1 ? { recordId, version: at } : null } : null)
    return null
  })
  const undo = (target: { recordId: string; version: number }) => change(async () => {
    const r = await undoTaskAction(companyId, target.recordId, target.version, target.version)
    setNotice(r.success ? { kind: 'done', text: '取り消しました', undo: null } : null)
    return r.success ? null : r.error
  })
  // A link between records set or taken off (the 案件's ［変える］［外す］, a row's 「つながりを外す」), with 取り消す.
  const recordLink = (source: string, input: RecordLinkInput, remove: boolean, done: string) => change(async () => {
    const r = await setRecordLink(companyId, source, input, remove)
    if (!r.success) return r.error
    setNotice({ kind: 'done', text: done, undo: r.entryVersion ? { recordId: source, version: r.entryVersion } : null })
    return null
  })
  // Linking to a 案件・プロジェクト: a task seen by more people than it is narrowed only on the
  // member's yes (records.md "A task and its 案件・プロジェクト"); a no leaves it unlinked.
  const linkBundle = (b: { id: string; title: string; typeLabel?: string }) => change(async () => {
    const input = { link: 'bundle', target: b.id, expectedVersion: version }
    const r = await setRecordLink(companyId, recordId, input, false)
    if (r.success) {
      setNotice({ kind: 'done', text: `「${b.title}」につなぎました`, undo: r.entryVersion ? { recordId, version: r.entryVersion } : null })
      return null
    }
    if (r.code !== 'WIDER_THAN_BUNDLE') return r.error
    const word = b.typeLabel ?? bundleKind?.name ?? 'プロジェクト'
    const yes = await new Promise<boolean>(resolve => setNarrowing({ word, answer: v => { setNarrowing(null); resolve(v) } }))
    if (!yes) return null
    const narrowed = await setRecordLink(companyId, recordId, { ...input, narrow: true }, false)
    if (!narrowed.success) return narrowed.error
    // Narrowing is never undone (it would show the task to more people again): no 取り消す.
    setNotice({ kind: 'done', text: `「${b.title}」につなぎ、${word}と同じ人たちだけに見えるようにしました`, undo: null })
    return null
  })
  const fileLink = (companyPath: string, remove: boolean) => change(async () => {
    const r = await (remove ? unlinkFileFromTask : linkFileToTask)(companyId, recordId, companyPath, version)
    return r.success ? null : r.error
  })
  const share = (folder: string) => change(async () => {
    const r = await shareTaskToFolder(companyId, recordId, folder, version)
    return r.success ? null : r.error
  })
  // 「議事録を確認する」: the meeting's summary, the AI's proposals and its decisions, each pressed on its own record.
  const review = card.review && <MinutesReview companyId={companyId} review={card.review} busy={busy}
    onAct={(id, action, at) => change(async () => { const r = await actOnTask(companyId, id, { action, expectedVersion: at }); return r.success ? null : r.error })} />
  // 「タグ」: who may set tags edits them in place (AI suggestions inside); a typed 案件 name offers ［案件につなぐ］.
  const tagField = <TagField companyId={companyId} title={card.record.title} tags={card.tags} tagsInUse={tagsInUse} canEdit={card.canSetTags} busy={busy}
    onSet={tags => runSteps([{ action: 'set_tags', args: { tags } }])}
    bundleType={bundleFolder ? bundleKind?.type : undefined} linkedBundleId={card.bundle?.id ?? null}
    {...(card.canSetBundle ? { onLinkBundle: (b: BundleChoice) => linkBundle(b) } : {})} />
  const top = notice?.kind === 'conflict'
    ? <ConflictNotice lines={card.history.filter(h => h.version !== undefined && h.version > notice.since).reverse()} />
    : notice?.kind === 'done'
      ? <DoneNotice text={notice.text} busy={busy} onUndo={notice.undo ? () => void undo(notice.undo!) : null} />
      : null
  return <><CardBody card={card} top={top} team={team ?? card.teamMode} review={review} tagField={tagField} rootPath={rootPath} busy={busy} shareFolders={card.record.personal ? shareFolders : []} onShare={share} onConsult={onConsult} onNudge={onNudge} consultations={consultations} onDetachConsultation={onDetachConsultation} renderPrepared={renderPrepared} renderSource={renderSource} renderSections={renderSections} onRun={runSteps}
    linkDrop={linkDrop} notDownloadedFolderOf={notDownloadedFolderOf}
    onLinkFile={p => fileLink(p, false)} onUnlinkFile={p => fileLink(p, true)} personalHere={personalHere}
    {...(card.record.personal && createTodayFile ? { onNewFile: async (name: string) => {
      const made = await createTodayFile(name)
      if ('error' in made) return { error: made.error }
      // Made in today's folder: linked to this task, then opened as the active tab in the middle.
      const failure = await fileLink(made.path, false)
      void runCommand('file.open', { path: `${rootPath}/${made.path}` })
      return { linkError: failure }
    } } : {})}
    companyId={companyId} bundleWord={bundleKind?.name ?? 'プロジェクト'}
    {...(bundlePlaces ? { bundlePlaces } : {})}
    onCreateBundle={bundleKind ? async (title: string, place: BundlePlace | null) => {
      const made = await createBundle(companyId, { type: place?.kind?.type ?? bundleKind.type, title, folder: place ? place.folder : bundleFolder })
      if (!made.success) return made.error
      return linkBundle({ id: made.recordId, title, typeLabel: place?.kind?.name ?? bundleKind.name })
    } : undefined}
    onShowToBundle={() => change(async () => {
      const r = await shareTaskToBundle(companyId, recordId, version)
      return r.success ? null : r.error
    })}
    onUnlinkRecord={(l, label) => recordLink(l.source, { link: l.link, target: l.target, expectedVersion: l.sourceVersion }, true, `「${label}」とのつながりを外しました`)}
    onSetBundle={b => linkBundle(b)}
    onRemoveBundle={() => card.bundle ? recordLink(recordId, { link: 'bundle', target: card.bundle.id, expectedVersion: version }, true, `「${card.bundle.title}」から外しました`) : Promise.resolve(null)}
    onRetry={runId => change(async () => { const r = await retryTaskRun(companyId, runId); return r.success ? null : r.error })}
    onReconcile={(runId, key, done) => change(async () => { const r = await reconcileTaskRun(companyId, runId, key, done); return r.success ? null : r.error })} />
    <ConfirmDialog isOpen={narrowing !== null} title={`${narrowing?.word ?? ''}につなぐ`}
      message={`このやることは、${narrowing?.word ?? ''}より多くの人に見えています。${narrowing?.word ?? ''}と同じ人たちだけに見えるようにしますか？（しない場合は、つなぎません）`}
      confirmText="同じ人たちだけにする" cancelText="つながない" confirmOnEnter={false}
      onConfirm={() => narrowing?.answer(true)} onCancel={() => narrowing?.answer(false)} /></>
}

interface BodyProps {
  card: TaskCardData
  top: ReactNode
  team: boolean
  rootPath: string
  busy: boolean
  renderPrepared: (record: RecordViewSummary) => ReactNode
  renderSource: (record: RecordViewSummary) => ReactNode
  renderSections?: (record: RecordViewSummary) => ReactNode
  onRun: (steps: Array<Omit<TaskActInput, 'expectedVersion'>>, done?: string) => Promise<string | null>
  onRetry: (runId: string) => Promise<string | null>
  onReconcile: (runId: string, key: string, done: boolean) => Promise<string | null>
  linkDrop: ReturnType<typeof useLinkDrop>
  notDownloadedFolderOf?: NotDownloadedFolderOf
  onLinkFile: (companyPath: string) => Promise<string | null>
  onUnlinkFile: (companyPath: string) => Promise<string | null>
  /** Linked `.personal/` files that are on this computer. */
  personalHere: ReadonlySet<string>
  /** ［＋ 新しいファイル］ (a task only the member sees): `error` keeps the name window open. */
  onNewFile?: (name: string) => Promise<{ error: string } | { linkError: string | null }>
  companyId: string
  bundleWord: string
  onCreateBundle?: (title: string, place: BundlePlace | null) => Promise<string | null>
  bundlePlaces?: NewBundlePlaces
  /** ［〇〇の人に見せる］ on a task only the member (or a list) sees that belongs to a 案件・プロジェクト. */
  onShowToBundle: () => Promise<string | null>
  onUnlinkRecord: (link: RemovableLink, label: string) => Promise<string | null>
  onSetBundle: (bundle: BundleChoice) => Promise<string | null>
  onRemoveBundle: () => Promise<string | null>
  /** Offered only for an owner-only task (empty otherwise). */
  shareFolders: ShareFolder[]
  onShare: (folder: string) => Promise<string | null>
  onConsult?: (record: { id: string; title: string }, fresh?: boolean) => void
  onNudge?: (record: { id: string; title: string }) => void
  consultations: readonly LinkedConsultation[]
  onDetachConsultation?: (sessionId: string) => void
  tagField: ReactNode
  review: ReactNode
}

function CardBody({ card, top, team, rootPath, busy, renderPrepared, renderSource, renderSections, onRun, onRetry, onReconcile, linkDrop, notDownloadedFolderOf, onLinkFile, onUnlinkFile, personalHere, onNewFile, companyId, bundleWord, onCreateBundle, bundlePlaces, onShowToBundle, onUnlinkRecord, onSetBundle, onRemoveBundle, shareFolders, onShare, onConsult, onNudge, consultations, onDetachConsultation, tagField, review }: BodyProps) {
  const { record } = card
  const now = useMemo(() => companyNow(Date.now()), [])
  const [runError, setRunError] = useState<string | null>(null)
  const [linkError, setLinkError] = useState<string | null>(null)
  const [unlinked, setUnlinked] = useState<string | null>(null)
  const [naming, setNaming] = useState<{ error: string | null } | null>(null)
  const makeFile = async (name: string) => {
    if (!onNewFile) return
    const r = await onNewFile(name.trim())
    if ('error' in r) { setNaming({ error: r.error }); return }
    setNaming(null)
    setLinkError(r.linkError ? `ファイルは今日のフォルダに作りましたが、つなげませんでした：${r.linkError}` : null)
  }
  const runAction = async (fn: () => Promise<string | null>) => setRunError(await fn())
  const unlink = async (path: string) => {
    const failure = await onUnlinkFile(path)
    setLinkError(failure)
    setUnlinked(failure ? null : path)
  }
  const relink = async (path: string) => {
    const failure = await onLinkFile(path)
    setLinkError(failure)
    if (!failure) setUnlinked(null)
  }
  // The 案件 is at the head of the card, so it is not repeated on the right.
  const rows: LinkedRow[] = [
    ...card.links.flatMap(l => (l.record ? [{
      ...recordRow(l.record, l.label),
      // Where it came from (もとの会議・もとの連絡) has no 「…」: it is history.
      ...(l.removable ? { menu: [{ label: 'つながりを外す', hint: '相手の記録は消えません', onClick: () => { if (!busy) void onUnlinkRecord(l.removable!, l.record!.title).then(setLinkError) } }] } : {}),
    }] : [])),
    ...card.files.map(f => ({
      ...fileRow(rootPath, f.path, f.broken, personalHere.has(f.path), pathFacts(f, notDownloadedFolderOf)),
      menu: [{ label: 'つながりを外す', hint: 'ファイルは消えません。経緯に残ります', onClick: () => { if (!busy) void unlink(f.path) } }],
    })),
  ]
  // 「AIへの相談」 on the right: the consultations about this task, ［相談する］［＋新しい相談］.
  const consult = consultationLinks(consultations, onConsult && (fresh => onConsult({ id: record.id, title: record.title }, fresh)), onDetachConsultation)
  const postpone = card.actions.find(a => a.action === 'set_due')
  const doneLine = whenDoneLine(card)
  const turn = record.state === 'preparing' ? 'AI の番' : null
  return (
    <RecordPage testId="task-card" kind="task" name="やること" title={record.title} top={top}
      chips={<>
        {record.stateLabel && <Chip tone={record.state === 'done' ? 'green' : 'gray'}>{record.stateLabel}</Chip>}
        {turn && <Chip>{turn}</Chip>}
        {/* 「あなただけ」 is said once, top right (見られる人), owner 2026-11-03. */}
        <RecordMarks record={record} personal={false} />
        {card.names.assignee && <span className="text-[11.5px] text-gray-500 dark:text-zinc-400">担当 {card.names.assignee}さん{card.names.requester && !(card.roles.assignee && card.roles.requester) && card.names.requester !== card.names.assignee ? `・頼んだ人 ${card.names.requester}さん` : ''}</span>}
      </>}
      actions={<>
        <TaskActions key={`${record.state}@${record.version}`} card={card} busy={busy} team={team} today={now.date} onRun={onRun} />
      </>}
      from={card.origin && <OriginLine origin={card.origin} />}
      bottom={<><HistoryFold lines={card.history} /><FieldsFold fields={card.fields} /></>}
      seenBy={card.viewers ? <SeenBy who={card.viewers.text} /> : record.personal ? <SeenBy who={ONLY_YOU} /> : null}
      links={<LinkedColumn rows={[...rows, ...consult.rows]}
        extras={[{ name: 'ファイル', kind: 'file', action: <>
          <TaskFiles rootPath={rootPath} linked={card.files.map(f => f.path)} busy={busy} onLink={onLinkFile} />
          {onNewFile && <button type="button" disabled={busy} onClick={() => setNaming({ error: null })} data-new-file className="ml-1 mt-0.5 inline-flex items-center gap-0.5 rounded px-1 text-[11.5px] text-accent hover:underline disabled:opacity-50"><Plus size={10} />新しいファイル</button>}
        </>, note: 'つながりは、このやることを見られる人みんなに見えます' }, ...(consult.extra ? [consult.extra] : [])]}
        drop={{ label: `ファイル・フォルダ・やること・${bundleWord}・相談`, accepts: linkDrop.accepts, onDrop: e => { linkDrop.drop(record.id, e) },
          notice: <LinkDropNotice notice={linkDrop.notice} busy={linkDrop.busy} /> }}
        notice={<>
          {linkError && <p role="alert" className="text-[11.5px] text-red-600 dark:text-red-400">{linkError}</p>}
          {unlinked && (
            <p role="status" className="flex flex-wrap items-center gap-1 rounded-md bg-gray-100 px-2 py-1 text-[11.5px] dark:bg-zinc-800">
              「{unlinked.split('/').pop()}」とのつながりを外しました
              <button type="button" disabled={busy} onClick={() => void relink(unlinked)} className="text-accent hover:underline">取り消す</button>
            </p>
          )}
        </>} />}>
      {doneLine && <p className="text-[11.5px] text-gray-500 dark:text-zinc-400">{doneLine}</p>}
      <WaitBand key={`${record.state}@${record.version}`} card={card} today={now.date} busy={busy} onRun={onRun} {...(onNudge ? { onNudge: () => onNudge({ id: record.id, title: record.title }) } : {})} />
      {card.okLine && <p className="flex items-center gap-1.5 rounded-md bg-emerald-500/10 px-2 py-1 text-[12.5px] text-emerald-800 dark:text-emerald-300"><CheckCircle size={14} weight="fill" />{card.okLine}</p>}

      {(card.prepSummary || card.prepared.length > 0) && (
        <section aria-label="AI が用意したもの" className="space-y-2 rounded-xl border border-accent/30 bg-accent/5 p-3">
          <h2 className="flex items-center gap-1.5 text-[12px] font-semibold"><Sparkle size={13} weight="fill" className="text-accent" />AI が用意したもの</h2>
          {card.prepSummary && <p className="whitespace-pre-wrap text-[12.5px] text-gray-700 dark:text-zinc-200">{card.prepSummary}</p>}
          {card.prepared.map(p => <div key={p.id}>{renderPrepared(p)}</div>)}
        </section>
      )}

      {review}

      {card.runs.length > 0 && (
        <section aria-label="AI が止まっています" className="space-y-2 rounded-xl border border-amber-500/40 bg-amber-500/5 p-3 text-[12.5px]">
          {card.runs.map(run => (
            <div key={run.runId} className="space-y-1.5">
              <p className="flex items-center gap-1.5"><Warning size={14} className="text-amber-500" />{run.label}</p>
              {run.unknown.map(op => (
                <div key={op.key} className="flex flex-wrap items-center gap-2 pl-5">
                  <span className="text-gray-600 dark:text-zinc-300">送った先で確かめてください：</span>
                  <button type="button" disabled={busy} onClick={() => void runAction(() => onReconcile(run.runId, op.key, true))} className="rounded border border-gray-300 px-2 py-0.5 text-[11.5px] dark:border-zinc-600">届いていた</button>
                  <button type="button" disabled={busy} onClick={() => void runAction(() => onReconcile(run.runId, op.key, false))} className="rounded border border-gray-300 px-2 py-0.5 text-[11.5px] dark:border-zinc-600">届いていなかった</button>
                </div>
              ))}
              {run.canRetry && <button type="button" disabled={busy} onClick={() => void runAction(() => onRetry(run.runId))} className="ml-5 rounded border border-gray-300 px-2 py-0.5 text-[11.5px] dark:border-zinc-600"><Robot size={11} className="mr-1 inline" />もう一度</button>}
            </div>
          ))}
          {runError && <p role="alert" className="text-red-600 dark:text-red-400">{runError}</p>}
        </section>
      )}

      <BundleField companyId={companyId} bundle={card.bundle} word={bundleWord} canSet={card.canSetBundle} busy={busy} onSet={onSetBundle} onRemove={onRemoveBundle}
        {...(bundlePlaces ? { places: bundlePlaces } : {})}
        {...(onCreateBundle ? { newFrom: { title: record.title, titleNote: 'やることの件名から入れました', counterpart: null, homework: 0 }, onCreate: (title: string, _h: boolean, place: BundlePlace | null) => onCreateBundle(title, place) } : {})} />
      {card.bundle && (record.personal || record.membersOnly) && <ShowToBundle bundle={card.bundle} busy={busy} onShow={onShowToBundle} />}
      <DueAndTags card={card} now={now} busy={busy} tagField={tagField}
        onPostpone={postpone ? due => void onRun([{ action: 'set_due', args: { due } }], card.names.requester && !card.roles.requester ? `期限を延ばしました。頼んだ${card.names.requester}さんに知らせました` : '期限を延ばしました') : null} />
      {card.purpose && <p className="whitespace-pre-wrap text-[13px] text-gray-600 dark:text-zinc-300"><span className="mr-1.5 text-[11px] text-gray-500">目的</span>{card.purpose}</p>}
      <ShareToDepartment folders={shareFolders} busy={busy} onShare={onShare} />
      {/* もとの連絡: only for a task that came from one (no read, no 「読み込んでいます」 on every task). */}
      <RecordSourcePanel record={record}>{card.fromIncoming ? renderSource(record) : null}</RecordSourcePanel>
      {renderSections?.(record)}
      <InputDialog isOpen={naming !== null} title="新しいファイル（今日のフォルダ・あなたの Mac だけ）" defaultValue={fileNameFromTitle(record.title)}
        placeholder="メモ.md" error={naming?.error ?? null} onConfirm={makeFile} onCancel={() => setNaming(null)} />
    </RecordPage>
  )
}
