/**
 * The API of 「ブラウザ操作」 plans (PR 6a; agent-browser.md "Plans, executions, permits and locks";
 * server/src/routes/browser-plans.ts). Nothing in the app calls it yet (6b).
 */
import type { BrowserExecutionState, BrowserFact, BrowserPlanState, BrowserReportResult } from '../core/browser-plans'

/** POST /browser-plans: a candidate and the facts the app's checker read (never the AI's word). */
export interface BrowserPlanInput {
  connector: { id: string; version: string }
  operation: string
  /** The approved combination the app runs: its declaration's and checker folder's hashes, the facts version. */
  declarationHash: string
  checkerHash: string
  factsVersion: number
  target: Record<string, string>
  change: Record<string, string>
  facts: Record<string, BrowserFact>
  /** What the AI said about it (shown apart from the facts, never trusted). */
  explanation?: string
  /** The consultation it came from (informational). */
  conversationId?: string
}

export interface BrowserExecutionView {
  id: string
  state: BrowserExecutionState
  claimedAt: string
  permittedAt: string | null
  settledAt: string | null
  /** From when a person may say whether it happened (permit + 5 s + 30 s), once permitted. */
  confirmableAt: string | null
  voidReason: string | null
  confirmedBy: string | null
}

export interface BrowserPlanView {
  id: string
  state: BrowserPlanState
  closeReason: string | null
  connector: { id: string; version: string; label: string }
  operation: string
  label: string
  /** The declaration's warning (共有のリマインダ…), or null. */
  sharedNote: string | null
  delivers: 'none' | 'immediate' | 'unknown'
  account: string
  target: Record<string, string>
  change: Record<string, string>
  facts: Record<string, BrowserFact>
  explanation: string | null
  createdAt: string
  expiresAt: string
  approvedAt: string | null
  /** The fixed content's hash: approving sends back the one shown. */
  contentHash: string
  execution: BrowserExecutionView | null
}

/** POST /browser-plans/:planId/claim: the execution, its secret (once) and the fixed plan the runner takes. */
export interface BrowserClaim {
  executionId: string
  /** 256 random bits; the server keeps only its hash. Sent as `X-ACB-Browser-Execution` to permit and report. */
  secret: string
  plan: {
    planId: string
    companyId: string
    connector: { id: string; version: string }
    operation: string
    account: string
    target: Record<string, string>
    change: Record<string, string>
    before: Record<string, string[]>
    approvedAt: string
    expiresAt: string
  }
}

export interface BrowserPermit {
  permittedAt: string
  /** The app sends only within this many milliseconds, counted from just before it asked. */
  validMs: number
}

export interface BrowserReportAnswer {
  state: BrowserExecutionState
  /** applied: the state moved; same: the same report again; recorded: kept, the state stays. */
  outcome: 'applied' | 'same' | 'recorded'
}

export interface BrowserReportInput { result: BrowserReportResult; reason?: string }

/** One execution waiting for a person to say whether it happened. */
export interface BrowserWaitingItem {
  executionId: string
  planId: string
  userId: string
  connector: { id: string; version: string }
  operation: string
  label: string
  target: Record<string, string>
  state: BrowserExecutionState
  permittedAt: string | null
  confirmableAt: string | null
  /** The caller may press 「済んでいた」/「されていなかった」 now. */
  canConfirm: boolean
}

/** GET /browser-type-grants (owner/admin): the approved operation types and who may use them. */
export interface BrowserTypeGrantsView {
  types: Array<{ connector: string; version: string; declarationHash: string; operation: string; label: string }>
  grants: Array<{ userId: string; name: string | null; connector: string; operation: string; declarationHash: string; grantedAt: string; grantedBy: string }>
}
