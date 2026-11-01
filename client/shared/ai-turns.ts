/**
 * 「AI の番」 run automatically on the member's own PC (stage 2 S10,
 * `.claude/rules/ai-turns.md`): the shapes main and the renderer exchange.
 * The run itself is a hidden consultation in the main window (renderer); main
 * only claims the record (with the AI's record token, by its version) and
 * looks at it afterwards (with the session). Pure, no Node or Electron.
 */

import { DEFAULT_TASK_SETTINGS, TASK_SETTINGS_LIMITS } from '../../shared/core/task-settings'

/** The company's 「自動で進める」 and its limits: `autoRun` of the task settings (S6, `GET /task-settings`). */
export interface AutoTurnSettings {
  /** 「自動で進める」: AI turns start without a person pressing anything. */
  enabled: boolean
  /** At most this many automatic turns per member per day (local day). */
  dailyLimit: number
  /** Stop after this many failed automatic turns in a row (and tell the member). */
  stopAfterFailures: number
}

/** The company defaults (S6: 「自動で進める」 on unless an admin turns it off). */
export const DEFAULT_AUTO_TURN_SETTINGS: AutoTurnSettings = { ...DEFAULT_TASK_SETTINGS.autoRun }

/**
 * `autoRun` as the server answered it, each value checked against S6's limits. Unreadable or
 * missing → off: an AI turn never starts on a guess.
 */
export function readAutoTurnSettings(value: unknown): AutoTurnSettings {
  const v = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const count = (x: unknown, fallback: number, limits: { min: number; max: number }) =>
    typeof x === 'number' && Number.isInteger(x) && x >= limits.min && x <= limits.max ? x : fallback
  return {
    enabled: v.enabled === true,
    dailyLimit: count(v.dailyLimit, DEFAULT_AUTO_TURN_SETTINGS.dailyLimit, TASK_SETTINGS_LIMITS.dailyLimit),
    stopAfterFailures: count(v.stopAfterFailures, DEFAULT_AUTO_TURN_SETTINGS.stopAfterFailures, TASK_SETTINGS_LIMITS.stopAfterFailures),
  }
}

/**
 * Taking a record's AI turn (`aiTurns:claim`): the type's first AI action at
 * the record's version read just before — a compare-and-set on the server, so
 * of two PCs only one wins. `version`: the record's version after that action,
 * which the AI's first message names (an unattended run has no records_get;
 * null when the server's answer did not say).
 */
export type AiTurnClaimResult =
  | { claimed: true; version: number | null }
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

// The kinds of 「AI の番」 (each one's claim, settle, consultation and tools): ai-turn-steps/registry.ts.
