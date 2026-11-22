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
  /** The declaration's `delivers`; `unknown` also when the combination is no longer listed. */
  delivers: 'none' | 'scheduled' | 'immediate' | 'unknown'
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

/**
 * A plan's fixed content (6b-2: carried in the claim answer, `BrowserClaim.fixed.content`, as the exact
 * canonical JSON text the server stored and hashed). `format` 1; never changed once released (a new
 * shape is a new format).
 */
export interface BrowserPlanContent {
  format: 1
  company: string
  user: string
  conversation: string | null
  connector: { id: string; version: string; declarationHash: string; checkerHash: string; factsVersion: number }
  operation: string
  account: string
  target: Record<string, string>
  change: Record<string, string>
  facts: Record<string, BrowserFact>
  explanation: string | null
  createdAt: string
  expiresAt: string
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
  /**
   * The plan's fixed content as the server stored it (6b-2; added, absent from an older server): the
   * app checks `sha256:` + hex sha256 of `content`'s UTF-8 bytes equals `contentHash`, and that hash
   * equals the one the person approved, before it reads anything again or asks for a permit.
   */
  fixed?: {
    /** Canonical JSON of a `BrowserPlanContent`. */
    content: string
    contentHash: string
    factsVersion: number
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

/** GET /browser-executions-waiting: one page; `next` is the `after` of the next page (null: the last). */
export interface BrowserWaitingPage {
  items: BrowserWaitingItem[]
  next: string | null
}

/** GET /browser-type-grants (owner/admin): the approved operation types and who may use them. */
export interface BrowserTypeGrantsView {
  types: Array<{ connector: string; version: string; declarationHash: string; operation: string; label: string }>
  grants: Array<{ userId: string; name: string | null; connector: string; operation: string; declarationHash: string; grantedAt: string; grantedBy: string }>
}

/** One of the member's own plans still waiting for them (draft) or approved and not yet claimed. */
export interface BrowserOpenPlan {
  planId: string
  state: 'draft' | 'approved'
  connector: { id: string; version: string; label: string }
  operation: string
  label: string
  target: Record<string, string>
  /** The consultation it came from, if the app gave one (the card opens there). */
  conversationId: string | null
  createdAt: string
  expiresAt: string
  approvedAt: string | null
}

/** GET /browser-plans-open: newest first, at most 100; `more` when there are older ones still open. */
export interface BrowserOpenPlans {
  items: BrowserOpenPlan[]
  more: boolean
}
