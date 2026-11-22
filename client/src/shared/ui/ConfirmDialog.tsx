import { useId, useRef, type ReactNode } from 'react'
import { WarningCircle } from '@phosphor-icons/react'
import { Dialog, DialogFooter, DialogTitle } from './Dialog'

interface ConfirmDialogProps {
  isOpen: boolean
  title: string
  message: string
  /** More under the message (what the confirm is about, set apart: a web address's domain). */
  detail?: ReactNode
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
 * The one confirm dialog (.claude/rules/design-system.md, P1; its frame and keys are `Dialog`). Keyboard rules from the owner's
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

function OpenConfirmDialog({
  title,
  message,
  detail,
  confirmText = '確認',
  cancelText = 'キャンセル',
  danger = false,
  confirmOnEnter = true,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const messageId = useId()

  return (
    <Dialog
      onClose={onCancel}
      role={danger ? 'alertdialog' : 'dialog'}
      labelledBy={titleId}
      describedBy={messageId}
      // The scrim closes no confirm: an answer is always a button press (or Esc).
      closeOnScrim={false}
      // A dialog that may open while the member types starts on itself, so no stray key answers it.
      initialFocus={!confirmOnEnter ? undefined : danger ? cancelRef : confirmRef}
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
        <div className="min-w-0">
          <DialogTitle id={titleId}>{title}</DialogTitle>
          <p id={messageId} className="mt-2 whitespace-pre-line text-body text-text-muted">{message}</p>
          {detail}
        </div>
      </div>
      <DialogFooter>
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
      </DialogFooter>
    </Dialog>
  )
}
