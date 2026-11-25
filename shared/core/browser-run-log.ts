/**
 * 「ブラウザ操作」's operator runs (redesign step ④; agent-browser.md "The operator's window tools"): one run = the operator
 * AI moving through a registered domain's pages in the member's window, reading only. The server keeps one row per run
 * (who, which domain, when, how it ended) and its **run log** (design memo §3 I8): per step the page's address as a
 * pattern, what was done, and the label of what was pressed — **never a value** (what was typed, what the page showed, a
 * link's text, a query's values). Pure: the app builds each step with these rules and the server checks every step it is
 * sent with the same rules (`browserRunLogProblem`), so the one copy decides what a stored log may hold.
 *
 * The address and label rules are the recording's (`shared/core/browser-recording.ts`): one copy of what may be kept.
 */
import { browserAddressPattern, browserLabel, isBrowserAddressPattern } from './browser-recording'

/** What the operator may do in the window (read only: nothing here sends a write; the window's gate refuses every one). */
export const BROWSER_RUN_ACTIONS = ['click', 'type', 'select', 'go', 'back', 'wait'] as const
export type BrowserRunAction = typeof BROWSER_RUN_ACTIONS[number]

/** How a run ended: `done` (the operator finished), `stopped` (it stopped itself, or someone stopped it), `failed`. */
export const BROWSER_RUN_OUTCOMES = ['done', 'stopped', 'failed'] as const
export type BrowserRunOutcome = typeof BROWSER_RUN_OUTCOMES[number]

/** A run's state on the server: `running` holds the company × domain lock; every other state is final. */
export const BROWSER_RUN_STATES = ['running', 'done', 'stopped', 'failed', 'timed_out', 'refused', 'left'] as const
export type BrowserRunState = typeof BROWSER_RUN_STATES[number]

export const BROWSER_RUN_LIMITS = Object.freeze({
  /** Steps kept per run (the operator's own limit is lower). */
  steps: 60,
  /** The lock's lease: each step renews it; a run not heard from for this long is over (crash, sleep, lost network). */
  leaseMs: 2 * 60_000,
  /** A run never lasts longer than this, renewed or not. */
  runMs: 6 * 60_000,
  /** Runs listed at most (newest first). */
  list: 200,
})

/** One step of a run as stored: the page it was done on (a pattern), what was done, the label of what was pressed. */
export interface BrowserRunLogStep {
  page: string
  action: BrowserRunAction
  /** The button's or field's label (`browserRunLabel`); null for a link (its text is never kept), a page, a wait. */
  label: string | null
}

/**
 * An address of the operated domain as a pattern (`/orders/{n}/edit?page&q`), or null for another host or scheme: the
 * recording's rule (`browserAddressPattern`), so a run's log and a recording read the same way.
 */
export const browserRunAddressPattern = (url: string, domain: string): string | null => browserAddressPattern(url, domain)

/** A button's or field's label as kept: the recording's rule (`browserLabel`: digits, mail, addresses masked; 60 characters). */
export const browserRunLabel = (text: unknown): string | null => browserLabel(text)

/** A stored page pattern (the recording's `isBrowserAddressPattern`). */
export const isBrowserRunPage = (v: unknown): v is string => isBrowserAddressPattern(v)

/** Why a step list may not be stored, or null. Every page a pattern, every label already in the kept form. */
export function browserRunLogProblem(steps: unknown): string | null {
  if (!Array.isArray(steps)) return 'steps'
  if (steps.length > BROWSER_RUN_LIMITS.steps) return 'too-many'
  for (const s of steps) {
    if (!s || typeof s !== 'object' || Array.isArray(s)) return 'step'
    const o = s as Record<string, unknown>
    if (Object.keys(o).length !== 3 || !('page' in o) || !('action' in o) || !('label' in o)) return 'step'
    if (!isBrowserRunPage(o.page)) return 'page'
    if (!(BROWSER_RUN_ACTIONS as readonly unknown[]).includes(o.action)) return 'action'
    if (o.label !== null && (typeof o.label !== 'string' || browserRunLabel(o.label) !== o.label)) return 'label'
  }
  return null
}

/** Fixed reason words a run may end with (the app's; the server keeps only a word of this list, else none). */
export const BROWSER_RUN_END_REASONS = [
  'not-found', 'need-person', 'blocked', 'stopped-by-person', 'ai-stopped', 'context-changed', 'window-closed',
  'timeout', 'rounds', 'bad-answer', 'operator-failed', 'refused', 'no-answer', 'other-frames',
] as const
export type BrowserRunEndReason = typeof BROWSER_RUN_END_REASONS[number]
export const isBrowserRunEndReason = (v: unknown): v is BrowserRunEndReason => (BROWSER_RUN_END_REASONS as readonly unknown[]).includes(v)

/** The run's id as the server makes it (put in an address only in this shape). */
export const BROWSER_RUN_ID_RE = /^bo_[0-9a-f]{32}$/
