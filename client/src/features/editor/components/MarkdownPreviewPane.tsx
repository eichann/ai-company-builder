import { useRef, useState } from 'react'
import { Code, Eye, PencilSimple, ChatCircleDots } from '@phosphor-icons/react'
import type { EditorReview } from '../hooks/useEditorReview'
import type { ReviewFrameSlot, SnapshotDiffHandle } from '../reviewFrameSlot'
import { MarkdownPreview } from './MarkdownPreview'
import { InPlaceMarkdownEditor, type CommentFixStart } from './InPlaceMarkdownEditor'
import { findTextInMarkdown } from '../../doc-review/model'
import type { SelectionSlot } from '../selectionSlot'
import { Callout } from '../../../shared/ui/primitives'
import { PRIMARY_ACTION } from '../../../shared/ui/buttonStyles'

interface Props {
  paneId: string
  filePath: string
  content: string
  review: EditorReview['review']
  /** The review's parts, handed in by the screen (reviewFrameSlot.ts). */
  reviewFrame: ReviewFrameSlot
  textSelection: EditorReview['textSelection']
  showDiff: boolean
  setShowDiff: React.Dispatch<React.SetStateAction<boolean>>
  previewRef: React.MutableRefObject<HTMLDivElement | null>
  initialScrollRatio: number | undefined
  onShowEditor: () => void
  /** 編集: to the source, keeping a preview tab. */
  onEdit: () => void
  /** Edit the document right here (files-and-editor.md "Editing a document in place"); absent: read only. */
  inPlace?: { onChange: (text: string) => void } | null
  /** The review's comment box, handed in by the screen (selectionSlot.ts): ［コメント］ and a review's selection. */
  commentBox?: SelectionSlot['commentBox']
  /** The consultation's AI (selectionSlot.ts): ［AI に直してもらう］, and ［AI に反映してもらう］ on a completed review's comment. */
  aiFix?: SelectionSlot['aiFix']
}

/** A Markdown file shown rendered, with its review: banners, highlights, comments, history and the snapshot diff. */
export function MarkdownPreviewPane({
  paneId, filePath, content, review, reviewFrame: frame, textSelection, showDiff, setShowDiff, previewRef, initialScrollRatio, onShowEditor, onEdit, inPlace, commentBox, aiFix,
}: Props) {
  const mdPreviewContainerRef = useRef<HTMLDivElement>(null)
  // ［AI に反映してもらう］: the review's reading view closes and the document opens here, where the fix is asked
  // and shown under the comment's words. The comment is left as it is (never resolved for the member).
  const [commentFix, setCommentFix] = useState<CommentFixStart | null>(null)
  const reflectComment = inPlace && aiFix && review.isViewingCompleted && review.activeReview
    ? (comment: { id: string; selectedText: string; body: string }) => {
      const reviewId = review.activeReview!.id
      setShowDiff(false)
      review.closeViewingReview()
      const at = findTextInMarkdown(content, comment.selectedText)
      setCommentFix({
        quote: comment.selectedText,
        body: comment.body,
        at: at ? { start: at.start, end: at.end } : null,
        onStarted: () => setCommentFix(null),
        onBackToReview: () => review.viewReview(reviewId),
      })
    }
    : undefined
  // A review being made or read shows the document as it reads (its quotes are marked in the text).
  const editingHere = !!inPlace && !showDiff && !review.isReviewing && !review.isViewingCompleted
  const diffViewRef = useRef<SnapshotDiffHandle | null>(null)
  return (
    <div className="h-full flex flex-col">
      {review.saveError && frame.saveError({ failure: review.saveError, onDismiss: review.dismissSaveError })}
      {review.isReviewing && review.activeReview && frame.banner({
        activeReview: review.activeReview,
        onComplete: review.completeReview,
        onCancel: review.cancelReview,
      })}
      {review.isViewingCompleted && review.activeReview && frame.completedBanner({
        activeReview: review.activeReview,
        onClose: () => { review.closeViewingReview(); setShowDiff(false) },
        showDiff,
        onToggleDiff: () => setShowDiff(prev => !prev),
      })}
      {editingHere && review.otherInProgressReviews.length > 0 && (
        <div className="px-4 pt-2">
          <Callout tone="info">
            {review.otherInProgressReviews.map(r => r.reviewerName).join('、')} がレビュー中です。直すと、コメントの付いた言葉が見つからなくなることがあります（コメントは消えません）。
          </Callout>
        </div>
      )}
      <div className="flex-1 flex overflow-hidden">
        {/* Markdown content or diff view */}
        <div
          ref={mdPreviewContainerRef}
          className="flex-1 min-w-0 relative"
          onMouseUp={textSelection.handleMouseUp}
        >
          {showDiff && review.activeReview?.snapshot ? (
            frame.diff({
              ref: diffViewRef,
              snapshot: review.activeReview.snapshot,
              current: content,
            })
          ) : editingHere ? (
            <InPlaceMarkdownEditor
              paneId={paneId}
              filePath={filePath}
              content={content}
              onChange={inPlace.onChange}
              onShowSource={onShowEditor}
              previewRef={previewRef}
              initialScrollRatio={initialScrollRatio}
              aiFix={aiFix}
              startFix={commentFix ?? undefined}
              comment={commentBox ? {
                box: commentBox,
                // Into the member's own review (a new one when none is in progress); the quote is found in the tab's text.
                add: (text, body, severity) => {
                  const at = findTextInMarkdown(content, text)
                  return review.commentAsReviewer(text, at?.start ?? 0, at?.end ?? 0, body, severity)
                },
              } : undefined}
            />
          ) : (
          <MarkdownPreview
            ref={previewRef}
            paneId={paneId}
            content={content}
            basePath={filePath.substring(0, filePath.lastIndexOf('/'))}
            initialScrollRatio={initialScrollRatio}
            highlightRanges={(review.isReviewing || review.isViewingCompleted)
              ? review.activeReview?.comments
                  .filter(c => !c.orphaned)
                  .map(c => ({
                    text: c.selectedText,
                    resolved: c.resolved,
                    commentId: c.id,
                  }))
              : undefined}
          />
          )}
          {/* Floating view mode toggle + review button */}
          <div className="absolute top-3 right-3 flex items-center gap-2 opacity-60 hover:opacity-100 transition-opacity">
            {!review.isReviewing && !review.isViewingCompleted && (
              <>
                {frame.history({
                  reviews: review.completedReviews,
                  onSelectReview: review.viewReview,
                })}
                {/* 依頼ボタンはUI非表示。review-request の仕組み自体は
                    Slack通知連携で再利用予定のため残してある。 */}
                <button
                  onClick={review.startReview}
                  className="flex items-center gap-1 px-2 py-1 text-caption font-normal rounded-md border border-gray-200 dark:border-zinc-700 bg-white/90 dark:bg-zinc-800/90 backdrop-blur-sm shadow-sm text-amber-500 hover:text-amber-400 transition-colors"
                  title="新しいレビューを開始する"
                >
                  <ChatCircleDots size={12} />
                  レビューする
                </button>
              </>
            )}
            <div className="flex rounded-md border border-gray-200 dark:border-zinc-700 bg-white/90 dark:bg-zinc-800/90 backdrop-blur-sm shadow-sm overflow-hidden">
              <button
                onClick={onShowEditor}
                className="flex items-center gap-1 px-2 py-1 text-caption font-normal transition-colors text-gray-500 dark:text-zinc-500 hover:text-gray-700 dark:hover:text-zinc-300"
                title="もとの書き方"
              >
                <Code size={12} />
              </button>
              <button
                className="flex items-center gap-1 px-2 py-1 text-caption font-normal transition-colors bg-gray-200 dark:bg-zinc-700 text-gray-800 dark:text-zinc-200"
                title="文章"
              >
                <Eye size={12} />
              </button>
            </div>
          </div>
          {/* Floating edit button (hide during review; the document edited in place needs none) */}
          {!review.isReviewing && !editingHere && (
            <button
              onClick={onEdit}
              className={`absolute bottom-4 right-4 flex items-center gap-1.5 px-3 py-1.5 rounded-control text-xs font-medium shadow-lg transition-colors ${PRIMARY_ACTION}`}
            >
              <PencilSimple size={12} />
              編集
            </button>
          )}
          {textSelection.popover && commentBox?.({
            position: { x: textSelection.popover.x, y: textSelection.popover.y },
            selectedText: textSelection.popover.text,
            onSubmit: textSelection.handleSubmitComment,
            onClose: textSelection.closePopover,
          })}
        </div>
        {(review.isReviewing || review.isViewingCompleted) && review.activeReview && (
          frame.sidePanel({
            review: review.activeReview,
            onDeleteComment: review.isReviewing ? review.deleteComment : undefined,
            onToggleResolved: review.toggleResolved,
            onClickComment: (comment) => {
              if (showDiff && diffViewRef.current) {
                // Scroll to the text in the diff view
                diffViewRef.current.scrollToText(comment.selectedText)
              } else {
                // Scroll to the highlighted text in the markdown preview
                const mark = previewRef.current?.querySelector(`mark[data-comment-id="${comment.id}"]`)
                if (mark) {
                  mark.scrollIntoView({ behavior: 'smooth', block: 'center' })
                  mark.classList.add('ring-2', 'ring-amber-400')
                  setTimeout(() => mark.classList.remove('ring-2', 'ring-amber-400'), 1500)
                }
              }
            },
            onAddReply: review.addReply,
            onAskAi: reflectComment,
            readOnly: review.isViewingCompleted,
          })
        )}
      </div>
    </div>
  )
}
