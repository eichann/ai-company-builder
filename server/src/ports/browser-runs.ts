/**
 * One company's operator runs of 「ブラウザ操作」 and their log (agent-browser.md "The operator's window tools"), from its
 * handle (`CompanyData`), every method limited to that company. State changes are compare-and-set (true when the row
 * changed). Rules: services/browser-runs.ts. Nothing here holds a value the site showed or the operator typed.
 */
import type { BrowserRunAction, BrowserRunState, BrowserRunWriteStep } from '../../shared/core/browser-run-log'
import type { BrowserRunBudgetName } from '../../shared/core/browser-run-budget'

export interface BrowserRunRow {
  id: string
  userId: string
  host: string
  deviceId: string | null
  conversationId: string | null
  state: BrowserRunState
  reason: string | null
  startedAt: string
  leaseUntil: string
  endedAt: string | null
  /** The budget the server chose at the start (shared/core/browser-run-budget.ts); fixed. */
  budget: BrowserRunBudgetName
  /** The operator's answers so far (each continue adds one). */
  steps: number
  /** The frames run it named (fixed), or null. */
  frameRunId: string | null
  /** The lock's hard end (fixed; never past the named frames run's end); null for an older build's row (its start + standard). */
  endsAt: string | null
}

export interface BrowserRunLogRow {
  runId: string
  idx: number
  page: string
  action: BrowserRunAction
  label: string | null
}

export interface BrowserRunRepository {
  /** A new `running` row; false when another run holds the company × domain lock (the partial unique index). */
  insert(row: BrowserRunRow): boolean
  byId(id: string): BrowserRunRow | null
  /** Whether a `skill` run naming this frames run was ever started (at most one: the partial unique index). */
  skillRunOf(frameRunId: string): boolean
  /** That `skill` run itself (the frames run's work), if one was started. */
  skillRunFor(frameRunId: string): BrowserRunRow | null
  /** The `running` row of this domain, if any. */
  runningOn(host: string): BrowserRunRow | null
  /** One more step and the lease renewed, while the row runs and its steps are below `maxSteps` (compare-and-set). */
  renew(id: string, leaseUntil: string, maxSteps: number): boolean
  /** running → a final state (compare-and-set). */
  end(id: string, state: Exclude<BrowserRunState, 'running'>, reason: string | null, at: string): boolean
  /** The ids of this member's running rows. */
  runningOf(userId: string): string[]
  /** Mark the run's log written (0 → 1, compare-and-set): false when it already was. */
  markLogWritten(id: string): boolean
  appendLog(rows: readonly BrowserRunLogRow[]): void
  logOf(runIds: readonly string[]): BrowserRunLogRow[]
  /** A write run's page writes (step ⑤b), appended once with the log. */
  appendWrites(runId: string, rows: readonly BrowserRunWriteStep[]): void
  writesOf(runIds: readonly string[]): Array<BrowserRunWriteStep & { runId: string }>
  /** Newest first, at most `limit`; `userId` given: only that member's. */
  list(limit: number, userId?: string): BrowserRunRow[]
}
