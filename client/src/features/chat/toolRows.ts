import type { UIMessage } from 'ai'
import { RESTORED_TOOL_PART_TYPE, failureOf, readToolLine, toolLineOf, type ToolLine } from '../../../shared/tool-display'

/**
 * Render plan for an assistant message's parts (pure, no React).
 *
 * A turn with hundreds of tool calls produces one assistant message with
 * thousands of parts, and `@ai-sdk/react` structuredClones that message on
 * every chunk, so every part object is a new reference on every 50ms tick.
 * This module turns the parts into a bounded plan:
 *  - tool calls made inside a subagent (`callProviderMetadata[<provider>]
 *    .parentToolCallId`, e.g. set by ai-sdk-provider-claude-code) are nested under
 *    the subagent's own `Agent`/`Task` row instead of flat in the conversation;
 *  - consecutive finished calls of the same tool become one row (「決めたことを 2 件残しました」);
 *  - long runs of consecutive top-level tool rows collapse into one summary row;
 *  - each row carries primitive fields so memoised views can compare by value.
 */

type Part = UIMessage['parts'][number]

/** Tool names the Claude Code CLI uses for subagent launches (varies by CLI version). */
export const SUBAGENT_TOOL_NAMES: ReadonlySet<string> = new Set(['Agent', 'Task'])
/** A run of consecutive top-level tool rows longer than this collapses. */
export const RUN_COLLAPSE_THRESHOLD = 8
/** Rows of a collapsed run that stay visible (the latest ones, plus any running). */
export const RUN_VISIBLE_TAIL = 3
/** Inner rows of an expanded subagent group shown at once (the latest ones). */
export const GROUP_PAGE_SIZE = 50

export function getToolDisplayName(toolName: string): string {
  const names: Record<string, string> = {
    mcp__acb_consultations__search_consultations: '過去の相談を検索',
    mcp__acb_consultations__read_consultation: '過去の相談を参照',
    mcp__acb_company_files__company_search: '会社全体を検索',
    mcp__acb_company_files__company_read_file: '会社のファイルを参照',
    mcp__acb_company_files__company_list: '会社のフォルダを一覧',
    AskUserQuestion: 'ユーザーに質問',
    mcp__acb_ask__ask_user: 'ユーザーに質問',
    mcp__acb_review__request_review: '確認をお願いする',
    readFile: 'ファイル読取',
    writeFile: 'ファイル書込',
    listDirectory: 'ディレクトリ一覧',
    executeCommand: 'コマンド実行',
    readSkillFile: 'スキルファイル読取',
  }
  if (names[toolName]) return names[toolName]
  // A tool the app has no name for (a member's own MCP server): never the raw `mcp__…` id.
  const mcp = /^mcp__(.+?)__(.+)$/.exec(toolName)
  return mcp ? `道具（${mcp[1]}・${mcp[2]}）` : toolName
}

export interface ToolRow {
  toolCallId: string
  toolName: string
  state: string
  input?: unknown
  output?: unknown
  errorText?: string
  /** What the row says, in plain Japanese (shared/tool-display.ts): from the stream, else built here. */
  line: ToolLine
  /** The call did not work: the app's own refusal sentence when there is one. */
  failure?: { reason?: string }
  parentToolCallId?: string
}

/** The row's line: the one the main process put on the part, else the built-in / unknown-tool line. */
function lineOf(toolName: string, input: unknown, metadata: unknown): ToolLine {
  return readToolLine(metadata) ?? toolLineOf(toolName, input)
}

export interface ToolItem {
  kind: 'tool'
  key: string
  row: ToolRow
}

export interface AgentItem {
  kind: 'agent'
  key: string
  row: ToolRow
  /** Subagent description (`input.description`). */
  description: string
  children: ToolOrAgent[]
  /** Inner tool calls, recursively. */
  toolCount: number
  runningCount: number
  /** Changes whenever anything visible inside the group changes. */
  signature: string
}

/** Consecutive finished calls of one tool, shown as one row (「決めたことを 2 件残しました」) that expands. */
export interface SameItem {
  kind: 'same'
  key: string
  /** The latest call (what run bookkeeping reads). */
  row: ToolRow
  rows: ToolRow[]
  signature: string
}

export type ToolOrAgent = ToolItem | AgentItem | SameItem

export interface RunItem {
  kind: 'run'
  key: string
  items: ToolOrAgent[]
  /** Longer than RUN_COLLAPSE_THRESHOLD with rows to hide: rendered behind a summary row. */
  collapsible: boolean
  runningCount: number
  signature: string
}

export interface PartItem {
  kind: 'part'
  key: string
  index: number
  part: Part
}

export type PlanItem = PartItem | RunItem

export function isRunningState(state: string): boolean {
  return state === 'input-streaming' || state === 'input-available' || state === 'approval-requested' || state === 'approval-responded'
}

export function isTerminalState(state: string): boolean {
  return state === 'output-available' || state === 'output-error' || state === 'output-denied'
}

/** The subagent call this tool call ran inside: `parentToolCallId` in whichever provider's metadata carries it. */
function parentOf(part: { callProviderMetadata?: unknown }): string | undefined {
  const meta = part.callProviderMetadata
  if (!meta || typeof meta !== 'object') return undefined
  for (const value of Object.values(meta as Record<string, unknown>)) {
    const parent = (value as { parentToolCallId?: unknown } | null | undefined)?.parentToolCallId
    if (typeof parent === 'string' && parent) return parent
  }
  return undefined
}

/** Tool row for a `tool-*` or `dynamic-tool` part, else undefined. */
export function toolRowOf(part: Part): ToolRow | undefined {
  if (part.type === 'dynamic-tool') {
    const output = 'output' in part ? part.output : undefined
    const errorText = 'errorText' in part ? part.errorText : undefined
    const failure = failureOf(part.state, errorText, output)
    return {
      toolCallId: part.toolCallId,
      toolName: part.toolName,
      state: part.state,
      input: part.input,
      output,
      errorText,
      line: lineOf(part.toolName, part.input, part.callProviderMetadata),
      ...(failure ? { failure } : {}),
      parentToolCallId: parentOf(part),
    }
  }
  if (part.type === RESTORED_TOOL_PART_TYPE) {
    // A call of a restored conversation (chatSessionMessages.ts): its name and line only.
    const p = part as { id?: string; data?: { toolName?: unknown; line?: unknown } }
    const toolName = typeof p.data?.toolName === 'string' ? p.data.toolName : ''
    if (!toolName) return undefined
    const line = p.data?.line as ToolLine | undefined
    return {
      toolCallId: p.id ?? toolName, toolName, state: 'output-available',
      line: line && typeof line.label === 'string' && typeof line.many === 'string' ? line : toolLineOf(toolName, {}),
    }
  }
  if (typeof part.type === 'string' && part.type.startsWith('tool-')) {
    const p = part as { type: string; toolCallId: string; state: string; input?: unknown; output?: unknown; errorText?: string; callProviderMetadata?: unknown }
    const toolName = p.type.slice('tool-'.length)
    const failure = failureOf(p.state, p.errorText, p.output)
    return {
      toolCallId: p.toolCallId,
      toolName,
      state: p.state,
      input: p.input,
      output: p.output,
      errorText: p.errorText,
      line: lineOf(toolName, p.input, p.callProviderMetadata),
      ...(failure ? { failure } : {}),
      parentToolCallId: parentOf(p),
    }
  }
  return undefined
}

function rowSignature(row: ToolRow): string {
  return `${row.toolCallId}:${row.state}:${row.line.label}:${row.line.detail ?? ''}:${row.failure ? `!${row.failure.reason ?? ''}` : ''}`
}

/** Calls that may share one row: finished, worked, and the same tool (a running or failed call keeps its own row). */
function joinable(item: ToolOrAgent): item is ToolItem {
  return item.kind === 'tool' && item.row.state === 'output-available' && !item.row.failure
}

/** Merges consecutive joinable calls of one tool into a SameItem (keyed by the first call, so it stays mounted as it grows). */
export function groupSameCalls(items: readonly ToolOrAgent[]): ToolOrAgent[] {
  const out: ToolOrAgent[] = []
  for (let i = 0; i < items.length;) {
    const first = items[i]
    let end = i + 1
    if (joinable(first)) {
      while (end < items.length && joinable(items[end]) && items[end].row.toolName === first.row.toolName) end++
    }
    if (end - i < 2) { out.push(first); i = end; continue }
    const rows = items.slice(i, end).map(item => item.row)
    out.push({ kind: 'same', key: `same:${first.key}`, row: rows[rows.length - 1], rows, signature: rows.map(rowSignature).join(',') })
    i = end
  }
  return out
}

/** Parts that render nothing and therefore do not break a run of tool rows. */
function isInvisible(part: Part): boolean {
  return part.type === 'text' && !part.text
}

/**
 * Builds the render plan. O(parts). Subagent children are attached to their
 * `Agent`/`Task` row when that row is in the same message; otherwise they stay
 * top-level, so a missing parent never hides a row. Without parent metadata
 * (Codex, api-key mode, restored history) the plan is the flat list of parts,
 * with only long tool runs collapsed.
 */
export function planParts(parts: readonly Part[]): PlanItem[] {
  const rows: Array<ToolRow | undefined> = parts.map(toolRowOf)
  const agentIds = new Set<string>()
  for (const row of rows) if (row && SUBAGENT_TOOL_NAMES.has(row.toolName)) agentIds.add(row.toolCallId)

  const childrenOf = new Map<string, ToolRow[]>()
  for (const row of rows) {
    if (!row?.parentToolCallId || row.parentToolCallId === row.toolCallId || !agentIds.has(row.parentToolCallId)) continue
    const list = childrenOf.get(row.parentToolCallId)
    if (list) list.push(row)
    else childrenOf.set(row.parentToolCallId, [row])
  }

  const visiting = new Set<string>()
  const build = (row: ToolRow): ToolOrAgent => {
    if (!SUBAGENT_TOOL_NAMES.has(row.toolName) || visiting.has(row.toolCallId)) {
      return { kind: 'tool', key: row.toolCallId, row }
    }
    visiting.add(row.toolCallId)
    const children = groupSameCalls((childrenOf.get(row.toolCallId) ?? []).map(build))
    visiting.delete(row.toolCallId)
    let toolCount = 0
    let runningCount = 0
    const tail: string[] = []
    for (const child of children) {
      toolCount += child.kind === 'same' ? child.rows.length : 1 + (child.kind === 'agent' ? child.toolCount : 0)
      runningCount += (isRunningState(child.row.state) ? 1 : 0) + (child.kind === 'agent' ? child.runningCount : 0)
    }
    for (const child of children.slice(-GROUP_PAGE_SIZE)) tail.push(child.kind === 'tool' ? rowSignature(child.row) : child.signature)
    const description = typeof (row.input as { description?: unknown } | undefined)?.description === 'string'
      ? (row.input as { description: string }).description : ''
    return {
      kind: 'agent',
      key: row.toolCallId,
      row,
      description,
      children,
      toolCount,
      runningCount,
      signature: `${rowSignature(row)}|${description}|${toolCount}|${runningCount}|${tail.join(',')}`,
    }
  }

  // Every maximal run of top-level tool rows becomes one run item, collapsible
  // or not, so a run crossing the threshold keeps its React subtree (rows are
  // not remounted) and short runs render exactly the rows they did before.
  const plan: PlanItem[] = []
  let run: ToolOrAgent[] = []
  const flush = () => {
    if (run.length === 0) return
    const key = `run:${run[0].key}`
    const items = groupSameCalls(run)
    // Collapse only when that actually hides something (a run of subagent
    // groups, which always stay visible, renders as is).
    const tail = items.length > RUN_COLLAPSE_THRESHOLD ? visibleRunItems(items) : items
    const collapsible = tail.length < items.length
    let runningCount = 0
    for (const item of items) runningCount += isRunningState(item.row.state) ? 1 : 0
    plan.push({
      kind: 'run',
      key,
      items,
      collapsible,
      runningCount,
      signature: `${items.length}|${runningCount}|${tail.map(item => item.kind === 'tool' ? rowSignature(item.row) : item.signature).join(',')}`,
    })
    run = []
  }

  for (let index = 0; index < parts.length; index++) {
    const row = rows[index]
    if (row) {
      if (row.parentToolCallId && row.parentToolCallId !== row.toolCallId && agentIds.has(row.parentToolCallId)) continue
      run.push(build(row))
      continue
    }
    const part = parts[index]
    if (isInvisible(part)) continue
    flush()
    plan.push({ kind: 'part', key: `part:${index}`, index, part })
  }
  flush()
  return plan
}

/** Rows a collapsed run keeps visible: the latest few, anything running, and
 * every subagent group (already a single compact row each). */
export function visibleRunItems(items: readonly ToolOrAgent[]): ToolOrAgent[] {
  const tailStart = Math.max(0, items.length - RUN_VISIBLE_TAIL)
  return items.filter((item, i) => i >= tailStart || item.kind === 'agent' || isRunningState(item.row.state))
}

/** Equality for memoised tool rows: compares only what the row displays. A
 * terminal row with the same id and state is equal by definition (its output
 * no longer changes). */
export function toolRowPropsEqual(prev: { row: ToolRow }, next: { row: ToolRow }): boolean {
  const a = prev.row
  const b = next.row
  if (a === b) return true
  if (a.toolCallId !== b.toolCallId || a.state !== b.state || a.toolName !== b.toolName) return false
  if (isTerminalState(b.state)) return true
  return a.errorText === b.errorText && a.line.label === b.line.label && a.line.detail === b.line.detail
}

export function signaturePropsEqual(prev: { item: { key: string; signature: string } }, next: { item: { key: string; signature: string } }): boolean {
  return prev.item.key === next.item.key && prev.item.signature === next.item.signature
}
