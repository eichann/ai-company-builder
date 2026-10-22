import type { UIMessage } from 'ai'

/**
 * Render plan for an assistant message's parts (pure, no React).
 *
 * A turn with hundreds of tool calls produces one assistant message with
 * thousands of parts, and `@ai-sdk/react` structuredClones that message on
 * every chunk, so every part object is a new reference on every 50ms tick.
 * This module turns the parts into a bounded plan:
 *  - tool calls made inside a subagent (`callProviderMetadata['claude-code']
 *    .parentToolCallId`, set by ai-sdk-provider-claude-code) are nested under
 *    the subagent's own `Agent`/`Task` row instead of flat in the conversation;
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
    readFile: 'ファイル読取',
    writeFile: 'ファイル書込',
    listDirectory: 'ディレクトリ一覧',
    executeCommand: 'コマンド実行',
    readSkillFile: 'スキルファイル読取',
  }
  return names[toolName] || toolName
}

export interface ToolRow {
  toolCallId: string
  toolName: string
  state: string
  input?: unknown
  output?: unknown
  errorText?: string
  /** Row label derived from the input (`path`, else `command`). */
  inputSummary: string
  parentToolCallId?: string
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

export type ToolOrAgent = ToolItem | AgentItem

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

export function inputSummaryOf(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const inp = input as Record<string, unknown>
  if (inp.path) return String(inp.path)
  if (inp.command) return String(inp.command)
  return ''
}

function parentOf(part: { callProviderMetadata?: unknown }): string | undefined {
  const meta = part.callProviderMetadata as Record<string, Record<string, unknown> | undefined> | undefined
  const parent = meta?.['claude-code']?.parentToolCallId
  return typeof parent === 'string' && parent ? parent : undefined
}

/** Tool row for a `tool-*` or `dynamic-tool` part, else undefined. */
export function toolRowOf(part: Part): ToolRow | undefined {
  if (part.type === 'dynamic-tool') {
    return {
      toolCallId: part.toolCallId,
      toolName: part.toolName,
      state: part.state,
      input: part.input,
      output: 'output' in part ? part.output : undefined,
      errorText: 'errorText' in part ? part.errorText : undefined,
      inputSummary: inputSummaryOf(part.input),
      parentToolCallId: parentOf(part),
    }
  }
  if (typeof part.type === 'string' && part.type.startsWith('tool-')) {
    const p = part as { type: string; toolCallId: string; state: string; input?: unknown; output?: unknown; errorText?: string; callProviderMetadata?: unknown }
    return {
      toolCallId: p.toolCallId,
      toolName: p.type.slice('tool-'.length),
      state: p.state,
      input: p.input,
      output: p.output,
      errorText: p.errorText,
      inputSummary: inputSummaryOf(p.input),
      parentToolCallId: parentOf(p),
    }
  }
  return undefined
}

function rowSignature(row: ToolRow): string {
  return `${row.toolCallId}:${row.state}:${row.inputSummary.length}:${row.inputSummary.slice(0, 80)}:${row.errorText ? 1 : 0}`
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
    const children = (childrenOf.get(row.toolCallId) ?? []).map(build)
    visiting.delete(row.toolCallId)
    let toolCount = 0
    let runningCount = 0
    const tail: string[] = []
    for (const child of children) {
      toolCount += 1 + (child.kind === 'agent' ? child.toolCount : 0)
      runningCount += (isRunningState(child.row.state) ? 1 : 0) + (child.kind === 'agent' ? child.runningCount : 0)
    }
    for (const child of children.slice(-GROUP_PAGE_SIZE)) tail.push(child.kind === 'agent' ? child.signature : rowSignature(child.row))
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
    // Collapse only when that actually hides something (a run of subagent
    // groups, which always stay visible, renders as is).
    const tail = run.length > RUN_COLLAPSE_THRESHOLD ? visibleRunItems(run) : run
    const collapsible = tail.length < run.length
    let runningCount = 0
    for (const item of run) runningCount += isRunningState(item.row.state) ? 1 : 0
    const visible = tail
    plan.push({
      kind: 'run',
      key: `run:${run[0].key}`,
      items: run,
      collapsible,
      runningCount,
      signature: `${run.length}|${runningCount}|${visible.map(item => item.kind === 'agent' ? item.signature : rowSignature(item.row)).join(',')}`,
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
  return a.errorText === b.errorText && a.inputSummary === b.inputSummary
}

export function signaturePropsEqual(prev: { item: { key: string; signature: string } }, next: { item: { key: string; signature: string } }): boolean {
  return prev.item.key === next.item.key && prev.item.signature === next.item.signature
}
