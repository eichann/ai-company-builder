/**
 * Who a meeting's people are (minutes.md "Meetings for their attendees"): one copy for the minutes service (its buttons, its
 * text) and for a scheduled job's set watch (jobs.md "The set watch (schema 5)": who sees its occurrences, whose meeting it is).
 * Pure: the meeting's row and its fields as stored.
 */
import type { LedgerValue } from '../../shared/core/record-ledger'
import type { RecordRow } from '../ports/records'

/** The member ids of a meeting's `attendees` field (JSON of ids, ≤ 500 characters), or none. */
export function meetingAttendeeIds(raw: LedgerValue | undefined): string[] {
  if (typeof raw !== 'string') return []
  try {
    const v = JSON.parse(raw) as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** Is the member the minutes' assignee or an attendee (the `attendees` field)? */
export function isMeetingAssigneeOrAttendee(fields: Record<string, LedgerValue>, userId: string): boolean {
  return fields.assignee === userId || meetingAttendeeIds(fields.attendees).includes(userId)
}

/**
 * Is the member one of the meeting's people: on its list as a person, its assignee or an attendee? (Someone who reads it
 * through a group or department on the list did not attend: the minutes' own steps stay with the attendees, records.md
 * "Members-only records".)
 */
export function isMeetingPerson(row: Pick<RecordRow, 'members'>, fields: Record<string, LedgerValue>, userId: string): boolean {
  return (row.members?.includes(userId) ?? false) || isMeetingAssigneeOrAttendee(fields, userId)
}
