import { useState, type DragEvent } from 'react'
import { ArrowBendUpRight, ChatCircleDots, Check, CircleNotch, Clock, Eye, Robot, User, VideoCamera, Warning, WarningOctagon } from '@phosphor-icons/react'
import { NEXT_STEP, ONLY_YOU, thingKindOf, type ThingKind } from '../../../../shared/thing-words'
import { SeenBy, ThingIcon } from '../../../shared/ui/ThingIcon'
import type { AiTurnItemState, AiTurnItemView } from '../../../../shared/ai-turns'
import type { TaskListItem } from '../../../../shared/tasks'
import { dueText, dueWhen, meetingRowText, type CompanyNow, type ListEvent } from '../model'
import { isFileTreeDrag, isLinkableDrag, startRecordDrag } from '../../../shared/lib/dragTypes'
import { PRIMARY_ACTION } from '../../../shared/ui/buttonStyles'
import { STOP_ICON } from '../../../shared/ui/stateStyles'
import type { StopMeaning } from '../../../../../shared/design-tokens/stop-meaning'

const CHIP = 'shrink-0 rounded-small px-1 text-[10px]'
/** Where the automatic 「AI の番」 stands (ai-turns.md "Never silent"), before its reason. */
const AI_STATE_WORDS: Record<AiTurnItemState, string> = {
  running: 'AI が進めています',
  waiting: 'AI が始める予定です',
  'not-allowed': 'AI では始められません',
  failed: 'AI ができませんでした',
  handed: 'あなたにお渡ししました',
}
/** What a stopped 「AI の番」 means for the member: they start or hand it on (amber), or it failed (red). */
const AI_STOP = { 'not-allowed': 'needsAction', failed: 'failed' } as const satisfies Partial<Record<AiTurnItemState, StopMeaning>>

interface RowProps {
  item: TaskListItem
  now: CompanyNow
  active: boolean
  /** What the automatic 「AI の番」 says about it (running, waiting, failed…), when it is the AI's. */
  ai: AiTurnItemView | null
  busy: boolean
  onOpen: (recordId: string) => void
  /** The ☑ (`item.check`: 完了にする / 終わったので見てもらう / やり直す; a 来た連絡's 済んだ / 元に戻す); null: not offered here, the card decides. */
  onFinish: (() => void) | null
  onAccept: (() => void) | null
  onRetry: (() => void) | null
  onHand: (() => void) | null
  /**
   * Something dropped on it — a file or folder from the tree, a record, a consultation — to link
   * (`useLinkDrop`); true when taken. null: it takes no drops.
   */
  onDrop: ((e: DragEvent) => boolean) | null
  /** 「相談する」 about this task (null: not offered). */
  onConsult?: (() => void) | null
  /** More buttons for this item (「まとまりを選ぶ」, a meeting's 「自分で読み取る」 / 「今は読まない」). */
  extra?: Array<{ label: string; run: () => void }>
}

/** The one button a row of the member's turn shows for a kind that is not finished with ☑ (言葉の決まり 3b). */
const ROW_STEP: Partial<Record<ThingKind, string>> = {
  outbound: NEXT_STEP.checkAndSend, approval: NEXT_STEP.check, minutes_check: NEXT_STEP.check, reply_request: NEXT_STEP.check,
}

/**
 * One item of the list: its kind's icon (or ☑), the title, and only what to do next — whose turn,
 * the due, which 案件 / プロジェクト it belongs to (context, not a state). State words stay on the
 * opened record; a finished one is struck through.
 */
export function TaskRow({ item, now, active, ai, busy, onOpen, onFinish, onAccept, onRetry, onHand, onDrop, onConsult = null, extra = [] }: RowProps) {
  const [over, setOver] = useState(false)
  const done = item.turn === 'done'
  const when = dueWhen(item.due, now)
  const kind = thingKindOf(item)
  const step = item.turn === 'mine' && !onFinish ? ROW_STEP[kind] : undefined
  const boxWord = item.check?.action === 'request_review' ? NEXT_STEP.askToCheck : item.check?.action === 'reopen' ? NEXT_STEP.reopen
    : item.check?.action === 'settle' ? NEXT_STEP.settle : item.check?.action === 'undo' ? NEXT_STEP.unsettle : NEXT_STEP.complete
  // Finished (a done task's やり直す, a 来た連絡's 元に戻す): the green ✓.
  const ticked = item.check?.action === 'reopen' || item.check?.action === 'undo'
  const sub: string[] = []
  // A 「議事録を確認する」 says its meeting's time, so the current one stands out among others of the same title.
  const meeting = item.meetingAt ? meetingRowText(item.meetingAt, now) : null
  if (meeting) sub.push(meeting)
  if (item.waitingFor) sub.push(item.waitingFor)
  else if (item.turn === 'ai' && ai) sub.push(ai.reason ? `${AI_STATE_WORDS[ai.state]}：${ai.reason}` : AI_STATE_WORDS[ai.state])
  else if (item.turn === 'ai') sub.push('AI の番')
  if (item.actingFor) sub.push(`${item.actingFor}さんの代わり`)
  return (
    <div
      data-testid="task-row"
      className={`group flex items-start gap-2 rounded-control px-2.5 py-1.5 ${over ? 'outline-dashed outline-2 outline-primary' : ''} ${active ? 'bg-selected-bg' : 'hover:bg-gray-100 dark:hover:bg-zinc-800'}`}
      // The row itself can be dragged onto a record's 「つながっているもの」 (or another row) to link it.
      draggable
      onDragStart={e => startRecordDrag(e.dataTransfer, { id: item.id, title: item.title, word: item.typeLabel })}
      onDragOver={onDrop ? e => {
        if (!isLinkableDrag(e.dataTransfer)) return
        e.preventDefault()
        // The file tree allows link and move; a record or consultation only link.
        e.dataTransfer.dropEffect = isFileTreeDrag(e.dataTransfer) ? 'move' : 'link'
        setOver(true)
      } : undefined}
      onDragLeave={onDrop ? () => setOver(false) : undefined}
      onDrop={onDrop ? e => { setOver(false); if (onDrop(e)) e.preventDefault() } : undefined}
    >
      <span className="mt-[2px] shrink-0">
        {item.turn === 'ai' && !done ? (ai?.state === 'running' ? <CircleNotch size={15} className="animate-spin text-ai-icon" aria-label="AI が進めています" />
          : ai?.state === 'failed' ? <WarningOctagon size={15} weight="fill" className={STOP_ICON[AI_STOP.failed]} aria-label="AI が止まりました" />
          : ai?.state === 'not-allowed' ? <Warning size={15} className={STOP_ICON[AI_STOP['not-allowed']]} aria-label={AI_STATE_WORDS['not-allowed']} />
            : <Robot size={15} className="text-ai-icon" aria-label="AI の番" />)
          : onFinish ? (
            <button type="button" disabled={busy} onClick={onFinish} title={boxWord} aria-label={`「${item.title}」を${boxWord}`}
              className={`flex h-[15px] w-[15px] items-center justify-center rounded-small border disabled:opacity-40 ${ticked
                ? 'border-emerald-500 bg-emerald-500 text-white hover:bg-emerald-600'
                : 'border-gray-400 hover:border-primary hover:bg-selected-bg dark:border-zinc-500'}`}>
              {ticked && <Check size={10} weight="bold" />}
            </button>
          ) : item.type === 'task' && item.state === 'review' && !done ? (
            <span className="flex h-[15px] w-[15px] items-center justify-center rounded-small border border-amber-400 bg-amber-100 dark:bg-amber-500/20" aria-label="確かめてもらっています"><Eye size={9} className="text-amber-700" /></span>
          ) : done && item.type === 'task' && item.state === 'done' ? (
            <span className="flex h-[15px] w-[15px] items-center justify-center rounded-small bg-emerald-500 text-white" aria-label="完了"><Check size={10} weight="bold" /></span>
          ) : item.askedOfOthers ? (
            // Asked of someone else: nothing to press here, so no box (it read as 「もう済んだ」).
            <span role="img" aria-label="人に頼んだもの" title="人に頼んだもの" className="relative block h-[15px] w-[15px] text-gray-400 dark:text-zinc-500">
              <User size={12} weight="duotone" className="absolute right-0 top-0" />
              <ArrowBendUpRight size={9} weight="bold" className="absolute bottom-0 left-0" />
            </span>
          ) : <ThingIcon kind={kind} typeLabel={item.typeLabel} size={15} />}
      </span>
      {/* The row's own button: ↑ ↓ Enter move from it when working through the list (data-work-row). */}
      <button type="button" data-work-row={item.id} aria-current={active ? 'true' : undefined} onClick={() => onOpen(item.id)} className="min-w-0 flex-1 rounded-small text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring">
        <span className="flex items-center gap-1.5">
          <span className={`truncate text-body ${done ? 'text-gray-400 line-through dark:text-zinc-500' : 'text-gray-800 dark:text-zinc-200'}`}>{item.title}</span>
          {item.personal && <SeenBy who={ONLY_YOU} small />}
        </span>
        <span className="flex flex-wrap items-center gap-x-1 gap-y-0.5 text-caption font-normal text-gray-500 dark:text-zinc-400">
          {item.bundle && (
            <span role="link" tabIndex={0} title={`${item.bundle.typeLabel ?? ''}を開く`} data-bundle-chip
              onClick={e => { e.stopPropagation(); onOpen(item.bundle!.id) }}
              onKeyDown={e => { if (e.key === 'Enter') { e.stopPropagation(); onOpen(item.bundle!.id) } }}
              className="inline-flex max-w-[160px] items-center gap-0.5 hover:text-link">
              <ThingIcon kind="bundle" typeLabel={item.bundle.typeLabel} label={item.bundle.typeLabel} size={10} /><span className="truncate">{item.bundle.title}</span>
            </span>
          )}
          {item.due && !done && (
            <span className={`inline-flex items-center gap-0.5 ${when === 'overdue' ? 'text-red-600 dark:text-red-400 font-medium' : when === 'today' ? 'text-link' : ''}`}>
              <Clock size={10} />{when === 'overdue' ? '期限切れ ' : '期限 '}{dueText(item.due, now)}
            </span>
          )}
          {sub.length > 0 && <span className="truncate">{sub.join('・')}</span>}
        </span>
      </button>
      <span className="flex shrink-0 flex-col items-end gap-0.5">
        {step && <button type="button" onClick={() => onOpen(item.id)} className="rounded-md border border-gray-300 px-1.5 py-px text-caption font-normal text-gray-700 hover:border-primary hover:text-link dark:border-zinc-600 dark:text-zinc-200">{step}</button>}
        {item.tags.length > 0 && (
          <span className="flex flex-wrap justify-end gap-0.5">{item.tags.slice(0, 3).map(t => <span key={t} className={`${CHIP} bg-gray-100 dark:bg-zinc-800 text-gray-600 dark:text-zinc-300`}>#{t}</span>)}</span>
        )}
        {onConsult && (
          <button type="button" onClick={onConsult} aria-label="相談する" title="このやることについて相談する"
            className="rounded-small p-0.5 text-gray-400 opacity-0 hover:text-link focus:opacity-100 group-hover:opacity-100">
            <ChatCircleDots size={14} />
          </button>
        )}
        {onAccept && <button type="button" disabled={busy} onClick={onAccept} className={`rounded-small px-2 py-0.5 text-caption font-normal ${PRIMARY_ACTION}`}>{NEXT_STEP.accept}</button>}
        {extra.length > 0 && (
          <span className="flex flex-wrap justify-end gap-1">
            {extra.map(x => <button key={x.label} type="button" disabled={busy} onClick={x.run} className="rounded-small border border-selected-border px-1.5 text-caption font-normal text-link hover:bg-selected-bg disabled:opacity-40">{x.label}</button>)}
          </span>
        )}
        {(onRetry || onHand) && (
          <span className="flex gap-1">
            {onRetry && <button type="button" onClick={onRetry} className="rounded-small border border-gray-300 dark:border-zinc-600 px-1.5 text-caption font-normal hover:border-primary hover:text-link">もう一度</button>}
            {onHand && <button type="button" onClick={onHand} className="rounded-small border border-gray-300 dark:border-zinc-600 px-1.5 text-caption font-normal hover:border-primary hover:text-link">人に渡す</button>}
          </span>
        )}
      </span>
    </div>
  )
}

/** A meeting of today, read from the member's calendar (not a task: nothing to finish). */
export function EventRow({ e }: { e: ListEvent }) {
  return (
    <div data-testid="event-row" className={`flex items-start gap-2 rounded-control px-2.5 py-1.5 ${e.past ? '' : 'bg-sky-50 dark:bg-sky-500/10'}`}>
      <span className={`mt-[1px] w-[38px] shrink-0 text-small tabular-nums font-medium ${e.past ? 'text-gray-400' : 'text-sky-700 dark:text-sky-300'}`}>{e.start ?? '終日'}</span>
      <span className="min-w-0 flex-1">
        <span className={`flex items-center gap-1.5 text-body ${e.past ? 'text-gray-400 dark:text-zinc-500' : 'text-gray-800 dark:text-zinc-100'}`}>
          {e.event.online ? <VideoCamera size={12} className="shrink-0 text-sky-500" /> : <Clock size={12} className="shrink-0 text-sky-500" />}
          <span className="truncate">{e.event.title || '（題名なし）'}</span>
          {e.end && <span className="shrink-0 text-caption font-normal tabular-nums text-gray-400">〜{e.end}</span>}
        </span>
        <span className="block truncate text-caption font-normal text-gray-500 dark:text-zinc-400">
          予定{e.event.hasExternalAttendees ? '・社外の人あり' : '・社内'}{e.event.attendeeCount > 1 ? `・${e.event.attendeeCount}人` : ''}
        </span>
      </span>
    </div>
  )
}
