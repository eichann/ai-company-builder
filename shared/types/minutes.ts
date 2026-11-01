/**
 * API contract of the minutes intake (milestone 4 G7, `.claude/rules/minutes.md`):
 * meetings (`meeting` records, 会議) are found on the calendar and their minutes
 * (議事録, the meeting's content) are read where they are.
 */
import type { MeetingIntake } from '../core/minutes'

/** `POST /api/companies/:id/me/minutes/check` — what the member's own calendar showed now. */
export interface MinutesCheckResult {
  /** false: nothing was looked up (`reason` says why; e.g. no minutes folder chosen yet). */
  checked: boolean
  reason?: 'no-folder' | 'folder-unusable'
  /** Plain Japanese for the member when `checked` is false. */
  message?: string
  /** Meet meetings in the window that the company's setting reads (default: with someone from outside). */
  meetings: number
  /** Meetings the setting does not read (default: only company members — never read further, design §1-2). */
  internalOnly: number
  /** Meeting records made by this check (ids only). */
  created: string[]
  /** Meetings whose record exists already (this member or a colleague found it first). */
  existing: number
  /** Meetings whose notes / transcript are not generated yet (asked again next time). */
  waiting: number
  /** The member's meeting records stuck in 「読んでいる」 for over 30 minutes: the app runs `retry` on them. */
  stale: string[]
}

/** The まとまり (any type implementing `bundle`: a 案件, a 企画, a 取り組み) the meeting belongs to. */
export interface MinutesBundleSummary {
  id: string
  /** Its type (`deal`, …) and that type's label (案件, …), so the AI can call it by name. */
  type: string
  typeLabel: string
  title: string
  state: string | null
  /** Its server fields now (a deal's stage, confidence, amount, …). */
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
  /** The department folder the meeting record lives in (the company's minutes folder): where its decisions go. */
  folder: string | null
  /** Company members who attended (ids and display names). */
  attendees: Array<{ memberId: string; displayName: string }>
  /** How many people from outside attended (names and addresses are not given). */
  externalAttendees: number
  /** The linked まとまり now, or null. */
  bundle: MinutesBundleSummary | null
  /** Unfinished まとまり the meeting may be about (only when none is linked; readable ones only). */
  candidates: Array<{ id: string; title: string; typeLabel: string }>
  /** Instruction-like phrases found in the text (labels and their words); a flag, nothing removed. */
  instructionLike: Array<{ label: string; words: string }>
}

/** `POST …/minutes/item/:recordId/bundle { bundleId, expectedVersion? }`. */
export interface MinutesLinkBundleResult {
  recordId: string
  bundleId: string
  /** The まとまり's 相手 (a record implementing `counterpart` it links to), linked to the meeting too; null if none. */
  counterpartId: string | null
  version: number
}

/**
 * `GET|PUT /api/companies/:id/google/minutes-folder` (owner / admin). PUT takes
 * `{ folder?, meetings? }` (at least one).
 */
export interface MinutesFolderSetting {
  folder: string | null
  /** Department folders that can be chosen (never a private folder). */
  choices: string[]
  /** Which meetings are read: `external` (default) = with someone from outside, `all`. */
  meetings: MeetingIntake
}
