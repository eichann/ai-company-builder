import { useMemo, useState, type DragEvent, type ReactNode } from 'react'
import { ChatCircleDots, CheckCircle, CircleNotch, Clock, LinkSimple, Robot, Sparkle, Warning } from '@phosphor-icons/react'
import type { TaskCardData } from '../../../../shared/task-card'
import type { RecordViewSummary } from '../../../../shared/record-views'
import type { TaskActInput } from '../../../../shared/tasks'
import { RecordMarks, RecordRow } from '../../records/components/RecordRows'
import { groupByKind, kindTitle } from '../../records/model'
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

function when(at: string): string {
  const d = new Date(at)
  return Number.isNaN(d.getTime()) ? at : d.toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/**
 * A task's card (stage 2 S7c): what the AI prepared on top, then what the member can do, the
 * source (stage 3), 経緯 and 「つながっているもの」. What is offered comes from the type; the
 * server decides every action.
 */
export function TaskCard({ companyId, rootPath, recordId, renderPrepared, renderSource, renderSections, shareFolders = [], onConsult, tagsInUse = [], onChanged }: Props) {
  const { result, reload } = useTaskCard(companyId, recordId)
  const [busy, setBusy] = useState(false)
  if (result === null) return <div className="flex h-full items-center justify-center gap-2 text-xs text-gray-400"><CircleNotch size={14} className="animate-spin" />読み込み中...</div>
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
  const [dropping, setDropping] = useState(false)
  const [dropError, setDropError] = useState<string | null>(null)
  const runAction = async (fn: () => Promise<string | null>) => setRunError(await fn())
  // A file dragged from the file tree onto the card is linked (the first one; one link per drop).
  const drop = async (e: DragEvent) => {
    setDropping(false)
    const path = draggedFilePaths(e.dataTransfer).map(p => companyPathOf(p, rootPath)).find((p): p is string => p !== null)
    if (!path) return
    e.preventDefault()
    setDropError(await onLinkFile(path))
  }
  return (
    <div
      className={`flex flex-wrap gap-x-6 gap-y-5 p-5 text-gray-900 dark:text-zinc-100 ${dropping ? 'outline-dashed outline-2 -outline-offset-4 outline-accent' : ''}`}
      data-testid="task-card"
      onDragOver={e => { if (isFileTreeDrag(e.dataTransfer)) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDropping(true) } }}
      onDragLeave={e => { if (e.currentTarget === e.target) setDropping(false) }}
      onDrop={e => void drop(e)}
    >
      {dropError && <p role="alert" className="w-full text-[12px] text-red-600 dark:text-red-400">{dropError}</p>}
      <article className="min-w-[280px] flex-1 space-y-5">
        <header className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-gray-500 dark:text-zinc-400">
            <span className="font-medium">やること</span>
            {record.stateLabel && <span className="rounded-full bg-accent/10 px-2 py-px text-accent">{record.stateLabel}</span>}
            <RecordMarks record={record} />
            {card.tags.map(t => <span key={t} className="rounded bg-gray-100 px-1 text-[10px] dark:bg-zinc-800">#{t}</span>)}
          </div>
          <div className="flex items-start gap-2">
            <h1 className="min-w-0 flex-1 text-xl font-bold leading-snug">{record.title}</h1>
            {onConsult && (
              <button type="button" onClick={() => onConsult({ id: record.id, title: record.title })} title="このやることについて AI に相談します（前の相談があれば、それを開きます）"
                className="mt-0.5 inline-flex shrink-0 items-center gap-1 rounded-md border border-gray-300 px-2 py-0.5 text-[12px] text-gray-700 hover:border-accent hover:text-accent dark:border-zinc-600 dark:text-zinc-200">
                <ChatCircleDots size={13} />相談する
              </button>
            )}
          </div>
          {card.due && (
            <p className={`flex items-center gap-1 text-[13px] ${dueSoon === 'overdue' ? 'text-red-600 dark:text-red-400' : 'text-gray-600 dark:text-zinc-300'}`}>
              <Clock size={13} />{dueSoon === 'overdue' ? '期限切れ ' : '期限 '}{dueText(card.due, now)}
            </p>
          )}
          {tagSuggestions}
          {card.purpose && <p className="whitespace-pre-wrap text-[13px] text-gray-600 dark:text-zinc-300">{card.purpose}</p>}
          <ShareToDepartment folders={shareFolders} busy={busy} onShare={onShare} />
          {card.okLine && <p className="flex items-center gap-1.5 rounded-md bg-emerald-500/10 px-2 py-1 text-[12.5px] text-emerald-800 dark:text-emerald-300"><CheckCircle size={14} weight="fill" />{card.okLine}</p>}
        </header>

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

        {card.fields.length > 0 && (
          <dl className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-2">
            {card.fields.map(f => (
              <div key={f.label} className="rounded-md border border-gray-200 px-2.5 py-1.5 dark:border-zinc-800">
                <dt className="text-[10.5px] text-gray-500 dark:text-zinc-400">{f.label}</dt>
                <dd className="whitespace-pre-wrap break-words text-[12.5px]">{f.value}</dd>
              </div>
            ))}
          </dl>
        )}
        {renderSections?.(record)}
        {card.history.length > 0 && (
          <section aria-label="経緯">
            <h2 className="mb-2 flex items-center gap-1.5 text-[12px] font-semibold"><Clock size={13} className="text-accent" />経緯</h2>
            <ol className="ml-1.5 space-y-2 border-l border-gray-200 pl-4 dark:border-zinc-700">
              {card.history.map((h, i) => <li key={i} className="text-[12.5px]"><span className="mr-2 text-[11px] tabular-nums text-gray-400">{when(h.at)}</span>{h.text}</li>)}
            </ol>
          </section>
        )}
      </article>
      <aside className="w-[240px] flex-shrink-0 space-y-3" aria-label="つながっているもの">
        <h2 className="flex items-center gap-1.5 text-[12px] font-semibold"><LinkSimple size={13} />つながっているもの</h2>
        {groupByKind(card.links.flatMap(l => (l.record ? [{ ...l.record, linkLabel: l.label }] : []))).map(g => (
          <section key={g.kind}>
            <h3 className="mb-1 text-[11px] font-semibold text-gray-500 dark:text-zinc-400">{kindTitle(g.kind)}（{g.items.length}）</h3>
            <ul>{g.items.map(r => <li key={r.id}><RecordRow record={r} sub={r.linkLabel === r.typeLabel ? r.typeLabel : `${r.typeLabel}・${r.linkLabel}`} /></li>)}</ul>
          </section>
        ))}
        <TaskFiles rootPath={rootPath} files={card.files} busy={busy} onLink={onLinkFile} onUnlink={onUnlinkFile} />
      </aside>
    </div>
  )
}
