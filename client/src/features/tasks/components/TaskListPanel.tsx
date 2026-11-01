import { useMemo, useState, type ReactNode } from 'react'
import { CaretDown, CaretRight } from '@phosphor-icons/react'
import type { AiTurnItemsView } from '../../../../shared/ai-turns'
import type { TaskActInput, TaskCreateInput, TaskListData, TaskListItem } from '../../../../shared/tasks'
import { useInterval } from '../../../shared/hooks/useInterval'
import { actOnTask, createTask, linkFileToTask, linkMeetingBundle } from '../api'
import { useCalendarToday } from '../hooks/useCalendarToday'
import { companyNow, companyPathOf, filterByTag, listEvents, listSections, tagCounts, type ListMode, type ListSection } from '../model'
import { BundleChooser } from './BundleChooser'
import { QuickAdd } from './QuickAdd'
import { EventRow, TaskRow } from './TaskRow'

const HEADER = 'mb-1 flex w-full items-center gap-1.5 px-2.5 text-[11px] font-semibold text-gray-500 dark:text-zinc-400'

interface Props {
  companyId: string
  /** The member's company folder (a dragged file's path is named inside it for the server). */
  rootPath: string
  list: { data: TaskListData | null; error: string | null; reload: () => void }
  /** The automatic 「AI の番」's view of each record it holds (the chat's runner), when known. */
  aiTurns: AiTurnItemsView | null
  /** The opened record's card, drawn by the screen (the records feature). */
  renderCard: (recordId: string) => ReactNode
  /**
   * A received meeting the AI has not started (stopped, or no Claude Code): the member reads it in a
   * consultation themselves, or puts it aside. Absent where the company reads no minutes.
   */
  meetingActions?: { read: (recordId: string) => void; skip: (recordId: string) => Promise<string | null> }
  /**
   * Places the list and the opened card on the screen (AppShell: the ファイル tab's split, so the
   * card gets the editor area a file opens in). Absent: the list at a fixed width, the card beside it.
   */
  frame?: (panes: { list: ReactNode; card: ReactNode }) => ReactNode
  /** 「相談する」 on a task row (AppShell: `chat.consultAbout`). */
  onConsult?: (task: { id: string; title: string }) => void
}

/** The task list tab (やること): the list on the left, the opened item's card on the right. */
export function TaskListPanel({ companyId, rootPath, list, aiTurns, renderCard, meetingActions, frame, onConsult }: Props) {
  const [choosing, setChoosing] = useState<TaskListItem | null>(null)
  const [mode, setMode] = useState<ListMode>('turn')
  const [tag, setTag] = useState<string | null>(null)
  const [opened, setOpened] = useState<string | null>(null)
  const [unfolded, setUnfolded] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [nowMs, setNowMs] = useState(() => Date.now())
  useInterval(() => setNowMs(Date.now()), 60_000)
  const now = useMemo(() => companyNow(nowMs), [nowMs])
  const calendar = useCalendarToday(companyId)

  const items = useMemo(() => list.data?.items ?? [], [list.data])
  const tags = useMemo(() => tagCounts(items), [items])
  const shownTag = tag !== null && tags.some(t => t.tag === tag) ? tag : null
  const events = useMemo(() => (shownTag === null ? listEvents(calendar?.events ?? [], now) : []), [calendar, now, shownTag])
  const sections = useMemo(() => listSections(filterByTag(items, shownTag), events, mode, now), [items, events, mode, now, shownTag])
  const aiOf = (id: string) => aiTurns?.items.find(i => i.recordId === id) ?? null

  const run = async (item: TaskListItem, steps: Array<Omit<TaskActInput, 'expectedVersion'>>) => {
    setBusy(item.id)
    setMessage(null)
    try {
      let version = item.version
      for (const step of steps) {
        const r = await actOnTask(companyId, item.id, { ...step, expectedVersion: version })
        if (!r.success) { setMessage(r.error); return }
        version += 1
      }
    } finally {
      setBusy(null)
      list.reload()
    }
  }
  const finish = (item: TaskListItem) => run(item, item.state === 'in_progress' || item.state === 'review' ? [{ action: 'complete' }] : [{ action: 'start' }, { action: 'complete' }])
  // A file from the file tree dropped on a task row is linked to it (the first one the server may take).
  const dropFiles = async (item: TaskListItem, paths: string[]) => {
    const path = paths.map(p => companyPathOf(p, rootPath)).find((p): p is string => p !== null)
    if (!path) return
    setBusy(item.id)
    setMessage(null)
    try {
      const r = await linkFileToTask(companyId, item.id, path, item.version)
      setMessage(r.success ? `「${path.split('/').pop()}」を「${item.title}」につなぎました（経緯に残り、カードから外せます）` : r.error)
    } finally {
      setBusy(null)
      list.reload()
    }
  }
  const add = async (input: TaskCreateInput): Promise<string | null> => {
    const r = await createTask(companyId, input)
    if (!r.success) return r.error
    list.reload()
    return null
  }

  const row = (i: TaskListItem) => {
    const ai = i.turn === 'ai' ? aiOf(i.id) : null
    const extra: Array<{ label: string; run: () => void }> = []
    if (i.needsBundle) extra.push({ label: 'まとまりを選ぶ', run: () => setChoosing(i) })
    if (i.type === 'meeting' && i.turn === 'ai' && meetingActions && ai?.state !== 'running') {
      extra.push({ label: '自分で読み取る', run: () => meetingActions.read(i.id) })
      extra.push({ label: '今は読まない', run: () => void meetingActions.skip(i.id).then(e => { setMessage(e); list.reload() }) })
    }
    const canFinish = i.own && i.turn === 'mine' && ['todo', 'in_progress', 'review', 'waiting'].includes(i.state ?? '')
    return (
      <TaskRow
        key={i.id} item={i} now={now} active={opened === i.id} ai={ai} busy={busy === i.id}
        onOpen={setOpened}
        onFinish={canFinish ? () => void finish(i) : null}
        onAccept={i.turn === 'acceptance' && i.type === 'task' ? () => void run(i, [{ action: 'accept' }]) : null}
        onRetry={ai?.canRetry ? () => aiTurns?.retry(i.id) : null}
        onHand={ai?.canHand ? () => aiTurns?.handOver(i.id) : null}
        onDropFiles={i.type === 'task' && i.turn !== 'done' ? paths => void dropFiles(i, paths) : null}
        onConsult={i.type === 'task' && onConsult ? () => onConsult({ id: i.id, title: i.title }) : null}
        extra={extra}
      />
    )
  }
  const section = (s: ListSection) => {
    const open = !s.foldable || unfolded[s.key] === true
    const header = <>
      {s.foldable && (open ? <CaretDown size={10} /> : <CaretRight size={10} />)}{s.title}
      <span className="font-normal">{s.items.length + s.events.length}</span>
      {s.note && <span className="ml-auto truncate text-[10px] font-normal text-gray-400">{s.note}</span>}
    </>
    return (
      <section key={s.key} aria-label={s.title}>
        {s.foldable ? (
          <button type="button" aria-expanded={open} onClick={() => setUnfolded(u => ({ ...u, [s.key]: !open }))} className={HEADER}>{header}</button>
        ) : <h3 className={HEADER}>{header}</h3>}
        {open && <div className="space-y-0.5">{s.events.map(e => <EventRow key={e.event.id} e={e} />)}{s.items.map(row)}</div>}
      </section>
    )
  }

  const listPane = (
    <>
      {choosing && (
        <BundleChooser
          companyId={companyId} meetingTitle={choosing.title}
          onChoose={async b => {
            const r = await linkMeetingBundle(companyId, choosing.id, b.id)
            list.reload()
            return r?.success ? null : (r?.error ?? 'できませんでした。')
          }}
          onClose={() => setChoosing(null)}
        />
      )}
      <section aria-label="やることの一覧" className={`flex ${frame ? 'h-full w-full' : 'w-[380px] min-w-[300px] max-w-[45%] flex-shrink-0'} flex-col border-r border-gray-200 bg-white dark:border-zinc-800 dark:bg-zinc-900`}>
        <div className="flex h-10 flex-shrink-0 items-center gap-2 border-b border-gray-200 px-3 dark:border-zinc-800">
          <span className="text-[13px] font-semibold text-gray-800 dark:text-zinc-100">やること</span>
          <span role="group" aria-label="並べ方" className="inline-flex overflow-hidden rounded-md border border-gray-200 text-[11px] dark:border-zinc-700">
            {(['turn', 'date'] as const).map(m => (
              <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)}
                className={`px-2 py-0.5 ${mode === m ? 'bg-accent text-white' : 'text-gray-600 hover:bg-gray-100 dark:text-zinc-300 dark:hover:bg-zinc-800'}`}>
                {m === 'turn' ? '番ごと' : '日付ごと'}
              </button>
            ))}
          </span>
        </div>
        <QuickAdd now={now} tagsInUse={tags.map(t => t.tag)} onAdd={add} />
        {tags.length > 0 && (
          <div role="group" aria-label="タグで絞る" className="flex flex-shrink-0 flex-wrap items-center gap-1 px-3 py-1.5 text-[11px]">
            <button type="button" aria-pressed={shownTag === null} onClick={() => setTag(null)} className={`rounded-full px-2 py-px ${shownTag === null ? 'bg-gray-800 text-white dark:bg-zinc-100 dark:text-zinc-900' : 'text-gray-500 hover:bg-gray-100 dark:hover:bg-zinc-800'}`}>すべて</button>
            {tags.map(({ tag: t, count }) => (
              <button key={t} type="button" aria-pressed={shownTag === t} onClick={() => setTag(shownTag === t ? null : t)}
                className={`rounded-full px-2 py-px ${shownTag === t ? 'bg-accent text-white' : 'text-gray-500 hover:bg-gray-100 dark:text-zinc-400 dark:hover:bg-zinc-800'}`}>
                #{t}<span className="ml-0.5 opacity-60">{count}</span>
              </button>
            ))}
          </div>
        )}
        {(message || list.error) && <p role="alert" className="mx-3 my-1 rounded bg-amber-50 px-2 py-1 text-[11px] text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">{message ?? list.error}</p>}
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-1.5 pb-2 pt-1">
          {list.data === null && !list.error && <p className="px-2.5 py-2 text-[12px] text-gray-400">読み込み中...</p>}
          {list.data && sections.length === 0 && (
            <p className="px-2.5 py-4 text-[12px] leading-relaxed text-gray-500 dark:text-zinc-400">
              {shownTag ? `#${shownTag} のやることはありません。` : 'いま、やることはありません。上の1行で自分のやることを足せます。会議の議事録や、頼まれたことが届くと、ここに並びます。'}
            </p>
          )}
          {sections.map(section)}
          {calendar?.reason === 'not-connected' && shownTag === null && (
            <p className="px-2.5 text-[10.5px] text-gray-400">設定で Google の予定を読む許可をすると、今日の予定もここに並びます。</p>
          )}
        </div>
      </section>
    </>
  )
  const cardPane = (
    <div className="h-full min-w-0 flex-1 overflow-y-auto bg-white dark:bg-zinc-900" data-testid="task-card-area">
      {/* Keyed by the version the list knows: a change made from the list shows on the card too. */}
      {opened ? <div key={`${opened}@${items.find(i => i.id === opened)?.version ?? 0}`} className="h-full">{renderCard(opened)}</div>
        : <div className="flex h-full items-center justify-center text-sm text-gray-400">左の一覧から開きます</div>}
    </div>
  )
  if (frame) return <>{frame({ list: listPane, card: cardPane })}</>
  return (
    <div className="flex h-full min-h-0 w-full">
      {listPane}
      {cardPane}
    </div>
  )
}
