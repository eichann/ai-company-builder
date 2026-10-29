import type { UIMessage } from 'ai'
import type { AgentInteraction } from '../../shared/agent-interaction'
import { getToolDisplayName, isRunningState, SUBAGENT_TOOL_NAMES, toolRowOf } from '../components/chat/toolRows'
import type { buildConversationRows } from './conversationRows'
import { pendingReviewOf } from './reviewRequest'
import { REVIEW_TOOL_ID } from '../../shared/review-request'

/**
 * Whose turn a conversation is and what its AI is doing (the 「AIへの相談」
 * list). Pure: each open tab derives its status from what it already has
 * (useChat's status, the pending approval / question, the latest assistant
 * message) and publishes it to consultationStatusStore.
 */

export type ConsultationState = 'needs-you' | 'working' | 'unseen' | 'failed' | 'idle'
/** Why it is the member's turn: a permission, a question to answer, or work to review (「確認をお願いします」). */
export type NeedsYouKind = 'approve' | 'question' | 'review'

export interface ConsultationStatus {
  state: ConsultationState
  kind?: NeedsYouKind
  /** One line for the list: what the AI is doing / asking. Empty for idle. */
  line: string
}

export const IDLE_STATUS: ConsultationStatus = { state: 'idle', line: '' }

export interface StatusInputs {
  /** useChat's status. */
  status: string
  /** A tool approval this conversation waits for (ToolApprovalBanner). */
  approval?: { toolName: string; toolInput?: Record<string, unknown> }
  /** A question / permission request of this conversation (AgentInteractionCard). */
  interaction?: AgentInteraction
  /** The latest message of the conversation. */
  lastMessage?: UIMessage
  /** The running subagent's latest progress line (agentStatusStore). */
  progressLine?: string
  /** A turn finished while the member was looking elsewhere. */
  unseen: boolean
  /** The company folder, stripped from paths shown in the line. */
  rootPath?: string
}

const READ = new Set(['Read', 'readFile', 'NotebookRead', 'readSkillFile', 'mcp__acb_company_files__company_read_file'])
const WRITE = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'writeFile'])
const FIND = new Set(['Glob', 'Grep', 'LS', 'listDirectory', 'mcp__acb_company_files__company_search', 'mcp__acb_company_files__company_list'])
const RUN = new Set(['Bash', 'executeCommand'])
const WEB = new Set(['WebFetch', 'WebSearch', 'mcp__acb_web__web_research'])

/** A path shown relative to the company folder (else its last two parts). */
export function shortPath(value: string, rootPath?: string): string {
  const root = rootPath?.replace(/\/+$/, '')
  if (root && value.startsWith(`${root}/`)) return value.slice(root.length + 1)
  const parts = value.split('/').filter(Boolean)
  return parts.length > 2 ? parts.slice(-2).join('/') : value
}

function parsedInput(input: unknown): Record<string, unknown> {
  if (typeof input === 'string') {
    try { const value = JSON.parse(input); return value && typeof value === 'object' ? value : {} } catch { return {} }
  }
  return input && typeof input === 'object' ? input as Record<string, unknown> : {}
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
}

function host(url: string): string {
  try { return new URL(url).hostname } catch { return '' }
}

/** What a tool call is doing, in plain Japanese (no tool names, no command text). */
export function toolActivity(toolName: string, input: unknown, rootPath?: string): string {
  const inp = parsedInput(input)
  const file = text(inp.file_path) || text(inp.notebook_path) || text(inp.path)
  const at = (verb: string, target: string) => target ? `${verb}：${target}` : verb
  if (READ.has(toolName)) return at('ファイルを読んでいます', file && shortPath(file, rootPath))
  if (WRITE.has(toolName)) return at('ファイルを書いています', file && shortPath(file, rootPath))
  if (FIND.has(toolName)) return 'ファイルを探しています'
  if (RUN.has(toolName)) return 'コマンドを実行しています'
  if (WEB.has(toolName)) {
    const urls = Array.isArray(inp.urls) ? inp.urls : []
    return at('Webで調べています', host(text(inp.url) || text(urls[0])))
  }
  if (SUBAGENT_TOOL_NAMES.has(toolName)) return at('手分けして作業しています', text(inp.description))
  if (toolName.startsWith('mcp__acb_consultations__')) return '過去の相談を見ています'
  if (toolName === 'TodoWrite') return '作業の段取りを立てています'
  if (toolName === REVIEW_TOOL_ID) return '確認のお願いを出しています'
  if (toolName === 'Skill') return at('スキルを使っています', text(inp.skill) || text(inp.command))
  return `${getToolDisplayName(toolName)}を使っています`
}

/** The running subagent call of the latest message (whose progress line to show). */
export function runningSubagentId(message?: UIMessage): string | undefined {
  if (!message || message.role !== 'assistant') return undefined
  for (let i = message.parts.length - 1; i >= 0; i--) {
    const row = toolRowOf(message.parts[i])
    if (row && SUBAGENT_TOOL_NAMES.has(row.toolName) && isRunningState(row.state)) return row.toolCallId
  }
  return undefined
}

function workingLine(message: UIMessage | undefined, progressLine: string | undefined, rootPath?: string): string {
  if (progressLine) return progressLine
  if (!message || message.role !== 'assistant') return '考えています'
  for (let i = message.parts.length - 1; i >= 0; i--) {
    const part = message.parts[i]
    const row = toolRowOf(part)
    if (row) return isRunningState(row.state) ? toolActivity(row.toolName, row.input, rootPath) : '考えています'
    if (part.type === 'text') return part.state === 'streaming' ? '返事を書いています' : '考えています'
    if (part.type === 'reasoning') return '考えています'
  }
  return '考えています'
}

function interactionLine(interaction: AgentInteraction): ConsultationStatus {
  if (interaction.kind === 'permissions') {
    return { state: 'needs-you', kind: 'approve', line: `許可を待っています：${interaction.entries[0]?.label ?? interaction.reason}` }
  }
  const question = text(interaction.questions[0]?.question)
  return { state: 'needs-you', kind: 'question', line: question || '質問に答えてください' }
}

export function deriveConsultationStatus(inputs: StatusInputs): ConsultationStatus {
  if (inputs.interaction) return interactionLine(inputs.interaction)
  if (inputs.approval) {
    const inp = inputs.approval.toolInput ?? {}
    const file = text(inp.file_path) || text(inp.path)
    const what = getToolDisplayName(inputs.approval.toolName)
    return { state: 'needs-you', kind: 'approve', line: `許可を待っています：${file ? shortPath(file, inputs.rootPath) : what}` }
  }
  if (inputs.status === 'submitted' || inputs.status === 'streaming') {
    return { state: 'working', line: workingLine(inputs.lastMessage, inputs.progressLine, inputs.rootPath) }
  }
  if (inputs.status === 'error') return { state: 'failed', line: 'エラーで止まりました' }
  // The AI asked for a review and stopped: the member's turn until they answer (even after a restart).
  const review = pendingReviewOf(inputs.lastMessage)
  if (review) return { state: 'needs-you', kind: 'review', line: `確認をお願いします：${review.title}` }
  if (inputs.unseen) return { state: 'unseen', line: '返事が届いています' }
  return IDLE_STATUS
}

export function sameStatus(a: ConsultationStatus, b: ConsultationStatus) {
  return a.state === b.state && a.kind === b.kind && a.line === b.line
}

// --- The list's groups ---------------------------------------------------------

export type ConversationGroupKey = 'needs-you' | 'pinned' | 'failed' | 'working' | 'open' | 'done'
export const CONVERSATION_GROUPS: ReadonlyArray<{ key: ConversationGroupKey; label: string }> = [
  { key: 'needs-you', label: 'あなたの番' },
  { key: 'pinned', label: 'ピン留め' },
  { key: 'failed', label: '止まっています' },
  { key: 'working', label: 'AIが作業中' },
  { key: 'open', label: '開いている相談' },
  { key: 'done', label: '終わったもの' },
]

type Row = ReturnType<typeof buildConversationRows>[number]

/**
 * 「あなたの番」 comes before pinned; a pinned conversation in another state stays under ピン留め.
 * An open tab whose AI is idle (a new one, one with an unread reply, or one the member has read
 * and may continue) is 開いている相談 — unread ones first, marked 新着 by the list; only closed
 * conversations are 終わったもの — closing is how a member ends one.
 */
export function conversationGroupOf(row: Row, status: ConsultationStatus | undefined): ConversationGroupKey {
  const state = row.tab ? status?.state ?? 'idle' : 'idle'
  if (state === 'needs-you') return 'needs-you'
  if (row.session?.pinned) return 'pinned'
  if (state === 'failed' || state === 'working') return state
  return row.tab ? 'open' : 'done'
}

/** Rows in group order (the rows' own order kept inside a group: open tabs first, then by date; unread first in 開いている相談). */
export function groupConversationRows(rows: Row[], statusOf: (tabId: string) => ConsultationStatus | undefined) {
  const grouped = new Map<ConversationGroupKey, Row[]>(CONVERSATION_GROUPS.map(g => [g.key, []]))
  for (const row of rows) grouped.get(conversationGroupOf(row, row.tab ? statusOf(row.tab.id) : undefined))!.push(row)
  const unread = (row: Row) => Number(!!row.tab && statusOf(row.tab.id)?.state === 'unseen')
  grouped.get('open')!.sort((a, b) => unread(b) - unread(a))
  return CONVERSATION_GROUPS.map(group => ({ ...group, rows: grouped.get(group.key)! })).filter(group => group.rows.length > 0)
}
