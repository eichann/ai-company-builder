/**
 * 「もう一度」 of a scheduled job's occurrence (定期の仕事, B PR 5b, `.claude/rules/jobs.md` "「もう一度」"). Owner decisions
 * 2026-11-12: only an owner / admin presses it, only on an occurrence that ended `needs_person` or `expired`, and only
 * while the job would run it as pinned. The **same occurrence** goes back to `due` with a new deadline, so the
 * server's runner (placement `e`) or the responsible person's app (placement `a`, `GET /me/job-turns` →
 * `POST /job-run-claims`) takes it as any due occurrence; its やること stays `occurrenceTaskId` (one per occurrence).
 *
 * - **Why not now** (`blockOf`, one order for the button's state and the press): its state; a later occurrence of the
 *   job already made (its check covered this window); the company's jobs stopped; the job not active; another version
 *   approved since; the approved consent not accepted; the responsible person's rights now (`runnerRefusal`); for a PC
 *   job the emergency stop covering them (`unattendedRunStopped`, as the claim); a shelf Skill's pinned version gone;
 *   the deliverable place outside not usable; **an outside operation of its run whose result nobody confirmed**
 *   (結果が分からないうちは再開しない: `reconcile` first).
 * - **The press** (`retry`, one transaction, re-checked inside): the occurrence's previous run is closed (`done`, event
 *   `finished` `RETRIED`: its tokens stay fenced, its own 「もう一度」 answers `RUN_DONE`), so the next claim makes a
 *   **new run** whose hard deadline counts from that claim; the occurrence `due` with no run, `expires_at` = now +
 *   the pinned `missed.expiresAfterMinutes` (`jobRetryExpiresAt`), `retries` + 1, `retried_by` / `retried_at`.
 * - **Reconcile** (`reconcile`): an owner / admin says whether one of its run's unknown operations happened — the run
 *   core's reconciliation (`aiRuns.reconcileFor`), recorded with their id (`reconciled_by`).
 * Anyone else: 403 before anything; an occurrence of another job or company, or none: the one 404 `JOB_NOT_FOUND`.
 */
import {
  JOB_PC_STEP, JOB_RETRY_STATES, isJobId, isOccurrenceId, jobRetryExpiresAt,
  type JobDefinition, type JobDeliveryPlace, type JobRetryBlock,
} from '../../shared/core/jobs'
import { jobRetryBlockText } from '../../shared/core/job-words'
import type { AgentStopPolicy } from '../../shared/types/agent-stop'
import type { AiRunView } from '../../shared/types/ai-runs'
import type { JobOccurrenceView } from '../../shared/types/jobs'
import type { AiRunRow } from '../ports/ai-runs'
import type { Clock } from '../ports/clock'
import type { CompanyData, CompanyDataSource } from '../ports/company-data'
import type { JobOccurrenceRow, JobRow, JobVersionRow } from '../ports/jobs'
import type { Transactions } from '../ports/transactions'
import { hasFullAccess, type Member } from './access'
import { unattendedRunStopped } from './ai-runs'
import type { JobService } from './jobs'
import { JOBS_FORBIDDEN, occurrenceView } from './jobs'
import { ok, refuse, type Outcome, type Refusal } from './outcome'

export interface JobRetryDeps {
  companyData: CompanyDataSource
  transactions: Transactions
  clock: Clock
  roleOf: (companyId: string, userId: string) => string | null
  jobs: Pick<JobService, 'runnerRefusal' | 'pinnedSkillKept'>
  /** The emergency stop in force for a member (agent-stops.ts `policyFor`), as a claim reads it. */
  aiStops: (member: Member) => AgentStopPolicy
  /** The responsible person's chosen deliverable place is usable now (its connector answers). Absent → never. */
  placeUsable?: (companyId: string, userId: string, place: JobDeliveryPlace) => boolean
  /** The job's next slot after now (UTC ISO; the clock's zone and days off), or null: the new deadline never passes it. */
  nextSlotAt?: (companyId: string, definition: JobDefinition) => string | null
  /** The run core's reconciliation for a run the caller does not hold (services/ai-runs.ts `reconcileFor`). */
  reconcileFor: (companyId: string, runId: string, key: string, done: boolean, byUserId: string) => Outcome<{ run: AiRunView }>
}

const NOT_FOUND = () => refuse('not-found', '定期の仕事が見つかりません。', { code: 'JOB_NOT_FOUND' })
const BLOCKED = (why: JobRetryBlock) => refuse('conflict', jobRetryBlockText(why), { code: why })

const definitionOf = (v: JobVersionRow): JobDefinition => JSON.parse(v.definition) as JobDefinition

interface Found { handle: CompanyData; job: JobRow; occ: JobOccurrenceRow; version: JobVersionRow | null }

export function createJobRetry(deps: JobRetryDeps) {
  const { companyData, transactions, clock } = deps

  /** The occurrence of this job in the member's company, or null (another job's, another company's, none). */
  function find(member: Member, jobId: unknown, occurrenceId: unknown): Found | null {
    if (!isJobId(jobId) || !isOccurrenceId(occurrenceId)) return null
    const handle = companyData.forCompany(member.companyId)
    const job = handle.jobs.find(jobId)
    const occ = job ? handle.jobs.occurrence(occurrenceId) : null
    if (!job || !occ || occ.jobId !== job.id) return null
    return { handle, job, occ, version: handle.jobs.version(job.id, occ.jobVersion) }
  }

  /** The operations of the occurrence's run whose outside result nobody knows (in flight counts: it may have happened). */
  function unknownOperations(handle: CompanyData, occ: JobOccurrenceRow): Array<{ key: string; kind: string }> {
    if (!occ.runId) return []
    return handle.aiRuns.operations(occ.runId).filter(o => o.state === 'unknown' || o.state === 'in_progress').map(o => ({ key: o.key, kind: o.kind }))
  }

  /** Why 「もう一度」 does not work on this occurrence now, or null (it does). */
  function blockOf(f: Found): JobRetryBlock | null {
    const { handle, job, occ, version } = f
    if (!JOB_RETRY_STATES.includes(occ.state)) return 'NOT_RETRYABLE'
    // A later occurrence already came: its check started where the last one that ran stopped, so it looked at this
    // window too — running this one again would hand the same files or meetings to a second run.
    if (handle.jobs.occurrences(job.id, 1)[0]?.id !== occ.id) return 'NOT_LATEST'
    if (handle.jobs.stopped()) return 'JOB_STOPPED'
    if (job.state !== 'active') return 'JOB_PAUSED'
    if (!version || job.approvedVersion !== occ.jobVersion) return 'JOB_VERSION_CHANGED'
    if (job.acceptedConsent === null || job.acceptedConsent !== version.consentFingerprint) return 'JOB_NOT_ACCEPTED'
    if (deps.jobs.runnerRefusal(handle.companyId, version) !== null) return 'JOB_GRANT_EXCEEDS'
    const definition = definitionOf(version)
    if (definition.placement === 'a') {
      const role = deps.roleOf(handle.companyId, definition.actingUser)
      if (role === null) return 'JOB_GRANT_EXCEEDS'
      if (unattendedRunStopped(deps.aiStops({ companyId: handle.companyId, userId: definition.actingUser, role }))) return 'AI_STOPPED'
    }
    if (!deps.jobs.pinnedSkillKept(handle.companyId, version)) return 'JOB_SKILL_MISSING'
    const wanted = definition.grant.deliverTo
    if (wanted) {
      const chosen = job.acceptedPlace
      const usable = !!chosen && chosen.connector === wanted.connector && chosen.kind === wanted.kind && deps.placeUsable?.(handle.companyId, definition.actingUser, chosen) === true
      if (!usable) return 'JOB_PLACE_NOT_USABLE'
    }
    if (unknownOperations(handle, occ).length > 0) return 'JOB_RESULT_UNKNOWN'
    return null
  }

  /** What an owner / admin's occurrence view adds (`JobOccurrenceView`'s 「もう一度」 fields). */
  function viewOf(companyId: string, occ: JobOccurrenceRow): Pick<JobOccurrenceView, 'retries' | 'retriedBy' | 'retriedAt' | 'retry' | 'unknownOperations'> {
    const base = { retries: occ.retries ?? 0, retriedBy: occ.retriedBy ?? null, retriedAt: occ.retriedAt ?? null }
    if (!JOB_RETRY_STATES.includes(occ.state)) return base
    const handle = companyData.forCompany(companyId)
    const job = handle.jobs.find(occ.jobId)
    if (!job) return base
    const why = blockOf({ handle, job, occ, version: handle.jobs.version(job.id, occ.jobVersion) })
    return { ...base, retry: why === null ? { allowed: true } : { allowed: false, why }, unknownOperations: unknownOperations(handle, occ) }
  }

  /** The previous run closed for good (its tokens fenced, its own 「もう一度」 refused): the next claim makes a new run. */
  function closeRun(handle: CompanyData, run: AiRunRow, at: string): boolean {
    if (run.closedAt !== null) return true
    const closed: AiRunRow = { ...run, state: 'done', deviceId: null, claimExpiresAt: null, retryAt: null, closedAt: at, updatedAt: at }
    if (!handle.aiRuns.update(closed, { generation: run.generation, state: run.state })) return false
    handle.aiRuns.appendEvent({ runId: run.id, event: 'finished', generation: run.generation, stateAfter: 'done', code: 'RETRIED', at })
    return true
  }

  class Refused extends Error {
    constructor(readonly refusal: Refusal) { super('refused'); this.name = 'Refused' }
  }

  return {
    viewOf,

    /** POST /jobs/:jobId/occurrences/:occurrenceId/retry — 「もう一度」. */
    retry(member: Member, jobId: string, occurrenceId: string): Outcome<{ occurrence: JobOccurrenceView }> {
      if (!hasFullAccess(member.role)) return refuse('forbidden', JOBS_FORBIDDEN)
      try {
        return transactions.run((): Outcome<{ occurrence: JobOccurrenceView }> => {
          // Read and checked inside the write's transaction: a clock run or a claim in between cannot slip past it.
          const f = find(member, jobId, occurrenceId)
          if (!f) return NOT_FOUND()
          const why = blockOf(f)
          if (why) return BLOCKED(why)
          const { handle, occ } = f
          const nowMs = clock.nowMs()
          const at = new Date(nowMs).toISOString()
          const run = occ.runId ? handle.aiRuns.byId(occ.runId) : null
          if (run && !closeRun(handle, run, at)) throw new Refused(BLOCKED('NOT_RETRYABLE'))
          const definition = definitionOf(f.version as JobVersionRow)
          const expiresAt = jobRetryExpiresAt(nowMs, definition.missed.expiresAfterMinutes, deps.nextSlotAt?.(handle.companyId, definition) ?? null)
          if (!handle.jobs.retryOccurrence(occ.id, JOB_RETRY_STATES, expiresAt, member.userId, at)) throw new Refused(BLOCKED('NOT_RETRYABLE'))
          const after = handle.jobs.occurrence(occ.id) as JobOccurrenceRow
          return ok({ occurrence: { ...occurrenceView(after), ...viewOf(handle.companyId, after) } })
        })
      } catch (e) {
        if (e instanceof Refused) return e.refusal
        throw e
      }
    },

    /** POST /jobs/:jobId/occurrences/:occurrenceId/operations/:key/reconcile { done } — an owner / admin settles an unknown result. */
    reconcile(member: Member, jobId: string, occurrenceId: string, key: string, body: unknown): Outcome<{ occurrenceId: string }> {
      if (!hasFullAccess(member.role)) return refuse('forbidden', JOBS_FORBIDDEN)
      const f = find(member, jobId, occurrenceId)
      if (!f) return NOT_FOUND()
      const done = typeof body === 'object' && body !== null ? (body as { done?: unknown }).done : undefined
      if (typeof done !== 'boolean') return refuse('bad-request', 'done is true or false')
      // Only an occurrence a person looks at now (a running one's run is still its app's to finish).
      if (!JOB_RETRY_STATES.includes(f.occ.state)) return BLOCKED('NOT_RETRYABLE')
      const run = f.occ.runId ? f.handle.aiRuns.byId(f.occ.runId) : null
      if (!run || run.step !== JOB_PC_STEP || !unknownOperations(f.handle, f.occ).some(o => o.key === key)) {
        return refuse('not-found', '操作が見つかりません', { code: 'OPERATION_NOT_FOUND' })
      }
      // An operation still marked in flight on a run that no longer runs may have happened: unknown, as a finish makes it.
      if (run.state !== 'running') f.handle.aiRuns.updateOperation(run.id, key, ['in_progress'], { state: 'unknown' }, clock.now())
      const settled = deps.reconcileFor(member.companyId, run.id, key, done, member.userId)
      return settled.ok ? ok({ occurrenceId: f.occ.id }) : settled
    },
  }
}

export type JobRetry = ReturnType<typeof createJobRetry>
