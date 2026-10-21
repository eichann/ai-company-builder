'use client'

import { useId, useState, type ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

/**
 * Destructive-action dialog that stays disabled until the exact name of the
 * target is typed. `onConfirm` may throw; the dialog then stays open so the
 * caller's toast can explain and the user can retry or cancel.
 */
export function ConfirmByTypingDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmText,
  confirmLabel,
  onConfirm,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: ReactNode
  /** What the user must type, usually the target's name. */
  confirmText: string
  confirmLabel: string
  onConfirm: () => Promise<void>
  children?: ReactNode
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {/* Remount the form per opening so the typed text never carries over. */}
        {open && (
          <ConfirmForm
            title={title}
            description={description}
            confirmText={confirmText}
            confirmLabel={confirmLabel}
            onConfirm={onConfirm}
            onCancel={() => onOpenChange(false)}
          >
            {children}
          </ConfirmForm>
        )}
      </DialogContent>
    </Dialog>
  )
}

function ConfirmForm({
  title,
  description,
  confirmText,
  confirmLabel,
  onConfirm,
  onCancel,
  children,
}: {
  title: string
  description?: ReactNode
  confirmText: string
  confirmLabel: string
  onConfirm: () => Promise<void>
  onCancel: () => void
  children?: ReactNode
}) {
  const inputId = useId()
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const matches = typed.trim() === confirmText.trim()

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!matches || busy) return
    setBusy(true)
    try {
      await onConfirm()
    } catch {
      // The caller reports the failure; keep the dialog open.
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        {description && <DialogDescription asChild><div>{description}</div></DialogDescription>}
      </DialogHeader>
      {children}
      <div className="grid gap-2">
        <Label htmlFor={inputId} className="font-normal text-muted-foreground">
          確認のため <span className="font-semibold text-foreground select-all">{confirmText}</span> と入力してください
        </Label>
        <Input
          id={inputId}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoComplete="off"
          autoFocus
        />
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
          キャンセル
        </Button>
        <Button type="submit" variant="destructive" disabled={!matches || busy}>
          {busy ? '処理中…' : confirmLabel}
        </Button>
      </DialogFooter>
    </form>
  )
}
