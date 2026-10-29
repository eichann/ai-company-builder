// The document review's file access (window.electronAPI): the sidecar files
// next to a document, and the document itself. Shapes and names: model.ts.
import {
  getReplyFilePath,
  getReviewFilePath,
  getReviewRequestFilePath,
  type CommentReply,
  type ReplyFileData,
  type ResolutionEntry,
  type Review,
  type ReviewFileData,
} from './model'

/** The document's text, or null when it cannot be read. */
export function readDocument(filePath: string): Promise<string | null> {
  return window.electronAPI.readFile(filePath)
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

export async function readAllReviews(filePath: string): Promise<Review[]> {
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

export async function writeReview(filePath: string, review: Review): Promise<void> {
  const reviewFilePath = getReviewFilePath(filePath, review.id)
  const data: ReviewFileData = { version: 1, review }
  await window.electronAPI.writeFile(reviewFilePath, JSON.stringify(data, null, 2))
}

export async function deleteReviewFile(filePath: string, reviewId: string): Promise<void> {
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

export async function readAllReplies(filePath: string): Promise<{ replies: CommentReply[]; resolutions: ResolutionEntry[] }> {
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

export async function readMyReplies(filePath: string, emailHash: string): Promise<ReplyFileData | null> {
  try {
    const content = await window.electronAPI.readFile(getReplyFilePath(filePath, emailHash))
    if (!content) return null
    return JSON.parse(content) as ReplyFileData
  } catch {
    return null
  }
}

export async function writeMyReplies(filePath: string, emailHash: string, data: ReplyFileData): Promise<void> {
  await window.electronAPI.writeFile(getReplyFilePath(filePath, emailHash), JSON.stringify(data, null, 2))
}

// ============================================================================
// Review request file I/O
//
// NOTE: レビュー依頼ボタンはUI非表示にしたが、review-request の仕組み自体は
// Slack通知連携（サーバー側でpush検知 → Slackメンション付き通知）で
// 再利用予定のため残してある。将来的には requestedTo（宛先）フィールドを追加し、
// SlackメンバーIDと紐づけてメンション送信する想定。
// ============================================================================

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
