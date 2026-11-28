// ACB foundation: the parts of working through a list (shared/lib/workThrough.ts) — the bar over the item shown and the
// list's line after an item was done with — drawn alike by the やること list (app/), a 案件's やること (features/records)
// and the inbox (features/inbox). Rules: tasks-ui.md "Working through a list".
import { useSyncExternalStore } from 'react'
import { ArrowDown, ArrowUp, X } from '@phosphor-icons/react'
import { noticeOf, subscribeWork, type WorkPosition } from '../lib/workThrough'

const ICON_BUTTON = 'inline-flex h-control-sm px-1.5 items-center justify-center rounded-control text-text-muted hover:bg-surface-sunken hover:text-text disabled:opacity-disabled'

/** 「3 / 11」 with ［前の件］［次の件］ over the item shown, the keys said once, and ［閉じる］ where the item can be put away. */
export function WorkThroughBar({ position, onStep, onClose }: { position: WorkPosition | null; onStep: (delta: 1 | -1) => void; onClose?: () => void }) {
  return (
    <div role="group" aria-label="一覧の何件目か" data-work-bar className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-3 text-small text-text-muted">
      {/* An item no longer listed (just finished, or opened from elsewhere) has no place to count. */}
      {position && <>
        <span aria-live="polite" className="mr-1 tabular-nums font-medium text-text">{position.at} / {position.total}</span>
        <button type="button" aria-label="前の件" title="前の件（↑ または k）" disabled={position.at <= 1} onClick={() => onStep(-1)} className={ICON_BUTTON}><ArrowUp size={14} /></button>
        <button type="button" aria-label="次の件" title="次の件（↓ または j）" disabled={position.at >= position.total} onClick={() => onStep(1)} className={ICON_BUTTON}><ArrowDown size={14} /></button>
        <span className="ml-2 hidden truncate text-caption font-normal text-text-subtle md:inline">↑↓ で移る・Enter で中へ・Esc で一覧へ</span>
      </>}
      {onClose && (
        <button type="button" onClick={onClose} className="ml-auto inline-flex items-center gap-1 rounded-control px-1.5 py-0.5 text-small hover:bg-surface-sunken hover:text-text">
          <X size={12} aria-hidden />閉じる
        </button>
      )}
    </div>
  )
}

/** What the list says after an item was done with (「…を片づけました。次の件です」) and ［取り消す］ while it can be. */
export function WorkThroughNotice({ listKey }: { listKey: string }) {
  const notice = useSyncExternalStore(subscribeWork, () => noticeOf(listKey))
  if (!notice) return null
  return (
    <p role="status" data-work-notice className="mx-1.5 my-1 flex flex-wrap items-center gap-x-2 rounded-control border border-border bg-surface-raised px-2.5 py-1.5 text-small text-text shadow-card">
      <span className="min-w-0 flex-1">{notice.text}</span>
      {notice.undo && <button type="button" onClick={notice.undo} className="shrink-0 text-small text-link hover:text-link-hover">取り消す</button>}
    </p>
  )
}
