/**
 * One company's 「ブラウザ操作」 plans, executions, reports, target locks and type grants (PR 6a;
 * agent-browser.md "Plans, executions, permits and locks"), from its handle (`CompanyData`). Every
 * method is limited to that company. State changes are compare-and-set: they say whether they
 * changed a row, so of two at the same moment only one wins. Rules: services/browser-plans.ts.
 */
import type { BrowserExecutionState, BrowserPlanState, BrowserReportResult } from '../../shared/core/browser-plans'

export interface BrowserPlanRow {
  id: string
  userId: string
  connectorId: string
  connectorVersion: string
  operation: string
  declarationHash: string
  checkerHash: string
  factsVersion: number
  account: string
  /** The fixed content, canonical JSON. */
  content: string
  contentHash: string
  state: BrowserPlanState
  closeReason: string | null
  createdAt: string
  expiresAt: string
  approvedAt: string | null
  closedAt: string | null
  /**
   * Copies of two parts of the fixed content for the open-plans list, so it never reads the content
   * (6b-2a; fixed like it): the target as canonical JSON and the consultation. Null on a row an older
   * build wrote (the list then reads them from the content).
   */
  targetJson: string | null
  conversationId: string | null
}

/** A plan as the open-plans list reads it: every column but the content. */
export type BrowserPlanSummaryRow = Omit<BrowserPlanRow, 'content'>

export interface BrowserExecutionRow {
  id: string
  planId: string
  userId: string
  secretHash: string
  lockKey: string
  state: BrowserExecutionState
  voidReason: string | null
  claimedAt: string
  permittedAt: string | null
  /** The server's monotonic reading at the permit and that process start's id (the clock fix; null before a permit, or from an older build). */
  permittedMonoMs: number | null
  permittedBoot: string | null
  settledAt: string | null
  confirmedBy: string | null
}

export interface BrowserReportRow {
  id: string
  executionId: string
  result: BrowserReportResult
  reason: string | null
  outcome: 'applied' | 'same' | 'recorded' | 'conflict'
  stateBefore: BrowserExecutionState
  at: string
}

export interface BrowserTypeGrantRow {
  userId: string
  connectorId: string
  operation: string
  declarationHash: string
  grantedBy: string
  grantedAt: string
}

/** Fields a state change may set with it. */
export interface BrowserPlanChange { approvedAt?: string; closedAt?: string; closeReason?: string }
export interface BrowserExecutionChange {
  permittedAt?: string; permittedMonoMs?: number; permittedBoot?: string; settledAt?: string; voidReason?: string; confirmedBy?: string
}

export interface BrowserPlanRepository {
  insertPlan(row: BrowserPlanRow): void
  plan(planId: string): BrowserPlanRow | null
  /** draft / approved plans of a member (leaving the company closes them). */
  openPlansOf(userId: string): BrowserPlanSummaryRow[]
  /** The member's draft / approved plans, newest first, at most `limit`, without their content (the open-plans list). */
  newestOpenPlansOf(userId: string, limit: number): BrowserPlanSummaryRow[]
  /** Compare-and-set: only from `from`. True when the row changed. */
  setPlanState(planId: string, from: BrowserPlanState, to: BrowserPlanState, change: BrowserPlanChange): boolean

  insertExecution(row: BrowserExecutionRow): void
  execution(executionId: string): BrowserExecutionRow | null
  executionOfPlan(planId: string): BrowserExecutionRow | null
  /**
   * Executions in any of these states (the company's; of one member when given), oldest claim first.
   * No limit unless `page` is given: lifecycle work (leaving the company) must see every row. A page
   * (the waiting list) is `limit` rows after the execution `after` (by claim time, then id).
   */
  executionsIn(states: readonly BrowserExecutionState[], userId?: string, page?: { limit: number; after?: string }): BrowserExecutionRow[]
  /** Compare-and-set: only from `from`. True when the row changed. */
  setExecutionState(executionId: string, from: BrowserExecutionState, to: BrowserExecutionState, change: BrowserExecutionChange): boolean

  appendReport(row: BrowserReportRow): void
  reports(executionId: string): BrowserReportRow[]

  /** The execution holding the lock, or null. */
  lockHolder(lockKey: string): string | null
  /** Take the lock for this execution; false when someone holds it. */
  takeLock(lockKey: string, executionId: string, at: string): boolean
  /** Release the lock only when this execution holds it. */
  releaseLock(lockKey: string, executionId: string): void

  grants(): BrowserTypeGrantRow[]
  grant(userId: string, connectorId: string, operation: string, declarationHash: string): BrowserTypeGrantRow | null
  saveGrant(row: BrowserTypeGrantRow): void
  removeGrant(userId: string, connectorId: string, operation: string, declarationHash: string): void
  removeGrantsOf(userId: string): void
}

/**
 * Finds an execution's company by its secret's hash (control plane, like a key-broker token): the
 * report comes with the secret only — from an app whose member may have left the company.
 */
export interface BrowserExecutionLookup {
  bySecretHash(secretHash: string): { companyId: string; executionId: string } | null
}

/** A row of shared/browser-connectors/approved.json, as read (checked by the service). */
export interface ApprovedCombinationRow {
  connector: string
  version: string
  declarationHash: string
  checkerHash: string
  factsVersion: number
  minAppVersion: string | null
  status: string
  declaration: string
}

/** The approved combinations of browser connectors (the server is their authority). */
export interface BrowserConnectorCatalog {
  combinations(): ApprovedCombinationRow[]
}
