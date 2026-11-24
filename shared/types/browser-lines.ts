/**
 * API shapes of 「ブラウザ操作」's opened lines on the server (generalization PR 4; agent-browser.md "Plans of opened lines
 * on the server"). Provisional until a second site fits them (design memo §18). Nothing in the app calls these yet (PR 5).
 */
import type { BrowserLineExecutionState, BrowserLinePlanState, BrowserWriteResult, BrowserWriteState } from '../core/browser-plans'

export type { BrowserLineExecutionState, BrowserLinePlanState, BrowserWriteResult, BrowserWriteState }

/** Which opened line, exactly (the server accepts only an approved row with all six equal). */
export interface BrowserLineRef {
  site: string
  line: string
  version: string
  mapVersion: string
  meaningHash: string
  mechanicsHash: string
}

/** The inspection's result as kept: fixed words only (never a value the site showed). */
export interface BrowserInspectionResult {
  state: 'all_ok' | 'ng' | 'not_read'
  reads: Record<string, string>
  checks: string[]
}

export interface BrowserLineStepView {
  index: number
  kind: 'create' | 'change'
  state: BrowserWriteState
  permittedAt: string | null
  settledAt: string | null
  confirmableAt: string | null
  createdId: string | null
}

export interface BrowserLineExecutionView {
  id: string
  state: BrowserLineExecutionState
  claimedAt: string
  settledAt: string | null
  voidReason: string | null
  confirmedBy: string | null
  steps: BrowserLineStepView[]
}

export interface BrowserLinePlanView {
  id: string
  state: BrowserLinePlanState
  closeReason: string | null
  line: BrowserLineRef & { label: string }
  writes: number
  values: Record<string, { value: string; from: Record<string, unknown> }>
  createdAt: string
  expiresAt: string
  approvedAt: string | null
  contentHash: string
  result: BrowserInspectionResult | null
  execution: BrowserLineExecutionView | null
}

export interface BrowserLineClaim {
  executionId: string
  /** Answered once, never stored (the server keeps its sha256). */
  secret: string
  fixed: { content: string; contentHash: string }
}

export interface BrowserLinePermit {
  index: number
  permittedAt: string
  validMs: number
  /** For a write on what an earlier write created: the id the server recorded (the app may write to no other). */
  createdTarget: string | null
}

export interface BrowserLineReportAnswer { state: BrowserLineExecutionState; step: BrowserWriteState; outcome: 'applied' | 'same' | 'recorded' | 'conflict' }

export interface BrowserLineGrantsView {
  /** The approved rows; `writes`: the line writes to the site (else it only reads). */
  lines: Array<BrowserLineRef & { label: string; writes: boolean }>
  /** Lines with no approved row yet but one waiting for its review (`pending`): names only, nothing can be granted. */
  waiting: Array<{ site: string; line: string; label: string; writes: boolean }>
  /**
   * The grants in force, one per approved line row and person: `direct` (given on that row) or `carried` from another row
   * of the same line and meaning by the row's reviewed `grantsFrom` (which version of the line and map it was given on).
   */
  grants: Array<BrowserLineRef & {
    userId: string
    name: string | null
    from: { kind: 'direct' } | { kind: 'carried'; version: string | null; mapVersion: string | null; mechanicsHash: string }
    grantedAt: string
    grantedBy: string
  }>
}

/** What owners / admins see of a site whose shape changed (§16-1): the map's own names and counts, never a key name. */
export interface BrowserShapeNoticeView {
  site: string
  mapVersion: string
  thing: string
  thingLabel: string
  unknownKeys: number
  missingKeys: number
  unreadable: number
  reports: number
  firstAt: string
  lastAt: string
}
