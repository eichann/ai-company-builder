/**
 * 「もう一度」 of a scheduled job's occurrence (定期の仕事, B PR 5b, `.claude/rules/jobs.md` "「もう一度」"). Owner decisions
 * 2026-11-12: only an owner / admin presses it, only on an occurrence that ended `needs_person` or `expired`, and only
 * while the job would run it as pinned. The **same occurrence** goes back to `due` with a new deadline, so the
 * server's runner (placement `e`) or the responsible person's app (placement `a`, `GET /me/job-turns` →
 * `POST /job-run-claims`) takes it as any due occurrence; its やること stays `occurrenceTaskId` (one per occurrence).
 *
 * - **Why not now** (`blockOf`, one order for the button's state and the press): its state; pressed `JOB_RETRY_MAX`
 *   times already; a later slot of the job arrived (made or not: its check covers this window); too little time
 *   before the next slot for a whole run (`jobRetryExpiresAt`: claimed by the deadline, a run's approved minutes end
 *   before the next slot); the company's jobs stopped; the job not active; another version approved since; the
 *   approved consent not accepted; the responsible person's rights now (`runnerRefusal`); for a PC job the emergency
 *   stop covering them (`unattendedRunStopped`, as the claim); a shelf Skill's pinned version gone; the deliverable
 *   place outside not usable; **an outside operation of its run whose result nobody confirmed** (結果が分からないうちは
 *   再開しない: `reconcile` first).
 * - **The press** (`retry`, one transaction, re-checked inside): the occurrence's previous run is closed (`done`, event
 *   `finished` `RETRIED`: its tokens stay fenced, its own 「もう一度」 answers `RUN_DONE`), so the next claim makes a
 *   **new run** whose hard deadline counts from that claim; the occurrence `due` with no run and the new deadline,
 *   `retries` + 1, `retried_by` / `retried_at`.
 * - **What earlier runs made** (`previouslyMade`): the outside operations of the occurrence's earlier runs that are
 *   known done (a mail draft, a Drive file) — counted by kind for the owner / admin (their confirmation says it), and
 *   handed to the next run's turn so its AI does not make them again blindly.
 * - **Reconcile** (`reconcile`): an owner / admin says whether one of its run's unknown operations happened — the run
 *   core's reconciliation (`aiRuns.reconcileFor`), recorded with their id (`reconciled_by`), in one transaction.
 * Anyone else: 403 before anything; an occurrence of another job or company, or none: the one 404 `JOB_NOT_FOUND`.
 */
import {
  JOB_PC_STEP, JOB_RETRY_MAX, JOB_RETRY_STATES, isJobId, isOccurrenceId, jobRetryExpiresAt,
  type JobDefinition, type JobDeliveryPlace, type JobRetryBlock,
} from '../../shared/core/jobs'
import { jobRetryBlockText } from '../../shared/core/job-words'
import type { AgentStopPolicy } from '../../shared/types/agent-stop'
import type { AiRunView } from '../../shared/types/ai-runs'
import type { JobMadeBefore, JobOccurrenceView } from '../../shared/types/jobs'
import type { AiRunRow } from '../ports/ai-runs'
import type { Clock } from '../ports/clock'
import type { CompanyData, CompanyDataSource } from '../ports/company-data'
import type { JobOccurrenceRow, JobRow, JobVersionRow } from '../ports/jobs'
import type { Transactions } from '../ports/transactions'
import { hasFullAccess, type Member } from './access'
import { unattendedRunStopped } from './ai-runs'
import { JOBS_FORBIDDEN, occurrenceView, type JobService } from './jobs'
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
  /**
   * The job's slots around now (the clock's zone and days off): `latest` the newest slot at or before now (company time
   * `YYYY-MM-DDTHH:MM`, made or not), `nextAt` the next one (UTC ISO). Absent → neither (no slot rule applies).
   */
  slotsOf?: (companyId: string, definition: JobDefinition) => { latest: string | null; nextAt: string | null }
  /** The run core's reconciliation for a run the caller does not hold (services/ai-runs.ts `reconcileFor`). */
  reconcileFor: (companyId: string, runId: string, key: string, done: boolean, byUserId: string) => Outcome<{ run: AiRunView }>
}

const NOT_FOUND = () => refuse('not-found', '定期の仕事が見つかりません。', { code: 'JOB_NOT_FOUND' })
const BLOCKED = (why: JobRetryBlock) => refuse('conflict', jobRetryBlockText(why), { code: why })

const definitionOf = (v: JobVersionRow): JobDefinition => JSON.parse(v.definition) as JobDefinition

interface Found { handle: CompanyData; job: JobRow; occ: JobOccurrenceRow; version: JobVersionRow | null }

class Refused extends Error {
  constructor(readonly refusal: Refusal) { super('refused'); this.name = 'Refused' }
}

/**
 * The outside operations the occurrence's earlier runs are known to have done (state `done`: answered, or reconciled
 * as done), oldest first — kinds and what they made (`ref`), never a body. A run's own `create_task` is the one
 * やること's, not something to avoid. Shared with the claim's turn (services/job-runs.ts).
 */
export function madeBefore(handle: CompanyData, occurrenceId: string): JobMadeBefore[] {
  const made: JobMadeBefore[] = []
  const seen = new Set<string>()
  for (const run of handle.aiRuns.runsOf({ kind: 'occurrence', id: occurrenceId })) {
    for (const o of handle.aiRuns.operations(run.id)) {
      if (o.state !== 'done' || o.kind === 'record-create') continue
      // A draft's later versions are the same draft: one thing made.
      const id = o.refKind && o.refId ? `${o.refKind}:${o.refId}` : `${run.id}:${o.key}`
      if (seen.has(id)) continue
      seen.add(id)
      made.push({ kind: o.kind, ref: o.refKind && o.refId ? { kind: o.refKind, id: o.refId } : null })
    }
  }
  return made
}

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

  /** The new deadline a press would give now, or null when too little time is left before the next slot. */
  function newDeadline(f: Found, definition: JobDefinition, nowMs: number): string | null {
    const nextAt = deps.slotsOf?.(f.handle.companyId, definition).nextAt ?? null
    return jobRetryExpiresAt(nowMs, definition.missed.expiresAfterMinutes, definition.grant.limits.minutes, nextAt)
  }

  /** Why 「もう一度」 does not work on this occurrence now, or null (it does). */
  function blockOf(f: Found, nowMs: number): JobRetryBlock | null {
    const { handle, job, occ, version } = f
    if (!JOB_RETRY_STATES.includes(occ.state)) return 'NOT_RETRYABLE'
    if ((occ.retries ?? 0) >= JOB_RETRY_MAX) return 'RETRY_LIMIT'
    // A later occurrence already came: its check started where the last one that ran stopped, so it looked at this
    // window too — running this one again would hand the same files or meetings to a second run.
    if (handle.jobs.occurrences(job.id, 1)[0]?.id !== occ.id) return 'NOT_LATEST'
    if (!version || job.approvedVersion !== occ.jobVersion) return 'JOB_VERSION_CHANGED'
    const definition = definitionOf(version)
    // A later slot has arrived even when the clock has not made its occurrence yet (it will, within minutes).
    const latest = deps.slotsOf?.(handle.companyId, definition).latest ?? null
    if (latest !== null && latest > occ.dueSlot) return 'NOT_LATEST'
    if (newDeadline(f, definition, nowMs) === null) return 'NEXT_SLOT_SOON'
    if (handle.jobs.stopped()) return 'JOB_STOPPED'
    if (job.state !== 'active') return 'JOB_PAUSED'
    if (job.acceptedConsent === null || job.acceptedConsent !== version.consentFingerprint) return 'JOB_NOT_ACCEPTED'
    if (deps.jobs.runnerRefusal(handle.companyId, version) !== null) return 'JOB_GRANT_EXCEEDS'
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
  function viewOf(companyId: string, occ: JobOccurrenceRow): Pick<JobOccurrenceView, 'retries' | 'retriedBy' | 'retriedAt' | 'retry' | 'unknownOperations' | 'madeBefore'> {
    const base = { retries: occ.retries ?? 0, retriedBy: occ.retriedBy ?? null, retriedAt: occ.retriedAt ?? null }
    if (!JOB_RETRY_STATES.includes(occ.state)) return base
    const handle = companyData.forCompany(companyId)
    const job = handle.jobs.find(occ.jobId)
    if (!job) return base
    const why = blockOf({ handle, job, occ, version: handle.jobs.version(job.id, occ.jobVersion) }, clock.nowMs())
    // Kinds and how many only: what was made is the responsible person's own (an owner-only draft, a file in their
    // picked folder) — no id, title or place reaches the owner / admin.
    const counts = new Map<string, number>()
    for (const m of madeBefore(handle, occ.id)) counts.set(m.kind, (counts.get(m.kind) ?? 0) + 1)
    return {
      ...base, retry: why === null ? { allowed: true } : { allowed: false, why }, unknownOperations: unknownOperations(handle, occ),
      madeBefore: [...counts].map(([kind, count]) => ({ kind, count })),
    }
  }

  /** The previous run closed for good (its tokens fenced, its own 「もう一度」 refused): the next claim makes a new run. */
  function closeRun(handle: CompanyData, run: AiRunRow, at: string): boolean {
    if (run.closedAt !== null) return true
    const closed: AiRunRow = { ...run, state: 'done', deviceId: null, claimExpiresAt: null, retryAt: null, closedAt: at, updatedAt: at }
    if (!handle.aiRuns.update(closed, { generation: run.generation, state: run.state })) return false
    handle.aiRuns.appendEvent({ runId: run.id, event: 'finished', generation: run.generation, stateAfter: 'done', code: 'RETRIED', at })
    return true
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
          const nowMs = clock.nowMs()
          const why = blockOf(f, nowMs)
          if (why) return BLOCKED(why)
          const { handle, occ } = f
          const at = new Date(nowMs).toISOString()
          const expiresAt = newDeadline(f, definitionOf(f.version as JobVersionRow), nowMs) as string
          const run = occ.runId ? handle.aiRuns.byId(occ.runId) : null
          if (run && !closeRun(handle, run, at)) throw new Refused(BLOCKED('NOT_RETRYABLE'))
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
      try {
        return transactions.run((): Outcome<{ occurrenceId: string }> => {
          // An operation still marked in flight on a run that no longer runs may have happened: unknown, as a finish
          // makes it — together with the answer, or not at all.
          if (run.state !== 'running') f.handle.aiRuns.updateOperation(run.id, key, ['in_progress'], { state: 'unknown' }, clock.now())
          const settled = deps.reconcileFor(member.companyId, run.id, key, done, member.userId)
          if (!settled.ok) throw new Refused(settled)
          return ok({ occurrenceId: f.occ.id })
        })
      } catch (e) {
        if (e instanceof Refused) return e.refusal
        throw e
      }
    },
  }
}

export type JobRetry = ReturnType<typeof createJobRetry>
