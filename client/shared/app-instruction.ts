/**
 * A first message the app composed for the AI (「相談する」 on a task, a plugin's person step):
 * the AI receives its text as the turn's message, but it is never shown as the member's own words
 * — not as a bubble, not in the list's preview. The chat shows a small chip naming what the
 * consultation is about instead (tasks-ui.md "Consulting about a task"). Pure: renderer, main
 * (the history summary) and tests use it.
 */
import { TOPIC_RECORD_RE } from './task-consult'

export interface AppInstruction {
  /** `task`: 「相談する」 on a task; `step`: a business plugin's person step on a record. */
  kind: 'task' | 'step'
  recordId: string
  /** The task's title, or the step's consultation title. */
  title: string
}

/** A stored or received value read back as an instruction marker; anything else is not one. */
export function readAppInstruction(value: unknown): AppInstruction | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (v.kind !== 'task' && v.kind !== 'step') return null
  if (typeof v.recordId !== 'string' || !TOPIC_RECORD_RE.test(v.recordId)) return null
  if (typeof v.title !== 'string') return null
  return { kind: v.kind, recordId: v.recordId, title: v.title.slice(0, 300) }
}

/** The marker on a live chat message (AI SDK `metadata.appInstruction`). */
export function appInstructionOf(message: { metadata?: unknown }): AppInstruction | null {
  const metadata = message.metadata
  return metadata && typeof metadata === 'object' ? readAppInstruction((metadata as { appInstruction?: unknown }).appInstruction) : null
}

/**
 * A message the app sent in the member's place when it started a consultation (`chat.newConsultation`: a Skill's 実行,
 * reading minutes, 「会議のたたき台を作る」, 「AI に直してもらう」; and an automatic 「AI の番」's first message), or into the
 * current one (`chat.askToFix`: a document's 「AI に直してもらう」, the passage as outside text): shown as a
 * bubble like the member's, but not words the member typed. Its text may carry outside text (minutes, a Skill someone
 * else wrote), so it never counts as the member's own request (records.md "The AI at the member's request",
 * `latestMemberText`). AI SDK `metadata.appSent`, stored with the message.
 */
export function appSentOf(message: { metadata?: unknown }): boolean {
  const metadata = message.metadata
  return !!metadata && typeof metadata === 'object' && (metadata as { appSent?: unknown }).appSent === true
}

/** The chip's text at the top of the consultation. */
export function appInstructionLabel(instruction: AppInstruction): string {
  const title = instruction.title.trim() || (instruction.kind === 'task' ? 'やること' : '手順')
  return instruction.kind === 'task' ? `このやることについての相談：${title}` : `この手順についての相談：${title}`
}
