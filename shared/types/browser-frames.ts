import type { BrowserSkillStepsSeal } from '../core/browser-skill-steps'

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
 * request left), `unknown` (it may have been sent; the run is locked), `refused` (the site answered that it did not take
 * it — a 4xx, shared/core/browser-frame-match.ts `browserWriteAnswerKind`; never done, the run goes on, and trying again
 * is a new write with its own permit and unit).
 */
export type BrowserFrameWriteState = 'permitted' | 'done' | 'verified' | 'not_sent' | 'unknown' | 'refused'
export const BROWSER_FRAME_WRITE_STATES: readonly BrowserFrameWriteState[] = ['permitted', 'done', 'verified', 'not_sent', 'unknown', 'refused']

/** What the app reports for one write (never `verified`: that is the server's, for a safe pattern). */
export type BrowserFrameWriteResult = 'done' | 'not_sent' | 'unknown' | 'refused'

/** The person's answer about a write in doubt, from the card: 「済んでいた」 / 「されていなかった」. */
export type BrowserFrameConfirmAnswer = 'done' | 'not_done'

export interface BrowserFrameView {
  /** 1-based, in the declaration's order. */
  frame: number
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string
  /**
   * The exact raw query the address must carry (without the `?`; agent-browser.md "A write with an exact query"). Absent:
   * the address carries none (also from an older server). An older app ignores it and so never fits a write to it: it
   * refuses any address with a query, and the server refuses one without.
   */
  query?: string
  fields: Record<string, string>
  max: number
  used: number
  /** Units still usable now: 0 once the run is locked or ended. */
  left: number
  /**
   * The run's promise (agent-browser.md "The run's promise"): the other body fields this frame's writes may carry, and the
   * body fields bound to a promised value by label — from the Skill's `browser.yaml`. Absent: not declared (also from an
   * older server).
   */
  body?: string[]
  bind?: Record<string, string>
}

export interface BrowserFrameWriteView {
  write: number
  frame: number
  state: BrowserFrameWriteState
  permittedAt: string
  settledAt: string | null
  /** For an `unknown` write: from when the person may answer about it (the server's estimate; it decides at the press). */
  confirmableAt?: string | null
  /** The person's answer about it, who and when (null: none). Absent from an older server. */
  confirmed?: { answer: BrowserFrameConfirmAnswer; by: string; at: string } | null
  /**
   * A `refused` write the app read again and found unchanged (agent-browser.md "Sent is not done"): only then is it known
   * not saved. False: the site's error alone — whether it saved anything is not known. Absent for other states and from an
   * older server.
   */
  checked?: boolean
}

export interface BrowserFrameRunView {
  runId: string
  state: BrowserFrameRunState
  endReason: BrowserFrameEndReason | null
  host: string
  /** `skill`: frames from a company Skill's approved declaration; `adhoc`: from the plan the person approves on the card. */
  source: 'skill' | 'adhoc'
  /**
   * A Skill run's Skill, by its path (`.claude/skills/<name>` or `<department>/.claude/skills/<name>`): the one the server
   * resolved a name to. A run started before department Skills holds the bare name (the company's).
   */
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
  /**
   * The write ledger (agent-browser.md "The write ledger across requests"): earlier writes of this member on this domain
   * whose result nobody knows (`unknown`, or still `permitted`, and not answered), of any earlier run however old, whose
   * frame may meet one of this run's frames. The app asks the person about each (［済んでいた］／［されていなかった］, the
   * earlier run's `confirm`) before the operator works; the server refuses a permit to the very same target until then
   * (`BROWSER_WRITE_IN_DOUBT`). Empty when none; absent from an older server.
   */
  doubts?: BrowserFrameDoubt[]
  /**
   * A Skill run's steps sealed at the folder version its frames come from (shared/core/browser-skill-steps.ts): the app hands
   * the operator its copy of the Skill's steps only when it is exactly that text. Absent for an ad-hoc plan and from an older
   * server (the app then does not start a Skill's work).
   */
  steps?: BrowserSkillStepsSeal
}

/** An earlier write in doubt, as the start names it: its run and write, the frame it fitted, and from when it may be answered. */
export interface BrowserFrameDoubt {
  runId: string
  write: number
  frame: { method: 'POST' | 'PUT' | 'PATCH' | 'DELETE'; path: string; query?: string; fields: Record<string, string> }
  permittedAt: string
  confirmableAt: string
}

/** What the app read of the held write, sent with a permit: its shape only, never the body's other values. */
export interface BrowserFramePermitRequest {
  method: string
  path: string
  /** The frame's fixed fields as the body holds them, and `_method` when the body has one. */
  fields: Record<string, string>
}

/**
 * Why a permit was refused for the run's promise (409, agent-browser.md "The run's promise"): `BROWSER_PROMISE_BROKEN` (a
 * bound field holds another value or is missing: `reason`, `field`) or `BROWSER_PROMISE_ASK` (not in the promise yet: the
 * body field names outside it, the path's open segments by place, the bound fields with no promised value) — the person is
 * asked on the card, and their 「書いてよい」 adds exactly those (`POST …/promise-add`).
 */
export interface BrowserPromiseRefusal {
  code: 'BROWSER_PROMISE_BROKEN' | 'BROWSER_PROMISE_ASK'
  reason?: 'value' | 'missing'
  field?: string
  fields?: string[]
  targets?: number[]
  values?: string[]
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
