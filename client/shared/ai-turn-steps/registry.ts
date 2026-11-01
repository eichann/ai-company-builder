/**
 * Every kind of 「AI の番」 the app runs automatically (`.claude/rules/ai-turns.md` "Steps"). A
 * new kind is one file in this folder plus one line below; main's claim and settle, the runner's
 * queue and the chat server's least-privilege filter all read the kind from here. Pure.
 */
import type { MinutesNotice } from '../minutes-app'
import type { TaskListItem } from '../tasks'
import { inboxTriage } from './inbox-triage'
import { minutesReading } from './minutes-reading'
import type { AiTurnCandidate, AiTurnStepDefinition } from './types'

const STEPS = [
  minutesReading,
  // Lanes (ipc-and-main-process.md "Lane markers"): add only right under your lane's ▼.
  // lane A ▼
  // lane A ▲
  // lane B ▼
  inboxTriage,
  // lane B ▲
  // lane C ▼
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
    const bad = s.tools.recordTools.find(n => !TOOL_NAME.test(n))
      ?? s.tools.recordToolEndings.find(e => !TOOL_ENDING.test(e))
      ?? s.tools.builtinTools.find(n => !TOOL_NAME.test(n))
    if (bad !== undefined) return `${s.step}: tool "${bad}" is not one exact tool`
  }
  return null
}

const problem = checkAiTurnSteps(STEPS)
if (problem) throw new Error(`ai-turn-steps: ${problem}`)

/** The steps by name. */
export const AI_TURN_STEPS: ReadonlyMap<string, Step> = new Map(STEPS.map((s): [string, Step] => [s.step, s]))

export function isAiTurnStep(value: unknown): value is AiTurnStep {
  return typeof value === 'string' && AI_TURN_STEPS.has(value)
}

export function aiTurnStepDefinition(step: AiTurnStep): Step {
  return AI_TURN_STEPS.get(step)!
}

/** The step that runs this record, or null (a kind the app does not run). */
export function aiTurnStepForRecord(recordId: string): Step | null {
  return [...AI_TURN_STEPS.values()].find(s => s.recordId.test(recordId)) ?? null
}

/** Whether the step declares this record tool (its plain name, not the mcp__ id). */
export function aiTurnStepAllowsRecordTool(step: AiTurnStep, name: string): boolean {
  const tools = aiTurnStepDefinition(step).tools
  return tools.recordTools.includes(name) || tools.recordToolEndings.some(ending => name.endsWith(ending) && name.length > ending.length)
}

/**
 * The runner's queue: every record waiting for the member's AI whose kind has a step — received
 * minutes from main's check (`listedBy: 'minutes'`), the rest from the task list's 「AI の番」
 * (`turn: 'ai'`).
 */
export function aiTurnQueue(input: { minutes: readonly MinutesNotice[]; tasks: readonly TaskListItem[] }): AiTurnCandidate[] {
  const queue: AiTurnCandidate[] = []
  const seen = new Set<string>()
  for (const n of input.minutes) {
    if (aiTurnStepForRecord(n.id)?.listedBy !== 'minutes' || seen.has(n.id)) continue
    seen.add(n.id)
    queue.push({ id: n.id, title: n.title, version: n.version, meetingAt: n.meetingAt })
  }
  for (const r of input.tasks) {
    if (r.turn !== 'ai' || aiTurnStepForRecord(r.id)?.listedBy !== 'ai-turn' || seen.has(r.id)) continue
    seen.add(r.id)
    queue.push({ id: r.id, title: r.title, version: r.version, dueAt: r.due })
  }
  return queue
}
