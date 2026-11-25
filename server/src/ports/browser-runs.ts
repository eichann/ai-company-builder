/**
 * One company's operator runs of 「ブラウザ操作」 and their log (agent-browser.md "The operator's window tools"), from its
 * handle (`CompanyData`), every method limited to that company. State changes are compare-and-set (true when the row
 * changed). Rules: services/browser-runs.ts. Nothing here holds a value the site showed or the operator typed.
 */
import type { BrowserRunAction, BrowserRunState } from '../../shared/core/browser-run-log'

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
  /** The `running` row of this domain, if any. */
  runningOn(host: string): BrowserRunRow | null
  /** Renew the lease of a running row (compare-and-set on `running`). */
  renew(id: string, leaseUntil: string): boolean
  /** running → a final state (compare-and-set). */
  end(id: string, state: Exclude<BrowserRunState, 'running'>, reason: string | null, at: string): boolean
  /** The ids of this member's running rows. */
  runningOf(userId: string): string[]
  appendLog(rows: readonly BrowserRunLogRow[]): void
  logOf(runIds: readonly string[]): BrowserRunLogRow[]
  /** Newest first, at most `limit`; `userId` given: only that member's. */
  list(limit: number, userId?: string): BrowserRunRow[]
}
