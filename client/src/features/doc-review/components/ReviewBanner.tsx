import { ChatCircleDots, Check } from '@phosphor-icons/react'
import type { Review } from '../model'

export function ReviewBanner({
  activeReview,
  onComplete,
  onCancel,
}: {
  activeReview: Review
  onComplete: () => void
  onCancel: () => void
}) {
  const mustFixCount = activeReview.comments.filter(c => c.severity === 'must_fix' && !c.resolved).length
  const totalCount = activeReview.comments.length

  return (
    <div className="flex items-center gap-3 px-4 py-2.5 bg-amber-500 border-b border-amber-600 text-white text-xs shadow-sm">
      <ChatCircleDots size={14} className="flex-shrink-0" />
      <span className="flex-1 font-medium">
        レビュー中 — テキストを選択してコメントを追加
        {totalCount > 0 && (
          <span className="ml-2 text-amber-100">
            ({totalCount}件{mustFixCount > 0 && <span className="text-red-100 font-bold ml-1">対応必須{mustFixCount}件</span>})
          </span>
        )}
      </span>
      <button
        onClick={onCancel}
        className="px-2.5 py-1 rounded text-amber-100 hover:text-white hover:bg-amber-600 transition-colors"
      >
        キャンセル
      </button>
      <button
        onClick={onComplete}
        className="flex items-center gap-1 px-3 py-1.5 rounded bg-white text-amber-700 font-medium hover:bg-amber-50 transition-colors shadow-sm"
      >
        <Check size={12} />
        レビュー完了
      </button>
    </div>
  )
}
