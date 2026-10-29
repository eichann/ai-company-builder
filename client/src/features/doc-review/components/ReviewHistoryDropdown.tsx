import { useState, useRef, useEffect } from 'react'
import { CheckCircle } from '@phosphor-icons/react'
import type { Review } from '../model'

export function ReviewHistoryDropdown({
  reviews,
  onSelectReview,
}: {
  reviews: Review[]
  onSelectReview: (reviewId: string) => void
}) {
  const [open, setOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  if (reviews.length === 0) return null

  return (
    <div ref={dropdownRef} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 px-2 py-1 text-[11px] rounded-md border border-gray-200 dark:border-zinc-700 bg-white/90 dark:bg-zinc-800/90 backdrop-blur-sm shadow-sm text-gray-500 dark:text-zinc-400 hover:text-gray-700 dark:hover:text-zinc-200 transition-colors"
        title="レビュー履歴を確認"
      >
        <CheckCircle size={12} />
        レビュー履歴 ({reviews.length})
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 w-64 rounded-lg border border-gray-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 shadow-xl z-50 overflow-hidden">
          <div className="px-3 py-2 border-b border-gray-200 dark:border-zinc-700 text-[11px] text-gray-500 dark:text-zinc-400 font-medium">
            過去のレビュー
          </div>
          <div className="max-h-48 overflow-y-auto">
            {reviews.map((r) => {
              const mustFix = r.comments.filter(c => c.severity === 'must_fix').length
              const shouldFix = r.comments.filter(c => c.severity === 'should_fix').length
              return (
                <button
                  key={r.id}
                  onClick={() => { onSelectReview(r.id); setOpen(false) }}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-left text-xs hover:bg-gray-100 dark:hover:bg-zinc-700/50 transition-colors"
                >
                  <CheckCircle size={14} className="text-blue-500 dark:text-blue-400 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-gray-700 dark:text-zinc-300 truncate">{r.reviewerName}</span>
                      <span className="text-[10px] text-gray-400 dark:text-zinc-500">{r.comments.length}件</span>
                    </div>
                    <div className="text-[10px] text-gray-400 dark:text-zinc-500 mt-0.5 flex items-center gap-2">
                      <span>
                        {r.completedAt
                          ? new Date(r.completedAt).toLocaleDateString('ja-JP', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
                          : '日時不明'}
                      </span>
                      {mustFix > 0 && <span className="text-red-500 dark:text-red-400">必須{mustFix}</span>}
                      {shouldFix > 0 && <span className="text-amber-500 dark:text-amber-400">できれば{shouldFix}</span>}
                    </div>
                  </div>
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
