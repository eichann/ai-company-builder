import { CHOICE_PART_TYPE, readChoiceRecord, type ChoicePromptRecord } from '../../../shared/choice-prompt'
import { STEER_PART_TYPE, readSteerRecord, type SteerRecord } from '../../../shared/steer'

/**
 * Choice prompts in chat history. History keeps an assistant reply as one
 * flattened `content` string, so each prompt is stored with `at`: the length
 * of `content` when it was asked. Restoring splits the text there, and the
 * collapsed question + the member's answer come back where they were.
 *
 * `seq` is the record's place among the reply's questions and extra
 * instructions, in live order: a question and an instruction can share one
 * `at` (nothing was written between them), and only `seq` says which came
 * first. It survives a save → restore → save unchanged. History written before `seq` existed has
 * none; those records keep the stored order (questions, then instructions).
 */
export type StoredChoicePrompt = ChoicePromptRecord & { at?: number; seq?: number }

const withSeq = (seq: number | undefined) => seq === undefined ? {} : { seq }

/** A `data-choice-prompt` part seen while flattening (content so far = `at`, records so far = `seq`). */
export function storedChoiceFromPart(part: { type: string; data?: unknown }, at: number, seen: readonly StoredChoicePrompt[], seq?: number): StoredChoicePrompt | undefined {
  if (part.type !== CHOICE_PART_TYPE) return undefined
  const record = readChoiceRecord(part.data)
  if (!record || seen.some(r => r.id === record.id)) return undefined
  return { ...record, at, ...withSeq(seq) }
}

/** Extra instructions sent while the AI worked (shared/steer.ts), kept the same way. */
export type StoredSteer = SteerRecord & { at?: number; seq?: number }

/** A `data-steer` part seen while flattening (content so far = `at`, records so far = `seq`). */
export function storedSteerFromPart(part: { type: string; data?: unknown }, at: number, seen: readonly StoredSteer[], seq?: number): StoredSteer | undefined {
  if (part.type !== STEER_PART_TYPE) return undefined
  const record = readSteerRecord(part.data)
  if (!record || seen.some(r => r.id === record.id)) return undefined
  return { ...record, at, ...withSeq(seq) }
}

type RestoredPart = { type: 'text'; text: string }
  | { type: typeof CHOICE_PART_TYPE; id: string; data: ChoicePromptRecord }
  | { type: typeof STEER_PART_TYPE; id: string; data: SteerRecord }

/** `content` + stored prompts (and extra instructions) → text, choice and steer parts in their original order. */
export function restoreTextWithChoices(content: string, stored: readonly unknown[] | undefined, steers?: readonly unknown[]): RestoredPart[] {
  const records: Array<{ part: RestoredPart; at: number; seq?: number }> = []
  const offset = (value: unknown) => {
    const raw = (value as { at?: unknown }).at
    return typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0 ? Math.min(raw, content.length) : content.length
  }
  const sequence = (value: unknown) => {
    const raw = (value as { seq?: unknown }).seq
    return typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0 ? raw : undefined
  }
  for (const value of stored ?? []) {
    const record = readChoiceRecord(value)
    if (record) records.push({ part: { type: CHOICE_PART_TYPE, id: `choice-${record.id}`, data: record }, at: offset(value), seq: sequence(value) })
  }
  for (const value of steers ?? []) {
    const record = readSteerRecord(value)
    if (record) records.push({ part: { type: STEER_PART_TYPE, id: `steer-${record.id}`, data: record }, at: offset(value), seq: sequence(value) })
  }
  if (records.length === 0) return [{ type: 'text', text: content }]
  // At the same offset: the live order when every record knows it (`seq`),
  // else (older history) the order they were stored in — the sort is stable.
  const live = records.every(r => r.seq !== undefined)
  records.sort((a, b) => a.at - b.at || (live ? a.seq! - b.seq! : 0))
  const parts: RestoredPart[] = []
  let from = 0
  for (const { part, at } of records) {
    if (at > from) parts.push({ type: 'text', text: content.slice(from, at) })
    parts.push(part)
    from = at
  }
  if (from < content.length) parts.push({ type: 'text', text: content.slice(from) })
  return parts
}
