import { useState } from 'react'
import { ChatCircleDots, CheckCircle, Circle, CircleNotch, Clock, LockSimple, Robot, VideoCamera, Warning } from '@phosphor-icons/react'
import type { AiTurnItemState, AiTurnItemView } from '../../../../shared/ai-turns'
import type { TaskListItem } from '../../../../shared/tasks'
import { dueText, dueWhen, type CompanyNow, type ListEvent } from '../model'
import { draggedFilePaths, isFileTreeDrag } from '../../../shared/lib/dragTypes'

const CHIP = 'shrink-0 rounded px-1 text-[10px]'
/** Where the automatic 「AI の番」 stands (ai-turns.md "Never silent"), before its reason. */
const AI_STATE_WORDS: Record<AiTurnItemState, string> = {
  running: 'AI が進めています',
  waiting: 'AI が始める予定です',
  'not-allowed': 'AI では始められません',
  failed: 'AI ができませんでした',
  handed: 'あなたにお渡ししました',
}

interface RowProps {
  item: TaskListItem
  now: CompanyNow
  active: boolean
  /** What the automatic 「AI の番」 says about it (running, waiting, failed…), when it is the AI's. */
  ai: AiTurnItemView | null
  busy: boolean
  onOpen: (recordId: string) => void
  /** Finishing one's own task from the list (null: not offered here, the card decides). */
  onFinish: (() => void) | null
  onAccept: (() => void) | null
  onRetry: (() => void) | null
  onHand: (() => void) | null
  /** A file dragged from the file tree onto it (absolute paths); null: it takes no files. */
  onDropFiles: ((paths: string[]) => void) | null
  /** 「相談する」 about this task (null: not offered). */
  onConsult?: (() => void) | null
  /** More buttons for this item (「まとまりを選ぶ」, a meeting's 「自分で読み取る」 / 「今は読まない」). */
  extra?: Array<{ label: string; run: () => void }>
}

/** One item of the list: what it is, when it is due, whose turn, its まとまり and tags. */
export function TaskRow({ item, now, active, ai, busy, onOpen, onFinish, onAccept, onRetry, onHand, onDropFiles, onConsult = null, extra = [] }: RowProps) {
  const [over, setOver] = useState(false)
  const done = item.turn === 'done'
  const when = dueWhen(item.due, now)
  const sub: string[] = []
  if (item.type !== 'task') sub.push(item.typeLabel)
  if (item.waitingFor) sub.push(item.waitingFor)
  else if (item.turn === 'ai' && ai) sub.push(ai.reason ? `${AI_STATE_WORDS[ai.state]}：${ai.reason}` : AI_STATE_WORDS[ai.state])
  else if (item.turn === 'ai') sub.push('AI が進めます')
  if (item.actingFor) sub.push(`${item.actingFor}さんの代わり`)
  if (done) sub.push(item.state === 'cancelled' ? '中止' : '終わった')
  return (
    <div
      data-testid="task-row"
      className={`group flex items-start gap-2 rounded-lg px-2.5 py-1.5 ${over ? 'outline-dashed outline-2 outline-accent' : ''} ${active ? 'bg-accent/10 dark:bg-accent/20' : 'hover:bg-gray-100 dark:hover:bg-zinc-800'}`}
      onDragOver={onDropFiles ? e => { if (isFileTreeDrag(e.dataTransfer)) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setOver(true) } } : undefined}
      onDragLeave={onDropFiles ? () => setOver(false) : undefined}
      onDrop={onDropFiles ? e => { setOver(false); const paths = draggedFilePaths(e.dataTransfer); if (paths.length > 0) { e.preventDefault(); onDropFiles(paths) } } : undefined}
    >
      <span className="mt-[2px] shrink-0">
        {done ? <CheckCircle size={15} weight="fill" className="text-emerald-500" aria-label="終わった" />
          : item.turn === 'ai' ? (ai?.state === 'running' ? <CircleNotch size={15} className="animate-spin text-accent" aria-label="AI が進めています" />
            : ai?.state === 'failed' || ai?.state === 'not-allowed' ? <Warning size={15} className="text-amber-500" aria-label="止まっています" />
              : <Robot size={15} className="text-accent" aria-label="AI の番" />)
            : onFinish ? (
              <button type="button" disabled={busy} onClick={onFinish} title="終わった" aria-label={`「${item.title}」を終わったにする`} className="disabled:opacity-40">
                <Circle size={15} className="text-gray-300 dark:text-zinc-600 group-hover:text-emerald-500" />
              </button>
            ) : <Circle size={15} className="text-gray-300 dark:text-zinc-600" />}
      </span>
      <button type="button" onClick={() => onOpen(item.id)} className="min-w-0 flex-1 text-left">
        <span className="flex items-center gap-1.5">
          <span className={`truncate text-[13px] ${done ? 'text-gray-400 line-through dark:text-zinc-500' : 'text-gray-800 dark:text-zinc-200'}`}>{item.title}</span>
          {item.personal && <LockSimple size={11} className="shrink-0 text-gray-400" aria-label="自分だけ" />}
        </span>
        <span className="flex flex-wrap items-center gap-x-1 gap-y-0.5 text-[11px] text-gray-500 dark:text-zinc-400">
          {item.due && !done && (
            <span className={`inline-flex items-center gap-0.5 ${when === 'overdue' ? 'text-red-600 dark:text-red-400 font-medium' : when === 'today' ? 'text-accent' : ''}`}>
              <Clock size={10} />{when === 'overdue' ? '期限切れ ' : '期限 '}{dueText(item.due, now)}
            </span>
          )}
          {sub.length > 0 && <span className="truncate">{sub.join('・')}</span>}
        </span>
      </button>
      <span className="flex shrink-0 flex-col items-end gap-0.5">
        {item.bundle && (
          <button
            type="button"
            onClick={() => onOpen(item.bundle!.id)}
            title="まとまりの全体を見る"
            className={`${CHIP} max-w-[120px] truncate border border-gray-200 dark:border-zinc-700 text-gray-600 dark:text-zinc-300 hover:border-accent hover:text-accent`}
          >
            {item.bundle.title}
          </button>
        )}
        {item.tags.length > 0 && (
          <span className="flex flex-wrap justify-end gap-0.5">{item.tags.slice(0, 3).map(t => <span key={t} className={`${CHIP} bg-gray-100 dark:bg-zinc-800 text-gray-600 dark:text-zinc-300`}>#{t}</span>)}</span>
        )}
        {onConsult && (
          <button type="button" onClick={onConsult} aria-label="相談する" title="このやることについて相談する"
            className="rounded p-0.5 text-gray-400 opacity-0 hover:text-accent focus:opacity-100 group-hover:opacity-100">
            <ChatCircleDots size={14} />
          </button>
        )}
        {onAccept && <button type="button" disabled={busy} onClick={onAccept} className="rounded bg-accent px-2 py-0.5 text-[11px] text-white disabled:opacity-40">引き受ける</button>}
        {extra.length > 0 && (
          <span className="flex flex-wrap justify-end gap-1">
            {extra.map(x => <button key={x.label} type="button" disabled={busy} onClick={x.run} className="rounded border border-accent/40 px-1.5 text-[10.5px] text-accent hover:bg-accent/10 disabled:opacity-40">{x.label}</button>)}
          </span>
        )}
        {(onRetry || onHand) && (
          <span className="flex gap-1">
            {onRetry && <button type="button" onClick={onRetry} className="rounded border border-gray-300 dark:border-zinc-600 px-1.5 text-[10.5px] hover:border-accent hover:text-accent">もう一度</button>}
            {onHand && <button type="button" onClick={onHand} className="rounded border border-gray-300 dark:border-zinc-600 px-1.5 text-[10.5px] hover:border-accent hover:text-accent">人に渡す</button>}
          </span>
        )}
      </span>
    </div>
  )
}

/** A meeting of today, read from the member's calendar (not a task: nothing to finish). */
export function EventRow({ e }: { e: ListEvent }) {
  return (
    <div data-testid="event-row" className={`flex items-start gap-2 rounded-lg px-2.5 py-1.5 ${e.past ? '' : 'bg-sky-50 dark:bg-sky-500/10'}`}>
      <span className={`mt-[1px] w-[38px] shrink-0 text-[11.5px] tabular-nums font-medium ${e.past ? 'text-gray-400' : 'text-sky-700 dark:text-sky-300'}`}>{e.start ?? '終日'}</span>
      <span className="min-w-0 flex-1">
        <span className={`flex items-center gap-1.5 text-[13px] ${e.past ? 'text-gray-400 dark:text-zinc-500' : 'text-gray-800 dark:text-zinc-100'}`}>
          {e.event.online ? <VideoCamera size={12} className="shrink-0 text-sky-500" /> : <Clock size={12} className="shrink-0 text-sky-500" />}
          <span className="truncate">{e.event.title || '（題名なし）'}</span>
          {e.end && <span className="shrink-0 text-[10.5px] tabular-nums text-gray-400">〜{e.end}</span>}
        </span>
        <span className="block truncate text-[11px] text-gray-500 dark:text-zinc-400">
          予定{e.event.hasExternalAttendees ? '・社外の人あり' : '・社内'}{e.event.attendeeCount > 1 ? `・${e.event.attendeeCount}人` : ''}
        </span>
      </span>
    </div>
  )
}
