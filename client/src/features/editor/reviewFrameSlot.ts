// What the screen (app/) plugs in around a document (files-and-editor.md "The review frame"): the
// editor decides which document is reviewed, how it is read and where each part stands (above it,
// beside it, in its place); the review's state and how its parts look — the banners, the history, the
// side panel and the snapshot diff — are doc-review's, handed in here, so the editor imports no other
// feature's parts (renderer-structure.md, principle 2). The comment box is the selection slot's
// (selectionSlot.ts). Only doc-review's model (pure functions and types) is seen from here.
import type { ReactNode, Ref } from 'react'
import type { CommentSeverity, DocumentReading, Review, ReviewComment, ReviewSaveFailure } from '../doc-review/model'

type AddComment = (selectedText: string, startOffset: number, endOffset: number, body: string, severity: CommentSeverity) => Promise<boolean>

/** The review of the open document, as the editor uses it (doc-review's `useMarkdownReview`). */
export interface OpenDocumentReview {
  reviews: Review[]
  completedReviews: Review[]
  /** The review being made or read, or null. */
  activeReview: Review | null
  isReviewing: boolean
  isViewingCompleted: boolean
  /** Other members' reviews in progress (editing may lose their comments' places). */
  otherInProgressReviews: Review[]
  loading: boolean
  saveError: ReviewSaveFailure | null
  dismissSaveError: () => void
  startReview: () => Promise<boolean>
  completeReview: () => Promise<boolean>
  cancelReview: () => Promise<boolean>
  /** Into the review in progress. */
  addComment: AddComment
  /** Into the member's own review (a new one when none is in progress): ［コメント］ of the selection bubble. */
  commentAsReviewer: AddComment
  deleteComment: (commentId: string) => Promise<boolean>
  toggleResolved: (commentId: string) => Promise<boolean>
  addReply: (commentId: string, body: string) => Promise<boolean>
  viewReview: (reviewId: string) => void
  closeViewingReview: () => void
  /** Read the sidecars again (one of the document's changed on disk). */
  reload: () => void
}

/** The snapshot diff's handle: a comment pressed in the side panel scrolls to its words. */
export interface SnapshotDiffHandle {
  scrollToText: (text: string) => void
}

export interface ReviewFrameSlot {
  /**
   * The review's state for the open document (a hook: called on every render of the editor, so the
   * screen hands in one that never changes). `reading`: how the document is read for its review
   * (an HTML page's words); Markdown's as written when absent.
   */
  useReview: (filePath: string | null, reviewerName: string, reviewerEmail: string, memberId?: string | null, reading?: DocumentReading) => OpenDocumentReview
  /** Above the document: a save that failed. */
  saveError: (props: { failure: ReviewSaveFailure; onDismiss: () => void }) => ReactNode
  /** Above the document: the review in progress (［完了］, ［やめる］). */
  banner: (props: { activeReview: Review; onComplete: () => void; onCancel: () => void }) => ReactNode
  /** Above the document: a completed review being read (［閉じる］, 「変更を確認」). */
  completedBanner: (props: { activeReview: Review; onClose: () => void; showDiff?: boolean; onToggleDiff?: () => void }) => ReactNode
  /** Beside ［レビューする］: the completed reviews to read. */
  history: (props: { reviews: Review[]; onSelectReview: (reviewId: string) => void }) => ReactNode
  /** Beside the document: the shown review's comments. */
  sidePanel: (props: {
    review: Review
    onDeleteComment?: (commentId: string) => void
    onToggleResolved: (commentId: string) => void
    onClickComment: (comment: ReviewComment) => void
    onAddReply?: (commentId: string, body: string) => Promise<boolean> | void
    onAskAi?: (comment: ReviewComment) => void
    readOnly?: boolean
  }) => ReactNode
  /** In the document's place: the lines then (`snapshot`) and now; also the 「比べる」 of a file changed on disk. */
  diff: (props: { snapshot: string; current: string; noChangesMessage?: string; ref?: Ref<SnapshotDiffHandle> }) => ReactNode
}
