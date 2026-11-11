import { useRef, useState } from 'react'
import { Bell, GearSix } from '@phosphor-icons/react'
import { NOTIFICATION_KIND_LABELS, NOTIFICATION_KINDS, UNDOABLE_NOTIFICATION_KINDS } from '../../../../../shared/types/notifications'
import { DEFAULT_FEATURES, noticeKindsShown, type CompanyFeatures } from '../../../../../shared/core/features'
import { shortDue, turnGroups, type MeetingTurn, type NoticesState, type NoticeTarget } from '../../../../shared/notifications-app'
import { ThingIcon } from '../../../shared/ui/ThingIcon'
import { useEventListener } from '../../../shared/hooks/useEventListener'
import { jobNoticeTarget } from '../../../../shared/jobs'
import { getNoticeSettings, markNoticesRead, setNoticeSetting, undoNoticedAiChange, undoNoticedChange } from '../api'

const ICON_BUTTON = 'relative p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-zinc-800 text-gray-500 dark:text-zinc-400 hover:text-gray-700 dark:hover:text-zinc-200 transition-colors'
const PANEL = 'absolute right-0 top-full z-30 mt-1 w-80 max-h-[70vh] overflow-y-auto rounded-lg border border-gray-200 bg-white text-sm shadow-lg dark:border-zinc-700 dark:bg-zinc-900'
const ROW = 'block w-full px-3 py-2 text-left hover:bg-gray-50 dark:hover:bg-zinc-800'

/** A meeting the task list would show, with what the member can do about it (composed by AppShell). */
export interface MeetingTurnRow extends MeetingTurn {
  actions: Array<{ label: string; run: () => void }>
}

interface Props {
  companyId: string
  /** Only where the department on screen does not show the task list: its meetings come here instead. */
  meetings?: MeetingTurnRow[]
  state: NoticesState
  /** Open a record (AppShell: its card, or a consultation while there is no card screen). */
  onOpen: (target: NoticeTarget) => void
  /** Show the task list (the morning's 「今日のあなたの番」 is about no one record). */
  onOpenTasks?: () => void
  /** Show the member's scheduled jobs (a job's notice — 「受け取りが要ります」 — is about no record). */
  onOpenJobs?: () => void
  /** The company's 「使う機能」 (absent = all on): 「知らせの設定」 lists no kind of a feature that is off. */
  features?: CompanyFeatures
}

type Open = 'turn' | 'bell' | 'settings' | null

/**
 * The title bar's 「あなたの番 N」 (what the member presses, until it is done — by kind with one line
 * on what to do; the count is the list's) and the bell (what happened, read only, gone once read;
 * I.1) — drawn by the core app only.
 * Each list item opens its record; reading the bell's list marks nothing until
 * an item is opened or 「すべて既読」 is pressed, so the other PC's dot stays honest.
 */
export function TitleBarNotices({ companyId, state, meetings = [], onOpen, onOpenTasks, onOpenJobs, features = DEFAULT_FEATURES }: Props) {
  const [open, setOpen] = useState<Open>(null)
  const [kinds, setKinds] = useState<Record<string, boolean> | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** Notices whose change was undone here (「元に戻しました」 instead of the button). */
  const [undone, setUndone] = useState<ReadonlySet<string>>(new Set())
  const root = useRef<HTMLDivElement>(null)
  useEventListener<MouseEvent>(document, 'mousedown', e => { if (!root.current?.contains(e.target as Node)) setOpen(null) }, { enabled: open !== null })
  useEventListener<KeyboardEvent>(document, 'keydown', e => { if (e.key === 'Escape') setOpen(null) }, { enabled: open !== null })

  if (!state.available) return null
  const { myTurn, notices } = state
  const waitingMeetings = meetings.filter(m => m.needsPerson).length
  const turnTotal = myTurn.total + waitingMeetings
  // A meeting waiting for the member is theirs to press (あなたの番); one the AI is reading is only news (the bell).
  const meetingList = (list: MeetingTurnRow[]) => list.length > 0 && (
    <section aria-label="会議" className="border-b border-gray-100 dark:border-zinc-800">
      {list.map(m => (
        <div key={`${m.kind}:${m.id}`} className="px-3 py-2">
          <span className="block truncate text-gray-800 dark:text-zinc-100">{m.kind === 'bundle' ? '会議：' : '議事録：'}{m.title}</span>
          <span className={`block text-xs ${m.needsPerson ? 'text-amber-700 dark:text-amber-300' : 'text-gray-500 dark:text-zinc-400'}`}>{m.text}</span>
          {m.actions.length > 0 && (
            <span className="mt-1 flex flex-wrap gap-1.5">
              {m.actions.map(a => (
                <button key={a.label} type="button" onClick={() => { setOpen(null); a.run() }}
                  className="rounded border border-gray-300 px-2 py-0.5 text-[11.5px] hover:bg-gray-50 dark:border-zinc-600 dark:hover:bg-zinc-800">{a.label}</button>
              ))}
            </span>
          )}
        </div>
      ))}
    </section>
  )
  const toggle = (which: Open) => { setError(null); setOpen(open === which ? null : which) }
  // What the member's own AI did for them (a task their reply finished): ［元に戻す］ undoes that entry.
  const undo = async (id: string, recordId: string, version: number, aiChange?: { pluginId: string; operationId: string }) => {
    setError(null)
    // An AI's automatic change is undone through its operation (the outside system too); the others by their entry.
    const r = aiChange ? await undoNoticedAiChange(companyId, aiChange.pluginId, aiChange.operationId) : await undoNoticedChange(companyId, recordId, version)
    if (r?.success) {
      setUndone(u => new Set([...u, id]))
      void markNoticesRead(companyId, [id])
    } else setError(r?.error ?? '元に戻せませんでした。そのあとに変わったかもしれません。')
  }

  const openSettings = async () => {
    setOpen('settings')
    const r = await getNoticeSettings(companyId)
    if (r?.success) setKinds(r.kinds)
    else setError(r?.error ?? '知らせの設定を読めませんでした。')
  }
  const switchKind = async (kind: string, on: boolean) => {
    setKinds(k => (k ? { ...k, [kind]: on } : k))
    const r = await setNoticeSetting(companyId, kind, on)
    if (!r?.success) { setKinds(k => (k ? { ...k, [kind]: !on } : k)); setError(r?.error ?? '変えられませんでした。') }
  }

  return (
    <div ref={root} className="relative flex items-center gap-1">
      <button
        type="button"
        onClick={() => toggle('turn')}
        className="rounded-full bg-amber-500/15 px-2.5 py-1 text-xs text-amber-800 hover:bg-amber-500/25 dark:text-amber-300"
        title="あなたが今週動くもの"
        aria-expanded={open === 'turn'}
      >
        あなたの番 <b className="tabular-nums">{turnTotal}</b>
      </button>
      <button type="button" onClick={() => toggle('bell')} className={ICON_BUTTON} title="起きたこと（読むだけ）" aria-label={notices.unread > 0 ? `起きたこと（未読 ${notices.unread} 件）` : '起きたこと'} aria-expanded={open === 'bell'}>
        <Bell size={18} />
        {notices.unread > 0 && <span data-testid="notices-unread-dot" className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-red-500" />}
      </button>

      {open === 'turn' && (
        <div className={PANEL} role="menu" aria-label="あなたの番">
          <p className="px-3 pt-2 pb-1 text-[12px] font-semibold text-gray-700 dark:text-zinc-200">あなたの番<span className="ml-1.5 font-normal text-gray-400">あなたが押すもの</span></p>
          {meetingList(meetings.filter(m => m.needsPerson))}
          {myTurn.items.length === 0 && waitingMeetings === 0 && <p className="px-3 py-3 text-gray-500 dark:text-zinc-400">いま、あなたの番のものはありません。</p>}
          {turnGroups(myTurn.items).map(g => (
            <section key={g.line} aria-label={g.line} className="pb-1">
              <p className="flex items-center gap-1.5 px-3 pt-1.5 text-[11px] font-semibold text-gray-500 dark:text-zinc-400"><ThingIcon kind={g.kind} size={12} />{g.line}</p>
              {g.items.map(item => (
                <button key={item.id} type="button" role="menuitem" className={`${ROW} pl-8`} onClick={() => { setOpen(null); onOpen({ recordId: item.id, title: item.title }) }}>
                  <span className="block truncate text-gray-800 dark:text-zinc-100">{item.title}</span>
                  {item.due && <span className="text-xs text-gray-500 dark:text-zinc-400">期限 {shortDue(item.due)}</span>}
                </button>
              ))}
            </section>
          ))}
          {myTurn.total > myTurn.items.length && <p className="px-3 py-2 text-xs text-gray-500">ほかに {myTurn.total - myTurn.items.length} 件</p>}
          {(myTurn.resting ?? 0) > 0 && (
            <p className="px-3 py-1.5 text-[11px] text-gray-500 dark:text-zinc-400">まだ始めていない、期限が来週以降か、期限のないもの {myTurn.resting}件は、やることの一覧の「先のこと」「いつか」にあります。</p>
          )}
          <p className="border-t border-gray-100 px-3 py-1.5 text-[10.5px] text-gray-500 dark:border-zinc-800 dark:text-zinc-400">起きたことはベルに出ます。ここは押すものだけです。</p>
        </div>
      )}

      {open === 'bell' && (
        <div className={PANEL} role="menu" aria-label="起きたこと">
          <div className="flex items-center justify-between border-b border-gray-100 px-3 py-1.5 text-xs dark:border-zinc-800">
            <span className="font-semibold text-gray-700 dark:text-zinc-200">起きたこと<span className="ml-1 font-normal text-gray-400">読むだけ</span></span>
            <button type="button" className="text-blue-600 disabled:text-gray-400 dark:text-blue-400" disabled={notices.unread === 0}
              onClick={() => { void markNoticesRead(companyId, 'all').then(r => { if (r && !r.success) setError(r.error) }) }}>
              すべて読んだ
            </button>
          </div>
          {error && <p role="alert" className="px-3 py-2 text-xs text-red-600">{error}</p>}
          {meetingList(meetings.filter(m => !m.needsPerson))}
          {notices.items.length === 0
            ? <p className="px-3 py-3 text-gray-500 dark:text-zinc-400">起きたことはまだありません。</p>
            : notices.items.map(item => (
              <div key={item.id} className="relative">
              <button type="button" role="menuitem" className={ROW}
                onClick={() => {
                  setOpen(null)
                  if (!item.read) void markNoticesRead(companyId, [item.id])
                  const jobTarget = item.recordId === '' ? jobNoticeTarget(item.kind) : null
                  if (jobTarget === 'jobs') onOpenJobs?.()
                  else if (jobTarget === 'none') { /* read; nothing to open */ }
                  else if (item.recordId === '') onOpenTasks?.()
                  else onOpen({ recordId: item.recordId, title: item.recordTitle })
                }}>
                <span className={`block ${item.read ? 'text-gray-500 dark:text-zinc-400' : 'font-medium text-gray-800 dark:text-zinc-100'}`}>
                  {!item.read && <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-red-500 align-middle" />}
                  {item.text}
                </span>
                <span className="text-xs text-gray-400">{new Date(item.createdAt).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
              </button>
              {(UNDOABLE_NOTIFICATION_KINDS.includes(item.kind) || (item.aiChange && !item.aiChange.undone)) && (
                undone.has(item.id)
                  ? <span className="absolute bottom-2 right-3 text-[11.5px] text-gray-500 dark:text-zinc-400">元に戻しました</span>
                  : (
                    <button type="button" className="absolute bottom-1.5 right-3 rounded border border-gray-300 px-2 py-0.5 text-[11.5px] hover:bg-gray-50 dark:border-zinc-600 dark:hover:bg-zinc-800"
                      onClick={() => void undo(item.id, item.recordId, item.version, item.aiChange)}>
                      元に戻す
                    </button>
                  )
              )}
              </div>
            ))}
          <button type="button" className="flex w-full items-center gap-1 border-t border-gray-100 px-3 py-1.5 text-xs text-gray-500 hover:text-gray-700 dark:border-zinc-800 dark:text-zinc-400" onClick={() => void openSettings()}>
            <GearSix size={12} /> 知らせの設定
          </button>
        </div>
      )}

      {open === 'settings' && (
        <div className={PANEL} aria-label="知らせの設定">
          <p className="border-b border-gray-100 px-3 py-2 text-xs text-gray-500 dark:border-zinc-800 dark:text-zinc-400">どの知らせを出すかを選べます。ほかのパソコンでも同じ設定になります。</p>
          {error && <p role="alert" className="px-3 py-2 text-xs text-red-600">{error}</p>}
          {kinds === null && !error && <p className="px-3 py-2 text-gray-500">読み込んでいます…</p>}
          {kinds && noticeKindsShown(NOTIFICATION_KINDS, features).map(kind => (
            <label key={kind} className="flex cursor-pointer items-start gap-2 px-3 py-1.5 hover:bg-gray-50 dark:hover:bg-zinc-800">
              <input type="checkbox" className="mt-0.5" checked={kinds[kind] === true} onChange={e => void switchKind(kind, e.target.checked)} />
              <span className="text-gray-700 dark:text-zinc-200">{NOTIFICATION_KIND_LABELS[kind]}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  )
}
