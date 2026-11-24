/**
 * One company's plans of opened lines (generalization PR 4; agent-browser.md "Plans of opened lines on the server"):
 * plans of shape 2, write executions and one row per write, reports, the new path's locks, per-line grants and the
 * strict read's notices — from its handle (`CompanyData`), every method limited to that company. State changes are
 * compare-and-set (true when the row changed). Rules: services/browser-lines.ts, services/browser-line-steps.ts.
 */
import type { BrowserLineExecutionState, BrowserLinePlanState, BrowserWriteResult, BrowserWriteState } from '../../shared/core/browser-plans'

export interface BrowserLinePlanRow {
  id: string
  userId: string
  /** The content's shape (2). A shape this build does not know is frozen: never listed, claimed or permitted. */
  shape: number
  site: string
  lineName: string
  lineVersion: string
  mapVersion: string
  meaningHash: string
  mechanicsHash: string
  /** How many writes the plan holds (0: an inspection). */
  writes: number
  content: string
  contentHash: string
  state: BrowserLinePlanState
  closeReason: string | null
  createdAt: string
  expiresAt: string
  approvedAt: string | null
  closedAt: string | null
  conversationId: string | null
  /** The inspection's result (fixed words, canonical JSON), set once. */
  result: string | null
  reportedAt: string | null
}

export interface BrowserLineExecutionRow {
  id: string
  planId: string
  userId: string
  secretHash: string
  state: BrowserLineExecutionState
  voidReason: string | null
  claimedAt: string
  firstPermittedAt: string | null
  settledAt: string | null
  confirmedBy: string | null
}

export interface BrowserStepRow {
  executionId: string
  index: number
  kind: 'create' | 'change'
  state: BrowserWriteState
  permittedAt: string | null
  permittedMonoMs: number | null
  permittedBoot: string | null
  settledAt: string | null
  createdId: string | null
  createdLockKey: string | null
  confirmedBy: string | null
}

export interface BrowserLineReportRow {
  id: string
  executionId: string
  index: number
  result: BrowserWriteResult
  reason: string | null
  createdId: string | null
  outcome: 'applied' | 'same' | 'recorded' | 'conflict'
  stateBefore: BrowserWriteState
  at: string
}

export interface BrowserLineGrantRow {
  userId: string
  site: string
  lineName: string
  meaningHash: string
  mechanicsHash: string
  grantedBy: string
  grantedAt: string
}

export interface BrowserShapeNoticeRow {
  site: string
  mapVersion: string
  thing: string
  unknownKeys: number
  missingKeys: number
  unreadable: number
  reports: number
  firstAt: string
  lastAt: string
}

export interface BrowserLinePlanChange { approvedAt?: string; closedAt?: string; closeReason?: string; result?: string; reportedAt?: string }
export interface BrowserLineExecutionChange { firstPermittedAt?: string; settledAt?: string; voidReason?: string; confirmedBy?: string }
export interface BrowserStepChange {
  permittedAt?: string; permittedMonoMs?: number; permittedBoot?: string; settledAt?: string; createdId?: string; createdLockKey?: string; confirmedBy?: string
}

export interface BrowserLineRepository {
  insertPlan(row: BrowserLinePlanRow): void
  plan(planId: string): BrowserLinePlanRow | null
  /** A member's plans in these states (leaving the company closes them); every row. */
  plansOf(userId: string, states: readonly BrowserLinePlanState[]): BrowserLinePlanRow[]
  setPlanState(planId: string, from: BrowserLinePlanState, to: BrowserLinePlanState, change: BrowserLinePlanChange): boolean

  insertExecution(row: BrowserLineExecutionRow, steps: readonly BrowserStepRow[]): void
  execution(executionId: string): BrowserLineExecutionRow | null
  executionOfPlan(planId: string): BrowserLineExecutionRow | null
  /** A member's executions in these states; every row. */
  executionsOf(userId: string, states: readonly BrowserLineExecutionState[]): BrowserLineExecutionRow[]
  setExecutionState(executionId: string, from: BrowserLineExecutionState, to: BrowserLineExecutionState, change: BrowserLineExecutionChange): boolean

  steps(executionId: string): BrowserStepRow[]
  setStepState(executionId: string, index: number, from: BrowserWriteState, to: BrowserWriteState, change: BrowserStepChange): boolean

  appendReport(row: BrowserLineReportRow): void
  reports(executionId: string): BrowserLineReportRow[]

  /** The new path's lock holder, or null. */
  lockHolder(lockKey: string): string | null
  takeLock(lockKey: string, executionId: string, at: string): boolean
  /** Every lock this execution holds goes (only its own). */
  releaseLocksOf(executionId: string): void

  grants(): BrowserLineGrantRow[]
  grantsOf(userId: string, site: string, lineName: string): BrowserLineGrantRow[]
  saveGrant(row: BrowserLineGrantRow): void
  /** Every grant of this person on this line (any meaning or mechanics): an untick leaves nothing in force. */
  removeLineGrantsOf(userId: string, site: string, lineName: string): void
  removeGrantsOf(userId: string): void

  shapeNotices(): BrowserShapeNoticeRow[]
  shapeNotice(site: string, mapVersion: string, thing: string): BrowserShapeNoticeRow | null
  saveShapeNotice(row: BrowserShapeNoticeRow): void
  /** Add one to a member's notices for a site on a day; the new count. */
  countShapeReport(userId: string, site: string, day: string): number
  /** Everyone's notices for a site on a day in this company. */
  shapeReportsOn(site: string, day: string): number
}

/** Finds a write execution's company by its secret's hash (control plane, as the old path's `BrowserExecutionLookup`). */
export interface BrowserLineExecutionLookup {
  bySecretHash(secretHash: string): { companyId: string; executionId: string } | null
}

/** `shared/browser-connectors/opened.json` as read (checked by the service). */
export interface BrowserOpenedListSource {
  file(): unknown
}
