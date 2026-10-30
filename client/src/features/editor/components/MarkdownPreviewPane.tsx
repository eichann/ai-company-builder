import { useRef } from 'react'
import { Code, Eye, PencilSimple, ChatCircleDots } from '@phosphor-icons/react'
import { ReviewBanner } from '../../doc-review/components/ReviewBanner'
import { ReviewSaveError } from '../../doc-review/components/ReviewSaveError'
import { CompletedReviewBanner } from '../../doc-review/components/CompletedReviewBanner'
import { ReviewHistoryDropdown } from '../../doc-review/components/ReviewHistoryDropdown'
import { ReviewSidePanel } from '../../doc-review/components/ReviewSidePanel'
import { CommentPopover } from '../../doc-review/components/CommentPopover'
import { MarkdownDiffView, type MarkdownDiffViewHandle } from '../../doc-review/components/MarkdownDiffView'
import type { EditorReview } from '../hooks/useEditorReview'
import { MarkdownPreview } from './MarkdownPreview'

interface Props {
  paneId: string
  filePath: string
  content: string
  review: EditorReview['review']
  textSelection: EditorReview['textSelection']
  showDiff: boolean
  setShowDiff: React.Dispatch<React.SetStateAction<boolean>>
  previewRef: React.MutableRefObject<HTMLDivElement | null>
  initialScrollRatio: number | undefined
  onShowEditor: () => void
  /** 編集: to the source, keeping a preview tab. */
  onEdit: () => void
}

/** A Markdown file shown rendered, with its review: banners, highlights, comments, history and the snapshot diff. */
export function MarkdownPreviewPane({
  paneId, filePath, content, review, textSelection, showDiff, setShowDiff, previewRef, initialScrollRatio, onShowEditor, onEdit,
}: Props) {
  const mdPreviewContainerRef = useRef<HTMLDivElement>(null)
  const diffViewRef = useRef<MarkdownDiffViewHandle | null>(null)
  return (
    <div className="h-full flex flex-col">
      {review.saveError && <ReviewSaveError failure={review.saveError} onDismiss={review.dismissSaveError} />}
      {review.isReviewing && review.activeReview && (
        <ReviewBanner
          activeReview={review.activeReview}
          onComplete={review.completeReview}
          onCancel={review.cancelReview}
        />
      )}
      {review.isViewingCompleted && review.activeReview && (
        <CompletedReviewBanner
          activeReview={review.activeReview}
          onClose={() => { review.closeViewingReview(); setShowDiff(false) }}
          showDiff={showDiff}
          onToggleDiff={() => setShowDiff(prev => !prev)}
        />
      )}
      <div className="flex-1 flex overflow-hidden">
        {/* Markdown content or diff view */}
        <div
          ref={mdPreviewContainerRef}
          className="flex-1 min-w-0 relative"
          onMouseUp={textSelection.handleMouseUp}
        >
          {showDiff && review.activeReview?.snapshot ? (
            <MarkdownDiffView
              ref={diffViewRef}
              snapshot={review.activeReview.snapshot}
              current={content}
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
                <ReviewHistoryDropdown
                  reviews={review.completedReviews}
                  onSelectReview={review.viewReview}
                />
                {/* 依頼ボタンはUI非表示。review-request の仕組み自体は
                    Slack通知連携で再利用予定のため残してある。 */}
                <button
                  onClick={review.startReview}
                  className="flex items-center gap-1 px-2 py-1 text-[11px] rounded-md border border-gray-200 dark:border-zinc-700 bg-white/90 dark:bg-zinc-800/90 backdrop-blur-sm shadow-sm text-amber-500 hover:text-amber-400 transition-colors"
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
                className="flex items-center gap-1 px-2 py-1 text-[11px] transition-colors text-gray-500 dark:text-zinc-500 hover:text-gray-700 dark:hover:text-zinc-300"
                title="エディタ"
              >
                <Code size={12} />
              </button>
              <button
                className="flex items-center gap-1 px-2 py-1 text-[11px] transition-colors bg-gray-200 dark:bg-zinc-700 text-gray-800 dark:text-zinc-200"
                title="プレビュー"
              >
                <Eye size={12} />
              </button>
            </div>
          </div>
          {/* Floating edit button (hide during review) */}
          {!review.isReviewing && (
            <button
              onClick={onEdit}
              className="absolute bottom-4 right-4 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-accent text-white shadow-lg hover:bg-accent/90 transition-colors"
            >
              <PencilSimple size={12} />
              編集
            </button>
          )}
          {textSelection.popover && (
            <CommentPopover
              position={{ x: textSelection.popover.x, y: textSelection.popover.y }}
              selectedText={textSelection.popover.text}
              onSubmit={textSelection.handleSubmitComment}
              onClose={textSelection.closePopover}
            />
          )}
        </div>
        {(review.isReviewing || review.isViewingCompleted) && review.activeReview && (
          <ReviewSidePanel
            review={review.activeReview}
            onDeleteComment={review.isReviewing ? review.deleteComment : undefined}
            onToggleResolved={review.toggleResolved}
            onClickComment={(comment) => {
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
            }}
            onAddReply={review.addReply}
            readOnly={review.isViewingCompleted}
          />
        )}
      </div>
    </div>
  )
}
