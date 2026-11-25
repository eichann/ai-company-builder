// 番ごと's 期限切れ (owner decision 2026-11-26, 「受け箱の作り直し」 依頼1): one line instead of a red list, and 「まとめて直す…」 —
// all to next Monday, all without a due, or one by one 来週へ / やめる. Each press goes to the server as the card's own
// actions do (`set_due`, a task's `cancel` = アーカイブ) and is said with ［元に戻す］; the server decides every one.
import { useState } from 'react'
import type { TaskListItem } from '../../../../shared/tasks'
import { Button } from '../../../shared/ui/primitives'
import { askedByOthers, dueText, overdueFixes, type CompanyNow } from '../model'

export interface OverdueDone { text: string; undo?: () => void }

interface Props {
  items: readonly TaskListItem[]
  now: CompanyNow
  /** 「来週の月曜」 in company time (`nextMondayDue`). */
  nextMonday: string
  busy: boolean
  /** What the last press did (with its 元に戻す), said inside the block. */
  done: OverdueDone | null
  onOpen: (recordId: string) => void
  onMove: (items: readonly TaskListItem[], due: string | null) => void
  onDrop: (item: TaskListItem) => void
}

export function OverdueFix({ items, now, nextMonday, busy, done, onOpen, onMove, onDrop }: Props) {
  const [open, setOpen] = useState(false)
  const movable = items.filter(i => overdueFixes(i).move)
  // Said before 「全部…」 is pressed: those requesters are told (none of them → nothing said).
  const asked = askedByOthers(movable)
  return (
    <section aria-label="期限切れ" data-overdue className="mx-1 rounded-control border border-danger-border bg-danger-bg px-2.5 py-2">
      <p className="text-small text-danger-text">期限切れ {items.length} 件。期限を直すか、やめるかを選んでください。</p>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <Button size="sm" aria-expanded={open} onClick={() => setOpen(o => !o)}>{open ? '閉じる' : 'まとめて直す…'}</Button>
      </div>
      {done && (
        <p role="status" className="mt-1.5 flex flex-wrap items-center gap-2 text-small text-text">
          {done.text}
          {done.undo && <button type="button" disabled={busy} onClick={done.undo} className="text-small text-link hover:text-link-hover">元に戻す</button>}
        </p>
      )}
      {open && (
        <div className="mt-2 rounded-control border border-[color:var(--color-border)] bg-surface-raised">
          {movable.length > 0 && (
            <div className="flex flex-wrap gap-1.5 border-b border-[color:var(--color-border)] p-2">
              {asked > 0 && <p data-overdue-asked className="w-full text-caption text-text-muted">うち {asked} 件は頼まれたものです。頼んだ人に知らせが届きます。</p>}
              <Button size="sm" disabled={busy} title={dueText(nextMonday, now)} onClick={() => onMove(movable, nextMonday)}>全部 来週の月曜へ</Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => onMove(movable, null)}>全部 期限なしに</Button>
            </div>
          )}
          <ul>
            {items.map(i => {
              const fix = overdueFixes(i)
              return (
                <li key={i.id} data-overdue-row={i.id} className="flex items-center gap-1.5 border-b border-[color:var(--color-border)] px-2 py-1.5 last:border-b-0">
                  <button type="button" onClick={() => onOpen(i.id)} className="min-w-0 flex-1 truncate text-left text-small text-text hover:text-link">
                    {i.title}<span className="ml-1.5 text-caption text-danger-text">{i.due ? dueText(i.due, now) : ''}</span>
                  </button>
                  {fix.move && <button type="button" disabled={busy} className="text-caption text-link hover:text-link-hover" onClick={() => onMove([i], nextMonday)}>来週へ</button>}
                  {fix.drop && <button type="button" disabled={busy} className="text-caption text-link hover:text-link-hover" onClick={() => onDrop(i)}>やめる</button>}
                </li>
              )
            })}
          </ul>
          {movable.length < items.length && <p className="px-2 py-1.5 text-caption text-text-subtle">ここで直せないものは、開いてカードから直してください。</p>}
        </div>
      )}
    </section>
  )
}
