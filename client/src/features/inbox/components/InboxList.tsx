// The inbox's chips, rows and sections (notifications.md "The inbox", "Working through the inbox"). Presentational: what a
// look shows is decided in workModel.ts / model.ts and handed in; nothing here reads, counts or filters.
import type { ReactNode } from 'react'
import { ArrowRight, Bell, Check, GearSix } from '@phosphor-icons/react'
import { STOP_LOOK } from '../../../../../shared/design-tokens/stop-meaning'
import { Button, NewDot, StatusBadge, type StatusBadgeVariant } from '../../../shared/ui/primitives'
import { ThingIcon } from '../../../shared/ui/ThingIcon'
import { commandArea } from '../../../shared/commands/commands'
import { workListRef } from '../../../shared/lib/workThrough'
import { useWhenVisible } from '../../../shared/hooks/useWhenVisible'
import { useIsNarrowerThan } from '../../../shared/hooks/useIsNarrowerThan'
import { shortDue, type RowButton } from '../../../../shared/notifications-app'
import { countText, type InboxFilter, type InboxItem, type InboxTone } from '../model'
import { foldKinds, INBOX_KINDS, type InboxKind, type InboxSections } from '../workModel'

/**
 * The chips switch what is shown; they carry no count for あなた待ち and 新着 (owner decision 2026-11-28, 11番-7): those two
 * counts are the title bar's ［受け箱］, never shown twice. 確認したもの keeps its own (it is counted nowhere else).
 */
const FILTERS: Array<{ id: InboxFilter; label: string }> = [
  { id: 'waiting', label: 'あなた待ち' },
  { id: 'new', label: '新着' },
  { id: 'seen', label: '確認したもの' },
]

const toneVariant = (tone: InboxTone): StatusBadgeVariant =>
  tone === 'success' || tone === 'neutral' || tone === 'ai' || tone === 'info' ? tone : STOP_LOOK[tone].variant

const when = (iso: string) => new Date(iso).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })

const CHIP = 'h-6 rounded-full border px-2.5 text-small transition-colors duration-fast'
const chipLook = (on: boolean) => (on
  ? 'border-selected-border bg-selected-bg text-selected-text'
  : 'border-[color:var(--color-border)] text-text-muted hover:bg-surface-sunken hover:text-text')

/** The chips in the panel's heading, and 「知らせの設定」 at the right. */
export function InboxChips({ filter, seenCount, onFilter, onSettings }: { filter: InboxFilter; seenCount: number; onFilter: (f: InboxFilter) => void; onSettings?: () => void }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <div role="group" aria-label="受け箱の絞り込み" className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
        {FILTERS.map(f => (
          <button key={f.id} type="button" aria-pressed={filter === f.id} onClick={() => onFilter(f.id)} className={`${CHIP} ${chipLook(filter === f.id)}`}>
            {f.label}{f.id === 'seen' && <> <b className="tabular-nums">{countText(seenCount)}</b></>}
          </button>
        ))}
      </div>
      {onSettings && (
        <button type="button" onClick={onSettings} className="flex flex-shrink-0 items-center gap-1 rounded-control px-1.5 py-1 text-small text-text-muted hover:bg-surface-sunken hover:text-text">
          <GearSix size={12} aria-hidden /> 知らせの設定
        </button>
      )}
    </div>
  )
}

/** Below this width the kind chips do not fit on one line: the last ones go under 「その他」 (decision 11番-6). */
const KINDS_FIT_PX = 440

/** The kind chips (すべて・止まった・承認・連絡・メール・知らせ), each with its count; on one line, 「その他」 holding the rest. */
export function KindChips({ kind, counts, onKind }: { kind: InboxKind; counts: Record<InboxKind, number>; onKind: (k: InboxKind) => void }) {
  const [ref, narrow] = useIsNarrowerThan<HTMLDivElement>(KINDS_FIT_PX)
  const { shown, folded } = foldKinds(narrow)
  const label = (id: InboxKind) => INBOX_KINDS.find(k => k.id === id)!.label
  const inFolded = folded.includes(kind)
  return (
    <div ref={ref} role="group" aria-label="種類で絞る" data-inbox-kinds className="flex min-w-0 flex-nowrap items-center gap-1.5 overflow-hidden px-3 py-1.5">
      {shown.map(id => (
        <button key={id} type="button" aria-pressed={kind === id} data-inbox-kind={id} onClick={() => onKind(id)} className={`${CHIP} flex-shrink-0 ${chipLook(kind === id)}`}>
          {label(id)} <span className="tabular-nums">{countText(counts[id])}</span>
        </button>
      ))}
      {folded.length > 0 && (
        // A plain select: one line that never moves the list down, and the keyboard and screen readers know it as is.
        <select aria-label="ほかの種類" data-inbox-kind-more value={inFolded ? kind : ''} onChange={e => { if (e.target.value) onKind(e.target.value as InboxKind) }}
          className={`${CHIP} flex-shrink-0 bg-transparent ${chipLook(inFolded)}`}>
          <option value="">その他</option>
          {folded.map(id => <option key={id} value={id}>{label(id)} {countText(counts[id])}</option>)}
        </select>
      )}
    </div>
  )
}

/** A row's own buttons from the feature it belongs to (a meeting's ［AI に読ませる］…). */
export type InboxRowButton = RowButton

interface RowProps {
  item: InboxItem
  buttons?: readonly InboxRowButton[]
  /** The row whose item is shown beside the list now. */
  current?: boolean
  onOpen: (item: InboxItem) => void
  /** ［確認した］ (a 新着 row) or ［済んだ］ (a stop of あなた待ち): marks its notices read without opening anything. */
  onSeen: (item: InboxItem) => void
  /** One of the row's own buttons was pressed (the inbox marks its notices read first). */
  onButton: (item: InboxItem, button: InboxRowButton) => void
  onUndo?: (item: InboxItem) => void
  undone?: boolean
}

export function InboxRow({ item, buttons = [], current, onOpen, onSeen, onButton, onUndo, undone }: RowProps) {
  // Opened in this look: read already, kept in its place without its dot (decision 11番-3).
  const isNew = item.section === 'new' && !item.seenHere
  const dim = item.section === 'seen' || item.section === 'moving' || !!item.seenHere
  // The one blue button is what あなた待ち asks for (approve, check and send); news only opens.
  const primary = item.section === 'waiting' && (item.action.kind === 'openApprovalCard' || item.action.kind === 'openMailDraft' || item.action.kind === 'openBrowserPlan')
  // A stop about nothing to open is dealt with elsewhere: its only button is ［済んだ］.
  const opens = !(item.stop && item.action.kind === 'none')
  return (
    <li data-inbox-row={item.key} data-inbox-current={current ? '' : undefined}
      className={`relative flex items-start gap-2.5 border-b border-[color:var(--color-border)] px-3 py-2.5 ${current ? 'bg-selected-bg' : ''}`}>
      <span className="mt-1 flex w-4 flex-shrink-0 justify-center">
        {isNew ? <NewDot label="新着" /> : null}
      </span>
      <span className="mt-0.5 flex-shrink-0 text-text-subtle">
        {item.thing === 'notice' ? <Bell size={14} aria-hidden /> : <ThingIcon kind={item.thing} size={14} />}
      </span>
      <button type="button" data-work-row={item.key} onClick={() => { if (opens) onOpen(item) }} className="min-w-0 flex-1 text-left">
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
  /** What this look draws (the chip's sections, narrowed to the kind and paged): `workModel.ts`. */
  sections: InboxSections
  /** Each section's rows under the chip and kind, all of them (paging hides none from the count; a row opened here is not news). */
  totals: { waiting: number; news: number; seen: number }
  filter: InboxFilter
  /** 案2: this week's turn that is not あなた待ち, said once beside its count (`InboxView.counts.elsewhere`). */
  elsewhere?: number
  onOpenTasks?: () => void
  /** The server's turn went past its first 200 (`InboxView.turnNotListed`). */
  turnNotListed?: boolean
  /** Unread notices past the server's list, told under 確認したもの (`InboxView.unreadNotListed`). */
  unreadNotListed?: number
  /** Rows not drawn yet: shown as the member reaches the end (or presses the line). */
  more?: { left: number; onMore: () => void }
  /** Working through the list (↑ ↓ Enter Esc): its key and the order of every row (`orderOf`). */
  work?: { listKey: string; order: readonly string[]; currentKey: string | null }
  /** 「…を片づけました。次の件です」 with ［取り消す］ (`WorkThroughNotice`). */
  notice?: ReactNode
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

const Heading = ({ label, count, danger, children, action }: { label: string; count: number; danger?: boolean; children?: ReactNode; action?: ReactNode }) => (
  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 bg-bg px-3 pt-2.5 pb-1">
    <h3 className={`text-small font-strong ${danger ? 'text-danger-text' : 'text-text-muted'}`}>{label} <span className="tabular-nums">{countText(count)}</span></h3>
    {children}
    <span className="flex-1" />
    {action}
  </div>
)
const Empty = ({ children }: { children: ReactNode }) => <p className="px-3 py-3 text-small text-text-muted">{children}</p>

/** The end of what is drawn: told when it comes into view, and a line to press for the next rows. */
function MoreRows({ left, onMore }: { left: number; onMore: () => void }) {
  const seen = useWhenVisible<HTMLButtonElement>(onMore)
  return (
    <button ref={seen} type="button" data-inbox-more onClick={onMore} className="w-full px-3 py-2 text-left text-small text-link hover:text-link-hover">
      続きを表示（あと {left} 件）
    </button>
  )
}

/** The inbox's rows: あなた待ち and 新着 (the 「新着」 chip), or one of them, or 確認したもの. */
export function InboxList({ sections, totals, filter, elsewhere = 0, onOpenTasks, turnNotListed, unreadNotListed = 0, more, work, notice, meetingButtons, onOpen, onSeen, onButton, onUndo, undone, onAllSeen, meetingNote, error, status }: ListProps) {
  const row = (item: InboxItem) => <InboxRow key={item.key} item={item} buttons={item.meetingId ? meetingButtons?.(item.meetingId) : undefined} current={work?.currentKey === item.key}
    onOpen={onOpen} onSeen={onSeen} onButton={onButton} onUndo={onUndo} undone={!!item.undo && undone.has(item.undo.noticeId)} />
  const hasMeetings = [...sections.news, ...sections.moving].some(i => i.meetingId)
  const listAttrs = work ? { ref: workListRef(work.listKey, work.order), 'data-work-list': work.listKey, ...commandArea('list', work.listKey) } : {}
  return (
    <div className="text-body text-text">
      {error && <p role="alert" className="px-3 py-2 text-small text-danger-text">{error}</p>}
      {status && !error && <p role="status" className="px-3 py-2 text-small text-success-text">{status}</p>}
      {notice}
      <div {...listAttrs}>
        {(filter === 'new' || filter === 'waiting') && (
          <section aria-label="あなた待ち">
            <Heading label="あなた待ち（止まった仕事・承認・送る前の確認）" count={totals.waiting} danger={totals.waiting > 0}>
              {/* 案2 (owner decision 2026-11-28): the red count stays what is stopped; the rest of the turn is said here once. */}
              {elsewhere > 0 && onOpenTasks && (
                <button type="button" data-inbox-elsewhere onClick={onOpenTasks} className="inline-flex items-center gap-1 text-small text-link hover:text-link-hover">
                  ほかに 今日が期限など {elsewhere} 件は『やること』で<ArrowRight size={12} aria-hidden />
                </button>
              )}
            </Heading>
            {sections.waiting.length > 0 ? <ul>{sections.waiting.map(row)}</ul> : totals.waiting === 0 && <Empty>あなたを待っているものはありません。</Empty>}
            {turnNotListed && <p className="px-3 py-1.5 text-caption text-text-subtle">あなたの番が多いため、ここにまだ出ていない承認や送る前の確認があるかもしれません。</p>}
          </section>
        )}
        {filter === 'new' && (sections.waiting.length === totals.waiting) && (
          <section aria-label="新着">
            <Heading label="新着" count={totals.news}
              action={totals.news > 0 ? <button type="button" className="text-small text-link hover:text-link-hover" onClick={onAllSeen}>すべて確認した</button> : undefined} />
            {hasMeetings && meetingNote}
            {sections.news.length > 0 ? <ul>{sections.news.map(row)}</ul> : totals.news === 0 && <Empty>新着はありません。全部確認しました。</Empty>}
            {sections.moving.length > 0 && <ul aria-label="進んでいるもの">{sections.moving.map(row)}</ul>}
          </section>
        )}
        {filter === 'seen' && (
          <section aria-label="確認したもの">
            <Heading label="確認したもの" count={totals.seen} />
            {sections.seen.length > 0 ? <ul>{sections.seen.map(row)}</ul> : <Empty>まだありません。</Empty>}
            {unreadNotListed > 0 && <p data-inbox-unlisted className="px-3 py-2 text-small text-text-muted">ほかに未読 {unreadNotListed} 件（古いもの）</p>}
          </section>
        )}
      </div>
      {more && more.left > 0 && <MoreRows key={more.left} left={more.left} onMore={more.onMore} />}
    </div>
  )
}
