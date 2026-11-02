import { useMemo, useState } from 'react'
import { CaretDown, CaretRight, Briefcase } from '@phosphor-icons/react'
import type { AiTurnItemsView } from '../../../../shared/ai-turns'
import type { TaskActInput, TaskCreateInput, TaskListData, TaskListItem } from '../../../../shared/tasks'
import { useInterval } from '../../../shared/hooks/useInterval'
import { actOnTask, createTask, declineMeetingBundle, linkFileToTask, linkMeetingBundle } from '../api'
import { useCalendarToday } from '../hooks/useCalendarToday'
import { bundleListWord, companyNow, companyPathOf, filterByTag, listEvents, listRows, listSections, tagCounts, type ListMode, type ListRow, type ListSection } from '../model'
import { CALM } from '../../../../shared/thing-words'
import { ThingIcon } from '../../../shared/ui/ThingIcon'
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
  /** The record whose tab the middle shows (its row is marked). */
  activeRecordId?: string | null
  /** A row opens its record in a tab in the middle, where files open too (AppShell: `record.open`). */
  onOpen: (recordId: string) => void
  /**
   * A received meeting the AI has not started (stopped, or no Claude Code): the member reads it in a
   * consultation themselves, or puts it aside. Absent where the company reads no minutes.
   */
  meetingActions?: { read: (recordId: string) => void; skip: (recordId: string) => Promise<string | null> }
  /** The department folder on screen: a task asked of someone from the one line is shown to its readers. */
  askFolder?: string | null
  /** 「相談する」 on a task row (AppShell: `chat.consultAbout`). */
  onConsult?: (task: { id: string; title: string }) => void
}

/** The task list tab (やること): the list; an item opens in a tab in the middle (records and files share the tabs). */
export function TaskListPanel({ companyId, rootPath, list, aiTurns, activeRecordId = null, onOpen, meetingActions, onConsult, askFolder = null }: Props) {
  const [choosing, setChoosing] = useState<TaskListItem | null>(null)
  const [mode, setMode] = useState<ListMode>('turn')
  const [tag, setTag] = useState<string | null>(null)
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
  // 「〇〇ごと」: the kinds in the member's list; with none, the company's own kind (records.md "Bundle kinds").
  const kinds = list.data?.bundleKinds
  const bundleWord = useMemo(() => bundleListWord(items, kinds?.core.name), [items, kinds])
  // The one line's ［〇〇］: what the department on screen makes (全社: the company's own kind).
  const deptKind = kinds ? (kinds.departments.find(d => d.folder === askFolder)?.kind ?? kinds.core) : null
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
  // ☑ (task v9): complete from any state but 準備中 — no made-up start; 確かめてから → 見てもらう; done → やり直す.
  const press = (item: TaskListItem) => {
    const c = item.check
    if (!c) return
    if (c.action === 'request_review') void run(item, [{ action: 'request_review', args: { reviewer: c.reviewer } }])
    else void run(item, [{ action: c.action }])
  }
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
  const yesBundle = async (item: TaskListItem, bundleId: string) => {
    setBusy(item.id)
    setMessage(null)
    try {
      const r = await linkMeetingBundle(companyId, item.id, bundleId)
      if (!r?.success) setMessage(r?.error ?? 'できませんでした。')
    } finally {
      setBusy(null)
      list.reload()
    }
  }
  // 「まとまりはない（社内の会議など）」: the server closes the question for good; no AI turn follows.
  const noBundle = async (item: TaskListItem) => {
    setBusy(item.id)
    setMessage(null)
    try {
      const r = await declineMeetingBundle(companyId, item.id)
      if (!r.success) setMessage(r.error)
    } finally {
      setBusy(null)
      list.reload()
    }
  }
  const add = async (input: TaskCreateInput): Promise<string | null> => {
    const r = await createTask(companyId, input.assignee ? { ...input, folder: askFolder } : input)
    if (!r.success) return r.error
    list.reload()
    return null
  }

  const row = (i: TaskListItem) => {
    const ai = i.turn === 'ai' ? aiOf(i.id) : null
    const extra: Array<{ label: string; run: () => void }> = []
    if (i.needsBundle) {
      // 「『…』の会議ですか？」: はい links the suggested one (the same link as choosing by hand).
      const s = i.suggestedBundle
      if (s) extra.push({ label: 'はい', run: () => void yesBundle(i, s.id) })
      extra.push({ label: s ? 'ちがう／選ぶ' : 'まとまりを選ぶ', run: () => setChoosing(i) })
      extra.push({ label: 'まとまりはない', run: () => void noBundle(i) })
    }
    if (i.type === 'meeting' && i.turn === 'ai' && i.state === 'received' && meetingActions && ai?.state !== 'running') {
      extra.push({ label: '自分で読み取る', run: () => meetingActions.read(i.id) })
      extra.push({ label: '今は読まない', run: () => void meetingActions.skip(i.id).then(e => { setMessage(e); list.reload() }) })
    }
    return (
      <TaskRow
        key={i.id} item={i} now={now} active={activeRecordId === i.id} ai={ai} busy={busy === i.id}
        onOpen={onOpen}
        onFinish={i.check ? () => press(i) : null}
        onAccept={i.turn === 'acceptance' && i.type === 'task' ? () => void run(i, [{ action: 'accept' }]) : null}
        onRetry={ai?.canRetry ? () => aiTurns?.retry(i.id) : null}
        onHand={ai?.canHand ? () => aiTurns?.handOver(i.id) : null}
        onDropFiles={i.type === 'task' && i.turn !== 'done' ? paths => void dropFiles(i, paths) : null}
        onConsult={i.type === 'task' && onConsult ? () => onConsult({ id: i.id, title: i.title }) : null}
        extra={extra}
      />
    )
  }
  // 「まとまりを選ぶ会議 n件」: one row for the meetings of one 相手 or series, opened to show each.
  const listRow = (r: ListRow) => {
    if (r.kind === 'item') return row(r.item)
    const open = unfolded[`group:${r.key}`] === true
    return (
      <div key={`group:${r.key}`} data-testid="bundle-group">
        <button type="button" aria-expanded={open} onClick={() => setUnfolded(u => ({ ...u, [`group:${r.key}`]: !open }))}
          className="flex w-full items-start gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-gray-100 dark:hover:bg-zinc-800">
          <Briefcase size={15} className="mt-[2px] shrink-0 text-gray-400" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] text-gray-800 dark:text-zinc-200">まとまりを選ぶ会議 {r.items.length}件</span>
            <span className="block truncate text-[11px] text-gray-500 dark:text-zinc-400">{r.label}</span>
          </span>
          {open ? <CaretDown size={10} className="mt-1.5" /> : <CaretRight size={10} className="mt-1.5" />}
        </button>
        {open && <div className="ml-4 space-y-0.5">{r.items.map(row)}</div>}
      </div>
    )
  }
  const section = (s: ListSection) => {
    const open = !s.foldable || unfolded[s.key] === true
    const header = <>
      {s.foldable && (open ? <CaretDown size={10} /> : <CaretRight size={10} />)}{s.bundle && <ThingIcon kind="bundle" typeLabel={s.bundle.typeLabel} size={12} />}{s.title}
      <span className="font-normal">{s.items.length + s.events.length}</span>
      {s.note && <span className="ml-auto truncate text-[10px] font-normal text-gray-400">{s.note}</span>}
    </>
    return (
      <section key={s.key} aria-label={s.title}>
        {s.foldable ? (
          <button type="button" aria-expanded={open} onClick={() => setUnfolded(u => ({ ...u, [s.key]: !open }))} className={HEADER}>{header}</button>
        ) : s.bundle ? (
          // 〇〇ごと: the bundle's name opens it, like its chip on a row.
          <h3><button type="button" data-bundle-head={s.bundle.id} onClick={() => onOpen(s.bundle!.id)} className={`${HEADER} text-gray-700 hover:text-accent dark:text-zinc-200`}>{header}</button></h3>
        ) : <h3 className={HEADER}>{header}</h3>}
        {open && <div className="space-y-0.5">{s.events.map(e => <EventRow key={e.event.id} e={e} />)}{listRows(s.items).map(listRow)}</div>}
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
          onNoBundle={async () => {
            const r = await declineMeetingBundle(companyId, choosing.id)
            list.reload()
            return r.success ? null : r.error
          }}
          onClose={() => setChoosing(null)}
        />
      )}
      <section aria-label="やることの一覧" className="flex h-full w-full flex-col bg-white dark:bg-zinc-900">
        <div className="flex h-10 flex-shrink-0 items-center gap-2 border-b border-gray-200 px-3 dark:border-zinc-800">
          <span role="group" aria-label="並べ方" className="inline-flex overflow-hidden rounded-md border border-gray-200 text-[11px] dark:border-zinc-700">
            {(['turn', 'bundle', 'date'] as const).map(m => (
              <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)}
                className={`px-2 py-0.5 whitespace-nowrap ${mode === m ? 'bg-accent text-white' : 'text-gray-600 hover:bg-gray-100 dark:text-zinc-300 dark:hover:bg-zinc-800'}`}>
                {m === 'turn' ? '番ごと' : m === 'bundle' ? `${bundleWord}ごと` : '日付ごと'}
              </button>
            ))}
          </span>
        </div>
        <QuickAdd companyId={companyId} now={now} tagsInUse={tags.map(t => t.tag)} me={list.data?.me} members={list.data?.members} bundleWord={deptKind?.name ?? bundleWord} bundleType={askFolder ? deptKind?.type : undefined} onAdd={add} />
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
          {list.data === null && !list.error && <p className="px-2.5 py-2 text-[12px] text-gray-400">{CALM.loading}</p>}
          {list.data && sections.length === 0 && (
            <p className="px-2.5 py-4 text-[12px] leading-relaxed text-gray-500 dark:text-zinc-400">
              {shownTag ? `#${shownTag} のやることはありません。` : `${CALM.emptyTasks}。上の1行で自分のやることを足せます。`}
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
  return listPane
}
