// Generic: words edited where they are shown (RecordPage's `titleEdit`, the task card's 目的). What may be saved is
// the caller's rule (`onSave`); this part only opens, keeps the draft and closes.
import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { PencilSimpleLine } from '@phosphor-icons/react'

export interface InlineTextProps {
  value: string
  /** The control's name (「件名を直す」), said after what is shown. */
  label: string
  /** The field's name (「件名」). */
  fieldLabel: string
  /** What is shown while not editing (the text itself, or a quiet 「目的を書く」). */
  children: ReactNode
  /** One line (Enter saves) or several (⌘Enter / Ctrl+Enter saves, Enter is a new line). */
  multiline?: boolean
  maxLength?: number
  busy?: boolean
  /** Said under the field while editing (e.g. that saving accepts the request). */
  note?: ReactNode
  /** The class of the shown words; the field takes its font from where it stands. */
  className?: string
  /**
   * Sends the draft: null when saved or when nothing was to send (the field closes), else the words to show
   * under it ('' keeps the field open without words, e.g. when the screen shows a conflict itself).
   */
  onSave: (draft: string) => Promise<string | null>
}

/**
 * Pressed (or its pencil, the keyboard's way in: Enter / Space), the shown words turn into a field in the same place, focused with the
 * text selected. Enter (one line) or ⌘Enter saves — never while an IME converts; leaving the field saves; Esc
 * puts it back unchanged.
 */
export function InlineText({ value, label, fieldLabel, children, multiline = false, maxLength, busy = false, note, className = '', onSave }: InlineTextProps) {
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Focused with the text selected as the field appears (in the commit, so no key typed first is lost).
  const opened = useRef(false)
  const takeField = (el: HTMLInputElement | HTMLTextAreaElement | null) => {
    if (el && opened.current) { opened.current = false; el.focus(); el.select() }
  }
  const shown = useRef<HTMLButtonElement>(null)
  // One save at a time (Enter then the blur it causes); a closed field's late blur saves nothing.
  const saving = useRef(false)
  const open = useRef(false)

  const start = () => {
    if (busy) return
    open.current = true
    setError(null)
    setDraft(value)
    opened.current = true
  }
  const close = (back: boolean) => {
    open.current = false
    setDraft(null)
    setError(null)
    // Closed from the keyboard, focus goes back to the words (not lost to the page).
    if (back) requestAnimationFrame(() => shown.current?.focus())
  }
  const save = async (back: boolean) => {
    if (!open.current || saving.current || draft === null) return
    saving.current = true
    try {
      const failure = await onSave(draft)
      if (failure === null) close(back)
      else setError(failure)
    } finally { saving.current = false }
  }
  const onKey = (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); return }
    if (e.key !== 'Enter' || e.nativeEvent.isComposing || e.keyCode === 229) return
    if (multiline && !(e.metaKey || e.ctrlKey)) return
    e.preventDefault()
    void save(true)
  }

  if (draft === null) {
    const pencil = <PencilSimpleLine aria-hidden size={14} className="shrink-0 self-center text-text-subtle opacity-0 group-hover:opacity-100 group-focus-within:opacity-100" />
    // Only a call to write (「目的を書く」): the words are the button.
    if (children === label) {
      return (
        <button ref={shown} type="button" disabled={busy} onClick={start}
          className={`group -mx-1 inline-flex items-baseline gap-1 rounded-small px-1 text-left hover:bg-surface-sunken disabled:opacity-disabled ${className}`}>
          {children}{pencil}
        </button>
      )
    }
    // The words themselves are pressed with the mouse; the pencil is the keyboard's way in and names the action, so
    // the heading's text stays the title alone.
    return (
      <span className={`group -mx-1 inline-flex max-w-full items-baseline gap-1 rounded-small px-1 ${busy ? '' : 'cursor-text hover:bg-surface-sunken'} ${className}`}>
        <span onClick={start} className={`min-w-0 [overflow-wrap:anywhere] ${multiline ? 'whitespace-pre-wrap' : ''}`}>{children}</span>
        <button ref={shown} type="button" aria-label={label} title={label} disabled={busy} onClick={start}
          className="inline-flex shrink-0 self-center rounded-small focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring">{pencil}</button>
      </span>
    )
  }
  const common = {
    ref: takeField, 'aria-label': fieldLabel, value: draft, maxLength, onKeyDown: onKey,
    onBlur: () => { void save(false) },
    // The field takes the shown text's size and weight, so nothing jumps.
    style: { font: 'inherit' },
    className: '-mx-1 block w-full rounded-small border border-border-control bg-bg px-1 text-text focus:border-focus-border focus:outline-none',
  }
  return (
    <span className="block space-y-1">
      {multiline
        ? <textarea {...common} rows={3} onChange={e => setDraft(e.target.value)} />
        : <input {...common} onChange={e => setDraft(e.target.value.replace(/[\r\n]+/g, ' '))} />}
      {multiline && <span className="block text-caption font-normal text-text-subtle">⌘Enter またはほかの所を押すと保存・Esc でやめる</span>}
      {note && <span className="block text-small font-normal text-text-muted">{note}</span>}
      {error && <span role="alert" className="block text-small font-normal text-danger-text">{error}</span>}
    </span>
  )
}
