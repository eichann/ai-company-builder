// The document review's pure rules: sidecar file names and shapes, the
// reply-file hash, merging replies, detection for the file tree, unseen
// tracking and text matching. The names and JSON shapes are a stored
// contract (files-and-editor.md "Document review"): never change them.
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

export interface ResolutionEntry {
  reviewId: string
  commentId: string
  resolved: boolean
}

export interface ReplyFileData {
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

export interface ReviewFileData {
  version: number
  review: Review
}

export function getReviewFilePath(filePath: string, reviewId: string): string {
  return `${filePath}.review.${reviewId}.json`
}

export function emailToHash(email: string): string {
  // Simple deterministic hash for file naming
  let hash = 0
  for (let i = 0; i < email.length; i++) {
    hash = ((hash << 5) - hash + email.charCodeAt(i)) | 0
  }
  return Math.abs(hash).toString(36)
}

export function getReplyFilePath(filePath: string, emailHash: string): string {
  return `${filePath}.reply.${emailHash}.json`
}

/** Merge replies and resolutions from separate files into review comments */
export function mergeRepliesIntoReviews(reviews: Review[], allReplies: CommentReply[], allResolutions: ResolutionEntry[]): Review[] {
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

export function getReviewRequestFilePath(filePath: string): string {
  return `${filePath}.review-request.json`
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
