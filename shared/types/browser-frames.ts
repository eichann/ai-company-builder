/**
 * API shapes of 「ブラウザ操作」's writes within frames (redesign step ⑤a; agent-browser.md "Writes within frames"). The
 * server decides every value here; the app (step ⑤b) only sends what the routes ask for. Rules:
 * server/src/services/browser-frames.ts. Knows no site.
 */

/** A run: `waiting` its plan's approval, `open` (permits may be given), `locked` (a write was unknown: nothing more is
 *  sent in this run), `ended` (its unused frames are gone). */
export type BrowserFrameRunState = 'waiting' | 'open' | 'locked' | 'ended'
export const BROWSER_FRAME_RUN_STATES: readonly BrowserFrameRunState[] = ['waiting', 'open', 'locked', 'ended']

/** Why a run ended: asked to (`ended`), its time (`expired`), the member left (`left`), the Skill changed while its card
 *  was up (`changed`), or a permit's check refused it (the refusal's code). */
export type BrowserFrameEndReason = string

/**
 * A write's state: `permitted` (it may be on its way), `done` (the site returned success), `verified` (reserved: a safe
 * pattern's machine check that it landed as predicted — nothing sets it yet), `not_sent` (the app stopped before the
 * request left), `unknown` (it may have been sent; the run is locked).
 */
export type BrowserFrameWriteState = 'permitted' | 'done' | 'verified' | 'not_sent' | 'unknown'
export const BROWSER_FRAME_WRITE_STATES: readonly BrowserFrameWriteState[] = ['permitted', 'done', 'verified', 'not_sent', 'unknown']

/** What the app reports for one write (never `verified`: that is the server's, for a safe pattern). */
export type BrowserFrameWriteResult = 'done' | 'not_sent' | 'unknown'

export interface BrowserFrameView {
  /** 1-based, in the declaration's order. */
  frame: number
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string
  fields: Record<string, string>
  max: number
  used: number
  /** Units still usable now: 0 once the run is locked or ended. */
  left: number
}

export interface BrowserFrameWriteView {
  write: number
  frame: number
  state: BrowserFrameWriteState
  permittedAt: string
  settledAt: string | null
}

export interface BrowserFrameRunView {
  runId: string
  state: BrowserFrameRunState
  endReason: BrowserFrameEndReason | null
  host: string
  /** `skill`: frames from a company Skill's approved declaration; `adhoc`: from the plan the person approves on the card. */
  source: 'skill' | 'adhoc'
  skill: string | null
  /** The hash of the plan the card shows; approving sends it back. */
  planHash: string
  /** The person must approve the plan on the card before any permit (`state` is `waiting`). */
  needsApproval: boolean
  /** How it was approved: on the card, or before (a pre-approved Skill version). Null while waiting. */
  approval: 'card' | 'pre_approved' | null
  createdAt: string
  expiresAt: string
  endedAt: string | null
  frames: BrowserFrameView[]
  writes: BrowserFrameWriteView[]
}

/**
 * The answer to a start: the run, and — only here, only for a run waiting for its card — the one-time approval value the
 * card's ［任せる］ sends back. The app's main process keeps it for the card and never hands it to an AI tool's answer.
 */
export interface BrowserFrameRunStart extends BrowserFrameRunView {
  approvalToken: string | null
  /**
   * A Skill run's declared addresses (step ⑤b), from the approved declaration the server read — never an app's: what the
   * app reads again after writing (`after_read`, `{created}` allowed) and what neither the page nor the operator may read
   * during the run (`never_read`). Empty for an ad-hoc plan; absent from an older server (the app then reads nothing after
   * and refuses no read beyond its own rules).
   */
  afterRead?: string[]
  neverRead?: string[]
}

/** What the app read of the held write, sent with a permit: its shape only, never the body's other values. */
export interface BrowserFramePermitRequest {
  method: string
  path: string
  /** The frame's fixed fields as the body holds them, and `_method` when the body has one. */
  fields: Record<string, string>
}

/** The answer to a permit: send this one write once, within `validMs` of asking. */
export interface BrowserFramePermit {
  write: number
  frame: number
  permittedAt: string
  validMs: number
}

export interface BrowserFrameReportAnswer {
  /** `applied` moved the write; `same` the same answer again; `recorded` a late or non-moving answer kept as it was. */
  outcome: 'applied' | 'same' | 'recorded'
  run: BrowserFrameRunView
}
