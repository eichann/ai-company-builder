// One state machine over the sidecar files of the open document (load, start,
// comment, reply, resolve, complete, cancel); kept whole, ~310 lines.
import { useState, useCallback, useEffect } from 'react'
import {
  replyFileKey,
  mergeRepliesIntoReviews,
  type CommentReply,
  type CommentSeverity,
  type ReplyFileData,
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
  readMyReplies,
  readReviewRequestFile,
  writeMyReplies,
  writeReview,
  writeReviewRequestFile,
} from '../api'

export function useMarkdownReview(filePath: string | null, reviewerName: string, reviewerEmail: string, memberId?: string | null) {
  const [reviews, setReviews] = useState<Review[]>([])
  const [activeReview, setActiveReview] = useState<Review | null>(null)
  const [loading, setLoading] = useState(false)
  const [hasReviewRequest, setHasReviewRequest] = useState(false)
  const myReplyKey = replyFileKey(reviewerEmail, memberId)

  // Load all reviews from sidecar files
  const loadReviews = useCallback(async (docPath: string) => {
    setLoading(true)
    try {
      const [allReviewsRaw, replyData, docContent, reviewRequest] = await Promise.all([
        readAllReviews(docPath),
        readAllReplies(docPath),
        readDocument(docPath),
        readReviewRequestFile(docPath),
      ])
      setHasReviewRequest(reviewRequest !== null)

      // Merge external replies and resolutions into reviews
      const allReviews = mergeRepliesIntoReviews(allReviewsRaw, replyData.replies, replyData.resolutions)

      // Mark orphaned comments and auto-delete fully resolved reviews
      const cleaned: Review[] = []
      for (const r of allReviews) {
        if (r.status !== 'completed') {
          cleaned.push(r)
          continue
        }
        // Mark each comment as orphaned or not based on whether its text still exists
        const updatedComments = r.comments.map(c => ({
          ...c,
          orphaned: !docContent?.includes(c.selectedText),
        }))
        const nonOrphanedUnresolved = updatedComments.filter(c => !c.orphaned && !c.resolved)
        const orphanedUnresolved = updatedComments.filter(c => c.orphaned && !c.resolved)
        // Auto-delete completed reviews where all non-orphaned comments are resolved
        // and there are no unresolved orphaned comments (to prevent silent loss)
        if (nonOrphanedUnresolved.length === 0 && orphanedUnresolved.length === 0) {
          await deleteReviewFile(docPath, r.id)
          continue
        }
        // Persist orphaned flag if changed
        const hasChanges = r.comments.some((c, i) => c.orphaned !== updatedComments[i].orphaned)
        if (hasChanges) {
          const updatedReview = { ...r, comments: updatedComments }
          await writeReview(docPath, updatedReview)
          cleaned.push(updatedReview)
        } else {
          cleaned.push({ ...r, comments: updatedComments })
        }
      }

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
      console.error('Failed to load reviews:', err)
      setReviews([])
      setActiveReview(null)
    } finally {
      setLoading(false)
    }
  }, [reviewerEmail])

  useEffect(() => {
    if (filePath) {
      loadReviews(filePath)
    } else {
      setReviews([])
      setActiveReview(null)
    }
  }, [filePath, loadReviews])

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

  const startReview = useCallback(async () => {
    if (!filePath) return

    // Auto-remove review request when someone starts reviewing
    if (hasReviewRequest) {
      await deleteReviewRequestFile(filePath)
      setHasReviewRequest(false)
    }

    const newReview: Review = {
      id: crypto.randomUUID(),
      reviewerName,
      reviewerEmail,
      status: 'in_progress',
      createdAt: new Date().toISOString(),
      completedAt: null,
      comments: [],
    }
    await writeReview(filePath, newReview)
    setReviews(prev => [...prev, newReview])
    setActiveReview(newReview)
  }, [filePath, reviewerName, reviewerEmail, hasReviewRequest])

  const completeReview = useCallback(async () => {
    if (!activeReview || !filePath) return
    // Save snapshot of document content at review completion time
    const snapshot = await readDocument(filePath) || undefined
    const updated = { ...activeReview, status: 'completed' as const, completedAt: new Date().toISOString(), snapshot }
    await writeReview(filePath, updated)
    setReviews(prev => prev.map(r => r.id === updated.id ? updated : r))
    setActiveReview(null)
  }, [activeReview, filePath])

  const cancelReview = useCallback(async () => {
    if (!activeReview || !filePath) return
    await deleteReviewFile(filePath, activeReview.id)
    setReviews(prev => prev.filter(r => r.id !== activeReview.id))
    setActiveReview(null)
  }, [activeReview, filePath])

  const updateActiveReview = useCallback(async (updatedReview: Review) => {
    if (!filePath) return
    await writeReview(filePath, updatedReview)
    setReviews(prev => prev.map(r => r.id === updatedReview.id ? updatedReview : r))
    setActiveReview(updatedReview)
  }, [filePath])

  const addComment = useCallback(async (selectedText: string, startOffset: number, endOffset: number, body: string, severity: CommentSeverity) => {
    if (!activeReview) return
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
    await updateActiveReview({
      ...activeReview,
      comments: [...activeReview.comments, comment],
    })
  }, [activeReview, updateActiveReview, reviewerName])

  const deleteComment = useCallback(async (commentId: string) => {
    if (!activeReview) return
    await updateActiveReview({
      ...activeReview,
      comments: activeReview.comments.filter(c => c.id !== commentId),
    })
  }, [activeReview, updateActiveReview])

  const toggleResolved = useCallback(async (commentId: string) => {
    if (!activeReview || !filePath) return
    const comment = activeReview.comments.find(c => c.id === commentId)
    if (!comment) return
    const newResolved = !comment.resolved

    // Write resolution to own reply file (conflict-free)
    const existing = await readMyReplies(filePath, myReplyKey)
    const replyFileData: ReplyFileData = existing || {
      version: 1,
      authorName: reviewerName,
      authorEmail: reviewerEmail,
      replies: [],
      resolutions: [],
    }
    if (!replyFileData.resolutions) replyFileData.resolutions = []
    // Update or add resolution entry
    const resIdx = replyFileData.resolutions.findIndex(
      r => r.reviewId === activeReview.id && r.commentId === commentId
    )
    const entry: ResolutionEntry = { reviewId: activeReview.id, commentId, resolved: newResolved }
    if (resIdx >= 0) {
      replyFileData.resolutions[resIdx] = entry
    } else {
      replyFileData.resolutions.push(entry)
    }
    await writeMyReplies(filePath, myReplyKey, replyFileData)

    // Update local state immediately
    const updatedReview = {
      ...activeReview,
      comments: activeReview.comments.map(c =>
        c.id === commentId ? { ...c, resolved: newResolved } : c
      ),
    }
    setReviews(prev => prev.map(r => r.id === updatedReview.id ? updatedReview : r))
    setActiveReview(updatedReview)
  }, [activeReview, filePath, reviewerName, reviewerEmail, myReplyKey])

  const addReply = useCallback(async (commentId: string, body: string) => {
    if (!activeReview || !filePath) return
    const reply: CommentReply = {
      id: crypto.randomUUID(),
      authorName: reviewerName,
      body,
      createdAt: new Date().toISOString(),
      reviewId: activeReview.id,
      commentId,
    }

    // Write to own reply file (conflict-free)
    const existing = await readMyReplies(filePath, myReplyKey)
    const replyFileData: ReplyFileData = existing || {
      version: 1,
      authorName: reviewerName,
      authorEmail: reviewerEmail,
      replies: [],
    }
    replyFileData.replies.push(reply)
    await writeMyReplies(filePath, myReplyKey, replyFileData)

    // Update local state immediately
    const updatedReview = {
      ...activeReview,
      comments: activeReview.comments.map(c =>
        c.id === commentId ? { ...c, replies: [...c.replies, reply] } : c
      ),
    }
    setReviews(prev => prev.map(r => r.id === updatedReview.id ? updatedReview : r))
    setActiveReview(updatedReview)
  }, [activeReview, filePath, reviewerName, reviewerEmail, myReplyKey])

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
