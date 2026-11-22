import { useId, useRef, useState, type ReactNode } from 'react'
import { Dialog, DialogFooter, DialogTitle } from './Dialog'
import { Button } from './primitives'

interface InputDialogProps {
  isOpen: boolean
  title: string
  placeholder?: string
  defaultValue?: string
  /** Why the last value was refused; the dialog stays open with the typed name. */
  error?: string | null
  confirmText?: string
  onConfirm: (value: string) => void | Promise<void>
  onCancel: () => void
  /** More fields under the box (a colour choice); their state is the caller's. */
  children?: ReactNode
}

/** A one-field dialog (a name). Mounted fresh at each opening, so it starts from `defaultValue`. */
export function InputDialog(props: InputDialogProps) {
  if (!props.isOpen) return null
  return <OpenInputDialog {...props} />
}

function OpenInputDialog({
  title,
  placeholder,
  defaultValue = '',
  error = null,
  confirmText = '作成',
  onConfirm,
  onCancel,
  children,
}: InputDialogProps) {
  const [value, setValue] = useState(defaultValue)
  const [busy, setBusy] = useState(false)
  const selected = useRef(false)
  const titleId = useId()

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!value.trim() || busy) return
    setBusy(true)
    try {
      await onConfirm(value.trim())
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog onClose={onCancel} labelledBy={titleId} closeOnScrim={false}>
      <DialogTitle id={titleId} className="mb-4">{title}</DialogTitle>
      <form onSubmit={handleSubmit}>
        <input
          // Focus and select the name once, when the dialog opens.
          ref={el => { if (el && !selected.current) { selected.current = true; el.focus(); el.select() } }}
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={placeholder}
          aria-label={title}
          aria-invalid={error ? true : undefined}
          className="w-full px-3 py-2 bg-[var(--color-surface)] border border-border-control rounded-control text-text placeholder:text-text-subtle focus:outline-none focus:border-focus-border"
        />
        {children}
        {error && (
          <p role="alert" className="mt-2 text-xs text-danger-text whitespace-pre-line">{error}</p>
        )}
        <DialogFooter>
          <Button onClick={onCancel}>キャンセル</Button>
          <Button type="submit" variant="primary" disabled={!value.trim() || busy}>{confirmText}</Button>
        </DialogFooter>
      </form>
    </Dialog>
  )
}
