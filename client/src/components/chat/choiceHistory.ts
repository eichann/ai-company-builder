import { CHOICE_PART_TYPE, readChoiceRecord, type ChoicePromptRecord } from '../../../shared/choice-prompt'

/**
 * Choice prompts in chat history. History keeps an assistant reply as one
 * flattened `content` string, so each prompt is stored with `at`: the length
 * of `content` when it was asked. Restoring splits the text there, and the
 * collapsed question + the member's answer come back where they were.
 */
export type StoredChoicePrompt = ChoicePromptRecord & { at?: number }

/** A `data-choice-prompt` part seen while flattening (content so far = `at`). */
export function storedChoiceFromPart(part: { type: string; data?: unknown }, at: number, seen: readonly StoredChoicePrompt[]): StoredChoicePrompt | undefined {
  if (part.type !== CHOICE_PART_TYPE) return undefined
  const record = readChoiceRecord(part.data)
  if (!record || seen.some(r => r.id === record.id)) return undefined
  return { ...record, at }
}

type RestoredPart = { type: 'text'; text: string } | { type: typeof CHOICE_PART_TYPE; id: string; data: ChoicePromptRecord }

/** `content` + stored prompts → text and choice parts in their original order. */
export function restoreTextWithChoices(content: string, stored: readonly unknown[] | undefined): RestoredPart[] {
  const records: Array<{ record: ChoicePromptRecord; at: number }> = []
  for (const value of stored ?? []) {
    const record = readChoiceRecord(value)
    if (!record) continue
    const raw = (value as { at?: unknown }).at
    const at = typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0 ? Math.min(raw, content.length) : content.length
    records.push({ record, at })
  }
  if (records.length === 0) return [{ type: 'text', text: content }]
  records.sort((a, b) => a.at - b.at)
  const parts: RestoredPart[] = []
  let from = 0
  for (const { record, at } of records) {
    if (at > from) parts.push({ type: 'text', text: content.slice(from, at) })
    parts.push({ type: CHOICE_PART_TYPE, id: `choice-${record.id}`, data: record })
    from = at
  }
  if (from < content.length) parts.push({ type: 'text', text: content.slice(from) })
  return parts
}
