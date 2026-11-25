/**
 * How far and how long the operator AI may go in one run of 「ブラウザ操作」, and how long a write run's frames live
 * (agent-browser.md "Room for a Skill run"; knows no site). **The one copy of these times**: the server holds its lock and
 * ends its rows by them, the app's operator loop stops by them, and `browser-run-budget.test.ts` checks that they agree.
 *
 * - **A budget** is per operator run (one `POST /browser-runs`): at most `steps` of the operator's answers (each one
 *   `continue` on the server), the app stops operating `operateMs` after the run started, and the server holds the
 *   domain's lock for at most `runMs` from the start (the lease still ends a silent run sooner). `runMs` leaves the app
 *   room after `operateMs` for a write on its way (≤ 45 s), giving the window back and its `finish`.
 * - **Which budget** (`browserRunBudgetFor`, asked by the server only, at the start, from its own rows — never the app's
 *   word): `skill` only for a run naming its member's frames run that was built from an approved company Skill's
 *   declaration and is already `open` (approved on the card, or a pre-approved version) — the work of a Skill run.
 *   Everything else — reading (`browser_browse`), any preview, an ad-hoc plan's work — is `standard`, as before.
 * - **A frames run's times**: a run waiting for the card ends `approve` after it was made; any run ends `run` after it was
 *   made. A Skill run's frames run is made before its preview, so its preview (`standard`), the card and its work
 *   (`skill`) all fit in `approve` + the skill budget's `runMs` < `run`.
 */

export interface BrowserRunBudget {
  /** The operator's answers (one `continue` each) in one run. */
  steps: number
  /** The app operates this long after the run started, at most. */
  operateMs: number
  /** The server holds the domain this long after the run started, at most, renewed or not. */
  runMs: number
}

export const BROWSER_RUN_BUDGETS: Readonly<Record<'standard' | 'skill', Readonly<BrowserRunBudget>>> = Object.freeze({
  standard: Object.freeze({ steps: 20, operateMs: 5 * 60_000, runMs: 6 * 60_000 }),
  skill: Object.freeze({ steps: 60, operateMs: 15 * 60_000, runMs: 17 * 60_000 }),
})
export type BrowserRunBudgetName = keyof typeof BROWSER_RUN_BUDGETS
export const BROWSER_RUN_BUDGET_NAMES: readonly BrowserRunBudgetName[] = ['standard', 'skill']
export const isBrowserRunBudgetName = (v: unknown): v is BrowserRunBudgetName => (BROWSER_RUN_BUDGET_NAMES as readonly unknown[]).includes(v)

/** A budget by the name the server answered; anything else (an older server sends none) is `standard`. */
export const browserRunBudget = (name: unknown): Readonly<BrowserRunBudget> => BROWSER_RUN_BUDGETS[isBrowserRunBudgetName(name) ? name : 'standard']

/**
 * The one rule: which budget an operator run gets — from whether it is a write task's run and the frames run it names as
 * the server holds it (null: it names none, or none holds the domain for it). Only a write task's run naming an approved
 * company Skill's frames run that is open gets `skill`.
 */
export function browserRunBudgetFor(run: { write: boolean; frameRun: { source: string; state: string } | null }): BrowserRunBudgetName {
  return run.write && run.frameRun !== null && run.frameRun.source === 'skill' && run.frameRun.state === 'open' ? 'skill' : 'standard'
}

export const BROWSER_FRAME_RUN_TIMES = Object.freeze({
  /** A frames run waiting for the person's approval of its plan ends this long after it was made. */
  approve: 10 * 60_000,
  /** A frames run ends this long after it was made, whatever its state (its unused frames are gone). */
  run: 30 * 60_000,
})
