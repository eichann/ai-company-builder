// The document review's file access (window.electronAPI): the sidecar files
// next to a document, and the document itself. Shapes and names: model.ts.
import {
  getReplyFilePath,
  getReviewFilePath,
  getReviewRequestFilePath,
  mergeReviewEdits,
  type CommentReply,
  type ReplyFileData,
  type ResolutionEntry,
  type Review,
  type ReviewFileData,
} from './model'
import { tempSaveFileName } from '../../../shared/temp-save-file'
import type { ElectronPort } from '../../shared/ipc/electron-api'

/**
 * The two capabilities this module uses, as small ports over the IPC contract
 * (src/shared/ipc/electron-api.ts): reading files on this computer, and
 * changing them. Nothing here sends anything outside the computer. Every
 * function defaults to window.electronAPI; tests pass their own.
 */
export type ReviewReads = ElectronPort<'readFile' | 'readDirectory' | 'exists'>
export type ReviewWrites = ElectronPort<'writeFile' | 'renameItem' | 'deleteItem'>
/** Saving reads the file first (merge, never overwrite an unreadable one), so it needs both. */
export type ReviewFiles = ReviewReads & ReviewWrites

/** The document's text, or null when it cannot be read. */
export function readDocument(filePath: string, reads: ReviewReads = window.electronAPI): Promise<string | null> {
  return reads.readFile(filePath)
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

export async function readAllReviews(filePath: string, reads: ReviewReads = window.electronAPI): Promise<Review[]> {
  try {
    const dir = filePath.substring(0, filePath.lastIndexOf('/'))
    const entries = await reads.readDirectory(dir)
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
        const content = await reads.readFile(entry.path)
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

/**
 * Saves the reviewer's own review. When the file changed since `base` (what this
 * app last read or wrote), both sides' edits are merged (`mergeReviewEdits`).
 * Returns what was written. Throws ReviewSaveError; a file that is there but
 * cannot be read or parsed is never overwritten.
 */
export function saveReview(filePath: string, review: Review, base: Review | null, files: ReviewFiles = window.electronAPI): Promise<Review> {
  const path = getReviewFilePath(filePath, review.id)
  return oneAtATime(path, async () => {
    const onDisk = await readJsonSidecar<ReviewFileData>(path, files)
    const toWrite = onDisk?.review && base ? mergeReviewEdits(base, onDisk.review, review) : review
    const data: ReviewFileData = { version: 1, review: toWrite }
    await writeSidecar(path, JSON.stringify(data, null, 2), files)
    return toWrite
  })
}

/** Deletes the reviewer's own (cancelled) review. Throws ReviewSaveError when it stays. */
export async function deleteReviewFile(filePath: string, reviewId: string, files: ReviewFiles = window.electronAPI): Promise<void> {
  const reviewFilePath = getReviewFilePath(filePath, reviewId)
  await oneAtATime(reviewFilePath, () => retrying(reviewFilePath, async () => {
    const result = await files.deleteItem(reviewFilePath)
    return result.success || !await files.exists(reviewFilePath)
  }))
  // Clean up reply files: remove replies and resolutions referencing this review
  await cleanupRepliesForReview(filePath, reviewId, files)
}

async function cleanupRepliesForReview(filePath: string, reviewId: string, files: ReviewFiles): Promise<void> {
  try {
    const dir = filePath.substring(0, filePath.lastIndexOf('/'))
    const entries = await files.readDirectory(dir)
    if (!entries) return

    const baseName = filePath.substring(filePath.lastIndexOf('/') + 1)
    const prefix = `${baseName}.reply.`
    const suffix = '.json'
    const replyFiles = entries.filter(e =>
      !e.isDirectory && e.name.startsWith(prefix) && e.name.endsWith(suffix)
    )

    for (const entry of replyFiles) {
      try {
        const content = await files.readFile(entry.path)
        if (!content) continue
        const data = JSON.parse(content) as ReplyFileData
        const filteredReplies = data.replies.filter(r => r.reviewId !== reviewId)
        const filteredResolutions = (data.resolutions || []).filter(r => r.reviewId !== reviewId)
        if (filteredReplies.length === 0 && filteredResolutions.length === 0) {
          // Reply file is empty — delete it
          await files.deleteItem(entry.path)
        } else if (filteredReplies.length !== data.replies.length || filteredResolutions.length !== (data.resolutions || []).length) {
          // Some entries removed — rewrite
          await files.writeFile(entry.path, JSON.stringify({
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

export async function readAllReplies(filePath: string, reads: ReviewReads = window.electronAPI): Promise<{ replies: CommentReply[]; resolutions: ResolutionEntry[] }> {
  try {
    const dir = filePath.substring(0, filePath.lastIndexOf('/'))
    const entries = await reads.readDirectory(dir)
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
        const content = await reads.readFile(entry.path)
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

/**
 * Read-modify-write of the member's own reply file, one change at a time per
 * file, always on what is on disk now (another window or a sync may have
 * changed it). Throws ReviewSaveError; an unreadable file is never overwritten.
 */
export function updateMyReplies(
  filePath: string,
  replyKey: string,
  author: { authorName: string; authorEmail: string },
  change: (data: ReplyFileData) => void,
  files: ReviewFiles = window.electronAPI,
): Promise<void> {
  const path = getReplyFilePath(filePath, replyKey)
  return oneAtATime(path, async () => {
    const data: ReplyFileData = await readJsonSidecar<ReplyFileData>(path, files)
      ?? { version: 1, authorName: author.authorName, authorEmail: author.authorEmail, replies: [] }
    change(data)
    await writeSidecar(path, JSON.stringify(data, null, 2), files)
  })
}

// ============================================================================
// Saving safely
// ============================================================================

/** A sidecar could not be saved (after retries). The hook shows it to the member. */
export class ReviewSaveError extends Error {
  constructor(readonly path: string) {
    super(`Could not save ${path}`)
  }
}

const RETRY_DELAYS_MS = [150, 400]
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** Runs `attempt` until it reports success, waiting between tries; then throws. */
async function retrying(path: string, attempt: () => Promise<boolean>): Promise<void> {
  for (let i = 0; ; i++) {
    let ok = false
    try { ok = await attempt() } catch { ok = false }
    if (ok) return
    if (i >= RETRY_DELAYS_MS.length) throw new ReviewSaveError(path)
    await sleep(RETRY_DELAYS_MS[i])
  }
}

/**
 * Writes next to the target, then renames over it, so a sync or the AI never
 * reads half a file. fs:writeFile only says yes/no, so every failure is retried
 * (a busy file on Windows, a moment of a full disk); a refused folder fails fast.
 */
function writeSidecar(path: string, content: string, files: ReviewFiles): Promise<void> {
  return retrying(path, async () => {
    const slash = path.lastIndexOf('/')
    const temp = `${path.slice(0, slash)}/${tempSaveFileName(path.slice(slash + 1), Math.random().toString(36).slice(2, 10))}`
    if (!await files.writeFile(temp, content)) {
      await files.deleteItem(temp)
      return false
    }
    const moved = await files.renameItem(temp, path)
    if (!moved.success) await files.deleteItem(temp)
    return moved.success
  })
}

/** The parsed file, null when it does not exist; throws when it is there but unreadable. */
async function readJsonSidecar<T>(path: string, files: ReviewReads): Promise<T | null> {
  const content = await files.readFile(path)
  if (content === null) {
    if (await files.exists(path)) throw new ReviewSaveError(path)
    return null
  }
  try {
    return JSON.parse(content) as T
  } catch {
    throw new ReviewSaveError(path)
  }
}

const queues = new Map<string, Promise<unknown>>()

/** Runs saves to the same file one after another, so two quick clicks never lose one. */
function oneAtATime<T>(path: string, run: () => Promise<T>): Promise<T> {
  const next = (queues.get(path) ?? Promise.resolve()).catch(() => {}).then(run)
  queues.set(path, next)
  void next.catch(() => {}).finally(() => { if (queues.get(path) === next) queues.delete(path) })
  return next
}

// ============================================================================
// Review request file I/O
//
// NOTE: レビュー依頼ボタンはUI非表示にしたが、review-request の仕組み自体は
// Slack通知連携（サーバー側でpush検知 → Slackメンション付き通知）で
// 再利用予定のため残してある。将来的には requestedTo（宛先）フィールドを追加し、
// SlackメンバーIDと紐づけてメンション送信する想定。
// ============================================================================

export async function readReviewRequestFile(filePath: string, reads: ReviewReads = window.electronAPI): Promise<{ requestedBy: string; requestedAt: string } | null> {
  try {
    const content = await reads.readFile(getReviewRequestFilePath(filePath))
    if (!content) return null
    return JSON.parse(content)
  } catch {
    return null
  }
}

export async function writeReviewRequestFile(filePath: string, requestedBy: string, files: ReviewFiles = window.electronAPI): Promise<void> {
  await files.writeFile(
    getReviewRequestFilePath(filePath),
    JSON.stringify({ requestedBy, requestedAt: new Date().toISOString() }, null, 2),
  )
}

export async function deleteReviewRequestFile(filePath: string, files: ReviewFiles = window.electronAPI): Promise<void> {
  try {
    await files.deleteItem(getReviewRequestFilePath(filePath))
  } catch {
    // ignore — file may not exist
  }
}
