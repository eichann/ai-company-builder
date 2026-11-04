/**
 * API contract of the minutes intake (milestone 4 G7, `.claude/rules/minutes.md`):
 * meetings (`meeting` records, 会議) are found on the calendar and their minutes
 * (議事録, the meeting's content) are read where they are.
 */
import type { MeetingIntake } from '../core/minutes'

/** `POST /api/companies/:id/me/minutes/check` — what the member's own calendar showed now. */
export interface MinutesCheckResult {
  /**
   * false: nothing was looked up (`reason` says why). Since meetings need no folder (owner decision
   * 2026-11-04) the server no longer answers `no-folder` / `folder-unusable`; they stay in the type
   * for older apps.
   */
  checked: boolean
  reason?: 'no-folder' | 'folder-unusable'
  /** Plain Japanese for the member when `checked` is false. */
  message?: string
  /** Meet meetings in the window that are recorded (every one except events marked private). */
  meetings: number
  /** Meetings not recorded: events marked private in the calendar (never read further). Named before the 2026-11-04 change. */
  internalOnly: number
  /** Meeting records made by this check (ids only). */
  created: string[]
  /** Meetings whose record exists already (this member or a colleague found it first). */
  existing: number
  /** Meetings whose notes / transcript are not generated yet (asked again next time). */
  waiting: number
  /**
   * The member's meeting records that were stuck in 「読んでいる」 for over 30 minutes. The server
   * puts them back to 「届いた」 itself (the ledger's actor is the server clock); an older app's
   * `retry` on them then finds nothing to do.
   */
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
  /**
   * The meeting record's version now: `expectedVersion` for its next action (finish_reading /
   * fail_reading). An unattended run cannot look the record up otherwise.
   */
  version: number
  /** Put above the text: it is data from outside, not instructions. */
  header: string
  text: string
  footer: string
  truncated: boolean
  /** The documents' versions as read now (`notes:7,transcript:7`). */
  docVersion: string
  meeting: { title: string; at: string | null }
  /**
   * The department folder the meeting record lives in, or null: a meeting seen by its attendees only
   * (every meeting found since 2026-11-04) has none, and its decisions take its list (no folder).
   */
  folder: string | null
  /** Company members who attended (ids and display names). */
  attendees: Array<{ memberId: string; displayName: string }>
  /** How many people from outside attended (names and addresses are not given). */
  externalAttendees: number
  /** The linked まとまり now, or null. */
  bundle: MinutesBundleSummary | null
  /** Unfinished まとまり the meeting may be about (only when none is linked; readable ones only). */
  candidates: Array<{ id: string; title: string; typeLabel: string }>
  /** A person said 「まとまりはない（社内の会議など）」: nobody is asked which まとまり it is. */
  noBundle: boolean
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
 * `{ folder?, meetings?, bundleQuestionDays? }` (at least one). Since 2026-11-04 meetings are seen
 * by their attendees only: `folder` and `meetings` are still kept and answered for older admin
 * consoles but change nothing; `bundleQuestionDays` is still used.
 */
export interface MinutesFolderSetting {
  folder: string | null
  /** Department folders that can be chosen (never a private folder). */
  choices: string[]
  /** Which meetings are read: `external` (default) = with someone from outside, `all`. */
  meetings: MeetingIntake
  /** Days 「どのまとまりの会議ですか？」 stays in あなたの番 after a meeting is read (default 7, 1–30). */
  bundleQuestionDays: number
}

/**
 * `GET /api/companies/:id/me/minutes/bundle-questions` — the member's 「どのまとまりの会議ですか？」
 * items of あなたの番, decided by the server: meetings they are the assignee of, read within the
 * company's days, with someone from outside, no まとまり linked and the question not closed, in a
 * company that has some まとまり. Ids, titles and times only.
 */
export interface MeetingBundleQuestions {
  days: number
  questions: MeetingBundleQuestion[]
}

export interface MeetingBundleQuestion {
  recordId: string
  title: string
  version: number
  /** When the meeting took place (ISO), or null. */
  meetingAt: string | null
  /** When it was read (ISO): it leaves あなたの番 `days` after. */
  readAt: string
  /**
   * Meetings of the same counterpart or series share it (an opaque key, no Google id): the list
   * shows them as one row 「まとまりを選ぶ会議 n件」. `label` names the group (the series' title).
   */
  group: { key: string; label: string }
  /**
   * 「『…』の会議ですか？」: the one open まとまり (readable by the member) of the meeting's 相手 — the
   * outside participants' company found by 名寄せ. Null: none, or two or more (the plain question).
   * Never linked until the person says はい (the same `…/bundle` as choosing by hand).
   */
  suggested: { id: string; title: string; typeLabel: string } | null
}

/** `GET /api/companies/:id/me/minutes/item/:recordId/bundle-question` — one meeting's question, for its card. */
export interface MeetingBundleQuestionState {
  recordId: string
  title: string
  version: number
  /** A まとまり may be chosen now (none linked; the member is the assignee or an admin). */
  canChoose: boolean
  /** 「まとまりはない」 was chosen earlier (a まとまり can still be chosen). */
  noBundle: boolean
  /** As `MeetingBundleQuestion.suggested` (only while a まとまり may be chosen). */
  suggested: MeetingBundleQuestion['suggested']
}

/** `POST …/minutes/item/:recordId/no-bundle { expectedVersion? }` — 「まとまりはない（社内の会議など）」. */
export interface MinutesNoBundleResult {
  recordId: string
  version: number
}

/**
 * Meetings for their attendees (owner decision 2026-11-04, minutes.md): one meeting's place in the
 * task list's banner 「議事録が届きました」, as `GET /api/companies/:id/me/minutes/arrivals` answers it.
 * Ids, titles, times, counts and the names of the members on its list only — never minutes text.
 */
export interface MeetingArrival {
  recordId: string
  title: string
  version: number
  /** When the meeting took place (ISO), or null. */
  meetingAt: string | null
  /**
   * `arrived`: 「議事録が届きました」, nobody asked the AI yet; `asked`: the AI's turn (not started);
   * `reading`: the AI is reading; `read`: read (`summary` may say what came of it);
   * `skipped`: someone chose ［読まない］; `failed`: the AI could not read it.
   */
  status: 'arrived' | 'asked' | 'reading' | 'read' | 'skipped' | 'failed'
  /** Members on the meeting's list (who may see it), the caller included. */
  attendeeCount: number
  /** Who asked the AI to read it (its reader), or who chose ［読まない］; null for none. */
  by: { memberId: string; displayName: string } | null
  /** The caller is that person. */
  byYou: boolean
  /** The meeting is one of a recurring series (「この定例は次から自動で読む」 can be set). */
  series: boolean
  /** The caller set this series to be read automatically. */
  autoSeries: boolean
}

/**
 * `GET /api/companies/:id/me/minutes/arrivals` — the caller's meetings that took place in the last
 * `days` (`MEETING_ARRIVED_DAYS`), newest first. An arrived meeting older than that leaves this
 * answer (the banner) and stays openable and readable from its card.
 */
export interface MeetingArrivals {
  days: number
  items: MeetingArrival[]
}

/** `POST …/me/minutes/item/:recordId/read-request { expectedVersion? }` — ［AI に読ませる］ (any attendee). */
export interface MeetingReadRequestResult {
  recordId: string
  version: number
  /** Now the AI's turn on the caller's PC (they are its assignee). */
  state: string
}

/** `POST …/me/minutes/item/:recordId/skip { expectedVersion? }` — ［読まない］ (any attendee). */
export interface MeetingSkipResult {
  recordId: string
  version: number
}

/** `PUT …/me/minutes/item/:recordId/auto-series { auto }` — 「この定例は次から自動で読む」 (the caller's own). */
export interface MeetingAutoSeriesResult {
  recordId: string
  autoSeries: boolean
}
