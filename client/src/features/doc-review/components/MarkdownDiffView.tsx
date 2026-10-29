import React, { useRef, useMemo, useImperativeHandle } from 'react'
import { computeLineDiff } from '../../../lib/line-diff'

export interface MarkdownDiffViewHandle {
  scrollToText: (text: string) => void
}

export const MarkdownDiffView = React.forwardRef<MarkdownDiffViewHandle, { snapshot: string; current: string; noChangesMessage?: string }>(
  function MarkdownDiffView({ snapshot, current, noChangesMessage = 'レビュー時点から変更はありません' }, ref) {
    const containerRef = useRef<HTMLDivElement>(null)
    // Myers diff (lib/line-diff.ts); null = too large to compare.
    const diff = useMemo(() => computeLineDiff(snapshot, current), [snapshot, current])
    const hasChanges = diff === null || diff.some(d => d.type !== 'same')

    useImperativeHandle(ref, () => ({
      scrollToText(text: string) {
        if (!containerRef.current) return
        const lines = containerRef.current.querySelectorAll('[data-diff-line]')
        // Search for the first line containing part of the selected text
        const searchText = text.split('\n')[0].trim()
        for (const line of lines) {
          if (line.textContent && line.textContent.includes(searchText)) {
            line.scrollIntoView({ behavior: 'smooth', block: 'center' })
            line.classList.add('ring-2', 'ring-amber-400')
            setTimeout(() => line.classList.remove('ring-2', 'ring-amber-400'), 1500)
            return
          }
        }
      }
    }), [])

    if (diff === null) {
      return (
        <div className="h-full flex items-center justify-center px-8 text-center text-gray-400 dark:text-zinc-500 text-sm">
          差分が大きすぎるため表示できません。ファイルを直接確認してください。
        </div>
      )
    }

    if (!hasChanges) {
      return (
        <div className="h-full flex items-center justify-center text-gray-400 dark:text-zinc-500 text-sm">
          {noChangesMessage}
        </div>
      )
    }

    return (
      <div ref={containerRef} className="h-full overflow-auto px-8 py-6">
        <div className="max-w-3xl mx-auto font-mono text-sm leading-relaxed">
          {diff.map((line, i) => (
            <div
              key={i}
              data-diff-line
              className={`px-3 py-0.5 border-l-2 transition-all ${
                line.type === 'add'
                  ? 'bg-green-50 dark:bg-green-500/10 border-green-400 dark:border-green-500 text-green-800 dark:text-green-300'
                  : line.type === 'del'
                    ? 'bg-red-50 dark:bg-red-500/10 border-red-400 dark:border-red-500 text-red-800 dark:text-red-400 line-through opacity-60'
                    : 'border-transparent text-gray-700 dark:text-zinc-300'
              }`}
            >
              <span className="inline-block w-5 text-[10px] text-gray-300 dark:text-zinc-600 select-none mr-2">
                {line.type === 'add' ? '+' : line.type === 'del' ? '−' : ' '}
              </span>
              {line.text || '\u00A0'}
            </div>
          ))}
        </div>
      </div>
    )
  }
)
