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
 * - **Who** (stage 4b-1, owner memo 「段4b 設計メモ」 §4-3 / D11, Codex review 4 #2 / #3): an owner / admin who sees the
 *   occurrence (an event one only while they read its record); and, for an event occurrence run by the PC (schema 3),
 *   **the pinned version's responsible person** while they read its record — they may reconcile what their own run
 *   sent and ask for 「もう一度」 — and **the job's current responsible person** may ask for 「もう一度」 (`rightsOf`). Being
 *   allowed to ask is not being able to run: an occurrence stays pinned to its version and that version's responsible
 *   person, so after another version was approved (a hand-over included) the press answers `JOB_VERSION_CHANGED` and
 *   never moves whose rights run it. The pinned person finds their occurrences, also after a hand-over, through
 *   `GET /me/job-occurrences` (`mine`), which shows no version of the job but the one they ran.
 * Anyone else (a member with no such right, whatever the ids): 403 `JOBS_FORBIDDEN`; for an owner / admin an occurrence
 * of another job or company, or none, or one they may not see: the one 404 `JOB_NOT_FOUND`.
 */
import {
  JOB_PC_STEP, JOB_RECONCILE_STATES, JOB_RETRY_MAX, JOB_RETRY_STATES, isJobId, isOccurrenceId, jobRetryExpiresAt, storedJobDefinition,
  type JobDefinition, type JobDeliveryPlace, type JobRetryBlock,
} from '../../shared/core/jobs'
import { jobRetryBlockText } from '../../shared/core/job-words'
import type { AgentStopPolicy } from '../../shared/types/agent-stop'
import type { AiRunView } from '../../shared/types/ai-runs'
import type { JobMadeBefore, JobOccurrenceView, MyJobOccurrenceView } from '../../shared/types/jobs'
import type { AiRunRow } from '../ports/ai-runs'
import type { Clock } from '../ports/clock'
import type { CompanyData, CompanyDataSource } from '../ports/company-data'
import type { JobOccurrenceRow, JobRow, JobVersionRow } from '../ports/jobs'
import type { Transactions } from '../ports/transactions'
import { hasFullAccess, type Member } from './access'
import { unattendedRunStopped } from './ai-runs'
import { EVENT_RECORDS_CHECKED, JOBS_FORBIDDEN, OCCURRENCES_LISTED, occurrenceView, type JobService } from './jobs'
import { eventShown } from './job-events'
import { recordReader } from './record-access'
import { ok, refuse, type Outcome, type Refusal } from './outcome'

export interface JobRetryDeps {
  companyData: CompanyDataSource
  transactions: Transactions
  clock: Clock
  roleOf: (companyId: string, userId: string) => string | null
  jobs: Pick<JobService, 'runnerRefusal' | 'pinnedSkillKept' | 'occurrenceShown' | 'pinnedNameOf'>
  /** The emergency stop in force for a member (agent-stops.ts `policyFor`), as a claim reads it. */
  aiStops: (member: Member) => AgentStopPolicy
  /** The responsible person's chosen deliverable place is usable now (its connector answers). Absent → never. */
  placeUsable?: (companyId: string, userId: string, place: JobDeliveryPlace) => boolean
  /**
   * The job's slots around now (the clock's zone and days off): `latest` the newest slot at or before now (company time
   * `YYYY-MM-DDTHH:MM`, made or not), `nextAt` the next one (UTC ISO). Absent → neither (no slot rule applies).
   */
  slotsOf?: (companyId: string, definition: JobDefinition) => { latest: string | null; nextAt: string | null }
  /**
   * An event occurrence run by the PC (stage 4b-1): its conditions now (services/job-occurrences.ts `eventCondition`), bound
   * late. Absent → such an occurrence is never sent back (fails closed).
   */
  eventCondition?: (handle: CompanyData, occ: JobOccurrenceRow, absentToo: boolean) => string | null
  /** The run core's reconciliation for a run the caller does not hold (services/ai-runs.ts `reconcileFor`). */
  reconcileFor: (companyId: string, runId: string, key: string, done: boolean, byUserId: string) => Outcome<{ run: AiRunView }>
}

const NOT_FOUND = () => refuse('not-found', '定期の仕事が見つかりません。', { code: 'JOB_NOT_FOUND' })
const FORBIDDEN = () => refuse('forbidden', JOBS_FORBIDDEN)
/** What a member may do with an occurrence (D11): nothing, ask for 「もう一度」, say what its run's outside operation did. */
interface Rights { retry: boolean; reconcile: boolean }
const NO_RIGHTS: Rights = { retry: false, reconcile: false }

/** An event occurrence run by the PC (schema 3, stage 4b-1): the only kind whose responsible person presses here. */
const eventPc = (occ: JobOccurrenceRow, definition: JobDefinition | null): boolean =>
  !!occ.eventRecordId && definition !== null && definition.placement === 'a' && definition.check.kind === 'source_record'
const BLOCKED = (why: JobRetryBlock) => refuse('conflict', jobRetryBlockText(why), { code: why })

/** The stored definition, or null for a shape this build does not know (jobs.md "Shapes this build does not know"): never run. */
const definitionOf = (v: JobVersionRow): JobDefinition | null => storedJobDefinition(v)

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
    // An event occurrence of a record the member cannot read does not exist for them (stage 4a, ⑥): the same 404.
    if (!deps.jobs.occurrenceShown(member, occ)) return null
    return { handle, job, occ, version: handle.jobs.version(job.id, occ.jobVersion) }
  }

  /**
   * What the member may do with this occurrence they see (`find`: an event one only while they read its record): an owner
   * / admin everything; for an event occurrence run by the PC, its pinned version's responsible person may reconcile and
   * ask for 「もう一度」, the job's current responsible person may ask for 「もう一度」 (whether it runs is `blockOf`'s:
   * pinned to its version, so another approved version answers `JOB_VERSION_CHANGED`). Anyone else nothing.
   */
  function rightsOf(member: Member, f: Found): Rights {
    if (hasFullAccess(member.role)) return { retry: true, reconcile: true }
    const definition = f.version ? definitionOf(f.version) : null
    if (!f.version || !eventPc(f.occ, definition)) return NO_RIGHTS
    const pinned = f.version.actingUserId === member.userId
    const approved = f.job.approvedVersion === null ? null : f.handle.jobs.version(f.job.id, f.job.approvedVersion)
    const current = approved?.actingUserId === member.userId
    return { retry: pinned || current, reconcile: pinned }
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
    // window too — running this one again would hand the same files or meetings to a second run. An event occurrence
    // (stage 4a) stands alone: no window, no later slot.
    const event = occ.eventSeq !== null && occ.eventSeq !== undefined
    // The newest time occurrence only (`occurrencesOf` with no records): an event occurrence — maybe of a record this
    // viewer cannot read — never decides the answer (review of #700).
    if (!event && handle.jobs.occurrencesOf(job.id, [], 1)[0]?.id !== occ.id) return 'NOT_LATEST'
    if (!version || job.approvedVersion !== occ.jobVersion) return 'JOB_VERSION_CHANGED'
    const definition = definitionOf(version)
    // A shape this build does not know: never sent back here (nothing could check or run it).
    if (definition === null) return 'JOB_SCHEMA_UNKNOWN'
    // A later slot has arrived even when the clock has not made its occurrence yet (it will, within minutes).
    const latest = deps.slotsOf?.(handle.companyId, definition).latest ?? null
    if (!event && latest !== null && latest > occ.dueSlot) return 'NOT_LATEST'
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
    // An event occurrence run by the PC (stage 4b-1, owner memo §4-2): the conditions that must hold all along — the
    // source record still asking for it, records on — checked now; its deadline is the press's own (not checked here).
    // Refused, nothing changes (the state, the deadline and the count stay).
    if (eventPc(occ, definition)) {
      const code = deps.eventCondition ? deps.eventCondition(handle, occ, false) : 'SOURCE_CHANGED'
      if (code === 'RECORDS_OFF') return 'RECORDS_OFF'
      if (code === 'OWNER_LEFT' || code === 'OWNER_RIGHTS_CHANGED') return 'JOB_GRANT_EXCEEDS'
      if (code !== null) return 'SOURCE_CHANGED'
    }
    return null
  }

  type RetryFields = Pick<JobOccurrenceView, 'retries' | 'retriedBy' | 'retriedAt' | 'retry' | 'unknownOperations' | 'madeBefore'>

  /**
   * What an occurrence view adds for this member (`JobOccurrenceView`'s 「もう一度」 fields): only what their rights cover
   * (`rightsOf`) — none for someone who may do nothing (a responsible person of a time job, as before).
   */
  function viewFor(member: Member, occ: JobOccurrenceRow): Partial<RetryFields> {
    const handle = companyData.forCompany(member.companyId)
    const job = handle.jobs.find(occ.jobId)
    if (!job) return {}
    const rights = rightsOf(member, { handle, job, occ, version: handle.jobs.version(job.id, occ.jobVersion) })
    if (!rights.retry && !rights.reconcile) return {}
    const all = viewOf(member.companyId, occ)
    // Someone who may reconcile but not ask for 「もう一度」 sees what is unknown, not the button's answer.
    return rights.retry ? all : { retries: all.retries, retriedBy: all.retriedBy, retriedAt: all.retriedAt, ...(all.unknownOperations ? { unknownOperations: all.unknownOperations } : {}) }
  }

  /** The 「もう一度」 fields of an occurrence (`viewFor` decides who gets them). */
  function viewOf(companyId: string, occ: JobOccurrenceRow): RetryFields {
    const base = { retries: occ.retries ?? 0, retriedBy: occ.retriedBy ?? null, retriedAt: occ.retriedAt ?? null }
    if (!JOB_RECONCILE_STATES.includes(occ.state)) return base
    const handle = companyData.forCompany(companyId)
    // Held (stage 4b-0.5): never sent back, but what its ended run left unknown is offered for reconciling.
    if (!JOB_RETRY_STATES.includes(occ.state)) return { ...base, unknownOperations: unknownOperations(handle, occ) }
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
    viewFor,

    /**
     * `GET /me/job-occurrences` (stage 4b-1, D11, Codex review 4 #3): the event occurrences run by the PC whose pinned
     * version names the member as responsible person — also after the job was handed to someone else — that they read
     * now (⑥: checked in one batch, left out in SQL before the limit), newest first, ≤ 100, with what they may do
     * (`viewFor`). Each names its job (an id) and the name of the version they ran (`HIDDEN_JOB_NAME` when it names a
     * place they cannot read now): never the job's newer versions.
     */
    mine(member: Member): Outcome<{ occurrences: MyJobOccurrenceView[] }> {
      const handle = companyData.forCompany(member.companyId)
      const reader = recordReader(member, handle.scopes.listWithRules())
      const records = handle.jobs.eventRecordsPinnedTo(member.userId, EVENT_RECORDS_CHECKED)
      const readable = records.length === 0 ? [] : handle.records.byIds(records).filter(r => r.removedAt === null && reader.record(r)).map(r => r.id)
      const out: MyJobOccurrenceView[] = []
      for (const occ of handle.jobs.occurrencesPinnedTo(member.userId, readable, OCCURRENCES_LISTED)) {
        const version = handle.jobs.version(occ.jobId, occ.jobVersion)
        if (!version || !eventPc(occ, definitionOf(version)) || !eventShown(handle, member, occ)) continue
        out.push({ ...occurrenceView(occ), jobId: occ.jobId, name: deps.jobs.pinnedNameOf(member, version), ...viewFor(member, occ) })
      }
      return ok({ occurrences: out })
    },

    /** POST /jobs/:jobId/occurrences/:occurrenceId/retry — 「もう一度」. */
    retry(member: Member, jobId: string, occurrenceId: string): Outcome<{ occurrence: JobOccurrenceView }> {
      const full = hasFullAccess(member.role)
      try {
        return transactions.run((): Outcome<{ occurrence: JobOccurrenceView }> => {
          // Read and checked inside the write's transaction: a clock run or a claim in between cannot slip past it.
          const f = find(member, jobId, occurrenceId)
          // A member with no right here gets one answer whatever the ids (D11): nothing tells which occurrence exists.
          if (!f) return full ? NOT_FOUND() : FORBIDDEN()
          if (!rightsOf(member, f).retry) return FORBIDDEN()
          const nowMs = clock.nowMs()
          const why = blockOf(f, nowMs)
          if (why) return BLOCKED(why)
          const { handle, occ } = f
          const at = new Date(nowMs).toISOString()
          const expiresAt = newDeadline(f, definitionOf(f.version as JobVersionRow) as JobDefinition, nowMs) as string
          const run = occ.runId ? handle.aiRuns.byId(occ.runId) : null
          if (run && !closeRun(handle, run, at)) throw new Refused(BLOCKED('NOT_RETRYABLE'))
          if (!handle.jobs.retryOccurrence(occ.id, JOB_RETRY_STATES, expiresAt, member.userId, at)) throw new Refused(BLOCKED('NOT_RETRYABLE'))
          const after = handle.jobs.occurrence(occ.id) as JobOccurrenceRow
          return ok({ occurrence: { ...occurrenceView(after), ...viewFor(member, after) } })
        })
      } catch (e) {
        if (e instanceof Refused) return e.refusal
        throw e
      }
    },

    /** POST /jobs/:jobId/occurrences/:occurrenceId/operations/:key/reconcile { done } — an owner / admin settles an unknown result. */
    reconcile(member: Member, jobId: string, occurrenceId: string, key: string, body: unknown): Outcome<{ occurrenceId: string }> {
      const f = find(member, jobId, occurrenceId)
      if (!f) return hasFullAccess(member.role) ? NOT_FOUND() : FORBIDDEN()
      // Only someone who may say what happened (D11): an owner / admin, or the pinned version's responsible person.
      if (!rightsOf(member, f).reconcile) return FORBIDDEN()
      const done = typeof body === 'object' && body !== null ? (body as { done?: unknown }).done : undefined
      if (typeof done !== 'boolean') return refuse('bad-request', 'done is true or false')
      // Only an occurrence a person looks at now (a running one's run is still its app's to finish) — or one held while
      // its run had something in flight (stage 4b-0.5): reconciling it resumes nothing (ai-runs.ts `reconcileRun`).
      if (!JOB_RECONCILE_STATES.includes(f.occ.state)) return BLOCKED('NOT_RETRYABLE')
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
