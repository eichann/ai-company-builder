/**
 * 「AI の番」 run automatically on the member's own PC (stage 2 S10,
 * `.claude/rules/ai-turns.md`): the shapes main and the renderer exchange.
 * The run itself is a hidden consultation in the main window (renderer); main
 * only claims the record (with the AI's record token, by its version) and
 * looks at it afterwards (with the session). Pure, no Node or Electron.
 */

/** The company's 「自動で進める」 and its limits (stage 2 S6 provides them; until then the defaults). */
export interface AutoTurnSettings {
  /** 「自動で進める」: AI turns start without a person pressing anything. */
  enabled: boolean
  /** At most this many automatic turns per member per day (local day). */
  dailyLimit: number
  /** Stop after this many failed automatic turns in a row (and tell the member). */
  stopAfterFailures: number
}

/** Owner decision 2026-11-01: automatic by default. */
export const DEFAULT_AUTO_TURN_SETTINGS: AutoTurnSettings = { enabled: true, dailyLimit: 20, stopAfterFailures: 3 }

/** Settings as received (a newer server, S6), each value checked; anything unusable → the default. */
export function readAutoTurnSettings(value: unknown): AutoTurnSettings {
  const v = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const count = (x: unknown, fallback: number, max: number) =>
    typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= max ? x : fallback
  return {
    enabled: typeof v.enabled === 'boolean' ? v.enabled : DEFAULT_AUTO_TURN_SETTINGS.enabled,
    dailyLimit: count(v.dailyLimit, DEFAULT_AUTO_TURN_SETTINGS.dailyLimit, 500),
    stopAfterFailures: count(v.stopAfterFailures, DEFAULT_AUTO_TURN_SETTINGS.stopAfterFailures, 50) || DEFAULT_AUTO_TURN_SETTINGS.stopAfterFailures,
  }
}

/**
 * Taking a record's AI turn (`aiTurns:claim`): the type's first AI action at
 * the version the app saw — a compare-and-set on the server, so of two PCs
 * only one wins.
 */
export type AiTurnClaimResult =
  | { claimed: true }
  | { claimed: false; reason: 'taken' | 'not-allowed' | 'unavailable' }

/**
 * The record after an automatic turn (`aiTurns:settle`): `done` = the AI
 * finished it, `failed` = it said it could not, `put-back` = it was still in
 * progress and went back to 「AI の番」 (`retry`), `unknown` = not readable now.
 */
export type AiTurnSettleResult = { outcome: 'done' | 'failed' | 'put-back' | 'unknown' }

/**
 * Where one record of 「AI の番」 stands on this PC, for every screen that lists it (the minutes
 * notice today, the task list later). Never silent: each state has a reason the member can read.
 * - `running`: the AI works on it now (a hidden consultation).
 * - `waiting`: it will start by itself (its turn, Claude's usage pause, today's limit, a stop).
 * - `not-allowed`: it cannot start here (no Claude Code, Codex, not signed in, the setting off).
 * - `failed`: the AI could not finish; handed to the person with the reason.
 * - `handed`: given to the person early (due soon, the AI waits for an answer, or the member chose).
 * `canRetry` offers 「もう一度」 (back to the AI), `canHand` offers 「人に渡す」.
 */
export type AiTurnItemState = 'running' | 'waiting' | 'not-allowed' | 'failed' | 'handed'

export interface AiTurnItemView {
  recordId: string
  state: AiTurnItemState
  /** Plain Japanese, for the member (empty only while running). */
  reason: string
  canRetry: boolean
  canHand: boolean
}

/** What the runner exposes: each waiting record's state, and the member's two choices. */
export interface AiTurnItemsView {
  items: readonly AiTurnItemView[]
  retry: (recordId: string) => void
  handOver: (recordId: string) => void
}

const MINUTES_ID_RE =/^minutes-[0-9a-z]{6,32}$/

/** The record kinds the runner handles, and each one's claiming action. Today: minutes 「読む」. */
export const AI_TURN_CLAIM_ACTIONS = { minutes: 'start_reading' } as const

/** A record id the runner may claim (only the kinds above). */
export function aiTurnKindOf(recordId: string): keyof typeof AI_TURN_CLAIM_ACTIONS | null {
  return MINUTES_ID_RE.test(recordId) ? 'minutes' : null
}
