import type { UIMessage } from 'ai'
import { REVIEW_PART_TYPE, readReviewRecord, type ReviewRecord } from '../../shared/review-request'

/**
 * The 「確認をお願いします」 request a conversation waits on: the last one in
 * its latest message, when that message is the AI's. Anything the member
 * sends afterwards (「この内容で進めて」, a correction, any message) answers it.
 */
export function pendingReviewOf(message: UIMessage | undefined): ReviewRecord | undefined {
  if (!message || message.role !== 'assistant') return undefined
  for (let i = message.parts.length - 1; i >= 0; i--) {
    const part = message.parts[i]
    if (part.type !== REVIEW_PART_TYPE) continue
    const record = readReviewRecord((part as { data?: unknown }).data)
    if (record) return record
  }
  return undefined
}
