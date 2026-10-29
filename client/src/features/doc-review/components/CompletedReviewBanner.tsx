import { CheckCircle } from '@phosphor-icons/react'
import type { Review } from '../model'

export function CompletedReviewBanner({
  activeReview,
  onClose,
  showDiff,
  onToggleDiff,
}: {
  activeReview: Review
  onClose: () => void
  showDiff?: boolean
  onToggleDiff?: () => void
}) {
  const resolvedCount = activeReview.comments.filter(c => c.resolved).length
  const mustFixCount = activeReview.comments.filter(c => c.severity === 'must_fix').length
  const date = activeReview.completedAt
    ? new Date(activeReview.completedAt).toLocaleDateString('ja-JP', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : ''

  return (
    <div className="flex items-center gap-3 px-4 py-2 border-b text-xs bg-blue-50 dark:bg-blue-500/10 border-blue-200 dark:border-blue-500/30 text-blue-600 dark:text-blue-300">
      <CheckCircle size={14} />
      <span className="flex-1">
        <span className="font-medium">{activeReview.reviewerName}</span>
        <span className="ml-1.5 text-gray-400 dark:text-zinc-500">({date})</span>
        <span className="ml-2 text-gray-500 dark:text-zinc-400">
          {activeReview.comments.length}件のコメント（{resolvedCount}件解決済み）
          {mustFixCount > 0 && <span className="text-red-500 dark:text-red-400 ml-1">対応必須{mustFixCount}件</span>}
        </span>
      </span>
      {activeReview.snapshot && onToggleDiff && (
        <button
          onClick={onToggleDiff}
          className={`px-2 py-1 rounded text-[11px] transition-colors ${
            showDiff
              ? 'bg-blue-500 text-white'
              : 'text-blue-500 dark:text-blue-400 hover:bg-blue-100 dark:hover:bg-blue-500/20'
          }`}
        >
          {showDiff ? '変更表示中' : '変更を確認'}
        </button>
      )}
      <button
        onClick={onClose}
        className="px-2 py-1 rounded text-gray-400 dark:text-zinc-400 hover:text-gray-600 dark:hover:text-zinc-200 hover:bg-gray-100 dark:hover:bg-zinc-700/50 transition-colors"
      >
        閉じる
      </button>
    </div>
  )
}
