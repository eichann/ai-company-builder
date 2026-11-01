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

/**
 * An unattended step (owner decision 2026-11-01): the automatic run gets ONLY the tools its step
 * declares — the app's record tools named here, and Claude Code's built-in tools listed in
 * `builtinTools` (none for minutes reading). The member's own settings, MCP servers, hooks and
 * plugins are not loaded. Normal consultations are unchanged.
 */
export type AiTurnStep = 'minutes-reading'

export interface AiTurnStepTools {
  /** Record tools (acb_records) by exact name. */
  recordTools: readonly string[]
  /** Record tools by name ending: a business plugin's operations (`<plugin>__update_deal`). */
  recordToolEndings: readonly string[]
  /** Claude Code built-in tools the step declares ([] = none at all). */
  builtinTools: readonly string[]
}

export const AI_TURN_STEPS: Record<AiTurnStep, AiTurnStepTools> = {
  'minutes-reading': {
    recordTools: [
      'minutes_read', 'minutes_link_bundle', 'meeting__start_reading', 'meeting__finish_reading', 'meeting__fail_reading',
      'records_create', 'decisions_record', 'mail_recipients', 'mail_draft_create', 'mail_draft_update', 'mail_draft_show',
    ],
    recordToolEndings: ['__update_deal', '__log_meeting'],
    builtinTools: [],
  },
}

export function isAiTurnStep(value: unknown): value is AiTurnStep {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(AI_TURN_STEPS, value)
}

/** Whether the step declares this record tool (its plain name, not the mcp__ id). */
export function aiTurnStepAllowsRecordTool(step: AiTurnStep, name: string): boolean {
  const tools = AI_TURN_STEPS[step]
  return tools.recordTools.includes(name) || tools.recordToolEndings.some(ending => name.endsWith(ending) && name.length > ending.length)
}

/** A meeting record's id (`minutes-…` for one made before the type was renamed `meeting`). */
const MEETING_ID_RE = /^(?:meeting|minutes)-[0-9a-z]{6,32}$/

/** The record kinds the runner handles, and each one's claiming action. Today: reading a meeting's minutes. */
export const AI_TURN_CLAIM_ACTIONS = { meeting: 'start_reading' } as const

/** The state each kind's claiming action starts from (anything else: the record moved on). */
export const AI_TURN_CLAIM_FROM: Record<keyof typeof AI_TURN_CLAIM_ACTIONS, string> = { meeting: 'received' }

/** The step each kind runs: the server's execution run is per record and step (S10b). */
export const AI_TURN_KIND_STEPS: Record<keyof typeof AI_TURN_CLAIM_ACTIONS, AiTurnStep> = { meeting: 'minutes-reading' }

/** A record id the runner may claim (only the kinds above). */
export function aiTurnKindOf(recordId: string): keyof typeof AI_TURN_CLAIM_ACTIONS | null {
  return MEETING_ID_RE.test(recordId) ? 'meeting' : null
}
