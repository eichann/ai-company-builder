/**
 * The core role 会議の記録を読む (`meetings`, `.claude/rules/connector-roles.md`)
 * as the minutes intake asks it (`services/minutes.ts`, `.claude/rules/minutes.md`):
 * the member's meetings in a window, the record of one, its documents (notes,
 * transcript) and their text and version. Provider-neutral: Google implements it
 * today (`services/google-meetings.ts`); the role resolver picks the provider
 * per company (`services/connector-role-providers.ts`).
 *
 * Nothing read is stored or logged by the provider: the caller keeps opaque
 * ids only.
 */

export interface MeetingAttendee {
  /** Lower-case address as the provider gave it (never logged). */
  email: string
  /** The provider's display name (may be empty). */
  name: string
  organizer: boolean
  /** The attendee declined the event: not one of the meeting's people (minutes.md). */
  declined: boolean
  /**
   * On the event's attendee list. False for an organizer the provider names only as the organizer
   * (kept for the thank-you mail's recipients): not one of the meeting's people.
   */
  listed: boolean
}

export interface MeetEvent {
  eventId: string
  title: string
  /** ISO 8601 (UTC). */
  start: string
  end: string
  /** The meeting's code at the provider (`xxx-xxxx-xxx` for Meet). */
  meetingCode: string
  organizer: string | null
  attendees: MeetingAttendee[]
  /** Marked private in the calendar (visibility private / confidential): never recorded. */
  private: boolean
  /** The recurring series it is an instance of (the provider's opaque id), or null. */
  series: string | null
}

export interface MeetArtifactDoc {
  kind: 'notes' | 'transcript'
  docId: string
}

/** Why a read gave no answer the caller can use (the provider's short codes, never its message). */
export interface MeetingReadFailure {
  ok: false
  /** not-sent: nothing left ACB (a switch, no permission, no connector); refused: 4xx; unreadable: an answer of the wrong shape. */
  kind: 'not-sent' | 'refused' | 'rate-limited' | 'server-error' | 'unknown' | 'unreadable'
  reason: string
  status?: number
  googleReason?: string
}

/** Thrown by a reader when a call failed (the minutes service maps it to the member's refusal). */
export class MeetingReadFailed extends Error {
  constructor(readonly result: MeetingReadFailure) {
    super(`meeting read failed: ${result.kind} ${result.reason}`)
  }
}

export interface MeetingRecordsReader {
  /** The member's events with an online meeting in [from, to] (single events, by start time). */
  meetEvents(companyId: string, userId: string, from: Date, to: Date): Promise<MeetEvent[]>
  /** One event of the member's calendar (null when it is not there any more). */
  event(companyId: string, userId: string, eventId: string): Promise<MeetEvent | null>
  /** The record of the meeting that started near the event (null when none yet). */
  conferenceFor(companyId: string, userId: string, event: MeetEvent): Promise<string | null>
  /** The record's generated documents (notes first). */
  documents(companyId: string, userId: string, conferenceId: string): Promise<MeetArtifactDoc[]>
  /** A document's version (a number as text). */
  docVersion(companyId: string, userId: string, docId: string): Promise<string>
  /** A document as plain text, at most `max` characters (with a notice when cut). */
  docText(companyId: string, userId: string, docId: string, max?: number): Promise<{ text: string; truncated: boolean }>
  /**
   * What was said in the meeting, read from the meeting's own record instead of a document (speaker:
   * words, at most `max` characters), or null when the record holds none. For a document the member
   * opens but whose text the provider refuses to hand over (minutes.md "The text").
   */
  transcriptText(companyId: string, userId: string, conferenceId: string, max?: number): Promise<{ text: string; truncated: boolean } | null>
}
