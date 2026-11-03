import type { UIMessage } from 'ai'
import { referenceFromTool, type ConsultationReference } from '../../../shared/consultation-reference'
import type { ChatSession } from '../../../shared/chat-history'
import type { GenerateTitleRequest } from '../../../shared/chat-server-api'
import { REVIEW_PART_TYPE, readReviewRecord, type ReviewRecord } from '../../../shared/review-request'
import { PLUGIN_OPERATION_PART_TYPE, readPluginOperationCard, type PluginOperationCard } from '../../../shared/plugin-operations'
import { APPROVAL_PART_TYPE, readApprovalCardRef, type ApprovalCardRef } from '../../../shared/approvals'
import { MINUTES_BUNDLE_CHOICE_PART_TYPE, readMinutesBundleChoiceCard, type MinutesBundleChoiceCard } from '../../../shared/minutes-app'
import { MAIL_DRAFT_PART_TYPE, readMailDraftCard, type MailDraftCard } from '../../../shared/outbound-mail'
import { restoreTextWithChoices, storedChoiceFromPart, storedSteerFromPart, type StoredChoicePrompt, type StoredSteer } from './choiceHistory'
import { RESTORED_TOOL_PART_TYPE, TOOL_MARKER_RE, restoredToolLine, storedToolLine, type StoredToolLine } from '../../../shared/tool-display'
import { toolRowOf } from './toolRows'
import { appInstructionOf, readAppInstruction } from '../../../shared/app-instruction'
import { SECOND_OPINION_PART_TYPE, readSecondOpinionRecord, type SecondOpinionRecord } from '../../../shared/agents/second-opinion'

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
  const minutesDealChoices: MinutesBundleChoiceCard[] = []
  // The app's cards, in the order the tools produced them (restored in that order).
  const cardOrder: string[] = []
  const mailDrafts: MailDraftCard[] = []
  const secondOpinions: SecondOpinionRecord[] = []
  const toolLines: Record<string, StoredToolLine> = {}
  const appInstruction = appInstructionOf(msg)
  for (const part of msg.parts) {
    if (part.type === APPROVAL_PART_TYPE) {
      const ref = readApprovalCardRef((part as { data?: unknown }).data)
      if (ref && !approvals.some(a => a.id === ref.id)) { approvals.push(ref); cardOrder.push(`approval-${ref.id}`) }
      continue
    }
    if (part.type === PLUGIN_OPERATION_PART_TYPE) {
      const card = readPluginOperationCard((part as { data?: unknown }).data)
      if (card && !pluginOperations.some(c => c.id === card.id)) { pluginOperations.push(card); cardOrder.push(`plugin-op-${card.id}`) }
      continue
    }
    if (part.type === MINUTES_BUNDLE_CHOICE_PART_TYPE) {
      const card = readMinutesBundleChoiceCard((part as { data?: unknown }).data)
      if (card && !minutesDealChoices.some(c => c.id === card.id)) { minutesDealChoices.push(card); cardOrder.push(`minutes-deal-${card.id}`) }
      continue
    }
    if (part.type === MAIL_DRAFT_PART_TYPE) {
      const card = readMailDraftCard((part as { data?: unknown }).data)
      if (card && !mailDrafts.some(c => c.id === card.id)) { mailDrafts.push(card); cardOrder.push(`mail-draft-${card.id}`) }
      continue
    }
    if (part.type === SECOND_OPINION_PART_TYPE) {
      const record = readSecondOpinionRecord((part as { data?: unknown }).data)
      if (record && !secondOpinions.some(r => r.id === record.id)) secondOpinions.push(record)
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
    // Tool calls are kept as `[Tool: name]` markers (the hand-off compares this text), plus the labels of the app's tools.
    const row = toolRowOf(part)
    if (row) {
      content += `\n[Tool: ${row.toolName}]`
      const stored = storedToolLine(row.toolName, row.line)
      if (stored) toolLines[row.toolName] = stored
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
    ...(minutesDealChoices.length ? { minutesDealChoices } : {}),
    ...(cardOrder.length > 1 ? { cardOrder } : {}),
    ...(mailDrafts.length ? { mailDrafts } : {}),
    ...(secondOpinions.length ? { secondOpinions } : {}),
    ...(Object.keys(toolLines).length ? { toolLines } : {}),
    ...(appInstruction ? { appInstruction } : {}),
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
  const toolCalls = { n: 0 }
  for (const part of restoreTextWithChoices(msg.content, msg.choicePrompts, msg.steerInstructions)) {
    if (part.type === 'text') parts.push(...restoreToolMarkers(part.text, msg.toolLines, toolCalls))
    else parts.push(part)
  }
  for (const ref of msg.consultationReferences || []) parts.push({ type: 'data-consultation-reference', data: ref })
  const cards: UIMessage['parts'] = []
  for (const stored of msg.pluginOperations || []) {
    const card = readPluginOperationCard(stored)
    if (card) cards.push({ type: PLUGIN_OPERATION_PART_TYPE, id: `plugin-op-${card.id}`, data: card })
  }
  for (const stored of msg.approvals || []) {
    const ref = readApprovalCardRef(stored)
    if (ref) cards.push({ type: APPROVAL_PART_TYPE, id: `approval-${ref.id}`, data: ref })
  }
  for (const stored of msg.minutesDealChoices || []) {
    const card = readMinutesBundleChoiceCard(stored)
    if (card) cards.push({ type: MINUTES_BUNDLE_CHOICE_PART_TYPE, id: `minutes-deal-${card.id}`, data: card })
  }
  for (const stored of msg.mailDrafts || []) {
    const card = readMailDraftCard(stored)
    if (card) cards.push({ type: MAIL_DRAFT_PART_TYPE, id: `mail-draft-${card.id}`, data: card })
  }
  parts.push(...inCardOrder(cards, msg.cardOrder))
  for (const stored of msg.secondOpinions || []) {
    const record = readSecondOpinionRecord(stored)
    if (record) parts.push({ type: SECOND_OPINION_PART_TYPE, id: `second-opinion-${record.id}`, data: record })
  }
  for (const review of msg.reviewRequests || []) {
    const record = readReviewRecord(review)
    if (record) parts.push({ type: REVIEW_PART_TYPE, id: `review-${record.id}`, data: record })
  }
  const appInstruction = readAppInstruction(msg.appInstruction)
  return {
    id: msg.id,
    role: msg.role as 'user' | 'assistant',
    ...(appInstruction ? { metadata: { appInstruction } } : {}),
    parts,
  }
}

/** A stored text with its `\n[Tool: name]` markers turned back into tool rows (saved again as the same markers). */
export function restoreToolMarkers(text: string, toolLines: SessionMessage['toolLines'], counter = { n: 0 }): UIMessage['parts'] {
  const parts: UIMessage['parts'] = []
  let from = 0
  for (const match of text.matchAll(TOOL_MARKER_RE)) {
    const at = match.index ?? 0
    if (at > from) parts.push({ type: 'text', text: text.slice(from, at) })
    const toolName = match[1]
    parts.push({ type: RESTORED_TOOL_PART_TYPE, id: `tool-call-${counter.n++}`, data: { toolName, line: restoredToolLine(toolName, toolLines?.[toolName]) } } as UIMessage['parts'][number])
    from = at + match[0].length
  }
  if (from === 0) return [{ type: 'text', text }]
  if (from < text.length) parts.push({ type: 'text', text: text.slice(from) })
  return parts
}

/** Cards in their stored order (`cardOrder`); a card it does not name keeps its place after the named ones. */
export function inCardOrder(cards: UIMessage['parts'], order: string[] | undefined): UIMessage['parts'] {
  if (!Array.isArray(order) || order.length === 0) return cards
  const rank = (part: UIMessage['parts'][number]) => {
    const i = order.indexOf((part as { id?: string }).id ?? '')
    return i === -1 ? order.length : i
  }
  return cards.map((part, i) => ({ part, i })).sort((a, b) => rank(a.part) - rank(b.part) || a.i - b.i).map(x => x.part)
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
  return messages.slice(1, 7).filter(m => !appInstructionOf(m)).map(m => ({
    role: m.role as 'user' | 'assistant',
    content: messageText(m),
  })).filter(m => m.content.trim().length > 0)
}
