import { useEffect, useMemo, useRef, useState } from 'react'
import { CaretDown, ChatCircleDots, CheckCircle, CircleNotch, Eye, MagnifyingGlass, Plus, PushPin, PencilSimple, ShieldWarning, Sparkle, Trash, WarningCircle, X } from '@phosphor-icons/react'
import type { ChatSessionSummary } from '../../../shared/chat-history'
import { ConfirmDialog } from '../common/ConfirmDialog'

import { paginateConversationRows, buildConversationRows, isEmptyConversation, type ConversationTab } from '../../lib/conversationRows'
import { groupConversationRows, type ConsultationStatus, type ConversationGroupKey } from '../../lib/consultationStatus'
import { useConsultationStatuses } from './consultationStatusStore'
import { useCollapsedGroups } from '../../features/chat/hooks/useCollapsedGroups'
import { canCollapse, shownCollapsedGroups } from '../../features/chat/conversationGroups'
import { deleteChatSession, getChatSessionSummaries, onChatHistoryChanged, patchChatSession, searchChatSessions } from '../../features/chat/api'

interface Props {
  companyId: string
  tabs: ConversationTab[]
  activeTabId: string
  onSelectTab: (id: string) => void
  onOpenSession: (id: string) => void
  onCloseTab: (id: string) => void
  onNew: () => void
  onHide: () => void
}

/** The row's state at a glance: amber when it is the member's turn (shield: a permission, eye: a review, bubble: a question). */
function StatusIcon({ status }: { status?: ConsultationStatus }) {
  switch (status?.state) {
    case 'needs-you': return status.kind === 'approve'
      ? <ShieldWarning size={14} weight="fill" aria-hidden className="shrink-0 text-amber-500" />
      : status.kind === 'review'
        ? <Eye size={14} weight="bold" aria-hidden className="shrink-0 text-amber-500" />
        : <ChatCircleDots size={14} weight="fill" aria-hidden className="shrink-0 text-amber-500" />
    case 'working': return <CircleNotch size={14} aria-hidden className="shrink-0 animate-spin text-accent" />
    case 'unseen': return <Sparkle size={14} weight="fill" aria-hidden className="shrink-0 text-emerald-500" />
    case 'failed': return <WarningCircle size={14} weight="fill" aria-hidden className="shrink-0 text-red-500" />
    default: return <CheckCircle size={14} aria-hidden className="shrink-0 text-gray-400" />
  }
}

const LINE_TONE: Record<string, string> = {
  'needs-you': 'text-amber-700 dark:text-amber-300',
  failed: 'text-red-600 dark:text-red-400',
  unseen: 'text-emerald-700 dark:text-emerald-400',
}

/** A group's heading: a fold toggle with its count (「あなたの番」 never folds); a folded group still shows 新着. */
function GroupHeading({ group, first, count, folded, unread, onToggle }: { group: { key: ConversationGroupKey; label: string }; first: boolean; count: number; folded: boolean; unread: boolean; onToggle: (key: ConversationGroupKey) => void }) {
  const foldable = canCollapse(group.key)
  const tone = `flex w-full items-center justify-between rounded-md border-l-2 px-2 py-1.5 ${first ? 'mt-1' : 'mt-3'} mb-1 text-[11px] font-semibold ${group.key === 'needs-you'
    ? 'border-amber-500/60 bg-amber-500/15 text-amber-800 dark:text-amber-300'
    : 'border-accent/40 bg-gray-200/70 dark:bg-zinc-800 text-gray-600 dark:text-zinc-300'}`
  const content = <>
    <span className="flex items-center gap-1">
      {foldable && <CaretDown size={11} weight="bold" aria-hidden className={`transition-transform ${folded ? '-rotate-90' : ''}`} />}
      {group.key === 'pinned' && <PushPin size={11} weight="fill" aria-hidden />}{group.label}
      {unread && <span className="ml-1 rounded-full bg-emerald-600 px-1.5 py-px text-[10px] font-semibold text-white">新着</span>}
    </span>
    <span className="font-normal tabular-nums text-gray-500 dark:text-zinc-400">{count}件</span>
  </>
  if (!foldable) return <h3 className={tone}>{content}</h3>
  return <h3>
    <button type="button" onClick={() => onToggle(group.key)} aria-expanded={!folded} aria-controls={`conversation-group-${group.key}`}
      className={`${tone} text-left hover:brightness-95 focus-visible:outline-accent`}>{content}</button>
  </h3>
}

export function ChatSidebar({ companyId, tabs, activeTabId, onSelectTab, onOpenSession, onCloseTab, onNew, onHide }: Props) {
  const [sessions, setSessions] = useState<ChatSessionSummary[]>([])
  const [query, setQuery] = useState('')
  const [historyLimit, setHistoryLimit] = useState(20)
  useEffect(() => { setHistoryLimit(20) }, [companyId, query])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [deleting, setDeleting] = useState<ChatSessionSummary | null>(null)
  const busy = useRef(false)
  const refreshRef = useRef<() => void>(() => {})

  useEffect(() => {
    let alive = true
    let running = false
    let again = false
    async function refresh() {
      if (running) { again = true; return }
      running = true
      do {
        again = false
        try {
          const result = await getChatSessionSummaries(companyId)
          if (alive) { setSessions(result); setError(null) }
        } catch (e) { if (alive) setError(String(e instanceof Error ? e.message : e)) }
        finally { if (alive) setLoading(false) }
      } while (alive && again)
      running = false
    }
    refreshRef.current = () => { void refresh() }
    void refresh()
    const unsubscribe = onChatHistoryChanged(change => {
      if (change.companyId === companyId) void refresh()
    })
    return () => { alive = false; unsubscribe() }
  }, [companyId])

  // Message bodies stay in the main process; it answers which sessions match.
  // While a new answer is pending the previous one stays (no flicker while typing).
  const [contentMatches, setContentMatches] = useState<ReadonlySet<string> | null>(null)
  useEffect(() => {
    const trimmed = query.trim()
    if (!trimmed) { setContentMatches(null); return }
    let alive = true
    const timer = window.setTimeout(() => {
      searchChatSessions(companyId, trimmed)
        .then(ids => { if (alive) setContentMatches(new Set(ids)) })
        .catch(e => { if (alive) setError(String(e instanceof Error ? e.message : e)) })
    }, 150)
    return () => { alive = false; window.clearTimeout(timer) }
  }, [companyId, query, sessions])

  const rows = useMemo(() => {
    return buildConversationRows(sessions, tabs, query, contentMatches ?? undefined)
  }, [sessions, tabs, query, contentMatches])

  // Each open tab's live status (consultationStatusStore); history rows are done.
  const statuses = useConsultationStatuses()
  const { visibleRows, remaining } = useMemo(() => paginateConversationRows(rows, historyLimit), [rows, historyLimit])
  const groups = useMemo(() => groupConversationRows(visibleRows, id => statuses.get(id)), [visibleRows, statuses])
  // Counts include history not loaded yet (all of it is 終わったもの: closed conversations).
  const groupCounts = useMemo(() => new Map(groupConversationRows(rows, id => statuses.get(id)).map(group => [group.key, group.rows.length])), [rows, statuses])
  // The header count is what the AI waits for; a blank new conversation is not counted.
  // Folded groups (remembered per company); a search shows every match.
  const { collapsed: storedCollapsed, toggle: toggleGroup } = useCollapsedGroups(companyId)
  const collapsed = useMemo(() => shownCollapsedGroups(storedCollapsed, query), [storedCollapsed, query])
  const yourTurn = useMemo(() => rows.filter(row => row.tab && statuses.get(row.tab.id)?.state === 'needs-you').length, [rows, statuses])

  async function patch(id: string, changes: { title?: string; titleAutoGenerated?: boolean; pinned?: boolean }) {
    try { await patchChatSession(companyId, id, changes); setEditing(null) }
    catch (e) { setError(e instanceof Error ? e.message : '変更を保存できませんでした。') }
  }
  // A conversation closed before anything was sent is not kept in the history.
  function closeConversation(tabId: string, emptySession?: ChatSessionSummary) {
    onCloseTab(tabId)
    if (emptySession) void deleteChatSession(companyId, emptySession.id).catch(() => {})
  }
  async function remove() {
    if (!deleting || busy.current) return
    busy.current = true
    try { await deleteChatSession(companyId, deleting.id); setDeleting(null) }
    catch (e) { setError(e instanceof Error ? e.message : '削除できませんでした。') }
    finally { busy.current = false }
  }

  return <aside aria-label="AIへの相談" className="h-full w-64 flex flex-col border-r border-gray-200 dark:border-zinc-800 bg-gray-50 dark:bg-zinc-900 text-gray-900 dark:text-zinc-100">
    <div className="flex items-center gap-2 px-3 pt-3 pb-2">
      <h2 className="text-sm font-semibold">AIへの相談</h2>
      {yourTurn > 0 && <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] text-amber-800 dark:text-amber-300">あなたの番 <b className="tabular-nums">{yourTurn}</b></span>}
      <button onClick={onHide} aria-label="AIへの相談の一覧を閉じる" className="ml-auto p-1.5 rounded hover:bg-gray-200 dark:hover:bg-zinc-800"><X size={16} /></button>
    </div>
    <div className="px-3 space-y-3 pb-1">
      <button onClick={onNew} className="w-full flex items-center justify-center gap-2 bg-accent text-white rounded-lg py-2 text-sm"><Plus size={16} />AIに相談する</button>
      <label className="flex items-center gap-2 rounded-lg border border-gray-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-2 py-2">
        <MagnifyingGlass size={16} className="shrink-0 text-gray-400" />
        <input aria-label="相談を検索" placeholder="タイトル・本文を検索" value={query} onChange={e => setQuery(e.target.value)} className="w-full min-w-0 bg-transparent text-xs outline-none" />
        {query && <button onClick={() => setQuery('')} aria-label="検索をクリア"><X size={12} /></button>}
      </label>
      <p className="text-xs text-gray-500" aria-live="polite">{loading ? '読み込み中…' : `${rows.length}件${query.trim() ? 'の検索結果' : 'の相談'}`}</p>
    </div>
    {error && <div role="alert" className="px-3 pb-2 text-xs text-red-600">{error}<button onClick={() => refreshRef.current()} className="block underline mt-1">再読み込み</button></div>}
    <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-3">
      {!loading && !rows.length && <p className="p-3 text-xs text-gray-500">{query ? '一致する相談がありません。' : 'まだ相談はありません。'}</p>}
      {groups.map((group, groupIndex) => <section key={group.key} aria-label={group.label}>
        <GroupHeading group={group} first={groupIndex === 0} count={groupCounts.get(group.key) ?? group.rows.length}
          folded={collapsed.has(group.key)} onToggle={toggleGroup}
          unread={collapsed.has(group.key) && group.rows.some(row => row.tab && statuses.get(row.tab.id)?.state === 'unseen')} />
        <div id={`conversation-group-${group.key}`} hidden={collapsed.has(group.key)}>
        {group.rows.map(row => {
          const { session, tab } = row
          const active = tab?.id === activeTabId
          const status = tab ? statuses.get(tab.id) : undefined
          const live = status && status.state !== 'idle' ? status : undefined
          // Nothing sent and no draft: closing it leaves nothing in the history.
          const empty = !!tab && !live && isEmptyConversation(session)
          const preview = session?.draftInput?.trim() || session?.preview || '新しい相談を始めましょう'
          const line = live ? live.line : `${session?.draftInput?.trim() ? '下書き：' : ''}${preview.replace(/\[Tool:[^\]]*\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120)}`
          return <div key={row.key} className={`mb-1 rounded-lg border ${active ? 'bg-accent/10 border-accent/30' : 'border-transparent hover:bg-gray-100 dark:hover:bg-zinc-800'}`} data-conversation-id={session?.id ?? tab?.sessionId ?? row.key} data-status={live?.state ?? 'idle'}>
            {editing === session?.id && session ? <form className="p-2" onSubmit={e => { e.preventDefault(); if (title.trim()) void patch(session.id, { title: title.trim(), titleAutoGenerated: false }) }}>
              <input autoFocus aria-label="相談名" value={title} onChange={e => setTitle(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') setEditing(null) }} className="w-full rounded border border-accent p-1 text-sm bg-white dark:bg-zinc-800" />
              <div className="flex gap-3 mt-2 text-xs"><button type="submit" disabled={!title.trim()} className="text-accent">保存</button><button type="button" onClick={() => setEditing(null)}>キャンセル</button></div>
            </form> : <button onClick={() => tab ? onSelectTab(tab.id) : session && onOpenSession(session.id)} aria-current={active ? 'page' : undefined} className="block w-full text-left p-2 focus-visible:outline-accent rounded-lg">
              <div className="text-sm font-medium flex items-center gap-1.5" title={row.title}>{(live || session) && <StatusIcon status={live} />}<span className="truncate">{row.title}</span>{live?.state === 'unseen' && <span className="ml-auto shrink-0 rounded-full bg-emerald-600 px-1.5 py-px text-[10px] font-semibold text-white">新着</span>}</div>
              <p className={`text-xs truncate mt-1 ${live ? LINE_TONE[live.state] ?? 'text-gray-500 dark:text-zinc-400' : 'text-gray-500 dark:text-zinc-400'}`}>{line}</p>
              <div className="flex gap-2 mt-1 text-[10px] text-gray-500"><span>{session ? new Date(session.updatedAt).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '未送信'}</span>{active ? <span className="text-accent">表示中</span> : tab ? <span>開いています</span> : null}</div>
            </button>}
            <div className="flex items-center justify-end gap-1 px-2 pb-1">
              {session && <>
                <button aria-label={session.pinned ? 'ピン留めを解除' : 'ピン留め'} title={session.pinned ? 'ピン留めを解除' : 'ピン留め'} onClick={() => void patch(session.id, { pinned: !session.pinned })} className="p-1.5 rounded hover:bg-gray-200 dark:hover:bg-zinc-700"><PushPin size={13} weight={session.pinned ? 'fill' : 'regular'} /></button>
                <button aria-label="名前を編集" title="名前を編集" onClick={() => { setEditing(session.id); setTitle(session.title) }} className="p-1.5 rounded hover:bg-gray-200 dark:hover:bg-zinc-700"><PencilSimple size={13} /></button>
                <button aria-label="相談を削除" title="相談を削除" onClick={() => setDeleting(session)} className="p-1.5 rounded text-red-500 hover:bg-red-500/10"><Trash size={13} /></button>
              </>}
              {tab && tabs.length > 1 && <button aria-label={empty ? '相談を閉じる' : '相談を閉じる（履歴は残ります）'} title={empty ? '相談を閉じる' : '相談を閉じる（履歴は残ります）'} onClick={() => closeConversation(tab.id, empty ? session : undefined)} className="p-1.5 rounded hover:bg-gray-200 dark:hover:bg-zinc-700"><X size={13} /></button>}
            </div>
          </div>
        })}
        </div>
      </section>)}
      {remaining > 0 && !collapsed.has('done') && <button type="button" onClick={() => setHistoryLimit(value => value + 20)}
        className="mt-2 w-full rounded-lg border border-gray-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-2 text-xs font-medium text-gray-600 dark:text-zinc-300 hover:bg-gray-100 dark:hover:bg-zinc-700 focus-visible:outline-accent">
        続きを読み込む<span className="ml-1 font-normal text-gray-500">（残り{remaining}件）</span>
      </button>}
    </div>
    <ConfirmDialog isOpen={!!deleting} title="相談を削除しますか？" message={`「${deleting?.title ?? ''}」の履歴と下書きをこのPCのACBから削除します。開いている同じ相談も閉じます。`} confirmText="削除する" danger onConfirm={() => void remove()} onCancel={() => setDeleting(null)} />
  </aside>
}
