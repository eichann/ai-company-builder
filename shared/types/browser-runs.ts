/**
 * API shapes of the operator's runs of 「ブラウザ操作」 (agent-browser.md "The operator's window tools"; redesign step ④).
 * Generic units only — a registered domain, page patterns, labels —: never a value the site showed or the operator typed.
 */
import type { BrowserRunLogStep, BrowserRunOutcome, BrowserRunState, BrowserRunWriteStep } from '../core/browser-run-log'
import type { BrowserRunBudgetName } from '../core/browser-run-budget'

export type { BrowserRunLogStep, BrowserRunOutcome, BrowserRunState, BrowserRunWriteStep }

/** POST /browser-runs { host, conversationId?, frameRunId? } (+ this PC's key header): the run and its lease. */
export interface BrowserRunStarted {
  runId: string
  /** How long the lock is held without a renewal (each step renews it). */
  leaseMs: number
  /**
   * The run's budget as the server chose it (shared/core/browser-run-budget.ts; "Room for a Skill run"): its steps and
   * times. Absent from an older server: `standard`.
   */
  budget?: BrowserRunBudgetName
}

/** POST /browser-runs/:runId/continue (+ this PC's key header): the gate asked again, the lease renewed. */
export interface BrowserRunContinued {
  leaseMs: number
}

/** POST /browser-runs/:runId/finish { outcome, reason?, steps }: the run's log kept, the lock released. */
export interface BrowserRunFinish {
  outcome: BrowserRunOutcome
  reason?: string
  steps: BrowserRunLogStep[]
  /** A write run's page writes (step ⑤b); absent for a read run. */
  writes?: BrowserRunWriteStep[]
}

/** One run as GET /browser-runs lists it (the member's own; an owner / admin: everyone's). */
export interface BrowserRunView {
  id: string
  userId: string
  host: string
  state: BrowserRunState
  reason: string | null
  startedAt: string
  endedAt: string | null
  steps: BrowserRunLogStep[]
  /** Its page writes (step ⑤b): empty for a read run. Optional: an older server sends none. */
  writes?: BrowserRunWriteStep[]
}

export interface BrowserRunsList {
  runs: BrowserRunView[]
}
