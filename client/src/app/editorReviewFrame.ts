// The review around a document in the editor, composed by the screen (files-and-editor.md "The review
// frame"): its state and its banners, history, side panel and snapshot diff are doc-review's own, as
// they are, so the editor imports no other feature's parts.
import { createElement } from 'react'
import { useMarkdownReview } from '../features/doc-review/hooks/useMarkdownReview'
import { ReviewBanner } from '../features/doc-review/components/ReviewBanner'
import { ReviewSaveError } from '../features/doc-review/components/ReviewSaveError'
import { CompletedReviewBanner } from '../features/doc-review/components/CompletedReviewBanner'
import { ReviewHistoryDropdown } from '../features/doc-review/components/ReviewHistoryDropdown'
import { ReviewSidePanel } from '../features/doc-review/components/ReviewSidePanel'
import { MarkdownDiffView } from '../features/doc-review/components/MarkdownDiffView'
import type { ReviewFrameSlot } from '../features/editor/reviewFrameSlot'

export const EDITOR_REVIEW_FRAME: ReviewFrameSlot = {
  useReview: useMarkdownReview,
  saveError: props => createElement(ReviewSaveError, props),
  banner: props => createElement(ReviewBanner, props),
  completedBanner: props => createElement(CompletedReviewBanner, props),
  history: props => createElement(ReviewHistoryDropdown, props),
  sidePanel: props => createElement(ReviewSidePanel, props),
  diff: props => createElement(MarkdownDiffView, props),
}
