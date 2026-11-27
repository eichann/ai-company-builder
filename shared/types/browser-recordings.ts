/**
 * API shapes of 「ブラウザ操作」 の記録 (agent-browser.md "Recording"): a member sends one recording (`POST
 * /browser-recordings`); the sender and the company's owners / admins list, open and delete them. The content is the
 * core's `BrowserRecordingContent` (shared/core/browser-recording.ts): patterns, labels and symbols — never a value.
 */
import type { BrowserRecordingContent } from '../core/browser-recording'

export type { BrowserRecordingContent }

/** POST /browser-recordings: what the app sends. */
export interface BrowserRecordingSend {
  domain: string
  content: BrowserRecordingContent
}

/** One recording in a list (no content). */
export interface BrowserRecordingSummary {
  id: string
  userId: string
  /** The sender's name (null: not known any more). */
  name: string | null
  domain: string
  lines: number
  createdAt: string
  /** When it is deleted by itself (30 days after it was sent). */
  deleteAt: string
  /** True when the reader sent it. */
  mine: boolean
}

/**
 * POST /browser-recordings' answer: the summary, plus the Skill's draft made from it (agent-browser.md "A Skill's draft
 * from a recording"; additive — an older app reads the summary only).
 */
export interface BrowserRecordingSent extends BrowserRecordingSummary {
  /** The draft made from this recording, or null (no write the rule keeps, or the sender has 10 drafts). */
  draftId: string | null
  /** What happened to the draft, in plain Japanese for the sender. */
  draftNote: string
}

/** GET /browser-recordings: the sender's own; an owner / admin: every recording of the company. Newest first. */
export interface BrowserRecordingsList {
  items: BrowserRecordingSummary[]
  /** True when older recordings exist beyond the list. */
  more: boolean
}

/** GET /browser-recordings/:recordingId */
export interface BrowserRecordingDetail extends BrowserRecordingSummary {
  content: BrowserRecordingContent
}
