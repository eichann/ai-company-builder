/**
 * API shapes of the operator's runs of 「ブラウザ操作」 (agent-browser.md "The operator's window tools"; redesign step ④).
 * Generic units only — a registered domain, page patterns, labels —: never a value the site showed or the operator typed.
 */
import type { BrowserRunLogStep, BrowserRunOutcome, BrowserRunState } from '../core/browser-run-log'

export type { BrowserRunLogStep, BrowserRunOutcome, BrowserRunState }

/** POST /browser-runs { host, conversationId? } (+ this PC's key header): the run and its lease. */
export interface BrowserRunStarted {
  runId: string
  /** How long the lock is held without a renewal (each step renews it). */
  leaseMs: number
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
}

export interface BrowserRunsList {
  runs: BrowserRunView[]
}
