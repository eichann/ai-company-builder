'use client'

import { useRef, useState, type ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

/**
 * Confirmation for a reversible but consequential change (removing a rule,
 * taking edit rights away). Irreversible actions use ConfirmByTypingDialog.
 * `onConfirm` may throw; the dialog then stays open so the caller's toast can
 * explain and the user can retry or cancel.
 *
 * Keyboard rules shared with the app's ConfirmDialog (.claude/rules/design-system.md, P1): focus
 * starts on the cancel button when `destructive`, on the main action otherwise; Tab stays inside
 * and Esc cancels (Radix); Enter presses only the focused button; a destructive confirm is an
 * alertdialog that a click on the scrim does not close; focus returns to what opened it (the
 * callers open it without a Radix trigger, so Radix alone would not know where).
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel = 'キャンセル',
  destructive = true,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: ReactNode
  confirmLabel: string
  cancelLabel?: string
  destructive?: boolean
  onConfirm: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const openerRef = useRef<HTMLElement | null>(null)

  const confirm = async () => {
    setBusy(true)
    try {
      await onConfirm()
      onOpenChange(false)
    } catch {
      // The caller has shown a toast; keep the dialog open.
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent
        className="sm:max-w-md"
        role={destructive ? 'alertdialog' : 'dialog'}
        aria-modal="true"
        onOpenAutoFocus={(e) => {
          openerRef.current = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null
          e.preventDefault()
          ;(destructive ? cancelRef : confirmRef).current?.focus()
        }}
        onCloseAutoFocus={(e) => {
          const opener = openerRef.current
          openerRef.current = null
          if (opener?.isConnected) {
            e.preventDefault()
            opener.focus()
          }
        }}
        onPointerDownOutside={(e) => { if (destructive) e.preventDefault() }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription asChild><div className="space-y-2">{description}</div></DialogDescription>}
        </DialogHeader>
        <DialogFooter>
          <Button ref={cancelRef} type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button ref={confirmRef} type="button" variant={destructive ? 'destructive' : 'default'} onClick={confirm} disabled={busy}>
            {busy ? '処理しています…' : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
