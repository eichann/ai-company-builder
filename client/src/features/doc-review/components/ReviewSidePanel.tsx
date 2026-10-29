import React, { useState, useRef, useEffect } from 'react'
import { ArrowBendDownRight, CheckCircle, Trash, User } from '@phosphor-icons/react'
import type { CommentSeverity, Review, ReviewComment } from '../model'
import { SEVERITY_ORDER, SeverityBadge } from './severity'

function ReplyInput({
  onSubmit,
  onCancel,
}: {
  onSubmit: (body: string) => void
  onCancel: () => void
}) {
  const [body, setBody] = useState('')
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      if (body.trim()) {
        onSubmit(body.trim())
      }
    }
    if (e.key === 'Escape') onCancel()
  }

  return (
    <div className="mt-2 pt-2 border-t border-zinc-800/50">
      <textarea
        ref={inputRef}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="返信... (⌘+Enter)"
        className="w-full h-14 px-2 py-1 rounded bg-zinc-900 border border-zinc-700 text-[11px] text-zinc-200 placeholder-zinc-500 resize-none focus:outline-none focus:ring-1 focus:ring-blue-500/50"
      />
      <div className="flex justify-end gap-1 mt-1">
        <button onClick={onCancel} className="px-1.5 py-0.5 text-[10px] text-zinc-500 hover:text-zinc-300">
          キャンセル
        </button>
        <button
          onClick={() => body.trim() && onSubmit(body.trim())}
          disabled={!body.trim()}
          className="px-1.5 py-0.5 text-[10px] rounded bg-blue-600 text-white disabled:opacity-40"
        >
          返信
        </button>
      </div>
    </div>
  )
}

export function ReviewSidePanel({
  review,
  onDeleteComment,
  onToggleResolved,
  onClickComment,
  onAddReply,
  readOnly = false,
}: {
  review: Review
  onDeleteComment?: (commentId: string) => void
  onToggleResolved: (commentId: string) => void
  onClickComment: (comment: ReviewComment) => void
  /** Resolves to false when not saved: the reply box stays open with the text. */
  onAddReply?: (commentId: string, body: string) => Promise<boolean> | void
  readOnly?: boolean
}) {
  const [replyingTo, setReplyingTo] = useState<string | null>(null)

  // Sort comments by severity priority: must_fix → should_fix → note
  const sortedComments = [...review.comments].sort((a, b) => {
    return SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)
  })

  const SEVERITY_BORDER: Record<CommentSeverity, string> = {
    must_fix: 'border-l-red-400',
    should_fix: 'border-l-amber-400',
    note: 'border-l-gray-300 dark:border-l-zinc-600',
  }
  const SEVERITY_BG: Record<CommentSeverity, string> = {
    must_fix: 'bg-red-50 dark:bg-red-500/[0.03]',
    should_fix: 'bg-amber-50 dark:bg-amber-500/[0.03]',
    note: '',
  }

  if (review.comments.length === 0) {
    return (
      <div className="w-72 flex-shrink-0 border-l border-gray-200 dark:border-zinc-700/50 bg-gray-50 dark:bg-zinc-900 flex flex-col">
        <div className="px-4 py-2.5 border-b border-gray-200 dark:border-zinc-700/50 text-xs font-medium text-gray-700 dark:text-zinc-300 flex items-center gap-2">
          <User size={12} className="text-gray-400 dark:text-zinc-500" />
          {review.reviewerName}
        </div>
        <div className="flex-1 flex items-center justify-center">
          <p className="text-xs text-gray-400 dark:text-zinc-600 px-4 text-center leading-relaxed">
            テキストを選択して<br />コメントを追加してください
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="w-72 flex-shrink-0 border-l border-gray-200 dark:border-zinc-700/50 bg-gray-50 dark:bg-zinc-900 overflow-y-auto">
      {/* Header */}
      <div className="sticky top-0 z-10 px-4 py-2.5 border-b border-gray-200 dark:border-zinc-700/50 bg-gray-50 dark:bg-zinc-900 text-xs font-medium text-gray-700 dark:text-zinc-300 flex items-center justify-between">
        <span className="flex items-center gap-2">
          <User size={12} className="text-gray-400 dark:text-zinc-500" />
          {review.reviewerName}
        </span>
        <span className="text-gray-400 dark:text-zinc-500">{review.comments.length}件</span>
      </div>

      {/* Comments */}
      <div className="py-1">
        {sortedComments.map((comment) => (
          <div
            key={comment.id}
            data-comment-id={comment.id}
            className={`
              mx-1.5 my-1.5 rounded-md border-l-[3px] transition-colors
              ${comment.orphaned
                ? 'border-l-red-500/50 opacity-70'
                : `${SEVERITY_BORDER[comment.severity]} cursor-pointer hover:bg-gray-100 dark:hover:bg-zinc-800/60`
              }
              ${SEVERITY_BG[comment.severity]}
              ${comment.resolved ? 'opacity-45' : ''}
            `}
            onClick={() => !comment.orphaned && onClickComment(comment)}
          >
            {/* Comment content */}
            <div className="px-3 pt-2.5 pb-1">
              {/* Severity + author */}
              <div className="flex items-center gap-1.5 mb-1.5">
                <SeverityBadge severity={comment.severity} size="xs" />
                <span className="text-[10px] text-gray-400 dark:text-zinc-500">{comment.authorName}</span>
                {comment.orphaned && (
                  <span className="text-[9px] px-1 py-px rounded bg-red-100 dark:bg-red-500/15 text-red-500 dark:text-red-400 font-medium">位置不明</span>
                )}
              </div>

              {/* Quoted text */}
              <div className={`text-[10px] font-mono leading-relaxed mb-1.5 px-2 py-1 rounded ${
                comment.orphaned
                  ? 'text-red-300 dark:text-red-400/40 line-through bg-red-50 dark:bg-red-500/5'
                  : 'text-gray-500 dark:text-zinc-500 bg-gray-100 dark:bg-zinc-800/50'
              }`}>
                &ldquo;{comment.selectedText.slice(0, 50)}{comment.selectedText.length > 50 ? '...' : ''}&rdquo;
              </div>

              {/* Body */}
              <p className="text-[13px] text-gray-800 dark:text-zinc-200 whitespace-pre-wrap break-words leading-relaxed">{comment.body}</p>
            </div>

            {/* Replies */}
            {comment.replies.length > 0 && (
              <div className="mx-3 mt-1 mb-1 pl-2.5 border-l-2 border-gray-200 dark:border-zinc-700/60 space-y-2">
                {comment.replies.map((reply) => (
                  <div key={reply.id} className="py-0.5">
                    <span className="text-[10px] font-medium text-gray-400 dark:text-zinc-500">{reply.authorName}</span>
                    <p className="text-[11px] text-gray-600 dark:text-zinc-400 whitespace-pre-wrap break-words leading-relaxed">{reply.body}</p>
                  </div>
                ))}
              </div>
            )}

            {/* Reply input */}
            {replyingTo === comment.id && onAddReply ? (
              <div className="px-3">
                <ReplyInput
                  onSubmit={async (body) => { if (await onAddReply(comment.id, body) !== false) setReplyingTo(null) }}
                  onCancel={() => setReplyingTo(null)}
                />
              </div>
            ) : null}

            {/* Action bar */}
            <div className="flex items-center gap-0.5 px-3 py-1.5 mt-0.5 border-t border-gray-100 dark:border-zinc-800/40">
              <button
                onClick={(e) => { e.stopPropagation(); onToggleResolved(comment.id) }}
                className={`flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
                  comment.resolved
                    ? 'text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-400/10 hover:bg-green-100 dark:hover:bg-green-400/20'
                    : 'text-gray-400 dark:text-zinc-500 hover:text-green-600 dark:hover:text-green-400 hover:bg-green-50 dark:hover:bg-green-400/10'
                }`}
              >
                <CheckCircle size={11} weight={comment.resolved ? 'fill' : 'regular'} />
                {comment.resolved ? '解決済み' : '解決'}
              </button>
              {onAddReply && (
                <button
                  onClick={(e) => { e.stopPropagation(); setReplyingTo(replyingTo === comment.id ? null : comment.id) }}
                  className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium text-gray-400 dark:text-zinc-500 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-400/10 transition-colors"
                >
                  <ArrowBendDownRight size={11} />
                  返信
                </button>
              )}
              {!readOnly && onDeleteComment && (
                <button
                  onClick={(e) => { e.stopPropagation(); onDeleteComment(comment.id) }}
                  className="ml-auto p-1 rounded text-gray-300 dark:text-zinc-600 hover:text-red-500 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-400/10 transition-colors"
                >
                  <Trash size={11} />
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
