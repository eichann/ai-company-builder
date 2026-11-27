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
 * Pressed (or Enter / Space when focused), the shown words turn into a field in the same place, focused with the
 * text selected. Enter (one line) or ⌘Enter saves — never while an IME converts; leaving the field saves; Esc
 * puts it back unchanged.
 */
export function InlineText({ value, label, fieldLabel, children, multiline = false, maxLength, busy = false, note, className = '', onSave }: InlineTextProps) {
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const field = useRef<HTMLInputElement & HTMLTextAreaElement>(null)
  const shown = useRef<HTMLButtonElement>(null)
  // One save at a time (Enter then the blur it causes); a closed field's late blur saves nothing.
  const saving = useRef(false)
  const open = useRef(false)

  const start = () => {
    if (busy) return
    open.current = true
    setError(null)
    setDraft(value)
    requestAnimationFrame(() => { field.current?.focus(); field.current?.select() })
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
    return (
      <button ref={shown} type="button" disabled={busy} onClick={start}
        className={`group -mx-1 inline-flex max-w-full items-baseline gap-1.5 rounded-small px-1 text-left hover:bg-surface-sunken disabled:cursor-default disabled:hover:bg-transparent ${className}`}>
        <span className={`min-w-0 [overflow-wrap:anywhere] ${multiline ? 'whitespace-pre-wrap' : ''}`}>{children}</span>
        <PencilSimpleLine aria-hidden size={14} className="shrink-0 self-center text-text-subtle opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 group-disabled:opacity-0" />
        {children !== label && <span className="sr-only">（{label}）</span>}
      </button>
    )
  }
  const common = {
    ref: field, 'aria-label': fieldLabel, value: draft, maxLength, onKeyDown: onKey,
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
