// Generic: a date edited where it is shown (the task card's 期限, a 案件・プロジェクト's 期限). Pressed, the shown date opens
// a small chooser right under it, holding the value now: quick choices (the caller's), a calendar and typing (the
// browser's own date and time fields). What may be saved is the caller's rule (`onSave`); this part only opens, keeps
// the draft and closes. Never a separate editing window (owner 2026-11-27: 「その場で直す」).
import { useState, type KeyboardEvent, type ReactNode } from 'react'
import { PencilSimpleLine } from '@phosphor-icons/react'
import { isDateValue } from '../../../../shared/core/record-types'
import { useDismiss } from '../hooks/useDismiss'
import { Button } from './primitives'

export interface InlineDateChoice {
  label: string
  /** `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM`. */
  due: string
  /** How the date reads (「明日 09:00」). */
  shown: string
}

export interface InlineDateProps {
  /** `YYYY-MM-DD`, `YYYY-MM-DDTHH:MM`, or null (none yet). */
  value: string | null
  /** The control's name (「期限を変える」), said after what is shown; also the chooser's name. */
  label: string
  /** What is shown while closed (the date in the member's words, or 「なし」). */
  children: ReactNode
  /** Quick choices above the calendar (「あしたの朝」…); none = only the calendar. */
  choices?: readonly InlineDateChoice[]
  /** The choices' name (「延ばす」). */
  choicesLabel?: string
  busy?: boolean
  /** Said at the bottom of the chooser (e.g. who is told). */
  note?: ReactNode
  className?: string
  /** Sends the date: null when saved (the chooser closes), else the words to show in it ('' keeps it open without words). */
  onSave: (due: string) => Promise<string | null>
}

/** The calendar's and the time field's values of a stored date (`2026-12-01T17:00` → `2026-12-01`, `17:00`). */
function dateParts(value: string | null): { day: string; time: string } {
  if (!value || !isDateValue(value)) return { day: '', time: '' }
  return { day: value.slice(0, 10), time: value.length > 10 ? value.slice(11, 16) : '' }
}

/** What the fields send: the day, with the time when one is given; null when the day is not a date. */
function dateFromParts(day: string, time: string): string | null {
  const due = time ? `${day}T${time}` : day
  return isDateValue(due) ? due : null
}

export function InlineDate({ value, label, children, choices = [], choicesLabel = 'すぐ選ぶ', busy = false, note, className = '', onSave }: InlineDateProps) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(() => dateParts(value))
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [box, setBox] = useState<HTMLSpanElement | null>(null)
  // A press outside (the date and its chooser) or Esc closes it unchanged.
  useDismiss(box, open, () => { if (!saving) setOpen(false) })

  const start = () => {
    if (busy) return
    setDraft(dateParts(value))
    setError(null)
    setOpen(o => !o)
  }
  // One save at a time; a failure stays in the chooser with the draft.
  const save = async (due: string | null) => {
    if (saving || due === null) return
    if (due === value) { setOpen(false); return }
    setSaving(true)
    try {
      const failure = await onSave(due)
      if (failure === null) setOpen(false)
      else setError(failure)
    } finally { setSaving(false) }
  }
  const typed = dateFromParts(draft.day, draft.time)
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
    e.preventDefault()
    void save(typed)
  }
  const disabled = busy || saving
  return (
    <span ref={setBox} className={`relative inline-block ${className}`}>
      <button type="button" disabled={busy} aria-haspopup="dialog" aria-expanded={open} aria-label={label} title={label} onClick={start}
        className="group -mx-1 inline-flex items-center gap-1 rounded-small px-1 text-left hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring disabled:opacity-disabled">
        {children}
        <PencilSimpleLine aria-hidden size={14} className="shrink-0 text-text-subtle opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100" />
      </button>
      {open && (
        <span role="dialog" aria-label={label} className="absolute left-0 top-full z-menu mt-1 block w-96 rounded-control border border-border bg-surface-raised p-1 text-small font-normal text-text shadow-pop">
          {choices.length > 0 && (
            <span role="group" aria-label={choicesLabel} className="block">
              {choices.map(c => (
                <button key={c.label} type="button" disabled={disabled} onClick={() => void save(c.due)}
                  className="flex w-full justify-between rounded-small px-2 py-1 hover:bg-surface-sunken disabled:opacity-disabled">
                  <span>{c.label}</span><span className="tabular-nums text-text-subtle">{c.shown}</span>
                </button>
              ))}
            </span>
          )}
          <span className={`flex flex-wrap items-center gap-1.5 px-2 pb-1 ${choices.length > 0 ? 'mt-1 border-t border-border pt-2' : 'pt-1'}`}>
            <input type="date" aria-label="日付" value={draft.day} disabled={disabled} onKeyDown={onKey} autoFocus={choices.length === 0}
              onChange={e => setDraft(d => ({ ...d, day: e.target.value }))}
              className="rounded-small border border-border-control bg-bg px-1 py-0.5 text-small text-text focus:border-focus-border focus:outline-none" />
            <input type="time" aria-label="時刻（なくてもかまいません）" value={draft.time} disabled={disabled} onKeyDown={onKey}
              onChange={e => setDraft(d => ({ ...d, time: e.target.value }))}
              className="rounded-small border border-border-control bg-bg px-1 py-0.5 text-small text-text focus:border-focus-border focus:outline-none" />
            <Button size="sm" variant="primary" disabled={disabled || typed === null || typed === value} onClick={() => void save(typed)}>この日にする</Button>
          </span>
          {note && <span className="block px-2 pb-1 text-caption text-text-subtle">{note}</span>}
          {error && <span role="alert" className="block px-2 pb-1 text-small text-danger-text">{error}</span>}
        </span>
      )}
    </span>
  )
}
