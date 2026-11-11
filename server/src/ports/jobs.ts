/**
 * Scheduled jobs (定期の仕事, `.claude/rules/jobs.md`), behind the company handle (`CompanyData.jobs`;
 * adapters/sqlite/jobs.ts). Every method is limited to the handle's company: another company's job id
 * is not found and nothing of it changes. Versions are append-only: there is no method that rewrites a
 * version's definition (and a trigger refuses it), only one that adds a version and ones that mark a
 * version approved / accepted once.
 */
import type { JobOccurrenceState, JobPauseReason, JobState } from '../../shared/core/jobs'

export interface JobRow {
  id: string
  name: string
  state: JobState
  actingUserId: string
  latestVersion: number
  approvedVersion: number | null
  approvedFingerprint: string | null
  acceptedVersion: number | null
  acceptedConsent: string | null
  pausedReason: JobPauseReason | null
  pausedBy: string | null
  pausedAt: string | null
  createdBy: string
  createdAt: string
  updatedAt: string
}

export interface JobVersionRow {
  jobId: string
  version: number
  schema: number
  /** The canonical JSON of the definition. */
  definition: string
  fingerprint: string
  consentFingerprint: string
  actingUserId: string
  createdBy: string
  createdAt: string
  approvedBy: string | null
  approvedAt: string | null
  acceptedBy: string | null
  acceptedAt: string | null
}

/** An occurrence (回) of a job (`ai_job_occurrences`). */
export interface JobOccurrenceRow {
  id: string
  jobId: string
  /** The approved version when the clock made it: the run is pinned to it. */
  jobVersion: number
  /** Company time, `YYYY-MM-DDTHH:MM`: the occurrence's identity within its job. */
  dueSlot: string
  timeZone: string
  /** UTC ISO instants. */
  dueAt: string
  expiresAt: string
  state: JobOccurrenceState
  runId: string | null
  outcomeCode: string | null
  createdAt: string
  updatedAt: string
}

export interface JobRepository {
  /** Every job of the company, newest first. */
  list(): JobRow[]
  /** The jobs whose newest or approved version names the member as responsible person. */
  listFor(userId: string): JobRow[]
  find(jobId: string): JobRow | null
  /** A job with its first version, in one transaction (the caller's). */
  create(job: JobRow, first: JobVersionRow): void
  /** Append a version (its number = latest + 1, checked by the caller) and move the job's newest version, name and responsible person. */
  addVersion(version: JobVersionRow, at: string): void
  versions(jobId: string): JobVersionRow[]
  version(jobId: string, version: number): JobVersionRow | null
  /** The version approved: the job's pin, and the version's approved_* (set once). */
  approve(jobId: string, version: number, fingerprint: string, by: string, at: string, state: JobState): void
  /** The responsible person accepted this version's consent: the job's accepted_*, and the version's accepted_* (set once). */
  accept(jobId: string, version: number, consentFingerprint: string, by: string, at: string): void
  /** Pause / resume: the state with its reason (null on resume). */
  setState(jobId: string, state: JobState, reason: JobPauseReason | null, by: string | null, at: string): void
  /** 「定期の仕事をすべて止める」. */
  stopped(): boolean
  setStopped(stopped: boolean, by: string, at: string): void

  /** Insert an occurrence unless its (job, slot) is there already (`UNIQUE`): false = it was (nothing written). */
  insertOccurrence(row: JobOccurrenceRow): boolean
  occurrence(occurrenceId: string): JobOccurrenceRow | null
  /** A job's occurrences, newest slot first. */
  occurrences(jobId: string, limit: number): JobOccurrenceRow[]
  /** Occurrences in `due`, oldest due first (every job of the company). */
  dueOccurrences(limit: number): JobOccurrenceRow[]
  /** Occurrences in `running` (a PC's run holds them, B PR 5a), oldest due first (every job of the company). */
  runningOccurrences(limit: number): JobOccurrenceRow[]
  /**
   * Move an occurrence from one of `from` to `to` (compare-and-set): false = it was no longer in
   * `from` (someone else moved it first; nothing written).
   */
  moveOccurrence(occurrenceId: string, from: readonly JobOccurrenceState[], to: JobOccurrenceState, change: { runId?: string | null; outcomeCode: string | null }, at: string): boolean
}
