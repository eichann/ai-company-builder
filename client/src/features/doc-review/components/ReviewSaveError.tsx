import { WarningCircle, X } from '@phosphor-icons/react'
import type { ReviewSaveFailure } from '../hooks/useMarkdownReview'

// Wording for members who are not engineers: what happened, that nothing they
// wrote is lost, and the one thing to do.
const MESSAGES: Record<ReviewSaveFailure['kind'], string> = {
  comment: 'コメントを保存できませんでした。書いた内容は残っています。少し待ってから、もう一度「コメント」を押してください。',
  reply: '返信を保存できませんでした。書いた内容は残っています。少し待ってから、もう一度「返信」を押してください。',
  other: 'レビューを保存できませんでした。少し待ってから「もう一度試す」を押してください。',
}

export function ReviewSaveError({ failure, onDismiss }: { failure: ReviewSaveFailure; onDismiss: () => void }) {
  return (
    <div role="alert" className="flex items-center gap-3 px-4 py-2 border-b text-xs bg-red-50 dark:bg-red-500/10 border-red-200 dark:border-red-500/30 text-red-700 dark:text-red-300">
      <WarningCircle size={14} className="flex-shrink-0" />
      <span className="flex-1">{MESSAGES[failure.kind]}</span>
      {failure.retry && (
        <button
          onClick={failure.retry}
          className="px-2.5 py-1 rounded bg-white dark:bg-zinc-800 border border-red-200 dark:border-red-500/40 font-medium hover:bg-red-100 dark:hover:bg-red-500/20 transition-colors"
        >
          もう一度試す
        </button>
      )}
      <button onClick={onDismiss} aria-label="このお知らせを閉じる" className="p-1 rounded hover:bg-red-100 dark:hover:bg-red-500/20">
        <X size={12} />
      </button>
    </div>
  )
}
