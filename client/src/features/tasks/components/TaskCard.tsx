import { useMemo, useState, type DragEvent, type ReactNode } from 'react'
import { ChatCircleDots, CheckCircle, CircleNotch, Clock, Robot, Sparkle, Warning } from '@phosphor-icons/react'
import type { TaskCardData } from '../../../../shared/task-card'
import type { RecordViewSummary } from '../../../../shared/record-views'
import type { TaskActInput } from '../../../../shared/tasks'
import { RecordMarks } from '../../records/components/RecordRows'
import { fileRow, recordRow } from '../../records/components/linkRows'
import { LinkedColumn, type LinkedRow } from '../../../shared/ui/LinkedColumn'
import { Chip, FieldsFold, HistoryFold, RecordPage } from '../../../shared/ui/RecordPage'
import { actOnTask, linkFileToTask, reconcileTaskRun, retryTaskRun, shareTaskToFolder, unlinkFileFromTask } from '../api'
import { draggedFilePaths, isFileTreeDrag } from '../../../shared/lib/dragTypes'
import { useTaskCard } from '../hooks/useTaskCard'
import { companyNow, companyPathOf, dueText, dueWhen } from '../model'
import { RecordSourcePanel } from './RecordSourcePanel'
import { ShareToDepartment, type ShareFolder } from './ShareToDepartment'
import { TaskActions } from './TaskActions'
import { TaskFiles } from './TaskFiles'
import { TagSuggestions } from './TagSuggestions'

interface Props {
  companyId: string
  rootPath: string
  /** The caller keys this component by it. */
  recordId: string
  /** One thing the AI prepared (a mail draft, an approval request), drawn by the screen with its own card. */
  renderPrepared: (record: RecordViewSummary) => ReactNode
  /** The task's source (the original mail or Slack thread), drawn by the screen (`app/recordSource.tsx`). */
  renderSource: (record: RecordViewSummary) => ReactNode
  /** Business plugins' sections for this record's type (plugin-frame.md "The four slots"), drawn by the screen. */
  renderSections?: (record: RecordViewSummary) => ReactNode
  /** The departments the member can write to, offered by 「部署に出す」 on an owner-only task. */
  shareFolders?: ShareFolder[]
  /** 「相談する」: the member's latest consultation about this task, else a new one (AppShell: `chat.consultAbout`). */
  onConsult?: (record: { id: string; title: string }) => void
  /** Tags in use in the member's list (most used first), for 「タグの候補」. */
  tagsInUse?: string[]
  /** The member changed something (the list reads again). */
  onChanged?: () => void
}

/**
 * A task's card (stage 2 S7c): what the AI prepared on top, then what the member can do, the
 * source (stage 3), 経緯 and 「つながっているもの」. What is offered comes from the type; the
 * server decides every action.
 */
export function TaskCard({ companyId, rootPath, recordId, renderPrepared, renderSource, renderSections, shareFolders = [], onConsult, tagsInUse = [], onChanged }: Props) {
  const { result, reload } = useTaskCard(companyId, recordId)
  const [busy, setBusy] = useState(false)
  if (result === null) return <div className="flex h-full items-center justify-center gap-2 text-xs text-gray-400"><CircleNotch size={14} className="animate-spin" />読み込んでいます</div>
  if (!result.success) return <div role="alert" className="flex h-full items-center justify-center px-6 text-center text-sm text-gray-500 dark:text-zinc-400">{result.error}</div>

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
  const runSteps = (card: TaskCardData) => (steps: Array<Omit<TaskActInput, 'expectedVersion'>>) => change(async () => {
    let version = card.record.version
    for (const step of steps) {
      const r = await actOnTask(companyId, recordId, { ...step, expectedVersion: version })
      if (!r.success) return r.error
      version += 1
    }
    return null
  })
  const version = result.card.record.version
  const fileLink = (companyPath: string, remove: boolean) => change(async () => {
    const r = await (remove ? unlinkFileFromTask : linkFileToTask)(companyId, recordId, companyPath, version)
    return r.success ? null : r.error
  })
  const share = (folder: string) => change(async () => {
    const r = await shareTaskToFolder(companyId, recordId, folder, version)
    return r.success ? null : r.error
  })
  const card = result.card
  const tagSuggestions = card.canSetTags
    ? <TagSuggestions companyId={companyId} title={card.record.title} tags={card.tags} tagsInUse={tagsInUse} busy={busy}
      onSet={tags => runSteps(card)([{ action: 'set_tags', args: { tags } }])} />
    : null
  return <CardBody card={result.card} tagSuggestions={tagSuggestions} rootPath={rootPath} busy={busy} shareFolders={result.card.record.personal ? shareFolders : []} onShare={share} onConsult={onConsult} renderPrepared={renderPrepared} renderSource={renderSource} renderSections={renderSections} onRun={runSteps(result.card)}
    onLinkFile={p => fileLink(p, false)} onUnlinkFile={p => fileLink(p, true)}
    onRetry={runId => change(async () => { const r = await retryTaskRun(companyId, runId); return r.success ? null : r.error })}
    onReconcile={(runId, key, done) => change(async () => { const r = await reconcileTaskRun(companyId, runId, key, done); return r.success ? null : r.error })} />
}

interface BodyProps {
  card: TaskCardData
  rootPath: string
  busy: boolean
  renderPrepared: (record: RecordViewSummary) => ReactNode
  renderSource: (record: RecordViewSummary) => ReactNode
  renderSections?: (record: RecordViewSummary) => ReactNode
  onRun: (steps: Array<Omit<TaskActInput, 'expectedVersion'>>) => Promise<string | null>
  onRetry: (runId: string) => Promise<string | null>
  onReconcile: (runId: string, key: string, done: boolean) => Promise<string | null>
  onLinkFile: (companyPath: string) => Promise<string | null>
  onUnlinkFile: (companyPath: string) => Promise<string | null>
  /** Offered only for an owner-only task (empty otherwise). */
  shareFolders: ShareFolder[]
  onShare: (folder: string) => Promise<string | null>
  onConsult?: (record: { id: string; title: string }) => void
  tagSuggestions: ReactNode
}

function CardBody({ card, rootPath, busy, renderPrepared, renderSource, renderSections, onRun, onRetry, onReconcile, onLinkFile, onUnlinkFile, shareFolders, onShare, onConsult, tagSuggestions }: BodyProps) {
  const { record } = card
  const now = useMemo(() => companyNow(Date.now()), [])
  const [runError, setRunError] = useState<string | null>(null)
  const dueSoon = card.due ? dueWhen(card.due, now) : 'none'
  const [linkError, setLinkError] = useState<string | null>(null)
  const [unlinked, setUnlinked] = useState<string | null>(null)
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
  // A file dragged from the file tree onto 「つながっているもの」 is linked (the first one; one link per drop).
  const drop = async (e: DragEvent) => {
    const path = draggedFilePaths(e.dataTransfer).map(p => companyPathOf(p, rootPath)).find((p): p is string => p !== null)
    if (path) setLinkError(await onLinkFile(path))
  }
  const rows: LinkedRow[] = [
    ...card.links.flatMap(l => (l.record ? [recordRow(l.record, l.label)] : [])),
    ...card.files.map(f => ({
      ...fileRow(rootPath, f.path, f.broken),
      menu: [{ label: 'つながりを外す', hint: 'ファイルは消えません。経緯に残ります', onClick: () => { if (!busy) void unlink(f.path) } }],
    })),
  ]
  const unlinkedName = unlinked?.split('/').pop()
  return (
    <RecordPage testId="task-card" kind="task" name="やること" title={record.title}
      chips={<>
        {record.stateLabel && <Chip tone="accent">{record.stateLabel}</Chip>}
        <RecordMarks record={record} />
        {card.tags.map(t => <span key={t} className="rounded bg-gray-100 px-1 text-[10px] dark:bg-zinc-800">#{t}</span>)}
      </>}
      actions={onConsult && (
        <button type="button" onClick={() => onConsult({ id: record.id, title: record.title })} title="このやることについて AI に相談します（前の相談があれば、それを開きます）"
          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-gray-300 px-2 py-0.5 text-[12px] text-gray-700 hover:border-accent hover:text-accent dark:border-zinc-600 dark:text-zinc-200">
          <ChatCircleDots size={13} />相談する
        </button>
      )}
      from={card.purpose && <p className="whitespace-pre-wrap text-[13px] text-gray-600 dark:text-zinc-300">{card.purpose}</p>}
      bottom={<><HistoryFold lines={card.history} /><FieldsFold fields={card.fields} /></>}
      links={<LinkedColumn rows={rows}
        extras={[{ name: 'ファイル', kind: 'file', action: <TaskFiles rootPath={rootPath} linked={card.files.map(f => f.path)} busy={busy} onLink={onLinkFile} />, note: 'つながりは、このやることを見られる人みんなに見えます' }]}
        drop={{ label: 'ここにファイルをドロップしてつなぐ', accepts: e => isFileTreeDrag(e.dataTransfer), onDrop: e => void drop(e) }}
        notice={<>
          {linkError && <p role="alert" className="text-[11.5px] text-red-600 dark:text-red-400">{linkError}</p>}
          {unlinked && (
            <p role="status" className="flex flex-wrap items-center gap-1 rounded-md bg-gray-100 px-2 py-1 text-[11.5px] dark:bg-zinc-800">
              「{unlinkedName}」とのつながりを外しました
              <button type="button" disabled={busy} onClick={() => void relink(unlinked)} className="text-accent hover:underline">取り消す</button>
            </p>
          )}
        </>} />}>
      {card.due && (
        <p className={`flex items-center gap-1 text-[13px] ${dueSoon === 'overdue' ? 'text-red-600 dark:text-red-400' : 'text-gray-600 dark:text-zinc-300'}`}>
          <Clock size={13} />{dueSoon === 'overdue' ? '期限切れ ' : '期限 '}{dueText(card.due, now)}
        </p>
      )}
      {tagSuggestions}
      <ShareToDepartment folders={shareFolders} busy={busy} onShare={onShare} />
      {card.okLine && <p className="flex items-center gap-1.5 rounded-md bg-emerald-500/10 px-2 py-1 text-[12.5px] text-emerald-800 dark:text-emerald-300"><CheckCircle size={14} weight="fill" />{card.okLine}</p>}

      {(card.prepSummary || card.prepared.length > 0) && (
        <section aria-label="AI が用意したもの" className="space-y-2 rounded-xl border border-accent/30 bg-accent/5 p-3">
          <h2 className="flex items-center gap-1.5 text-[12px] font-semibold"><Sparkle size={13} weight="fill" className="text-accent" />AI が用意したもの</h2>
          {card.prepSummary && <p className="whitespace-pre-wrap text-[12.5px] text-gray-700 dark:text-zinc-200">{card.prepSummary}</p>}
          {card.prepared.map(p => <div key={p.id}>{renderPrepared(p)}</div>)}
        </section>
      )}

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

      <TaskActions key={`${record.state}@${record.version}`} card={card} now={now} busy={busy} onRun={onRun} />
      <RecordSourcePanel record={record}>{renderSource(record)}</RecordSourcePanel>
      {renderSections?.(record)}
    </RecordPage>
  )
}
