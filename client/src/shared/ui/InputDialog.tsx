import { useEffect, useRef, useState } from 'react'

interface InputDialogProps {
  isOpen: boolean
  title: string
  placeholder?: string
  defaultValue?: string
  onConfirm: (value: string) => void
  onCancel: () => void
}

export function InputDialog({
  isOpen,
  title,
  placeholder,
  defaultValue = '',
  onConfirm,
  onCancel,
}: InputDialogProps) {
  const [value, setValue] = useState(defaultValue)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (isOpen) {
      setValue(defaultValue)
      // Focus and select text after a short delay to ensure the dialog is rendered
      setTimeout(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      }, 50)
    }
  }, [isOpen, defaultValue])

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (!isOpen) return
      if (e.key === 'Escape') {
        onCancel()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onCancel])

  if (!isOpen) return null

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (value.trim()) {
      onConfirm(value.trim())
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-md p-4 bg-sidebar-bg border border-border rounded-lg shadow-xl">
        <h3 className="text-lg font-medium text-text-primary mb-4">{title}</h3>
        <form onSubmit={handleSubmit}>
          <input
            ref={inputRef}
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={placeholder}
            className="w-full px-3 py-2 bg-editor-bg border border-border rounded-md text-text-primary placeholder-text-secondary focus:outline-none focus:border-accent"
          />
          <div className="flex justify-end gap-2 mt-4">
            <button
              type="button"
              onClick={onCancel}
              className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary hover:bg-activitybar-bg rounded-md transition-colors"
            >
              キャンセル
            </button>
            <button
              type="submit"
              disabled={!value.trim()}
              className="px-4 py-2 text-sm bg-accent hover:bg-accent/80 disabled:bg-accent/50 disabled:cursor-not-allowed text-white rounded-md transition-colors"
            >
              作成
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
