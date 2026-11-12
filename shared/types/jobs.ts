/**
 * API contract of scheduled jobs (定期の仕事, B PR 3a, `.claude/rules/jobs.md`). Definitions and
 * approval (PR 3a); the occurrences the clock makes (PR 3b). Mounted at /api/companies/:companyId.
 *
 *   GET  /jobs                        owner/admin: every job; anyone else: the jobs they are responsible for
 *   GET  /jobs/:jobId                 the same people; with every version
 *   POST /jobs { definition }         owner/admin → 201
 *   PUT  /jobs/:jobId { definition }  owner/admin: a new version (the approved one stays)
 *   POST /jobs/:jobId/approve { version, fingerprint? }   owner/admin
 *   POST /me/jobs/:jobId/accept { version, fingerprint?, place? } the version's responsible person only (`place`: the
 *                                     deliverable place outside they chose, when the version names one)
 *   POST /jobs/:jobId/pause | resume  owner/admin; the responsible person for their own
 *   PUT  /jobs-stop { stopped }       owner/admin: 「定期の仕事をすべて止める」
 *   GET  /jobs/:jobId/occurrences     the same people as GET /jobs/:jobId: its occurrences (回), newest first (PR 3b)
 *   GET  /me/job-turns                the caller's PC-job occurrences to claim now (PR 5a)
 *   POST /job-run-claims { occurrenceId, deviceId, conversationId, checks, checkedCommit? }   claim one (PR 5a; 503 AI_STOPPED while stopped;
 *                                     409 JOB_CHECK_NOT_SUPPORTED when `checks` — the check kinds the app runs — lacks it, 5a-2)
 *   POST /jobs/:jobId/occurrences/:occurrenceId/retry                       owner/admin: 「もう一度」 (PR 5b)
 *   POST /jobs/:jobId/occurrences/:occurrenceId/operations/:key/reconcile { done }   owner/admin: an outside
 *                                     operation of its run whose result was unknown happened or not (PR 5b)
 */
import type { JobCheck, JobDefinition, JobDeliveryPlace, JobGrant, JobOccurrenceState, JobPauseReason, JobPlacement, JobProcedure, JobRetryBlock, JobState, JobTrigger } from '../core/jobs'
import type { AiRunView } from './ai-runs'

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
  /**
   * The deliverable place outside (jobs.md "A deliverable place outside"), when the approved version (else the
   * newest) names one: its kind (`label`, 「Google Drive のフォルダ」), whether the responsible person chose one when
   * accepting (`chosen`) and whether it is usable now (`usable`: false once a folder pick's 90 days are over — they
   * choose it again with 「受け取る」). `name` / `expiresAt` only for the responsible person themself (the place is
   * their own pick), null for anyone else. null: none. Absent from an older server.
   */
  deliverTo?: { connector: string; kind: string; label: string; chosen: boolean; usable: boolean; name: string | null; expiresAt: string | null } | null
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
  /**
   * 「もう一度」 (PR 5b), answered to owners / admins only (absent for anyone else, and from an older server): `retries`
   * how often it was sent back, `retriedBy` / `retriedAt` the last press; `retry` only on a `needs_person` /
   * `expired` occurrence — whether the button works now, else why not (`JOB_RETRY_BLOCKS`); `unknownOperations` the
   * outside operations of its run whose result nobody confirmed yet (kinds and keys only), to reconcile first.
   */
  retries?: number
  retriedBy?: string | null
  retriedAt?: string | null
  retry?: { allowed: true } | { allowed: false; why: JobRetryBlock }
  unknownOperations?: Array<{ key: string; kind: string }>
}

/** `POST /jobs/:jobId/occurrences/:occurrenceId/retry` (PR 5b): the occurrence back to `due`, with its new deadline. */
export interface JobRetryResult {
  occurrence: JobOccurrenceView
}

/**
 * One occurrence of a PC job (placement `a`) the caller may claim now (`GET /me/job-turns`, B PR 5a): only the
 * approved version's responsible person gets it, and only while the job runs as pinned (active, accepted, not
 * stopped, their rights covering every place it names). What their app needs to run it: the check (and since
 * when a file counts as new — the previous occurrence that ran, else the approval), the pinned procedure and
 * the grant. Its places are theirs to read (else it is not listed).
 */
export interface JobTurnView {
  occurrenceId: string
  jobId: string
  jobVersion: number
  /** The approved version's fingerprint (`sha256:<hex>`). */
  fingerprint: string
  /** The job's name by the usual rule (「定期の仕事」 when the newest version names a place they cannot read). */
  name: string
  dueSlot: string
  dueAt: string
  expiresAt: string
  /** `due`, or `running` when its run may be claimed again (the lease ran out, retried later). */
  state: 'due' | 'running'
  check: JobCheck
  /** ISO instant: a file changed after it is new for `new_files`. */
  checkSince: string
  /**
   * ISO instant where the check stops (B PR 5a-2): the occurrence's own `dueAt` (later things are the next
   * occurrence's), or what its first claim fixed. Absent from a server before 5a-2.
   */
  checkUntil?: string
  /**
   * A `new_files` check in the shared folder (B PR 5a-2): the commit the previous occurrence that ran looked up to
   * (files added after it are new, whatever their commits' dates), and the commit this occurrence's first claim named
   * (a re-claim looks up to the same). null: none known — the dates decide.
   */
  sinceCommit?: string | null
  checkedCommit?: string | null
  procedure: JobProcedure
  grant: JobGrant
  /**
   * The deliverable place outside the responsible person chose (`grant.deliverTo` with its `ref`): the one place
   * the run may put into (the connector's route checks it at every call). Absent: none.
   */
  deliverTo?: JobDeliveryPlace
  /**
   * How often an owner / admin sent this occurrence back with 「もう一度」 (PR 5b; absent: never, or an older server).
   * The app counts its own attempts per occurrence and press, so a press is tried again the same day.
   */
  retries?: number
  /**
   * Only in a claim's answer, for a `new_meetings` check (B PR 5a-2): the meetings it found (≤ 10, oldest
   * first) — the only ones whose minutes the run may read. Empty: the run finishes `nothing`.
   */
  meetings?: JobMeetingView[]
}

/** A meeting a `new_meetings` check found: its record id, its title (outside text: the calendar's) and its time. */
export interface JobMeetingView {
  id: string
  title: string
  at: string
}

/**
 * `POST /job-run-claims { occurrenceId, deviceId, conversationId, checks }` (B PR 5a): the run (`AiRunView`, step
 * `job-procedure`, subject kind `occurrence`) and the turn it runs. Then, as for any run: renew, finish
 * (`{ generation, outcome, failure?, jobResult? }` — `jobResult` `'nothing'` or `{ title, summary? }` on `done`).
 */
export interface JobRunClaim {
  run: AiRunView
  created: boolean
  turn: JobTurnView
}
