import type { ReactNode } from 'react'
import { Bell, Check, GearSix } from '@phosphor-icons/react'
import { STOP_LOOK } from '../../../../../shared/design-tokens/stop-meaning'
import { Button, NewDot, StatusBadge, type StatusBadgeVariant } from '../../../shared/ui/primitives'
import { ThingIcon } from '../../../shared/ui/ThingIcon'
import { shortDue, type RowButton } from '../../../../shared/notifications-app'
import { countText, type InboxFilter, type InboxItem, type InboxTone, type InboxView } from '../model'

const FILTERS: Array<{ id: InboxFilter; label: string }> = [
  { id: 'waiting', label: 'あなた待ち' },
  { id: 'new', label: '新着' },
  { id: 'seen', label: '確認したもの' },
]
const chipCount = (view: InboxView, f: InboxFilter) => (f === 'waiting' ? view.counts.waiting : f === 'new' ? view.counts.news : view.counts.seen)

const toneVariant = (tone: InboxTone): StatusBadgeVariant =>
  tone === 'success' || tone === 'neutral' || tone === 'ai' || tone === 'info' ? tone : STOP_LOOK[tone].variant

const when = (iso: string) => new Date(iso).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })

/** The chips in the panel's heading (あなた待ち's count in red), and 「知らせの設定」 at the right. */
export function InboxChips({ view, filter, onFilter, onSettings }: { view: InboxView; filter: InboxFilter; onFilter: (f: InboxFilter) => void; onSettings?: () => void }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <div role="group" aria-label="受け箱の絞り込み" className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
        {FILTERS.map(f => {
          const count = chipCount(view, f.id)
          return (
            <button key={f.id} type="button" aria-pressed={filter === f.id} onClick={() => onFilter(f.id)}
              className={`h-6 rounded-full border px-2.5 text-small transition-colors duration-fast ${filter === f.id
                ? 'border-selected-border bg-selected-bg text-selected-text'
                : 'border-[color:var(--color-border)] text-text-muted hover:bg-surface-sunken hover:text-text'}`}>
              {f.label} <b className={`tabular-nums ${f.id === 'waiting' && count > 0 ? 'text-danger-text' : ''}`}>{countText(count)}</b>
            </button>
          )
        })}
      </div>
      {onSettings && (
        <button type="button" onClick={onSettings} className="flex flex-shrink-0 items-center gap-1 rounded-control px-1.5 py-1 text-small text-text-muted hover:bg-surface-sunken hover:text-text">
          <GearSix size={12} aria-hidden /> 知らせの設定
        </button>
      )}
    </div>
  )
}

/** A row's own buttons from the feature it belongs to (a meeting's ［AI に読ませる］…). */
export type InboxRowButton = RowButton

interface RowProps {
  item: InboxItem
  buttons?: readonly InboxRowButton[]
  onOpen: (item: InboxItem) => void
  /** ［確認した］ (a 新着 row) or ［済んだ］ (a stop of あなた待ち): marks its notices read without opening anything. */
  onSeen: (item: InboxItem) => void
  /** One of the row's own buttons was pressed (the inbox marks its notices read first). */
  onButton: (item: InboxItem, button: InboxRowButton) => void
  onUndo?: (item: InboxItem) => void
  undone?: boolean
}

function InboxRow({ item, buttons = [], onOpen, onSeen, onButton, onUndo, undone }: RowProps) {
  const isNew = item.section === 'new'
  const dim = item.section === 'seen' || item.section === 'moving'
  // The one blue button is what あなた待ち asks for (approve, check and send); news only opens.
  const primary = item.section === 'waiting' && (item.action.kind === 'openApprovalCard' || item.action.kind === 'openMailDraft' || item.action.kind === 'openBrowserPlan')
  // A stop about nothing to open is dealt with elsewhere: its only button is ［済んだ］.
  const opens = !(item.stop && item.action.kind === 'none')
  return (
    <li data-inbox-row={item.key} className="relative flex items-start gap-2.5 border-b border-[color:var(--color-border)] px-3 py-2.5">
      <span className="mt-1 flex w-4 flex-shrink-0 justify-center">
        {isNew ? <NewDot label="新着" /> : null}
      </span>
      <span className="mt-0.5 flex-shrink-0 text-text-subtle">
        {item.thing === 'notice' ? <Bell size={14} aria-hidden /> : <ThingIcon kind={item.thing} size={14} />}
      </span>
      <button type="button" onClick={() => { if (opens) onOpen(item) }} className="min-w-0 flex-1 text-left">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className={`truncate text-body ${dim ? 'text-text-muted' : 'font-strong text-text'}`}>{item.title}</span>
          <StatusBadge variant={toneVariant(item.badge.tone)}>{item.badge.word}</StatusBadge>
        </span>
        <span className="mt-0.5 block text-small text-text-muted">{item.line}</span>
        {item.expiresSoon && <span data-inbox-expires className="mt-0.5 block text-small text-warning-text">あと1日で読めなくなります</span>}
        <span className="mt-0.5 block text-caption text-text-subtle">
          {[item.source, item.at ? when(item.at) : null, item.due ? `期限 ${shortDue(item.due)}` : null].filter(Boolean).join('・')}
        </span>
      </button>
      <span className="flex flex-shrink-0 flex-wrap items-center justify-end gap-1.5">
        {buttons.map(b => <Button key={b.label} size="sm" variant={b.primary ? 'primary' : 'secondary'} disabled={b.disabled} title={b.title} onClick={() => onButton(item, b)}>{b.label}</Button>)}
        {item.undo && onUndo && (undone
          ? <span className="text-small text-text-muted">元に戻しました</span>
          : <Button size="sm" onClick={() => onUndo(item)}>元に戻す</Button>)}
        {isNew && <Button size="sm" variant="ghost" onClick={() => onSeen(item)}><Check size={12} aria-hidden />確認した</Button>}
        {item.stop && <Button size="sm" variant="secondary" onClick={() => onSeen(item)}><Check size={12} aria-hidden />済んだ</Button>}
        {opens && item.action.kind !== 'none' && <Button size="sm" variant={primary ? 'primary' : 'secondary'} onClick={() => onOpen(item)}>{item.actionLabel}</Button>}
      </span>
    </li>
  )
}

interface ListProps {
  view: InboxView
  filter: InboxFilter
  /** The buttons of a meeting row (`InboxItem.meetingId`), from the minutes feature through AppShell. */
  meetingButtons?: (meetingId: string) => readonly InboxRowButton[]
  onOpen: (item: InboxItem) => void
  onSeen: (item: InboxItem) => void
  onButton: (item: InboxItem, button: InboxRowButton) => void
  onUndo: (item: InboxItem) => void
  undone: ReadonlySet<string>
  /** 「すべて確認した」: every 新着 row (never あなた待ち). */
  onAllSeen: () => void
  /** Said above 新着 when there are meetings (the minutes feature's 「自動で読む」 suggestion). */
  meetingNote?: ReactNode
  error: string | null
  /** What was just done from a row that moved it away (「…を元に戻しました」). */
  status?: string | null
}

const Heading = ({ label, count, danger, action }: { label: string; count: number; danger?: boolean; action?: ReactNode }) => (
  <div className="flex items-center gap-2 bg-bg px-3 pt-2.5 pb-1">
    <h3 className={`text-small font-strong ${danger ? 'text-danger-text' : 'text-text-muted'}`}>{label} <span className="tabular-nums">{countText(count)}</span></h3>
    <span className="flex-1" />
    {action}
  </div>
)
const Empty = ({ children }: { children: ReactNode }) => <p className="px-3 py-3 text-small text-text-muted">{children}</p>

/** The inbox's body: あなた待ち and 新着 (the 「新着」 chip), or one of them, or 確認したもの. */
export function InboxList({ view, filter, meetingButtons, onOpen, onSeen, onButton, onUndo, undone, onAllSeen, meetingNote, error, status }: ListProps) {
  const row = (item: InboxItem) => <InboxRow key={item.key} item={item} buttons={item.meetingId ? meetingButtons?.(item.meetingId) : undefined}
    onOpen={onOpen} onSeen={onSeen} onButton={onButton} onUndo={onUndo} undone={!!item.undo && undone.has(item.undo.noticeId)} />
  const hasMeetings = [...view.news, ...view.moving].some(i => i.meetingId)
  return (
    <div className="text-body text-text">
      {error && <p role="alert" className="px-3 py-2 text-small text-danger-text">{error}</p>}
      {status && !error && <p role="status" className="px-3 py-2 text-small text-success-text">{status}</p>}
      {(filter === 'new' || filter === 'waiting') && (
        <section aria-label="あなた待ち">
          <Heading label="あなた待ち（止まった仕事・承認・送る前の確認）" count={view.counts.waiting} danger={view.counts.waiting > 0} />
          {view.waiting.length > 0 ? <ul>{view.waiting.map(row)}</ul> : <Empty>あなたを待っているものはありません。</Empty>}
          {view.turnNotListed && <p className="px-3 py-1.5 text-caption text-text-subtle">やることが多いため、ほかの承認や送る前の確認は、左の「やること」で見てください。</p>}
        </section>
      )}
      {filter === 'new' && (
        <section aria-label="新着">
          <Heading label="新着" count={view.counts.news}
            action={view.counts.news > 0 ? <button type="button" className="text-small text-link hover:text-link-hover" onClick={onAllSeen}>すべて確認した</button> : undefined} />
          {hasMeetings && meetingNote}
          {view.news.length > 0 ? <ul>{view.news.map(row)}</ul> : <Empty>新着はありません。全部確認しました。</Empty>}
          {view.moving.length > 0 && <ul aria-label="進んでいるもの">{view.moving.map(row)}</ul>}
        </section>
      )}
      {filter === 'seen' && (
        <section aria-label="確認したもの">
          <Heading label="確認したもの" count={view.counts.seen} />
          {view.seen.length > 0 ? <ul>{view.seen.map(row)}</ul> : <Empty>まだありません。</Empty>}
          {view.unreadNotListed > 0 && <p data-inbox-unlisted className="px-3 py-2 text-small text-text-muted">ほかに未読 {view.unreadNotListed} 件（古いもの）</p>}
        </section>
      )}
      <p className="px-3 py-2 text-caption text-text-subtle">今日が期限のものを含め、あなたのやることは左の「やること」にあります。受け箱では数えません。</p>
    </div>
  )
}
