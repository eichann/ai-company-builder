import React, { useState, useCallback, useRef, useEffect, useMemo, useImperativeHandle } from 'react'
import {
  ChatCircleDots,
  Check,
  PaperPlaneTilt,
  Trash,
  CheckCircle,
  ArrowBendDownRight,
  User,
  WarningCircle,
  Info,
} from '@phosphor-icons/react'

// ============================================================================
// Types
// ============================================================================

export type CommentSeverity = 'must_fix' | 'should_fix' | 'note'

export interface CommentReply {
  id: string
  authorName: string
  body: string
  createdAt: string
  reviewId?: string
  commentId?: string
}

interface ResolutionEntry {
  reviewId: string
  commentId: string
  resolved: boolean
}

interface ReplyFileData {
  version: number
  authorName: string
  authorEmail: string
  replies: CommentReply[]
  resolutions?: ResolutionEntry[]
}

export interface ReviewComment {
  id: string
  authorName: string
  severity: CommentSeverity
  selectedText: string
  startOffset: number
  endOffset: number
  body: string
  createdAt: string
  resolved: boolean
  replies: CommentReply[]
  orphaned?: boolean
}

export interface Review {
  id: string
  reviewerName: string
  reviewerEmail: string
  status: 'in_progress' | 'completed'
  createdAt: string
  completedAt: string | null
  comments: ReviewComment[]
  snapshot?: string
}

interface ReviewFileData {
  version: number
  review: Review
}

// ============================================================================
// Severity helpers
// ============================================================================

const SEVERITY_CONFIG: Record<CommentSeverity, { label: string; color: string; bgColor: string; icon: typeof WarningCircle }> = {
  must_fix:   { label: '対応必須', color: 'text-red-400',  bgColor: 'bg-red-500/10',  icon: WarningCircle },
  should_fix: { label: 'できれば', color: 'text-amber-400', bgColor: 'bg-amber-500/10', icon: Info },
  note:       { label: '感想',     color: 'text-zinc-400',  bgColor: 'bg-zinc-500/10',  icon: ChatCircleDots },
}

const SEVERITY_ORDER: CommentSeverity[] = ['must_fix', 'should_fix', 'note']

function SeverityBadge({ severity, size = 'sm' }: { severity: CommentSeverity; size?: 'sm' | 'xs' }) {
  const config = SEVERITY_CONFIG[severity]
  const Icon = config.icon
  const textSize = size === 'sm' ? 'text-[11px]' : 'text-[10px]'
  const iconSize = size === 'sm' ? 12 : 10
  return (
    <span className={`inline-flex items-center gap-0.5 ${config.color} ${textSize}`}>
      <Icon size={iconSize} weight={severity === 'must_fix' ? 'fill' : 'regular'} />
      {config.label}
    </span>
  )
}

// ============================================================================
// Per-review sidecar file I/O
//
// Each review is stored as its own file:
//   document.md.review.{reviewId}.json
//
// This means each reviewer writes only their own file, avoiding git conflicts
// when multiple people review the same document.
// ============================================================================

function getReviewFilePath(filePath: string, reviewId: string): string {
  return `${filePath}.review.${reviewId}.json`
}

async function readAllReviews(filePath: string): Promise<Review[]> {
  try {
    const dir = filePath.substring(0, filePath.lastIndexOf('/'))
    const entries = await window.electronAPI.readDirectory(dir)
    if (!entries) return []

    const baseName = filePath.substring(filePath.lastIndexOf('/') + 1)
    const prefix = `${baseName}.review.`
    const suffix = '.json'
    const reviewFiles = entries.filter(e =>
      !e.isDirectory && e.name.startsWith(prefix) && e.name.endsWith(suffix)
    )

    const reviews: Review[] = []
    for (const entry of reviewFiles) {
      try {
        const content = await window.electronAPI.readFile(entry.path)
        if (content) {
          const data = JSON.parse(content) as ReviewFileData
          reviews.push(data.review)
        }
      } catch {
        // Skip corrupted review files
      }
    }

    return reviews
  } catch {
    return []
  }
}

async function writeReview(filePath: string, review: Review): Promise<void> {
  const reviewFilePath = getReviewFilePath(filePath, review.id)
  const data: ReviewFileData = { version: 1, review }
  await window.electronAPI.writeFile(reviewFilePath, JSON.stringify(data, null, 2))
}

async function deleteReviewFile(filePath: string, reviewId: string): Promise<void> {
  const reviewFilePath = getReviewFilePath(filePath, reviewId)
  try {
    await window.electronAPI.deleteItem(reviewFilePath)
  } catch {
    // ignore
  }
  // Clean up reply files: remove replies and resolutions referencing this review
  await cleanupRepliesForReview(filePath, reviewId)
}

async function cleanupRepliesForReview(filePath: string, reviewId: string): Promise<void> {
  try {
    const dir = filePath.substring(0, filePath.lastIndexOf('/'))
    const entries = await window.electronAPI.readDirectory(dir)
    if (!entries) return

    const baseName = filePath.substring(filePath.lastIndexOf('/') + 1)
    const prefix = `${baseName}.reply.`
    const suffix = '.json'
    const replyFiles = entries.filter(e =>
      !e.isDirectory && e.name.startsWith(prefix) && e.name.endsWith(suffix)
    )

    for (const entry of replyFiles) {
      try {
        const content = await window.electronAPI.readFile(entry.path)
        if (!content) continue
        const data = JSON.parse(content) as ReplyFileData
        const filteredReplies = data.replies.filter(r => r.reviewId !== reviewId)
        const filteredResolutions = (data.resolutions || []).filter(r => r.reviewId !== reviewId)
        if (filteredReplies.length === 0 && filteredResolutions.length === 0) {
          // Reply file is empty — delete it
          await window.electronAPI.deleteItem(entry.path)
        } else if (filteredReplies.length !== data.replies.length || filteredResolutions.length !== (data.resolutions || []).length) {
          // Some entries removed — rewrite
          await window.electronAPI.writeFile(entry.path, JSON.stringify({
            ...data,
            replies: filteredReplies,
            resolutions: filteredResolutions,
          }, null, 2))
        }
      } catch {
        // Skip
      }
    }
  } catch {
    // ignore
  }
}

// ============================================================================
// Reply file I/O
//
// Replies are stored in separate per-user files:
//   document.md.reply.{emailHash}.json
//
// Each user writes only their own reply file, making concurrent replies
// conflict-free in git.
// ============================================================================

function emailToHash(email: string): string {
  // Simple deterministic hash for file naming
  let hash = 0
  for (let i = 0; i < email.length; i++) {
    hash = ((hash << 5) - hash + email.charCodeAt(i)) | 0
  }
  return Math.abs(hash).toString(36)
}

function getReplyFilePath(filePath: string, emailHash: string): string {
  return `${filePath}.reply.${emailHash}.json`
}

async function readAllReplies(filePath: string): Promise<{ replies: CommentReply[]; resolutions: ResolutionEntry[] }> {
  try {
    const dir = filePath.substring(0, filePath.lastIndexOf('/'))
    const entries = await window.electronAPI.readDirectory(dir)
    if (!entries) return { replies: [], resolutions: [] }

    const baseName = filePath.substring(filePath.lastIndexOf('/') + 1)
    const prefix = `${baseName}.reply.`
    const suffix = '.json'
    const replyFiles = entries.filter(e =>
      !e.isDirectory && e.name.startsWith(prefix) && e.name.endsWith(suffix)
    )

    const allReplies: CommentReply[] = []
    const allResolutions: ResolutionEntry[] = []
    for (const entry of replyFiles) {
      try {
        const content = await window.electronAPI.readFile(entry.path)
        if (content) {
          const data = JSON.parse(content) as ReplyFileData
          allReplies.push(...data.replies)
          if (data.resolutions) allResolutions.push(...data.resolutions)
        }
      } catch {
        // Skip corrupted reply files
      }
    }
    return { replies: allReplies, resolutions: allResolutions }
  } catch {
    return { replies: [], resolutions: [] }
  }
}

async function readMyReplies(filePath: string, emailHash: string): Promise<ReplyFileData | null> {
  try {
    const content = await window.electronAPI.readFile(getReplyFilePath(filePath, emailHash))
    if (!content) return null
    return JSON.parse(content) as ReplyFileData
  } catch {
    return null
  }
}

async function writeMyReplies(filePath: string, emailHash: string, data: ReplyFileData): Promise<void> {
  await window.electronAPI.writeFile(getReplyFilePath(filePath, emailHash), JSON.stringify(data, null, 2))
}

/** Merge replies and resolutions from separate files into review comments */
function mergeRepliesIntoReviews(reviews: Review[], allReplies: CommentReply[], allResolutions: ResolutionEntry[]): Review[] {
  if (allReplies.length === 0 && allResolutions.length === 0) return reviews

  // Build a lookup: reviewId+commentId → replies[]
  const replyMap = new Map<string, CommentReply[]>()
  for (const reply of allReplies) {
    if (!reply.reviewId || !reply.commentId) continue
    const key = `${reply.reviewId}:${reply.commentId}`
    const existing = replyMap.get(key) || []
    existing.push(reply)
    replyMap.set(key, existing)
  }

  // Build a lookup: reviewId+commentId → resolved (last one wins)
  const resolutionMap = new Map<string, boolean>()
  for (const res of allResolutions) {
    const key = `${res.reviewId}:${res.commentId}`
    resolutionMap.set(key, res.resolved)
  }

  return reviews.map(review => ({
    ...review,
    comments: review.comments.map(comment => {
      const key = `${review.id}:${comment.id}`

      // Merge replies
      const externalReplies = replyMap.get(key) || []
      let mergedReplies = comment.replies
      if (externalReplies.length > 0) {
        const allCommentReplies = [...comment.replies, ...externalReplies]
        const seen = new Set<string>()
        mergedReplies = allCommentReplies.filter(r => {
          if (seen.has(r.id)) return false
          seen.add(r.id)
          return true
        })
        mergedReplies.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      }

      // Merge resolved state (reply file overrides review file)
      const resolvedOverride = resolutionMap.get(key)
      const resolved = resolvedOverride !== undefined ? resolvedOverride : comment.resolved

      return { ...comment, replies: mergedReplies, resolved }
    }),
  }))
}

// ============================================================================
// Review request file I/O
//
// NOTE: レビュー依頼ボタンはUI非表示にしたが、review-request の仕組み自体は
// Slack通知連携（サーバー側でpush検知 → Slackメンション付き通知）で
// 再利用予定のため残してある。将来的には requestedTo（宛先）フィールドを追加し、
// SlackメンバーIDと紐づけてメンション送信する想定。
// ============================================================================

function getReviewRequestFilePath(filePath: string): string {
  return `${filePath}.review-request.json`
}

export async function readReviewRequest(filePath: string): Promise<{ requestedBy: string; requestedAt: string } | null> {
  try {
    const content = await window.electronAPI.readFile(getReviewRequestFilePath(filePath))
    if (!content) return null
    return JSON.parse(content)
  } catch {
    return null
  }
}

export async function writeReviewRequest(filePath: string, requestedBy: string): Promise<void> {
  await window.electronAPI.writeFile(
    getReviewRequestFilePath(filePath),
    JSON.stringify({ requestedBy, requestedAt: new Date().toISOString() }, null, 2),
  )
}

export async function deleteReviewRequest(filePath: string): Promise<void> {
  try {
    await window.electronAPI.deleteItem(getReviewRequestFilePath(filePath))
  } catch {
    // ignore — file may not exist
  }
}

// ============================================================================
// Review file detection helpers (for file tree badges)
// ============================================================================

const REVIEW_FILE_PATTERN = /^(.+)\.review\.[^/]+\.json$/
const REVIEW_REQUEST_PATTERN = /^(.+)\.review-request\.json$/
const REPLY_FILE_PATTERN = /^(.+)\.reply\.[^/]+\.json$/

/** Check if a filename is a review-related sidecar file */
export function isReviewSidecarFile(fileName: string): boolean {
  return REVIEW_FILE_PATTERN.test(fileName)
    || REVIEW_REQUEST_PATTERN.test(fileName)
    || REPLY_FILE_PATTERN.test(fileName)
    || fileName.endsWith('.reviews.json')
}

/** From a list of filenames, extract which document names have reviews or review requests */
export function detectReviewStatus(fileNames: string[]): Map<string, { hasReview: boolean; hasRequest: boolean; reviewFileNames: string[] }> {
  const status = new Map<string, { hasReview: boolean; hasRequest: boolean; reviewFileNames: string[] }>()
  for (const name of fileNames) {
    const reviewMatch = name.match(/^(.+)\.review\.[^.]+\.json$/)
    if (reviewMatch) {
      const docName = reviewMatch[1]
      const existing = status.get(docName) || { hasReview: false, hasRequest: false, reviewFileNames: [] }
      existing.hasReview = true
      existing.reviewFileNames.push(name)
      status.set(docName, existing)
    }
    const requestMatch = name.match(/^(.+)\.review-request\.json$/)
    if (requestMatch) {
      const docName = requestMatch[1]
      const existing = status.get(docName) || { hasReview: false, hasRequest: false, reviewFileNames: [] }
      existing.hasRequest = true
      status.set(docName, existing)
    }
  }
  return status
}

/** Mark review files as seen for a given document path */
export function markReviewSeen(filePath: string, reviewFileNames: string[]): void {
  const key = `review-seen:${filePath}`
  localStorage.setItem(key, JSON.stringify(reviewFileNames.sort()))
}

/** Check if there are unseen review files for a given document path */
export function hasUnseenReviews(filePath: string, currentReviewFileNames: string[]): boolean {
  const key = `review-seen:${filePath}`
  const stored = localStorage.getItem(key)
  if (!stored) return currentReviewFileNames.length > 0
  try {
    const seen = JSON.parse(stored) as string[]
    // Unseen if any current review file name wasn't in the seen set
    const seenSet = new Set(seen)
    return currentReviewFileNames.some(name => !seenSet.has(name))
  } catch {
    return currentReviewFileNames.length > 0
  }
}

// ============================================================================
// Hook: useMarkdownReview
// ============================================================================

export function useMarkdownReview(filePath: string | null, reviewerName: string, reviewerEmail: string) {
  const [reviews, setReviews] = useState<Review[]>([])
  const [activeReview, setActiveReview] = useState<Review | null>(null)
  const [loading, setLoading] = useState(false)
  const [hasReviewRequest, setHasReviewRequest] = useState(false)
  const myEmailHash = emailToHash(reviewerEmail)

  // Load all reviews from sidecar files
  const loadReviews = useCallback(async (docPath: string) => {
    setLoading(true)
    try {
      const [allReviewsRaw, replyData, docContent, reviewRequest] = await Promise.all([
        readAllReviews(docPath),
        readAllReplies(docPath),
        window.electronAPI.readFile(docPath),
        readReviewRequest(docPath),
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
    await writeReviewRequest(filePath, reviewerName)
    setHasReviewRequest(true)
  }, [filePath, reviewerName])

  const cancelRequestReview = useCallback(async () => {
    if (!filePath) return
    await deleteReviewRequest(filePath)
    setHasReviewRequest(false)
  }, [filePath])

  const startReview = useCallback(async () => {
    if (!filePath) return

    // Auto-remove review request when someone starts reviewing
    if (hasReviewRequest) {
      await deleteReviewRequest(filePath)
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
  }, [filePath, reviewerName, reviewerEmail])

  const completeReview = useCallback(async () => {
    if (!activeReview || !filePath) return
    // Save snapshot of document content at review completion time
    const snapshot = await window.electronAPI.readFile(filePath) || undefined
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
    const existing = await readMyReplies(filePath, myEmailHash)
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
    await writeMyReplies(filePath, myEmailHash, replyFileData)

    // Update local state immediately
    const updatedReview = {
      ...activeReview,
      comments: activeReview.comments.map(c =>
        c.id === commentId ? { ...c, resolved: newResolved } : c
      ),
    }
    setReviews(prev => prev.map(r => r.id === updatedReview.id ? updatedReview : r))
    setActiveReview(updatedReview)
  }, [activeReview, filePath, reviewerName, reviewerEmail, myEmailHash])

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
    const existing = await readMyReplies(filePath, myEmailHash)
    const replyFileData: ReplyFileData = existing || {
      version: 1,
      authorName: reviewerName,
      authorEmail: reviewerEmail,
      replies: [],
    }
    replyFileData.replies.push(reply)
    await writeMyReplies(filePath, myEmailHash, replyFileData)

    // Update local state immediately
    const updatedReview = {
      ...activeReview,
      comments: activeReview.comments.map(c =>
        c.id === commentId ? { ...c, replies: [...c.replies, reply] } : c
      ),
    }
    setReviews(prev => prev.map(r => r.id === updatedReview.id ? updatedReview : r))
    setActiveReview(updatedReview)
  }, [activeReview, filePath, reviewerName, reviewerEmail, myEmailHash])

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

// ============================================================================
// Component: ReviewBanner
// ============================================================================

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

// ============================================================================
// Component: CompletedReviewBanner
// ============================================================================

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

// ============================================================================
// Component: ReviewHistoryDropdown
// ============================================================================

export function ReviewHistoryDropdown({
  reviews,
  onSelectReview,
}: {
  reviews: Review[]
  onSelectReview: (reviewId: string) => void
}) {
  const [open, setOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  if (reviews.length === 0) return null

  return (
    <div ref={dropdownRef} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 px-2 py-1 text-[11px] rounded-md border border-gray-200 dark:border-zinc-700 bg-white/90 dark:bg-zinc-800/90 backdrop-blur-sm shadow-sm text-gray-500 dark:text-zinc-400 hover:text-gray-700 dark:hover:text-zinc-200 transition-colors"
        title="レビュー履歴を確認"
      >
        <CheckCircle size={12} />
        レビュー履歴 ({reviews.length})
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 w-64 rounded-lg border border-gray-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 shadow-xl z-50 overflow-hidden">
          <div className="px-3 py-2 border-b border-gray-200 dark:border-zinc-700 text-[11px] text-gray-500 dark:text-zinc-400 font-medium">
            過去のレビュー
          </div>
          <div className="max-h-48 overflow-y-auto">
            {reviews.map((r) => {
              const mustFix = r.comments.filter(c => c.severity === 'must_fix').length
              const shouldFix = r.comments.filter(c => c.severity === 'should_fix').length
              return (
                <button
                  key={r.id}
                  onClick={() => { onSelectReview(r.id); setOpen(false) }}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-left text-xs hover:bg-gray-100 dark:hover:bg-zinc-700/50 transition-colors"
                >
                  <CheckCircle size={14} className="text-blue-500 dark:text-blue-400 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-gray-700 dark:text-zinc-300 truncate">{r.reviewerName}</span>
                      <span className="text-[10px] text-gray-400 dark:text-zinc-500">{r.comments.length}件</span>
                    </div>
                    <div className="text-[10px] text-gray-400 dark:text-zinc-500 mt-0.5 flex items-center gap-2">
                      <span>
                        {r.completedAt
                          ? new Date(r.completedAt).toLocaleDateString('ja-JP', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
                          : '日時不明'}
                      </span>
                      {mustFix > 0 && <span className="text-red-500 dark:text-red-400">必須{mustFix}</span>}
                      {shouldFix > 0 && <span className="text-amber-500 dark:text-amber-400">できれば{shouldFix}</span>}
                    </div>
                  </div>
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

// ============================================================================
// Component: CommentPopover (appears when text is selected during review)
// ============================================================================

export function CommentPopover({
  position,
  selectedText,
  onSubmit,
  onClose,
}: {
  position: { x: number; y: number }
  selectedText?: string
  onSubmit: (body: string, severity: CommentSeverity) => void
  onClose: () => void
}) {
  const [body, setBody] = useState('')
  const [severity, setSeverity] = useState<CommentSeverity>('must_fix')
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const timer = setTimeout(() => inputRef.current?.focus(), 50)
    return () => clearTimeout(timer)
  }, [])

  const handleSubmit = () => {
    if (body.trim()) {
      onSubmit(body.trim(), severity)
      setBody('')
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      handleSubmit()
    }
    if (e.key === 'Escape') {
      onClose()
    }
  }

  return (
    <div
      className="fixed z-50 w-72 rounded-lg border border-gray-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 shadow-xl"
      style={{ left: position.x, top: position.y + 8 }}
    >
      <div className="p-3">
        {/* Selected text quote */}
        {selectedText && (
          <div className="mb-2 px-2 py-1.5 border-l-2 border-gray-300 dark:border-zinc-600 bg-gray-50 dark:bg-zinc-900/50 rounded-r text-[11px] text-gray-500 dark:text-zinc-400 line-clamp-3 leading-relaxed">
            {selectedText}
          </div>
        )}
        {/* Severity selector */}
        <div className="flex gap-1 mb-2">
          {SEVERITY_ORDER.map((s) => {
            const config = SEVERITY_CONFIG[s]
            const Icon = config.icon
            const isActive = severity === s
            return (
              <button
                key={s}
                onClick={() => setSeverity(s)}
                className={`flex items-center gap-1 px-2 py-1 rounded text-[11px] transition-colors border ${
                  isActive
                    ? `${config.color} ${config.bgColor} border-current`
                    : 'text-gray-400 dark:text-zinc-500 border-transparent hover:text-gray-600 dark:hover:text-zinc-300 hover:bg-gray-100 dark:hover:bg-zinc-700/50'
                }`}
              >
                <Icon size={12} weight={s === 'must_fix' && isActive ? 'fill' : 'regular'} />
                {config.label}
              </button>
            )
          })}
        </div>
        <textarea
          ref={inputRef}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="コメントを入力... (⌘+Enter で送信)"
          className="w-full h-20 px-2 py-1.5 rounded bg-gray-50 dark:bg-zinc-900 border border-gray-200 dark:border-zinc-700 text-sm text-gray-800 dark:text-zinc-200 placeholder-gray-400 dark:placeholder-zinc-500 resize-none focus:outline-none focus:ring-1 focus:ring-amber-500/50"
        />
        <div className="flex justify-end gap-2 mt-2">
          <button
            onClick={onClose}
            className="px-2 py-1 text-xs text-gray-400 dark:text-zinc-400 hover:text-gray-600 dark:hover:text-zinc-200 transition-colors"
          >
            キャンセル
          </button>
          <button
            onClick={handleSubmit}
            disabled={!body.trim()}
            className="flex items-center gap-1 px-2.5 py-1 text-xs rounded bg-amber-600 hover:bg-amber-500 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <PaperPlaneTilt size={12} />
            コメント
          </button>
        </div>
      </div>
    </div>
  )
}

// ============================================================================
// Component: ReplyInput (inline reply form for a comment thread)
// ============================================================================

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

// ============================================================================
// Component: ReviewSidePanel
// ============================================================================

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
  onAddReply?: (commentId: string, body: string) => void
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
                  onSubmit={(body) => { onAddReply(comment.id, body); setReplyingTo(null) }}
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

// ============================================================================
// Helper: Find text offset in markdown source from rendered selection
// ============================================================================

export function findTextInMarkdown(markdown: string, selectedText: string): { start: number; end: number } | null {
  const index = markdown.indexOf(selectedText)
  if (index !== -1) {
    return { start: index, end: index + selectedText.length }
  }

  const normalizedSelected = selectedText.replace(/\s+/g, ' ').trim()
  const normalizedMd = markdown.replace(/\s+/g, ' ')
  const normalizedIndex = normalizedMd.indexOf(normalizedSelected)
  if (normalizedIndex !== -1) {
    let originalPos = 0
    let normalizedPos = 0
    while (normalizedPos < normalizedIndex && originalPos < markdown.length) {
      if (/\s/.test(markdown[originalPos])) {
        while (originalPos < markdown.length && /\s/.test(markdown[originalPos])) originalPos++
        normalizedPos++
      } else {
        originalPos++
        normalizedPos++
      }
    }
    return { start: originalPos, end: originalPos + selectedText.length }
  }

  return null
}

// ============================================================================
// Hook: useTextSelection
// ============================================================================

export function useTextSelection(
  isReviewing: boolean,
  markdownContent: string,
  onAddComment: (selectedText: string, startOffset: number, endOffset: number, body: string, severity: CommentSeverity) => void,
) {
  const [popover, setPopover] = useState<{ x: number; y: number; text: string; start: number; end: number } | null>(null)
  const isReviewingRef = useRef(isReviewing)
  useEffect(() => { isReviewingRef.current = isReviewing }, [isReviewing])

  const handleMouseUp = useCallback(() => {
    if (!isReviewingRef.current) return

    const selection = window.getSelection()
    if (!selection || selection.isCollapsed || !selection.toString().trim()) {
      return
    }

    const text = selection.toString().trim()
    const offsets = findTextInMarkdown(markdownContent, text)

    const range = selection.getRangeAt(0)
    const rect = range.getBoundingClientRect()

    setPopover({
      x: Math.min(rect.left, window.innerWidth - 300),
      y: rect.bottom,
      text,
      start: offsets?.start ?? 0,
      end: offsets?.end ?? 0,
    })
  }, [markdownContent])

  const handleSubmitComment = useCallback((body: string, severity: CommentSeverity) => {
    if (popover) {
      onAddComment(popover.text, popover.start, popover.end, body, severity)
      setPopover(null)
      window.getSelection()?.removeAllRanges()
    }
  }, [popover, onAddComment])

  const closePopover = useCallback(() => {
    setPopover(null)
    window.getSelection()?.removeAllRanges()
  }, [])

  useEffect(() => {
    if (!popover) return
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      if (target.closest('.fixed.z-50')) return
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [popover])

  return { popover, handleMouseUp, handleSubmitComment, closePopover }
}

// ============================================================================
// Component: MarkdownDiffView
// ============================================================================

type DiffLine = { type: 'same' | 'add' | 'del'; text: string }

function computeDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.split('\n')
  const newLines = newText.split('\n')
  const m = oldLines.length
  const n = newLines.length

  // LCS via Hunt-Szymanski for reasonable performance
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0))
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = oldLines[i - 1] === newLines[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1])
    }
  }

  // Backtrack to build diff
  const result: DiffLine[] = []
  let i = m, j = n
  const stack: DiffLine[] = []
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      stack.push({ type: 'same', text: oldLines[i - 1] })
      i--; j--
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      stack.push({ type: 'add', text: newLines[j - 1] })
      j--
    } else {
      stack.push({ type: 'del', text: oldLines[i - 1] })
      i--
    }
  }
  while (stack.length) result.push(stack.pop()!)
  return result
}

export interface MarkdownDiffViewHandle {
  scrollToText: (text: string) => void
}

export const MarkdownDiffView = React.forwardRef<MarkdownDiffViewHandle, { snapshot: string; current: string }>(
  function MarkdownDiffView({ snapshot, current }, ref) {
    const containerRef = useRef<HTMLDivElement>(null)
    const diff = useMemo(() => computeDiff(snapshot, current), [snapshot, current])
    const hasChanges = diff.some(d => d.type !== 'same')

    useImperativeHandle(ref, () => ({
      scrollToText(text: string) {
        if (!containerRef.current) return
        const lines = containerRef.current.querySelectorAll('[data-diff-line]')
        // Search for the first line containing part of the selected text
        const searchText = text.split('\n')[0].trim()
        for (const line of lines) {
          if (line.textContent && line.textContent.includes(searchText)) {
            line.scrollIntoView({ behavior: 'smooth', block: 'center' })
            line.classList.add('ring-2', 'ring-amber-400')
            setTimeout(() => line.classList.remove('ring-2', 'ring-amber-400'), 1500)
            return
          }
        }
      }
    }), [])

    if (!hasChanges) {
      return (
        <div className="h-full flex items-center justify-center text-gray-400 dark:text-zinc-500 text-sm">
          レビュー時点から変更はありません
        </div>
      )
    }

    return (
      <div ref={containerRef} className="h-full overflow-auto px-8 py-6">
        <div className="max-w-3xl mx-auto font-mono text-sm leading-relaxed">
          {diff.map((line, i) => (
            <div
              key={i}
              data-diff-line
              className={`px-3 py-0.5 border-l-2 transition-all ${
                line.type === 'add'
                  ? 'bg-green-50 dark:bg-green-500/10 border-green-400 dark:border-green-500 text-green-800 dark:text-green-300'
                  : line.type === 'del'
                    ? 'bg-red-50 dark:bg-red-500/10 border-red-400 dark:border-red-500 text-red-800 dark:text-red-400 line-through opacity-60'
                    : 'border-transparent text-gray-700 dark:text-zinc-300'
              }`}
            >
              <span className="inline-block w-5 text-[10px] text-gray-300 dark:text-zinc-600 select-none mr-2">
                {line.type === 'add' ? '+' : line.type === 'del' ? '−' : ' '}
              </span>
              {line.text || '\u00A0'}
            </div>
          ))}
        </div>
      </div>
    )
  }
)
