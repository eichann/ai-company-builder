import { normalizeRepoPath } from '../../shared/core/paths'

/**
 * 「確認をお願いする」: the app tool the chat AI calls to hand a piece of work
 * to the member for review and stop (owner decision 2026-10-29: non-blocking —
 * the tool returns at once and the AI ends its turn). The request lives in the
 * stored conversation as the tool call itself, so the conversation stays
 * 「あなたの番」 until the member sends anything, even after a restart.
 */
export const REVIEW_SERVER = 'acb_review'
export const REVIEW_TOOL = 'request_review'
/** The name the AI sees (and a skill's allowed-tools lists). */
export const REVIEW_TOOL_ID = `mcp__${REVIEW_SERVER}__${REVIEW_TOOL}`

export const REVIEW_LIMITS = { title: 120, files: 10, path: 1024, points: 5, point: 200, message: 2000 } as const

/**
 * The conversation's record of a request (a data part the chat server adds
 * when the tool accepts one; stored with the message as `reviewRequests`, so
 * it survives a restart). Paths are company-relative.
 */
export const REVIEW_PART_TYPE = 'data-review-request'
export interface ReviewRecord extends ReviewRequest { id: string }

/** What 「この内容で進めて」 sends. */
export const REVIEW_CONFIRM_MESSAGE = '確認しました。この内容で次に進めてください。'

export interface ReviewRequest {
  title: string
  /** Company-relative paths. */
  files: string[]
  points: string[]
  message?: string
}

/**
 * A company-relative path, or null. Absolute paths are accepted only inside
 * the company folder (the AI often passes them); '.' / '..' segments and the
 * company root itself are refused.
 */
export function companyRelativePath(raw: string, companyRoot?: string): string | null {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > REVIEW_LIMITS.path || raw.includes('\0')) return null
  let value = raw.trim().replace(/\\/g, '/')
  const root = companyRoot?.replace(/\\/g, '/').replace(/\/+$/, '')
  if (root && (value === root || value.startsWith(`${root}/`))) value = value.slice(root.length + 1)
  else if (value.startsWith('/') || /^[A-Za-z]:\//.test(value) || value.startsWith('~')) return null
  const normalized = normalizeRepoPath(value)
  return normalized ? normalized : null
}

const text = (value: unknown, max: number) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : ''

/**
 * The request as the conversation shows it (lenient: the input may be a JSON
 * string, as Codex's tool calls are). Undefined when there is no title.
 */
export function readReviewRequest(input: unknown, companyRoot?: string): ReviewRequest | undefined {
  let value = input
  if (typeof value === 'string') {
    try { value = JSON.parse(value) } catch { return undefined }
  }
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const title = text(record.title, REVIEW_LIMITS.title)
  if (!title) return undefined
  const files = (Array.isArray(record.files) ? record.files : [])
    .map(file => typeof file === 'string' ? companyRelativePath(file, companyRoot) : null)
    .filter((file): file is string => !!file)
    .slice(0, REVIEW_LIMITS.files)
  const points = (Array.isArray(record.points) ? record.points : [])
    .map(point => text(point, REVIEW_LIMITS.point))
    .filter(Boolean)
    .slice(0, REVIEW_LIMITS.points)
  const message = typeof record.message === 'string' ? record.message.trim().slice(0, REVIEW_LIMITS.message) : ''
  return { title, files, points, ...(message ? { message } : {}) }
}

/** A stored / streamed record, validated (undefined when malformed). */
export function readReviewRecord(data: unknown): ReviewRecord | undefined {
  if (!data || typeof data !== 'object') return undefined
  const id = (data as { id?: unknown }).id
  if (typeof id !== 'string' || !id || id.length > 200) return undefined
  const request = readReviewRequest(data)
  return request ? { id, ...request } : undefined
}
