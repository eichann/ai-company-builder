/**
 * What one kind of 「AI の番」 declares (`.claude/rules/ai-turns.md` "Steps"): which records it
 * runs, how main claims and settles them, the consultation it opens and the ONLY tools the
 * unattended run gets. One kind per file in this folder, listed in `registry.ts`. Pure.
 */

/** A record waiting for the member's AI, as the runner queues it. */
export interface AiTurnCandidate {
  id: string
  title: string
  version: number
  /** When it is due (ISO), if the record has a due date. */
  dueAt?: string | null
  /** The meeting's time (ISO) for minutes. */
  meetingAt?: string | null
  /**
   * A business plugin's step (`<pluginId>__<step>`, `plugin.ts`): the record runs that step,
   * whatever its type (the server listed it at the step's state). Absent for the static kinds.
   */
  pluginStep?: `${string}__${string}`
  /** Its state when queued: picks the step when one kind of record has several (a meeting's reading, its まとまり's part). */
  state?: string | null
}

/**
 * An unattended step (owner decision 2026-11-01): the automatic run gets ONLY the tools its step
 * declares — the app's record tools named here, and Claude Code's built-in tools listed in
 * `builtinTools`. The member's own settings, MCP servers, hooks and plugins are not loaded.
 */
export interface AiTurnStepTools {
  /** Record tools (acb_records) by exact name. */
  recordTools: readonly string[]
  /** Record tools by name ending: a business plugin's operations (`<plugin>__update_deal`). */
  recordToolEndings: readonly string[]
  /** Claude Code built-in tools the step declares ([] = none at all). */
  builtinTools: readonly string[]
}

export interface AiTurnStepDefinition<Step extends string = string> {
  /** The step's name: the server's execution run is per record and step (S10b). */
  step: Step
  /** The record ids this step runs (a kind may have several steps: the record's state picks one, `aiTurnStepForRecord`). */
  recordId: RegExp
  /**
   * Where the runner's queue gets these records: `minutes` = main's received minutes
   * (`minutes:notices`, only while Google may read them); `ai-turn` = the task list's 「AI の番」
   * (the server's `aiTurn`).
   */
  listedBy: 'minutes' | 'ai-turn'
  /**
   * The type's first AI action, run by main at the version read just before, and the state it
   * starts from. `action: null`: the type has no start mark (an interaction in 届いた) — the
   * server's execution run alone decides which PC runs it, and the run's own writes are compared
   * at the version the claim read. `from` may name several AI-turn states (a 返事のお願い: 準備中 and
   * 確かめ中) only with `action: null`.
   */
  claim: { action: string | null; from: string | readonly string[] }
  /**
   * The record's state after the run (main's `aiTurns:settle`): `done` = finished; `couldNot` =
   * the AI said it could not (a person looks); `closed` = a person ended it meanwhile; `working` =
   * still in progress, put back with `putBack` when the server's run finish did not (null: the
   * working state is the claim's own from-state, nothing to put back).
   */
  settle: { done: readonly string[]; couldNot: readonly string[]; closed: readonly string[]; working: string; putBack: string | null }
  tools: AiTurnStepTools
  /** The hidden consultation: its title, and whether it is linked to the minutes (chat history `minutesId`). */
  consultationTitle(candidate: AiTurnCandidate): string
  linksMinutes: boolean
  /** The first message, with the record's version after the claim (null when the server did not say). */
  firstMessage(candidate: AiTurnCandidate, version: number | null): string
}

/** The states a step's claim starts from (one or several). */
export function claimStates(step: Pick<AiTurnStepDefinition, 'claim'>): readonly string[] {
  return typeof step.claim.from === 'string' ? [step.claim.from] : step.claim.from
}
