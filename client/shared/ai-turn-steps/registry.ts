/**
 * Every kind of 「AI の番」 the app runs automatically (`.claude/rules/ai-turns.md` "Steps"). A
 * new kind is one file in this folder plus one line below; main's claim and settle, the runner's
 * queue and the chat server's least-privilege filter all read the kind from here. Pure.
 */
import type { MinutesNotice } from '../minutes-app'
import type { TaskListItem } from '../tasks'
import { inboxTriage } from './inbox-triage'
import { followUp } from './follow-up'
import { replyCheck } from './reply-check'
import { minutesReading } from './minutes-reading'
// lane C ▼
import { pluginTurnCandidate, type QueuedPluginStep } from './plugin'
import { taskWaitOver } from './task-wait-over'
// lane C ▲
import { claimStates, type AiTurnCandidate, type AiTurnStepDefinition } from './types'
import { coreStepCreateTypes } from '../../../shared/core/ai-runs'

const STEPS = [
  minutesReading,
  // Lanes (ipc-and-main-process.md "Lane markers"): add only right under your lane's ▼.
  // lane A ▼
  // lane A ▲
  // lane B ▼
  inboxTriage,
  followUp,
  replyCheck,
  // lane B ▲
  // lane C ▼
  taskWaitOver,
  // lane C ▲
] as const satisfies readonly AiTurnStepDefinition[]

/** A step's name (`minutes-reading`). */
export type AiTurnStep = (typeof STEPS)[number]['step']

type Step = AiTurnStepDefinition<AiTurnStep>

const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/
const TOOL_ENDING = /^__[a-z0-9_]{1,60}$/

/**
 * A list of steps the app may run, or the reason it may not: names once each, and tools named
 * exactly — an ending must be a whole operation (`__update_deal`), never one that matches every
 * tool, and no wildcard among the built-in tools (least privilege, `ai-turns.md`).
 */
export function checkAiTurnSteps(steps: readonly AiTurnStepDefinition[]): string | null {
  const names = new Set<string>()
  for (const s of steps) {
    if (names.has(s.step)) return `${s.step}: the step is listed twice`
    names.add(s.step)
    if (s.recordId.test('')) return `${s.step}: its record id pattern matches any id`
    if (typeof s.claim.from !== 'string' && (s.claim.action !== null || s.claim.from.length === 0)) return `${s.step}: several from-states only without a start mark`
    // Two steps of one kind must start from different states, or the state could not pick one.
    const sameStart = steps.find(o => o !== s && o.recordId.source === s.recordId.source && claimStates(o).some(f => claimStates(s).includes(f)))
    if (sameStart) return `${s.step}: starts from the same state as ${sameStart.step}`
    const bad = s.tools.recordTools.find(n => !TOOL_NAME.test(n))
      ?? s.tools.recordToolEndings.find(e => !TOOL_ENDING.test(e))
      ?? s.tools.builtinTools.find(n => !TOOL_NAME.test(n))
    if (bad !== undefined) return `${s.step}: tool "${bad}" is not one exact tool`
  }
  return null
}

/**
 * Every built-in step is in the server's table of what it may create (`CORE_STEP_CREATE_TYPES`),
 * and lists `records_create` exactly when it may create something: the app and the server agree.
 */
export function checkCreateTypes(steps: readonly AiTurnStepDefinition[]): string | null {
  for (const s of steps) {
    const types = coreStepCreateTypes(s.step)
    if (types === undefined) return `${s.step}: not in CORE_STEP_CREATE_TYPES`
    if (s.tools.recordTools.includes('records_create') !== types.length > 0) return `${s.step}: records_create and CORE_STEP_CREATE_TYPES disagree`
  }
  return null
}

const problem = checkAiTurnSteps(STEPS) ?? checkCreateTypes(STEPS)
if (problem) throw new Error(`ai-turn-steps: ${problem}`)

/** The steps by name. */
export const AI_TURN_STEPS: ReadonlyMap<string, Step> = new Map(STEPS.map((s): [string, Step] => [s.step, s]))

export function isAiTurnStep(value: unknown): value is AiTurnStep {
  return typeof value === 'string' && AI_TURN_STEPS.has(value)
}

export function aiTurnStepDefinition(step: AiTurnStep): Step {
  return AI_TURN_STEPS.get(step)!
}

/**
 * The step that runs this record, or null (a kind the app does not run). With the record's state,
 * the step that starts or works there; without it, or none matching, the kind's first step.
 */
export function aiTurnStepForRecord(recordId: string, state?: string | null): Step | null {
  const steps = [...AI_TURN_STEPS.values()].filter(s => s.recordId.test(recordId))
  if (steps.length === 0) return null
  if (state) {
    const found = steps.find(s => claimStates(s).includes(state) || s.settle.working === state)
    if (found) return found
  }
  return steps[0]
}

/** Whether the step declares this record tool (its plain name, not the mcp__ id). */
export function aiTurnStepAllowsRecordTool(step: AiTurnStep, name: string): boolean {
  const tools = aiTurnStepDefinition(step).tools
  return tools.recordTools.includes(name) || tools.recordToolEndings.some(ending => name.endsWith(ending) && name.length > ending.length)
}

/**
 * Whether the step may make this call: its tool (`aiTurnStepAllowsRecordTool`) and, for
 * `records_create`, only a type the step may create (`CORE_STEP_CREATE_TYPES`; the server checks
 * the same for the run's token). Text from outside starts these runs: a step makes only what its
 * job needs.
 */
export function aiTurnStepAllowsRecordCall(step: AiTurnStep, name: string, input: unknown): boolean {
  if (!aiTurnStepAllowsRecordTool(step, name)) return false
  if (name !== 'records_create') return true
  const type = typeof input === 'object' && input !== null ? (input as { type?: unknown }).type : undefined
  return typeof type === 'string' && (coreStepCreateTypes(step) ?? []).includes(type)
}

/** The record types the step may create ([] = none). */
export function aiTurnStepCreateTypes(step: AiTurnStep): readonly string[] {
  return coreStepCreateTypes(step) ?? []
}

/**
 * The runner's queue: every record waiting for the member's AI whose kind has a step — received
 * minutes from main's check (`listedBy: 'minutes'`), the rest from the task list's 「AI の番」
 * (`turn: 'ai'`). `asked`: meetings the member asked to be read themselves (they run while
 * 「自動で進める」 is off too).
 */
export function aiTurnQueue(input: { minutes: readonly MinutesNotice[]; tasks: readonly TaskListItem[]; plugins?: readonly QueuedPluginStep[]; asked?: ReadonlySet<string> }): AiTurnCandidate[] {
  const queue: AiTurnCandidate[] = []
  const seen = new Set<string>()
  // lane C ▼
  // One claim per record: a record a business plugin's step covers runs that step, never a core one too.
  const byPlugin = new Set((input.plugins ?? []).map(t => t.recordId))
  // lane C ▲
  for (const n of input.minutes) {
    if (aiTurnStepForRecord(n.id, 'received')?.listedBy !== 'minutes' || byPlugin.has(n.id) || seen.has(n.id)) continue
    seen.add(n.id)
    queue.push({ id: n.id, title: n.title, version: n.version, meetingAt: n.meetingAt, state: 'received', ...(input.asked?.has(n.id) ? { asked: true as const } : {}) })
  }
  for (const r of input.tasks) {
    const step = r.turn === 'ai' ? aiTurnStepForRecord(r.id, r.state) : null
    if (step?.listedBy !== 'ai-turn' || (step.onlyWaitOver && !r.waitOver) || byPlugin.has(r.id) || seen.has(r.id)) continue
    seen.add(r.id)
    const notUrgent = step.dueIsTheAisTurn ? !step.dueIsTheAisTurn({ state: r.state ?? '', waitOver: r.waitOver === true }) : false
    queue.push({ id: r.id, title: r.title, version: r.version, dueAt: r.due, state: r.state, ...(notUrgent ? { notUrgent: true as const } : {}) })
  }
  // lane C ▼
  // A business plugin's steps (plugin.ts): the server's list of the member's records at an ai_turn step.
  for (const t of input.plugins ?? []) {
    if (seen.has(t.recordId)) continue
    seen.add(t.recordId)
    queue.push(pluginTurnCandidate(t))
  }
  // lane C ▲
  return queue
}
