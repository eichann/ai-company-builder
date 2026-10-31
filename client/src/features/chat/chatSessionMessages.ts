import type { UIMessage } from 'ai'
import { referenceFromTool, type ConsultationReference } from '../../../shared/consultation-reference'
import type { ChatSession } from '../../../shared/chat-history'
import type { GenerateTitleRequest } from '../../../shared/chat-server-api'
import { REVIEW_PART_TYPE, readReviewRecord, type ReviewRecord } from '../../../shared/review-request'
import { PLUGIN_OPERATION_PART_TYPE, readPluginOperationCard, type PluginOperationCard } from '../../../shared/plugin-operations'
import { APPROVAL_PART_TYPE, readApprovalCardRef, type ApprovalCardRef } from '../../../shared/approvals'
import { restoreTextWithChoices, storedChoiceFromPart, storedSteerFromPart, type StoredChoicePrompt, type StoredSteer } from './choiceHistory'

// Conversion between the chat's live messages (AI SDK UIMessage) and the
// stored history (shared/chat-history.ts ChatSession). Pure; the history
// store and its fingerprints depend on the exact output, so keep it stable.

export type SessionMessage = ChatSession['messages'][0]

/** Autosave cadence (was 1 s; every tick re-serialised whole conversations in every tab). */
export const AUTOSAVE_INTERVAL_MS = 4000

export function uiMessageToSessionMessage(msg: UIMessage, timestamp: Date): SessionMessage {
  let content = ''
  let thinking: string | undefined
  const consultationReferences: ConsultationReference[] = []
  const choicePrompts: StoredChoicePrompt[] = []
  const steerInstructions: StoredSteer[] = []
  const reviewRequests: ReviewRecord[] = []
  const pluginOperations: PluginOperationCard[] = []
  const approvals: ApprovalCardRef[] = []
  for (const part of msg.parts) {
    if (part.type === APPROVAL_PART_TYPE) {
      const ref = readApprovalCardRef((part as { data?: unknown }).data)
      if (ref && !approvals.some(a => a.id === ref.id)) approvals.push(ref)
      continue
    }
    if (part.type === PLUGIN_OPERATION_PART_TYPE) {
      const card = readPluginOperationCard((part as { data?: unknown }).data)
      if (card && !pluginOperations.some(c => c.id === card.id)) pluginOperations.push(card)
      continue
    }
    if (part.type === REVIEW_PART_TYPE) {
      const review = readReviewRecord((part as { data?: unknown }).data)
      if (review && !reviewRequests.some(r => r.id === review.id)) reviewRequests.push(review)
      continue
    }
    // seq: the record's place among this reply's questions and instructions.
    const seq = choicePrompts.length + steerInstructions.length
    const choice = storedChoiceFromPart(part as { type: string; data?: unknown }, content.length, choicePrompts, seq)
    if (choice) { choicePrompts.push(choice); continue }
    const steer = storedSteerFromPart(part as { type: string; data?: unknown }, content.length, steerInstructions, seq)
    if (steer) { steerInstructions.push(steer); continue }
    const p = part as { type: string; toolName?: string; output?: unknown; data?: ConsultationReference }
    const ref = p.type === 'data-consultation-reference' ? p.data : referenceFromTool(p.toolName || p.type.replace(/^tool-/, ''), p.output)
    if (ref && !consultationReferences.some(r => r.id === ref.id)) consultationReferences.push(ref)
    if (part.type === 'text') content += part.text
    if (part.type === 'reasoning') thinking = (thinking || '') + part.text
    // Summarize tool invocations as text
    if (typeof part.type === 'string' && part.type.startsWith('tool-')) {
      const toolName = part.type.replace('tool-', '')
      content += `\n[Tool: ${toolName}]`
    }
    if (part.type === 'dynamic-tool') {
      const dynPart = part as { toolName: string }
      content += `\n[Tool: ${dynPart.toolName}]`
    }
  }
  return {
    id: msg.id,
    role: msg.role as 'user' | 'assistant',
    content,
    timestamp: timestamp.toISOString(),
    thinking,
    ...(consultationReferences.length ? { consultationReferences } : {}),
    ...(choicePrompts.length ? { choicePrompts } : {}),
    ...(steerInstructions.length ? { steerInstructions } : {}),
    ...(reviewRequests.length ? { reviewRequests } : {}),
    ...(pluginOperations.length ? { pluginOperations } : {}),
    ...(approvals.length ? { approvals } : {}),
  }
}

// Converted messages, per UIMessage object: while a reply streams only its own
// object changes (@ai-sdk/react replaces just the last message), so an
// autosave converts one message instead of the whole conversation.
const sessionMessageCache = new WeakMap<UIMessage, { at: number; images?: string[]; referenceFiles?: string[]; value: SessionMessage }>()

export function sessionMessageFor(msg: UIMessage, timestamp: Date, images?: string[], referenceFiles?: string[]): SessionMessage {
  const cached = sessionMessageCache.get(msg)
  if (cached && cached.at === timestamp.getTime() && cached.images === images && cached.referenceFiles === referenceFiles) return cached.value
  const value = {
    ...uiMessageToSessionMessage(msg, timestamp),
    ...(images ? { images } : {}),
    ...(referenceFiles ? { referenceFiles } : {}),
  }
  sessionMessageCache.set(msg, { at: timestamp.getTime(), images, referenceFiles, value })
  return value
}

/** Same objects in the same order (Object.is): nothing a save is built from changed. */
export function sameSaveInputs(a: unknown[] | null, b: unknown[]): boolean {
  return !!a && a.length === b.length && a.every((value, i) => Object.is(value, b[i]))
}

export function sessionMessageToUIMessage(msg: SessionMessage): UIMessage {
  const parts: UIMessage['parts'] = []
  if (msg.thinking) {
    parts.push({ type: 'reasoning' as const, text: msg.thinking })
  }
  // Answered (or closed) choice prompts come back collapsed, with the member's answer, where they were asked.
  parts.push(...restoreTextWithChoices(msg.content, msg.choicePrompts, msg.steerInstructions))
  for (const ref of msg.consultationReferences || []) parts.push({ type: 'data-consultation-reference', data: ref })
  for (const stored of msg.pluginOperations || []) {
    const card = readPluginOperationCard(stored)
    if (card) parts.push({ type: PLUGIN_OPERATION_PART_TYPE, id: `plugin-op-${card.id}`, data: card })
  }
  for (const stored of msg.approvals || []) {
    const ref = readApprovalCardRef(stored)
    if (ref) parts.push({ type: APPROVAL_PART_TYPE, id: `approval-${ref.id}`, data: ref })
  }
  for (const review of msg.reviewRequests || []) {
    const record = readReviewRecord(review)
    if (record) parts.push({ type: REVIEW_PART_TYPE, id: `review-${record.id}`, data: record })
  }
  return {
    id: msg.id,
    role: msg.role as 'user' | 'assistant',
    parts,
  }
}

/** The plain text of a message (its text parts). */
export function messageText(msg: UIMessage): string {
  let text = ''
  for (const part of msg.parts) {
    if (part.type === 'text') text += part.text
  }
  return text
}

/** A new conversation's first message: the assistant's greeting (id '1'). */
export function greetingMessages(text: string): UIMessage[] {
  return [{ id: '1', role: 'assistant' as const, parts: [{ type: 'text' as const, text }] }]
}

/**
 * The transcript sent for title generation: the greeting left out, the next
 * six messages, empty ones dropped.
 */
export function titleTranscript(messages: UIMessage[]): GenerateTitleRequest['messages'] {
  return messages.slice(1, 7).map(m => ({
    role: m.role as 'user' | 'assistant',
    content: messageText(m),
  })).filter(m => m.content.trim().length > 0)
}
