import React, { useState, useRef, useEffect } from 'react'
import { PaperPlaneTilt } from '@phosphor-icons/react'
import type { CommentSeverity } from '../model'
import { SEVERITY_CONFIG, SEVERITY_ORDER } from './severity'

export function CommentPopover({
  position,
  selectedText,
  onSubmit,
  onClose,
}: {
  position: { x: number; y: number }
  selectedText?: string
  /** Resolves to false when not saved: the text stays for another try. */
  onSubmit: (body: string, severity: CommentSeverity) => Promise<boolean> | void
  onClose: () => void
}) {
  const [body, setBody] = useState('')
  const [severity, setSeverity] = useState<CommentSeverity>('must_fix')
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const timer = setTimeout(() => inputRef.current?.focus(), 50)
    return () => clearTimeout(timer)
  }, [])

  const handleSubmit = async () => {
    if (body.trim()) {
      if (await onSubmit(body.trim(), severity) === false) return
      setBody('')
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      handleSubmit()
    }
    if (e.key === 'Escape') {
      onClose()
    }
  }

  return (
    <div
      className="fixed z-50 w-72 rounded-lg border border-gray-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 shadow-xl"
      style={{ left: position.x, top: position.y + 8 }}
    >
      <div className="p-3">
        {/* Selected text quote */}
        {selectedText && (
          <div className="mb-2 px-2 py-1.5 border-l-2 border-gray-300 dark:border-zinc-600 bg-gray-50 dark:bg-zinc-900/50 rounded-r text-[11px] text-gray-500 dark:text-zinc-400 line-clamp-3 leading-relaxed">
            {selectedText}
          </div>
        )}
        {/* Severity selector */}
        <div className="flex gap-1 mb-2">
          {SEVERITY_ORDER.map((s) => {
            const config = SEVERITY_CONFIG[s]
            const Icon = config.icon
            const isActive = severity === s
            return (
              <button
                key={s}
                onClick={() => setSeverity(s)}
                className={`flex items-center gap-1 px-2 py-1 rounded text-[11px] transition-colors border ${
                  isActive
                    ? `${config.color} ${config.bgColor} border-current`
                    : 'text-gray-400 dark:text-zinc-500 border-transparent hover:text-gray-600 dark:hover:text-zinc-300 hover:bg-gray-100 dark:hover:bg-zinc-700/50'
                }`}
              >
                <Icon size={12} weight={s === 'must_fix' && isActive ? 'fill' : 'regular'} />
                {config.label}
              </button>
            )
          })}
        </div>
        <textarea
          ref={inputRef}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="コメントを入力... (⌘+Enter で送信)"
          className="w-full h-20 px-2 py-1.5 rounded bg-gray-50 dark:bg-zinc-900 border border-gray-200 dark:border-zinc-700 text-sm text-gray-800 dark:text-zinc-200 placeholder-gray-400 dark:placeholder-zinc-500 resize-none focus:outline-none focus:ring-1 focus:ring-amber-500/50"
        />
        <div className="flex justify-end gap-2 mt-2">
          <button
            onClick={onClose}
            className="px-2 py-1 text-xs text-gray-400 dark:text-zinc-400 hover:text-gray-600 dark:hover:text-zinc-200 transition-colors"
          >
            キャンセル
          </button>
          <button
            onClick={handleSubmit}
            disabled={!body.trim()}
            className="flex items-center gap-1 px-2.5 py-1 text-xs rounded bg-amber-600 hover:bg-amber-500 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <PaperPlaneTilt size={12} />
            コメント
          </button>
        </div>
      </div>
    </div>
  )
}
