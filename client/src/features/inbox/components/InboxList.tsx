import type { ReactNode } from 'react'
import { Bell, CaretDown, CaretRight } from '@phosphor-icons/react'
import { STOP_LOOK } from '../../../../../shared/design-tokens/stop-meaning'
import { Button, NewDot, StatusBadge, type StatusBadgeVariant } from '../../../shared/ui/primitives'
import { ThingIcon } from '../../../shared/ui/ThingIcon'
import { shortDue } from '../../../../shared/notifications-app'
import { countText, type InboxFilter, type InboxItem, type InboxTone, type InboxView } from '../model'

const FILTERS: Array<{ id: InboxFilter; label: string }> = [
  { id: 'all', label: 'すべて' },
  { id: 'waiting', label: 'あなた待ち' },
  { id: 'working', label: '作業中' },
  { id: 'done', label: 'できた・未確認' },
]

const toneVariant = (tone: InboxTone): StatusBadgeVariant =>
  tone === 'success' || tone === 'neutral' || tone === 'ai' ? tone : STOP_LOOK[tone].variant

const when = (iso: string) => new Date(iso).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })

/** The chips in the panel's heading: one list filtered by state (no tabs by source, owner decision). */
export function InboxChips({ view, filter, onFilter }: { view: InboxView; filter: InboxFilter; onFilter: (f: InboxFilter) => void }) {
  return (
    <div role="group" aria-label="受け箱の絞り込み" className="flex min-w-0 flex-wrap items-center gap-1.5">
      {FILTERS.map(f => (
        <button key={f.id} type="button" aria-pressed={filter === f.id} onClick={() => onFilter(f.id)}
          className={`h-6 rounded-full border px-2.5 text-small transition-colors duration-fast ${filter === f.id
            ? 'border-selected-border bg-selected-bg text-selected-text'
            : 'border-[color:var(--color-border)] text-text-muted hover:bg-surface-sunken hover:text-text'}`}>
          {f.label} <b className="tabular-nums">{countText(view.counts[f.id])}</b>
        </button>
      ))}
    </div>
  )
}

interface RowProps {
  item: InboxItem
  onOpen: (item: InboxItem) => void
  onUndo?: (item: InboxItem) => void
  undone?: boolean
  dim?: boolean
}

function InboxRow({ item, onOpen, onUndo, undone, dim }: RowProps) {
  const unread = item.unreadNoticeIds.length > 0
  const primary = item.action.kind === 'openApprovalCard' || item.action.kind === 'openMailDraft'
  return (
    <li data-inbox-row={item.key} className="relative flex items-start gap-2.5 border-b border-[color:var(--color-border)] px-3 py-2.5">
      <span className="mt-1 flex w-4 flex-shrink-0 justify-center">
        {unread ? <NewDot label="新しい知らせ" /> : null}
      </span>
      <span className="mt-0.5 flex-shrink-0 text-text-subtle">
        {item.thing === 'notice' ? <Bell size={14} aria-hidden /> : <ThingIcon kind={item.thing} size={14} />}
      </span>
      <button type="button" onClick={() => onOpen(item)} className="min-w-0 flex-1 text-left">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className={`truncate text-body ${dim ? 'text-text-muted' : 'font-strong text-text'}`}>{item.title}</span>
          <StatusBadge variant={toneVariant(item.badge.tone)}>{item.badge.word}</StatusBadge>
        </span>
        <span className="mt-0.5 block text-small text-text-muted">{item.line}</span>
        <span className="mt-0.5 block text-caption text-text-subtle">
          {[item.source, item.at ? when(item.at) : null, item.due ? `期限 ${shortDue(item.due)}` : null].filter(Boolean).join('・')}
        </span>
      </button>
      <span className="flex flex-shrink-0 items-center gap-1.5">
        {item.undo && onUndo && (undone
          ? <span className="text-small text-text-muted">元に戻しました</span>
          : <Button size="sm" onClick={() => onUndo(item)}>元に戻す</Button>)}
        <Button size="sm" variant={primary ? 'primary' : 'secondary'} onClick={() => onOpen(item)}>{item.actionLabel}</Button>
      </span>
    </li>
  )
}

interface ListProps {
  view: InboxView
  filter: InboxFilter
  onOpen: (item: InboxItem) => void
  onUndo: (item: InboxItem) => void
  undone: ReadonlySet<string>
  /** 「まとめて確認済みにする」 (できた・未確認 only): the folded older ones, or every できた. */
  onBulkSeen: (scope: 'older' | 'done') => void
  seenOpen: boolean
  onToggleSeen: () => void
  error: string | null
}

const Heading = ({ label, count, action }: { label: string; count: number; action?: ReactNode }) => (
  <div className="flex items-center gap-2 bg-bg px-3 pt-2.5 pb-1">
    <h3 className="text-small font-strong text-text-muted">{label} <span className="tabular-nums">{countText(count)}</span></h3>
    <span className="flex-1" />
    {action}
  </div>
)

/** The inbox's body: あなた待ち (never folded, never capped), 作業中, できた・未確認, then today's seen ones. */
export function InboxList({ view, filter, onOpen, onUndo, undone, onBulkSeen, seenOpen, onToggleSeen, error }: ListProps) {
  const showWaiting = filter === 'all' || filter === 'waiting'
  const showWorking = filter === 'working' || (filter === 'all' && view.working.length > 0)
  const showDone = filter === 'all' || filter === 'done'
  const doneCount = view.counts.done
  const row = (item: InboxItem, dim = false) => <InboxRow key={item.key} item={item} onOpen={onOpen} onUndo={onUndo} undone={undone.has(item.key)} dim={dim} />
  const empty = view.counts.all === 0 && view.seenToday.length === 0
  return (
    <div className="text-body text-text">
      {error && <p role="alert" className="px-3 py-2 text-small text-danger-text">{error}</p>}
      {empty && filter === 'all' && <p className="px-3 py-4 text-small text-text-muted">いま、受け箱は空です。あなたが押すもの・届いた知らせが、ここに並びます。</p>}
      {showWaiting && (view.counts.waiting > 0 || filter === 'waiting') && (
        <section aria-label="あなた待ち">
          <Heading label="あなた待ち" count={view.counts.waiting}
            action={view.counts.waiting > 10 ? <span className="text-caption text-text-subtle">多いときは、期限の近いものから</span> : undefined} />
          <ul>{view.waiting.map(i => row(i))}</ul>
          {view.waitingNotListed > 0 && <p className="px-3 py-2 text-small text-text-muted">ほかに {view.waitingNotListed} 件あります（やることの一覧で見られます）。</p>}
          {view.counts.waiting === 0 && <p className="px-3 py-3 text-small text-text-muted">いま、あなたが押すものはありません。</p>}
          {view.resting > 0 && <p className="px-3 py-1.5 text-caption text-text-subtle">まだ始めていない、期限が来週以降か、期限のないもの {view.resting}件は、やることの一覧の「先のこと」「いつか」にあります。</p>}
        </section>
      )}
      {showWorking && (
        <section aria-label="作業中">
          <Heading label="作業中" count={view.working.length} />
          <ul>{view.working.map(i => row(i))}</ul>
          {view.working.length === 0 && <p className="px-3 py-3 text-small text-text-muted">AI が作業中の相談や「AI の番」は、まだ受け箱に出ません。右の「AI への相談」と、やることの「AI の番」で見られます。</p>}
        </section>
      )}
      {showDone && (doneCount > 0 || filter === 'done') && (
        <section aria-label="できた・未確認">
          <Heading label="できた・未確認" count={doneCount}
            action={doneCount > 0 ? <button type="button" className="text-small text-link hover:text-link-hover" onClick={() => onBulkSeen('done')}>まとめて確認済みにする</button> : undefined} />
          <ul>{view.done.map(i => row(i))}</ul>
          {view.doneLeftOut > 0 && <p className="px-3 py-2 text-small text-text-muted">ほか {view.doneLeftOut} 件</p>}
          {view.olderDone.count > 0 && (
            <div data-inbox-older className="flex items-center gap-2 border-b border-[color:var(--color-border)] px-3 py-2 text-small text-text-muted">
              <span className="flex-1">14 日より前のもの {view.olderDone.count} 件</span>
              <Button size="sm" onClick={() => onBulkSeen('older')}>まとめて確認済みにする</Button>
            </div>
          )}
          {doneCount === 0 && <p className="px-3 py-3 text-small text-text-muted">まだ確かめていない「できた」はありません。</p>}
        </section>
      )}
      {(filter === 'all' || filter === 'done') && view.seenToday.length > 0 && (
        <section aria-label="きょう確認したもの">
          <button type="button" aria-expanded={seenOpen} onClick={onToggleSeen} className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-small text-text-muted hover:text-text">
            {seenOpen ? <CaretDown size={12} /> : <CaretRight size={12} />}きょう確認したもの（{view.seenToday.length} 件）
          </button>
          {seenOpen && <ul>{view.seenToday.map(i => row(i, true))}</ul>}
        </section>
      )}
    </div>
  )
}
