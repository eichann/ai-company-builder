import { useRef, useState } from 'react'
import { Bell, GearSix } from '@phosphor-icons/react'
import { NOTIFICATION_KIND_LABELS, NOTIFICATION_KINDS } from '../../../../../shared/types/notifications'
import { shortDue, type NoticesState, type NoticeTarget } from '../../../../shared/notifications-app'
import { useEventListener } from '../../../shared/hooks/useEventListener'
import { getNoticeSettings, markNoticesRead, setNoticeSetting } from '../api'

const ICON_BUTTON = 'relative p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-zinc-800 text-gray-500 dark:text-zinc-400 hover:text-gray-700 dark:hover:text-zinc-200 transition-colors'
const PANEL = 'absolute right-0 top-full z-30 mt-1 w-80 max-h-[70vh] overflow-y-auto rounded-lg border border-gray-200 bg-white text-sm shadow-lg dark:border-zinc-700 dark:bg-zinc-900'
const ROW = 'block w-full px-3 py-2 text-left hover:bg-gray-50 dark:hover:bg-zinc-800'

interface Props {
  companyId: string
  state: NoticesState
  /** Open a record (AppShell: its card, or a consultation while there is no card screen). */
  onOpen: (target: NoticeTarget) => void
}

type Open = 'turn' | 'bell' | 'settings' | null

/**
 * The title bar's 「あなたの番 N」 (what waits for the member, until it is done)
 * and the bell (what happened, gone once read) — drawn by the core app only.
 * Each list item opens its record; reading the bell's list marks nothing until
 * an item is opened or 「すべて既読」 is pressed, so the other PC's dot stays honest.
 */
export function TitleBarNotices({ companyId, state, onOpen }: Props) {
  const [open, setOpen] = useState<Open>(null)
  const [kinds, setKinds] = useState<Record<string, boolean> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const root = useRef<HTMLDivElement>(null)
  useEventListener<MouseEvent>(document, 'mousedown', e => { if (!root.current?.contains(e.target as Node)) setOpen(null) }, { enabled: open !== null })
  useEventListener<KeyboardEvent>(document, 'keydown', e => { if (e.key === 'Escape') setOpen(null) }, { enabled: open !== null })

  if (!state.available) return null
  const { myTurn, notices } = state
  const toggle = (which: Open) => { setError(null); setOpen(open === which ? null : which) }

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
        title="あなたが次に動くもの"
        aria-expanded={open === 'turn'}
      >
        あなたの番 <b className="tabular-nums">{myTurn.total}</b>
      </button>
      <button type="button" onClick={() => toggle('bell')} className={ICON_BUTTON} title="知らせ" aria-label={notices.unread > 0 ? `知らせ（未読 ${notices.unread} 件）` : '知らせ'} aria-expanded={open === 'bell'}>
        <Bell size={18} />
        {notices.unread > 0 && <span data-testid="notices-unread-dot" className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-red-500" />}
      </button>

      {open === 'turn' && (
        <div className={PANEL} role="menu" aria-label="あなたの番">
          {myTurn.items.length === 0
            ? <p className="px-3 py-3 text-gray-500 dark:text-zinc-400">いま、あなたの番のものはありません。</p>
            : myTurn.items.map(item => (
              <button key={item.id} type="button" role="menuitem" className={ROW} onClick={() => { setOpen(null); onOpen({ recordId: item.id, title: item.title }) }}>
                <span className="block truncate text-gray-800 dark:text-zinc-100">{item.type === 'approval' ? '承認のお願い：' : ''}{item.title}</span>
                {item.due && <span className="text-xs text-gray-500 dark:text-zinc-400">期限 {shortDue(item.due)}</span>}
              </button>
            ))}
          {myTurn.total > myTurn.items.length && <p className="px-3 py-2 text-xs text-gray-500">ほかに {myTurn.total - myTurn.items.length} 件</p>}
        </div>
      )}

      {open === 'bell' && (
        <div className={PANEL} role="menu" aria-label="知らせ">
          <div className="flex items-center justify-between border-b border-gray-100 px-3 py-1.5 text-xs dark:border-zinc-800">
            <button type="button" className="text-blue-600 disabled:text-gray-400 dark:text-blue-400" disabled={notices.unread === 0}
              onClick={() => { void markNoticesRead(companyId, 'all').then(r => { if (r && !r.success) setError(r.error) }) }}>
              すべて既読にする
            </button>
            <button type="button" className="flex items-center gap-1 text-gray-500 hover:text-gray-700 dark:text-zinc-400" onClick={() => void openSettings()}>
              <GearSix size={12} /> 知らせの設定
            </button>
          </div>
          {error && <p role="alert" className="px-3 py-2 text-xs text-red-600">{error}</p>}
          {notices.items.length === 0
            ? <p className="px-3 py-3 text-gray-500 dark:text-zinc-400">知らせはありません。</p>
            : notices.items.map(item => (
              <button key={item.id} type="button" role="menuitem" className={ROW}
                onClick={() => {
                  setOpen(null)
                  if (!item.read) void markNoticesRead(companyId, [item.id])
                  onOpen({ recordId: item.recordId, title: item.recordTitle })
                }}>
                <span className={`block ${item.read ? 'text-gray-500 dark:text-zinc-400' : 'font-medium text-gray-800 dark:text-zinc-100'}`}>
                  {!item.read && <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-red-500 align-middle" />}
                  {item.text}
                </span>
                <span className="text-xs text-gray-400">{new Date(item.createdAt).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
              </button>
            ))}
        </div>
      )}

      {open === 'settings' && (
        <div className={PANEL} aria-label="知らせの設定">
          <p className="border-b border-gray-100 px-3 py-2 text-xs text-gray-500 dark:border-zinc-800 dark:text-zinc-400">どの知らせを出すかを選べます。ほかのパソコンでも同じ設定になります。</p>
          {error && <p role="alert" className="px-3 py-2 text-xs text-red-600">{error}</p>}
          {kinds === null && !error && <p className="px-3 py-2 text-gray-500">読み込んでいます…</p>}
          {kinds && NOTIFICATION_KINDS.map(kind => (
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
