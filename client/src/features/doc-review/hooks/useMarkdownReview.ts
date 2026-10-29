// One state machine over the sidecar files of the open document (load, start,
// comment, reply, resolve, complete, cancel); kept whole, ~350 lines.
import { useState, useCallback, useEffect, useRef } from 'react'
import {
  replyFileKey,
  markOrphanedComments,
  mergeRepliesIntoReviews,
  type CommentReply,
  type CommentSeverity,
  type ResolutionEntry,
  type Review,
  type ReviewComment,
} from '../model'
import {
  deleteReviewFile,
  deleteReviewRequestFile,
  readAllReplies,
  readAllReviews,
  readDocument,
  readReviewRequestFile,
  saveReview,
  updateMyReplies,
  writeReviewRequestFile,
} from '../api'

/**
 * A save that failed after its retries. `comment` / `reply`: the member's text
 * stays in its input, pressing the button again retries. `other`: `retry` runs
 * the same action again.
 */
export interface ReviewSaveFailure {
  kind: 'comment' | 'reply' | 'other'
  retry?: () => void
}

export function useMarkdownReview(filePath: string | null, reviewerName: string, reviewerEmail: string, memberId?: string | null) {
  const [reviews, setReviews] = useState<Review[]>([])
  const [activeReview, setActiveReview] = useState<Review | null>(null)
  const [loading, setLoading] = useState(false)
  const [hasReviewRequest, setHasReviewRequest] = useState(false)
  const [saveError, setSaveError] = useState<ReviewSaveFailure | null>(null)
  const myReplyKey = replyFileKey(reviewerEmail, memberId)
  // Each review file as this app last read or wrote it: the base for merging
  // when the file changed in between (sync from another computer, the AI).
  const storedRef = useRef(new Map<string, Review>())
  // Only the latest load may set state: a slow load of the previous document
  // must not show its reviews on this one.
  const loadSeqRef = useRef(0)

  // Load all reviews from sidecar files
  const loadReviews = useCallback(async (docPath: string) => {
    const seq = ++loadSeqRef.current
    setLoading(true)
    try {
      const [allReviewsRaw, replyData, docContent, reviewRequest] = await Promise.all([
        readAllReviews(docPath),
        readAllReplies(docPath),
        readDocument(docPath),
        readReviewRequestFile(docPath),
      ])
      if (seq !== loadSeqRef.current) return
      setHasReviewRequest(reviewRequest !== null)
      storedRef.current = new Map(allReviewsRaw.map(r => [r.id, r]))

      // Merge external replies and resolutions into reviews
      const allReviews = mergeRepliesIntoReviews(allReviewsRaw, replyData.replies, replyData.resolutions)

      // Opening a document only reads: 「位置不明」 is computed here, and completed
      // reviews stay (all resolved too) because members fix the document from them.
      const cleaned = markOrphanedComments(allReviews, docContent)

      setReviews(prev => {
        if (JSON.stringify(prev) === JSON.stringify(cleaned)) return prev
        return cleaned
      })

      // Find in-progress review by current user, or any in-progress
      const myInProgress = cleaned.find(r => r.status === 'in_progress' && r.reviewerEmail === reviewerEmail)
      // Only update activeReview if it changed (avoid unnecessary re-renders that break text selection)
      setActiveReview(prev => {
        if (prev && myInProgress && prev.id === myInProgress.id && prev.status === myInProgress.status) {
          if (JSON.stringify(prev.comments) === JSON.stringify(myInProgress.comments)) {
            return prev // no change — keep same reference
          }
          return myInProgress
        }
        if (myInProgress) return myInProgress
        // If viewing a completed review, keep it active (update with fresh data)
        if (prev && prev.status === 'completed') {
          const updated = cleaned.find(r => r.id === prev.id)
          if (updated) {
            if (JSON.stringify(prev.comments) === JSON.stringify(updated.comments)) {
              return prev
            }
            return updated
          }
          return null // review was deleted
        }
        return null
      })
    } catch (err) {
      if (seq !== loadSeqRef.current) return
      console.error('Failed to load reviews:', err)
      setReviews([])
      setActiveReview(null)
    } finally {
      if (seq === loadSeqRef.current) setLoading(false)
    }
  }, [reviewerEmail])

  useEffect(() => {
    setSaveError(null)
    if (filePath) {
      loadReviews(filePath)
    } else {
      loadSeqRef.current++
      setReviews([])
      setActiveReview(null)
    }
  }, [filePath, loadReviews])

  /**
   * Runs a save; on failure keeps the state as it was and reports it (`other`
   * saves offer to run the same save again). True when saved.
   */
  const attempt = useCallback((kind: ReviewSaveFailure['kind'], save: () => Promise<void>): Promise<boolean> => {
    async function run(): Promise<boolean> {
      try {
        await save()
        setSaveError(null)
        return true
      } catch (err) {
        console.error('Failed to save review:', err)
        setSaveError({ kind, retry: kind === 'other' ? () => { void run() } : undefined })
        return false
      }
    }
    return run()
  }, [])

  const showReview = useCallback((review: Review) => {
    setReviews(prev => prev.some(r => r.id === review.id) ? prev.map(r => r.id === review.id ? review : r) : [...prev, review])
    setActiveReview(review)
  }, [])

  /** Saves the reviewer's own review (merging edits made elsewhere) and shows what was written. */
  const saveOwnReview = useCallback(async (docPath: string, review: Review): Promise<Review> => {
    const saved = await saveReview(docPath, review, storedRef.current.get(review.id) ?? null)
    storedRef.current.set(saved.id, saved)
    return saved
  }, [])

  const requestReview = useCallback(async () => {
    if (!filePath) return
    await writeReviewRequestFile(filePath, reviewerName)
    setHasReviewRequest(true)
  }, [filePath, reviewerName])

  const cancelRequestReview = useCallback(async () => {
    if (!filePath) return
    await deleteReviewRequestFile(filePath)
    setHasReviewRequest(false)
  }, [filePath])

  const startReview = useCallback(async (): Promise<boolean> => {
    if (!filePath) return false
    const newReview: Review = {
      id: crypto.randomUUID(),
      reviewerName,
      reviewerEmail,
      status: 'in_progress',
      createdAt: new Date().toISOString(),
      completedAt: null,
      comments: [],
    }
    return attempt('other', async () => {
      showReview(await saveOwnReview(filePath, newReview))
      // Auto-remove review request when someone starts reviewing
      if (hasReviewRequest) {
        await deleteReviewRequestFile(filePath)
        setHasReviewRequest(false)
      }
    })
  }, [filePath, reviewerName, reviewerEmail, hasReviewRequest, attempt, showReview, saveOwnReview])

  const completeReview = useCallback(async (): Promise<boolean> => {
    if (!activeReview || !filePath) return false
    const review = activeReview
    return attempt('other', async () => {
      // Save snapshot of document content at review completion time
      const snapshot = await readDocument(filePath) || undefined
      const saved = await saveOwnReview(filePath, { ...review, status: 'completed' as const, completedAt: new Date().toISOString(), snapshot })
      setReviews(prev => prev.map(r => r.id === saved.id ? saved : r))
      setActiveReview(null)
    })
  }, [activeReview, filePath, attempt, saveOwnReview])

  const cancelReview = useCallback(async (): Promise<boolean> => {
    if (!activeReview || !filePath) return false
    const review = activeReview
    return attempt('other', async () => {
      await deleteReviewFile(filePath, review.id)
      storedRef.current.delete(review.id)
      setReviews(prev => prev.filter(r => r.id !== review.id))
      setActiveReview(null)
    })
  }, [activeReview, filePath, attempt])

  const addComment = useCallback(async (selectedText: string, startOffset: number, endOffset: number, body: string, severity: CommentSeverity): Promise<boolean> => {
    if (!activeReview || !filePath) return false
    const comment: ReviewComment = {
      id: crypto.randomUUID(),
      authorName: reviewerName,
      severity,
      selectedText,
      startOffset,
      endOffset,
      body,
      createdAt: new Date().toISOString(),
      resolved: false,
      replies: [],
    }
    const review = activeReview
    return attempt('comment', async () => {
      showReview(await saveOwnReview(filePath, { ...review, comments: [...review.comments, comment] }))
    })
  }, [activeReview, filePath, reviewerName, attempt, showReview, saveOwnReview])

  const deleteComment = useCallback(async (commentId: string): Promise<boolean> => {
    if (!activeReview || !filePath) return false
    const review = activeReview
    return attempt('other', async () => {
      showReview(await saveOwnReview(filePath, { ...review, comments: review.comments.filter(c => c.id !== commentId) }))
    })
  }, [activeReview, filePath, attempt, showReview, saveOwnReview])

  const author = { authorName: reviewerName, authorEmail: reviewerEmail }

  const toggleResolved = useCallback(async (commentId: string): Promise<boolean> => {
    if (!activeReview || !filePath) return false
    const comment = activeReview.comments.find(c => c.id === commentId)
    if (!comment) return false
    const newResolved = !comment.resolved
    const review = activeReview
    return attempt('other', async () => {
      // Write resolution to own reply file (conflict-free)
      await updateMyReplies(filePath, myReplyKey, author, data => {
        if (!data.resolutions) data.resolutions = []
        const entry: ResolutionEntry = { reviewId: review.id, commentId, resolved: newResolved }
        const at = data.resolutions.findIndex(r => r.reviewId === review.id && r.commentId === commentId)
        if (at >= 0) data.resolutions[at] = entry
        else data.resolutions.push(entry)
      })
      showReview({ ...review, comments: review.comments.map(c => c.id === commentId ? { ...c, resolved: newResolved } : c) })
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `author` is rebuilt from reviewerName / reviewerEmail, listed
  }, [activeReview, filePath, reviewerName, reviewerEmail, myReplyKey, attempt, showReview])

  const addReply = useCallback(async (commentId: string, body: string): Promise<boolean> => {
    if (!activeReview || !filePath) return false
    const reply: CommentReply = {
      id: crypto.randomUUID(),
      authorName: reviewerName,
      body,
      createdAt: new Date().toISOString(),
      reviewId: activeReview.id,
      commentId,
    }
    const review = activeReview
    return attempt('reply', async () => {
      // Write to own reply file (conflict-free)
      await updateMyReplies(filePath, myReplyKey, author, data => { data.replies.push(reply) })
      showReview({ ...review, comments: review.comments.map(c => c.id === commentId ? { ...c, replies: [...c.replies, reply] } : c) })
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `author` is rebuilt from reviewerName / reviewerEmail, listed
  }, [activeReview, filePath, reviewerName, reviewerEmail, myReplyKey, attempt, showReview])

  const completedReviews = reviews.filter(r => r.status === 'completed')

  const viewReview = useCallback((reviewId: string) => {
    const found = reviews.find(r => r.id === reviewId)
    if (found) setActiveReview(found)
  }, [reviews])

  const closeViewingReview = useCallback(() => {
    setActiveReview(prev => {
      if (prev && prev.status === 'completed') return null
      return prev
    })
  }, [])

  const reload = useCallback(async () => {
    if (filePath) await loadReviews(filePath)
  }, [filePath, loadReviews])

  const dismissSaveError = useCallback(() => setSaveError(null), [])

  // Check if any other user has an in-progress review
  const otherInProgressReviews = reviews.filter(
    r => r.status === 'in_progress' && r.reviewerEmail !== reviewerEmail
  )

  const isViewingCompleted = activeReview?.status === 'completed'

  return {
    reviews,
    completedReviews,
    activeReview,
    isReviewing: activeReview !== null && activeReview.status === 'in_progress',
    isViewingCompleted,
    otherInProgressReviews,
    hasReviewRequest,
    loading,
    saveError,
    dismissSaveError,
    startReview,
    completeReview,
    cancelReview,
    addComment,
    deleteComment,
    toggleResolved,
    addReply,
    viewReview,
    closeViewingReview,
    requestReview,
    cancelRequestReview,
    reload,
  }
}
