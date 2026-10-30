import { useEffect } from 'react'
import { WarningCircle } from '@phosphor-icons/react'

interface ConfirmDialogProps {
  isOpen: boolean
  title: string
  message: string
  confirmText?: string
  cancelText?: string
  danger?: boolean
  /** Enter confirms (default). Off when the dialog can open while the member is typing elsewhere. */
  confirmOnEnter?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({
  isOpen,
  title,
  message,
  confirmText = '確認',
  cancelText = 'キャンセル',
  danger = false,
  confirmOnEnter = true,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (!isOpen) return
      if (e.key === 'Escape') {
        onCancel()
      } else if (e.key === 'Enter' && confirmOnEnter) {
        onConfirm()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onConfirm, onCancel, confirmOnEnter])

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-md p-4 bg-sidebar-bg border border-border rounded-lg shadow-xl dark:bg-zinc-900 dark:border-white/10">
        <div className="flex items-start gap-3">
          {danger && (
            <WarningCircle
              size={24}
              weight="fill"
              className="text-red-400 flex-shrink-0 mt-0.5"
            />
          )}
          <div>
            <h3 className="text-lg font-medium text-text-primary dark:text-zinc-50">{title}</h3>
            <p className="mt-2 whitespace-pre-line text-sm text-text-secondary dark:text-zinc-300">{message}</p>
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-6">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary hover:bg-activitybar-bg rounded-md transition-colors dark:text-zinc-400 dark:hover:bg-white/[0.06] dark:hover:text-zinc-100"
          >
            {cancelText}
          </button>
          <button
            onClick={onConfirm}
            className={`px-4 py-2 text-sm text-white rounded-md transition-colors ${
              danger
                ? 'bg-red-500 hover:bg-red-600'
                : 'bg-accent hover:bg-accent/80'
            }`}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  )
}
