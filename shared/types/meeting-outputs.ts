/**
 * What one meeting's reading made twice (owner FB 29, `.claude/rules/minutes.md` "Outputs made
 * once"): `GET /api/companies/:id/records/meeting-duplicates` and
 * `POST …/records/meeting-duplicates/merge` (owner / admin).
 */
import type { RecordSummary } from './records'

/** Records of one meeting with the same type and title (`outputTitleKey`), oldest first. */
export interface MeetingDuplicateGroup {
  meetingId: string
  meetingTitle: string
  type: string
  /** The one kept by default: the oldest still in use. */
  keep: RecordSummary
  /** The others still in use (cancelled / retracted / discarded ones are left out). */
  duplicates: RecordSummary[]
  /** false for a mail draft: its author discards it. */
  mergeable: boolean
}

export interface MeetingDuplicates {
  groups: MeetingDuplicateGroup[]
}

/** `merge { keepId, duplicateIds }`: each duplicate cancelled / retracted with a note naming the kept one. */
export interface MeetingDuplicatesMerged {
  keptId: string
  merged: string[]
  /** Duplicates that could not move (their refusal's code), the rest went on. */
  failed: Array<{ id: string; code: string | null }>
}
