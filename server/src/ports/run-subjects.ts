/**
 * The subject of an execution run (「実行の対象」, B — separating AI runs from records, PR 1):
 * what a run of 「AI の番」 works on, and whether the member may claim it now. The run service
 * (services/ai-runs.ts) asks only this; it never asks the records or the business plugins' steps
 * itself. A record's run is resolved by services/run-subjects.ts (a core step by
 * `records.aiTurnOf`, a business plugin's step `<pluginId>__<step>` by `pluginSteps.turnOf` and
 * its pin), wired in src/composition.ts; that resolver refuses any other kind (PR 2). The run's kind is stored
 * with it (`ai_runs.subject_kind`, adapters/sqlite/ai-runs.ts). A job's occurrence (B PR 5a) is another resolver
 * (services/job-runs.ts, joined by `runSubjectsByKind`)
 * behind the same port; the run's fencing, idempotency keys, failure places and the emergency
 * stop do not look at the kind (.claude/rules/ai-turns.md "Execution runs on the server").
 */
import type { AiRunSubjectKind } from '../../shared/core/ai-runs'
import type { PluginStepProcedurePin } from '../../shared/core/plugins'

/**
 * The kinds of subject a run can have (`AI_RUN_SUBJECT_KINDS`): `record` — what
 * `POST /ai-run-claims` claims — and `occurrence`, a job's occurrence (since B PR 3b the server's own run of a
 * placement-e job, written by services/job-occurrences.ts, never claimed: jobs.md "The runner"; since B PR 5a also a PC
 * job's run, claimed by its responsible person's app: jobs.md "The PC's claim"). Whatever belongs to
 * records (the record's 「AI の番」, record tokens, the built-in steps' route scope, the minutes'
 * read-back) is reached only by a subject whose kind is `record`.
 */
export type RunSubjectKind = AiRunSubjectKind

export interface RunSubject {
  readonly kind: RunSubjectKind
  readonly id: string
}

/** The member a run is claimed for (services/access.ts `Member`). */
export interface RunSubjectMember {
  companyId: string
  userId: string
  role: string
}

/** What a claim may start from: the procedure it is pinned to (a business plugin step's; null for a core step). */
export interface RunSubjectResolution {
  pin: PluginStepProcedurePin | null
  /** A job's occurrence (B PR 5a): the job version the run is pinned to, kept in the run's procedure. */
  job?: { id: string; version: number; fingerprint: string }
}

/** A run as the subject's in-transaction hooks see it (B PR 5a). */
export interface RunSubjectLiveRun {
  id: string
  subject: RunSubject
  step: string
  userId: string
  /** The run's state after the change the hook is part of. */
  state: string
}

/** A finished run, as the subject's resolver is told of it. */
export interface RunSubjectRun {
  id: string
  subject: RunSubject
  step: string
  createdAt: string
}

export type RunSubjectAnswer<Refused> = { ok: true; value: RunSubjectResolution } | Refused

/**
 * `Refused` is the service layer's refusal (services/outcome.ts `Refusal`): the API's answer,
 * passed through by the run service unchanged.
 */
export interface RunSubjects<Refused> {
  /**
   * Whether `step` of the subject is the member's 「AI の番」 now, and what its run is pinned to
   * (pinned now when it is the work's first run). Refused with the API's answer otherwise (not
   * found, not the AI's turn, records off, the procedure stopped…). Called only after the
   * emergency stop allowed the claim, before the run is made. Answered synchronously when nothing
   * has to be awaited (a core step), so the caller's check and its write stay in one synchronous
   * stretch (.claude/rules/server.md "Repository ports are synchronous").
   */
  resolve(member: RunSubjectMember, subject: RunSubject, step: string): RunSubjectAnswer<Refused> | Promise<RunSubjectAnswer<Refused>>
  /** A run finished as done (a business plugin step answers what asked for it). Errors are the caller's to swallow. */
  afterDone(member: RunSubjectMember, run: RunSubjectRun): void
  /** A run finished as failed (its step may put the subject back to 「AI の番」). Errors are the caller's to swallow. */
  afterFailed(member: RunSubjectMember, run: RunSubjectRun): void
  /**
   * In the claim's transaction, after the run was written (a new run or a re-claim): the subject takes
   * the run (a job's occurrence becomes `running` with it). A refusal rolls the whole claim back. Absent:
   * nothing to take (records).
   */
  claimed?(member: RunSubjectMember, run: RunSubjectLiveRun): Refused | null
  /**
   * In the finish's transaction, after the run's next state was written: what the subject does with it
   * (a job's occurrence ends `done` / `nothing` with its one やること, or `needs_person`). `body` is the
   * finish's request. A refusal rolls the finish back. Absent: nothing (records: `afterDone` / `afterFailed`).
   */
  finishing?(member: RunSubjectMember, run: RunSubjectLiveRun, body: Record<string, unknown>): Refused | null
  /**
   * Whether a run-bound record token of this subject's run may use this AI route now (the grant at every
   * call, B PR 5a); null = yes. Asked for every run whose kind is not `record` (a record run's built-in
   * steps have their own table); absent → every route refused.
   */
  routeRefusal?(member: RunSubjectMember, run: RunSubjectLiveRun, route: string): Refused | null
  /** Whether a record token may be bound to this run at all (B PR 5a: a PC job's run); absent → only a record's run. */
  bindsTokens?(run: RunSubjectLiveRun): boolean
}
