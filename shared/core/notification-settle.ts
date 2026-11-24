/**
 * Which unread notices are settled (片付いた, owner decision D4 of 4b-4 「自動で読む・知らせ・受け箱の数」 第1.1版):
 * what the notice asked for is clearly no longer needed, judged from the **current state** of what it tells of —
 * never the ledger, never stored. A settled notice leaves the inbox's あなた待ち (and the title bar's number) and shows
 * under できた・未確認; it is not marked read, and nothing changes on the server (`notifications.md` "Settled notices").
 *
 * One table, only the clear kinds. Any other kind — one asking the requester for something, a kind this build does not
 * know — never settles (the safe side), and a state that could not be read never settles either.
 */
/** What the server read now about the thing a notice tells of. Absent or null = not known. */
export interface NoticeSubjectNow {
  /** `minutes_arrived`: the meeting record's state now. */
  meetingState?: string | null
  /** `job_failed` / `job_expired`: the occurrence's state now. */
  occurrenceState?: string | null
  /** `job_paused`: the job's state now. */
  jobState?: string | null
}

/** A meeting someone already took up (minutes.md): every state but `arrived` and `failed`. */
const MEETING_SETTLED_STATES: ReadonlySet<string> = new Set(['received', 'reading', 'read', 'skipped'])

/** An occurrence that ran to its end after the notice (only 「もう一度」 brings a failed or expired one there). */
const ranAfterwards = (state: string | null | undefined) => state === 'done' || state === 'nothing'

/** Notice kind → when it is settled. */
export const NOTICE_SETTLE_RULES = {
  // 「議事録が届きました」: someone asked the AI to read it, it is being read or read, or set aside (［読まない］). Not
  // `arrived`, nor `failed` (a reading that failed waits for a person again), nor a state this build does not know.
  minutes_arrived: (now: NoticeSubjectNow) => MEETING_SETTLED_STATES.has(now.meetingState ?? ''),
  // 「止まりました」 / 「期限切れ」: that very occurrence ran afterwards (pressed 「もう一度」 and done, or found nothing).
  job_failed: (now: NoticeSubjectNow) => ranAfterwards(now.occurrenceState),
  job_expired: (now: NoticeSubjectNow) => ranAfterwards(now.occurrenceState),
  // 「止めました」: the job runs again. A job retired, or paused again for another reason, stays (the safe side).
  job_paused: (now: NoticeSubjectNow) => now.jobState === 'active',
} as const

export type SettlingNoticeKind = keyof typeof NOTICE_SETTLE_RULES

export const isSettlingNoticeKind = (kind: string): kind is SettlingNoticeKind =>
  Object.prototype.hasOwnProperty.call(NOTICE_SETTLE_RULES, kind)

/** Is a notice of this kind settled by what is true now? Unknown kinds: never. */
export function noticeSettled(kind: string, now: NoticeSubjectNow): boolean {
  return isSettlingNoticeKind(kind) ? NOTICE_SETTLE_RULES[kind](now) : false
}
