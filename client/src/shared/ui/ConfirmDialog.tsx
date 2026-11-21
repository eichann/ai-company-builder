import { useId, useLayoutEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { WarningCircle } from '@phosphor-icons/react'
import { useEventListener } from '../hooks/useEventListener'
import { useLatestRef } from '../hooks/useLatestRef'

interface ConfirmDialogProps {
  isOpen: boolean
  title: string
  message: string
  confirmText?: string
  cancelText?: string
  /** Deleting or removing something: the red button, read out as an alert, focus starts on cancel. */
  danger?: boolean
  /**
   * Focus starts on a button, so Enter presses it (default: the main action, or 「やめる」 when
   * `danger`). Off when the dialog can open while the member is typing elsewhere: focus then starts
   * on the dialog itself and a stray Enter or space answers nothing. Either way Enter only ever
   * presses the focused button; nothing listens for Enter on the document.
   */
  confirmOnEnter?: boolean
  onConfirm: () => void
  onCancel: () => void
}

/**
 * The one confirm dialog (.claude/rules/design-system.md, P1). Keyboard rules from the owner's
 * proposal (components.html, 確認ダイアログ): initial focus on 「やめる」 for a danger confirm and
 * on the main action otherwise (on the dialog itself with `confirmOnEnter={false}`); Tab /
 * Shift+Tab stay inside; Esc cancels; Enter presses the focused button only (never a
 * document-level confirm, so an IME conversion's Enter elsewhere cannot confirm); focus returns to
 * what opened it. Stacked dialogs: only the top one acts.
 */
export function ConfirmDialog(props: ConfirmDialogProps) {
  if (!props.isOpen) return null
  return <OpenConfirmDialog {...props} />
}

/** Open confirm dialogs, last opened on top. Only the top one keeps focus and answers keys. */
const openDialogs: HTMLElement[] = []
const isTop = (el: HTMLElement) => openDialogs[openDialogs.length - 1] === el

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

function OpenConfirmDialog({
  title,
  message,
  confirmText = '確認',
  cancelText = 'キャンセル',
  danger = false,
  confirmOnEnter = true,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const messageId = useId()

  // A dialog that may open while the member types starts on itself, so no stray key answers it.
  const initialFocusRef = useLatestRef(() => (!confirmOnEnter ? panelRef.current : danger ? cancelRef.current : confirmRef.current))

  // Open: remember the opener, go on top, move focus in. Close: give focus back to the opener.
  useLayoutEffect(() => {
    const panel = panelRef.current
    if (!panel) return
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    openDialogs.push(panel)
    initialFocusRef.current()?.focus()
    return () => {
      const i = openDialogs.indexOf(panel)
      if (i >= 0) openDialogs.splice(i, 1)
      const active = document.activeElement
      const focusStillOurs = !active || active === document.body || panel.contains(active)
      if (opener?.isConnected && focusStillOurs) opener.focus()
    }
    // Runs once per opening: the dialog is mounted only while open and the ref never changes.
  }, [initialFocusRef])

  // Focus that lands outside the top dialog (a click elsewhere, a script) is brought back in.
  useEventListener<FocusEvent>(document, 'focusin', e => {
    const panel = panelRef.current
    if (!panel || !isTop(panel) || panel.contains(e.target as Node)) return
    initialFocusRef.current()?.focus()
  })

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    // Focus is held in the top dialog (above), so its keys reach no dialog underneath.
    const panel = panelRef.current
    if (!panel) return
    if (e.key === 'Escape') {
      // Ours alone: a dialog or panel underneath must not close on the same key.
      e.stopPropagation()
      e.preventDefault()
      onCancel()
      return
    }
    if (e.key === 'Tab') {
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE))
      if (items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      const active = document.activeElement
      if (e.shiftKey && (active === first || active === panel)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && (active === last || active === panel)) {
        e.preventDefault()
        first.focus()
      }
    }
  }

  return (
    <div
      className="fixed inset-0 z-dialog flex items-center justify-center bg-scrim"
      // A click on the scrim must not take focus out of the dialog (it closes nothing either).
      onMouseDown={e => { if (e.target === e.currentTarget) e.preventDefault() }}
    >
      <div
        ref={panelRef}
        role={danger ? 'alertdialog' : 'dialog'}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="w-full max-w-md p-dialog bg-surface-raised text-text rounded-card shadow-dialog outline-none"
      >
        <div className="flex items-start gap-3">
          {danger && (
            <WarningCircle
              size={24}
              weight="fill"
              aria-hidden
              className="text-danger-icon flex-shrink-0 mt-0.5"
            />
          )}
          <div>
            <h3 id={titleId} className="text-title text-text">{title}</h3>
            <p id={messageId} className="mt-2 whitespace-pre-line text-body text-text-muted">{message}</p>
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-6">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="h-control px-control-x text-body text-text-muted hover:text-text hover:bg-surface-sunken rounded-control transition-colors duration-fast focus-visible:outline-none focus-visible:ring-focus focus-visible:ring-focus-ring focus-visible:ring-offset-focus focus-visible:ring-offset-surface-raised"
          >
            {cancelText}
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            data-variant={danger ? 'danger' : 'primary'}
            className={`h-control px-control-x text-body font-strong rounded-control transition-colors duration-fast focus-visible:outline-none focus-visible:ring-focus focus-visible:ring-focus-ring focus-visible:ring-offset-focus focus-visible:ring-offset-surface-raised ${
              danger
                ? 'bg-danger text-on-danger hover:bg-danger-hover active:bg-danger-active'
                : 'bg-primary text-on-primary hover:bg-primary-hover active:bg-primary-active'
            }`}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  )
}
