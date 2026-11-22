/**
 * API contract of member proposals (「AIへの相談」から定期の仕事, `.claude/rules/jobs.md` "Member proposals").
 *
 *   The member's AI (record token on /api/records-ai; refused for a token bound to any execution run):
 *   GET  /api/records-ai/job-proposals-ai/places?under=<path>   the existing folders under `under` the member reads (and whether they write)
 *   POST /api/records-ai/job-proposals-ai/candidates { skill, trigger, check, reads, deliverable, readRecords, mailDrafts, minutes, missed }
 *                                                                → 201 JobCandidateView
 *
 *   The member's own session (/api/companies/:companyId; never a record token):
 *   GET  /me/job-candidates/:candidateId            the caller's candidate (and its proposal once submitted)
 *   POST /me/job-candidates/:candidateId/submit { fingerprint }   → 201 (200 when submitted already) JobProposalView
 *   GET  /me/job-proposals                          the caller's proposals, newest first
 *   POST /me/job-proposals/:proposalId/withdraw     the proposer, only while submitted
 *
 *   Owners / admins:
 *   GET  /job-proposals?state=submitted             the company's proposals, newest first
 *   POST /job-proposals/:proposalId/return { reason }   a fixed reason code, only while submitted
 */
import type { JobDefinition } from '../core/jobs'
import type { JobProposalReturnReason, JobProposalState } from '../core/job-proposals'

export interface JobCandidateView {
  id: string
  /** The schema-4 definition the server built and pinned: what the card shows and the submit sends on. */
  definition: JobDefinition
  /** `sha256:<hex>` of it: the submit names it. */
  fingerprint: string
  createdAt: string
  expiresAt: string
  /** Once submitted: its proposal. */
  proposal: JobProposalView | null
}

export interface JobProposalView {
  id: string
  jobId: string
  proposerId: string
  candidateId: string
  submittedVersion: number
  submittedFingerprint: string
  state: JobProposalState
  returnReason: JobProposalReturnReason | null
  decidedBy: string | null
  decidedAt: string | null
  createdAt: string
}

export interface JobCandidatePlaces {
  under: string
  folders: Array<{ path: string; write: boolean }>
}
