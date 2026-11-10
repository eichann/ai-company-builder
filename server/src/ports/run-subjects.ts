/**
 * The subject of an execution run (「実行の対象」, B — separating AI runs from records, PR 1):
 * what a run of 「AI の番」 works on, and whether the member may claim it now. The run service
 * (services/ai-runs.ts) asks only this; it never asks the records or the business plugins' steps
 * itself. Today every subject is a record, resolved by services/run-subjects.ts (a core step by
 * `records.aiTurnOf`, a business plugin's step `<pluginId>__<step>` by `pluginSteps.turnOf` and
 * its pin), wired in src/composition.ts. A later kind (a job's occurrence) is another resolver
 * behind the same port; the run's fencing, idempotency keys, failure places and the emergency
 * stop do not look at the kind (.claude/rules/ai-turns.md "Execution runs on the server").
 */
import type { PluginStepProcedurePin } from '../../shared/core/plugins'

/** The kinds of subject a run can have. Only records today (`ai_runs.record_id`). */
export type RunSubjectKind = 'record'

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
}
