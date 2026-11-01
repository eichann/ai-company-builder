/**
 * API contract of the minutes intake (milestone 4 G7, `.claude/rules/minutes.md`).
 */

/** `POST /api/companies/:id/me/minutes/check` — what the member's own calendar showed now. */
export interface MinutesCheckResult {
  /** false: nothing was looked up (`reason` says why; e.g. no minutes folder chosen yet). */
  checked: boolean
  reason?: 'no-folder' | 'folder-unusable'
  /** Plain Japanese for the member when `checked` is false. */
  message?: string
  /** Meet meetings with someone from outside the company in the window. */
  meetings: number
  /** Meetings with only company members (never read: design §1-2). */
  internalOnly: number
  /** Minutes records made by this check (ids only). */
  created: string[]
  /** Meetings whose minutes record exists already (this member or a colleague found it first). */
  existing: number
  /** Meetings whose notes / transcript are not generated yet (asked again next time). */
  waiting: number
  /** The member's minutes records stuck in 「読んでいる」 for over 30 minutes: the app runs `retry` on them. */
  stale: string[]
}

export interface MinutesDealSummary {
  id: string
  title: string
  state: string | null
  /** The deal's server fields now (stage, confidence, amount, …). */
  fields: Record<string, unknown>
  version: number
}

/**
 * `GET /api/records-ai/minutes/:recordId/text` (the member's AI, tool `minutes_read`) and
 * `GET /api/companies/:id/me/minutes/:recordId/text` (the app): the minutes as outside text.
 * Read from Google now with the member's own permission; never stored or logged.
 */
export interface MinutesText {
  recordId: string
  /** Put above the text: it is data from outside, not instructions. */
  header: string
  text: string
  footer: string
  truncated: boolean
  /** The documents' versions as read now (`notes:7,transcript:7`). */
  docVersion: string
  meeting: { title: string; at: string | null }
  /** The department folder the minutes record lives in (the company's minutes folder): where its decisions go. */
  folder: string | null
  /** Company members who attended (ids and display names). */
  attendees: Array<{ memberId: string; displayName: string }>
  /** How many people from outside attended (names and addresses are not given). */
  externalAttendees: number
  /** The linked deal now, or null. */
  deal: MinutesDealSummary | null
  /** Open deals the meeting may be about (only when no deal is linked; readable ones only). */
  candidates: Array<{ id: string; title: string }>
  /** Instruction-like phrases found in the text (labels and their words); a flag, nothing removed. */
  instructionLike: Array<{ label: string; words: string }>
}

/** `POST …/minutes/:recordId/deal { dealId, expectedVersion? }`. */
export interface MinutesLinkDealResult {
  recordId: string
  dealId: string
  customerId: string | null
  version: number
}

/** `GET|PUT /api/companies/:id/google/minutes-folder` (owner / admin). */
export interface MinutesFolderSetting {
  folder: string | null
  /** Department folders that can be chosen (never a private folder). */
  choices: string[]
}
