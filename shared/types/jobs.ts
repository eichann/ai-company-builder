/**
 * API contract of scheduled jobs (定期の仕事, B PR 3a, `.claude/rules/jobs.md`). Definitions and
 * approval only: nothing runs yet. Mounted at /api/companies/:companyId.
 *
 *   GET  /jobs                        owner/admin: every job; anyone else: the jobs they are responsible for
 *   GET  /jobs/:jobId                 the same people; with every version
 *   POST /jobs { definition }         owner/admin → 201
 *   PUT  /jobs/:jobId { definition }  owner/admin: a new version (the approved one stays)
 *   POST /jobs/:jobId/approve { version, fingerprint? }   owner/admin
 *   POST /me/jobs/:jobId/accept { version, fingerprint? } the version's responsible person only
 *   POST /jobs/:jobId/pause | resume  owner/admin; the responsible person for their own
 *   PUT  /jobs-stop { stopped }       owner/admin: 「定期の仕事をすべて止める」
 */
import type { JobDefinition, JobPauseReason, JobState } from '../core/jobs'

export type { JobState } from '../core/jobs'

/** Why a job would not run now (first that applies), or null when it would. */
export type JobWaiting = 'NOT_APPROVED' | 'NOT_ACCEPTED' | 'PAUSED' | 'COMPANY_STOPPED' | null

export interface JobVersionView {
  version: number
  /** `sha256:<hex>` of the canonical definition. */
  fingerprint: string
  /** `sha256:<hex>` of what the responsible person accepts (`jobConsentCanonical`). */
  consentFingerprint: string
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
