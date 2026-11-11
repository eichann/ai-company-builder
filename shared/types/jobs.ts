/**
 * API contract of scheduled jobs (定期の仕事, B PR 3a, `.claude/rules/jobs.md`). Definitions and
 * approval (PR 3a); the occurrences the clock makes (PR 3b). Mounted at /api/companies/:companyId.
 *
 *   GET  /jobs                        owner/admin: every job; anyone else: the jobs they are responsible for
 *   GET  /jobs/:jobId                 the same people; with every version
 *   POST /jobs { definition }         owner/admin → 201
 *   PUT  /jobs/:jobId { definition }  owner/admin: a new version (the approved one stays)
 *   POST /jobs/:jobId/approve { version, fingerprint? }   owner/admin
 *   POST /me/jobs/:jobId/accept { version, fingerprint? } the version's responsible person only
 *   POST /jobs/:jobId/pause | resume  owner/admin; the responsible person for their own
 *   PUT  /jobs-stop { stopped }       owner/admin: 「定期の仕事をすべて止める」
 *   GET  /jobs/:jobId/occurrences     the same people as GET /jobs/:jobId: its occurrences (回), newest first (PR 3b)
 */
import type { JobDefinition, JobOccurrenceState, JobPauseReason, JobPlacement, JobState, JobTrigger } from '../core/jobs'

export type { JobState } from '../core/jobs'

/** Why a job would not run now (first that applies), or null when it would. */
export type JobWaiting = 'NOT_APPROVED' | 'NOT_ACCEPTED' | 'PAUSED' | 'COMPANY_STOPPED' | null

export interface JobVersionView {
  version: number
  /** `sha256:<hex>` of the canonical definition; null whenever `definition` is hidden. */
  fingerprint: string | null
  /** `sha256:<hex>` of what the responsible person accepts (`jobConsentCanonical`); null whenever `definition` is hidden. */
  consentFingerprint: string | null
  /** null for a viewer who is not owner/admin when a place it names is not one they read now. */
  definition: JobDefinition | null
  createdBy: string
  createdAt: string
  approvedBy: string | null
  approvedAt: string | null
  acceptedBy: string | null
  acceptedAt: string | null
}

export interface JobView {
  id: string
  /** The newest version's name; 「定期の仕事」 for a responsible person who cannot read every place it names. */
  name: string
  state: JobState
  /** The responsible person of the newest version. */
  actingUserId: string
  latestVersion: number
  approvedVersion: number | null
  /** Whether the approved version's consent is the one the responsible person accepted. */
  accepted: boolean
  pausedReason: JobPauseReason | null
  waiting: JobWaiting
  createdBy: string
  createdAt: string
  updatedAt: string
  /**
   * When it runs (PR 4, for the screens): the approved version's trigger, else the newest version's. A
   * trigger names no place, so it is answered whenever the job is (also with `definition` hidden).
   * Absent from a server before PR 4.
   */
  trigger?: JobTrigger
  /** Where the version `trigger` is from runs (`e` the server, `a` the responsible person's PC). Absent before PR 4. */
  placement?: JobPlacement
  /**
   * The next slot (company time `YYYY-MM-DDTHH:MM`) of the approved version's trigger, or null (nothing
   * approved, retired, or none in the next 70 days). Paused or stopped jobs still answer it: the screen
   * says that it would not run. Absent before PR 4.
   */
  nextSlot?: string | null
  /** The newest occurrence (slot, state, code only), or null. Absent before PR 4. */
  lastOccurrence?: { dueSlot: string; state: JobOccurrenceState; outcomeCode: string | null } | null
  /**
   * The approved version (PR 4): its responsible person and its name — 「定期の仕事」 for a non-admin who cannot
   * read every place that version names. null: none approved. Absent before PR 4.
   */
  approved?: { responsibleUserId: string; name: string } | null
  /** The newest version's consent is the accepted one: approving it runs without a new acceptance. Absent before PR 4. */
  latestConsentAccepted?: boolean
  /**
   * The caller, by the API's own rules (absent before PR 4): `named` — the newest or approved version names
   * them (they see it); `controls` — they may pause it (the approved version's responsible person);
   * `mustAccept` — the approved version names them and its consent is not accepted yet.
   */
  you?: { named: boolean; controls: boolean; mustAccept: boolean }
  /** Present on GET /jobs/:jobId (newest first). */
  versions?: JobVersionView[]
}

export interface JobList {
  /** 「定期の仕事をすべて止める」 is on. */
  stopped: boolean
  /** Owner/admin may create, edit, approve and stop. */
  canManage: boolean
  jobs: JobView[]
}

/** One occurrence (回) of a job (`GET /jobs/:jobId/occurrences`): slots, states and codes only. */
export interface JobOccurrenceView {
  id: string
  /** The approved version it was made for (its run is pinned to it). */
  jobVersion: number
  /** Company time, `YYYY-MM-DDTHH:MM`. */
  dueSlot: string
  timeZone: string
  dueAt: string
  expiresAt: string
  state: JobOccurrenceState
  /** Why it ended as it did (`JOB_OUTCOME_CODES`), or null. */
  outcomeCode: string | null
  /** Whether a run did its work (state `done`). */
  ran: boolean
  updatedAt: string
}
