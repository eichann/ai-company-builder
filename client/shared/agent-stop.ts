// The emergency stop (monitoring M2) in the app: the words, the policy's stop
// part, which tool categories a stop covers, and the push channel's wire
// format (server-sent events). Pure: main, renderer and tests import it.
// Rules: .claude/rules/agent-stop.md.

import {
  AGENT_STOP_TOOL_KINDS,
  PUSH_EVENT_MAX_BYTES,
  parsePushEvent,
  type AgentStopPolicy,
  type AgentStopToolKind,
  type PushEvent,
} from '../../shared/types/agent-stop'
import type { ToolCategory } from './agent-events'

export { AGENT_STOP_SUPPORT_HEADER, PUSH_HEARTBEAT_MS, parsePushEvent } from '../../shared/types/agent-stop'
export type { AgentStopPolicy, AgentStopToolKind, PushEvent } from '../../shared/types/agent-stop'

const KIND_LABELS: Record<AgentStopToolKind, string> = {
  command: 'コマンドの実行',
  write: 'ファイルの書き込み',
  web: 'Web へのアクセス',
  'mcp-external': '外部の MCP',
}

export const AGENT_STOP_MESSAGES = {
  /** A new conversation turn while the member's AI is stopped. */
  turnRefused: '管理者が AI の利用を一時停止しています。再開されるまでお待ちください。',
  /** The end of a running reply the stop cut off. */
  turnStopped: '管理者が停止しました。',
  /** What the AI is told (and relays) when a stopped kind of tool is refused. */
  toolRefused: (kind: AgentStopToolKind | null) =>
    `管理者が${kind ? `「${KIND_LABELS[kind]}」` : ' AI の操作'}を一時停止しているため、実行していません。別の方法で同じ操作をせず、このことをユーザーにそのまま伝えてください。`,
} as const

/** The stop part of a policy answer; undefined when absent or malformed (an unknown tool kind is dropped). */
export function parseAgentStopPolicy(value: unknown): AgentStopPolicy | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const { all, tools } = value as { all?: unknown; tools?: unknown }
  if (typeof all !== 'boolean' || !Array.isArray(tools)) return undefined
  return { all, tools: AGENT_STOP_TOOL_KINDS.filter(kind => tools.includes(kind)) }
}

/**
 * The stopped kind a tool call of this category falls under: `'all'` when the
 * whole AI is stopped, the kind when that kind is, else null. Categories
 * other than the four kinds (read, app tools, questions, subagents) stop only
 * with the whole AI.
 */
export function stoppedKind(stop: AgentStopPolicy | undefined, category: ToolCategory): AgentStopToolKind | 'all' | null {
  if (!stop) return null
  if (stop.all) return 'all'
  return (stop.tools as readonly string[]).includes(category) ? category as AgentStopToolKind : null
}

/** A turn's live question "is this category stopped now?" (agents/connection.ts `toolStop`). */
export type ToolStopCheck = (category: ToolCategory) => AgentStopToolKind | 'all' | null

/**
 * The push channel's address on the signed-in server: https only (plain http
 * only for this computer, i.e. a developer's local server), no credentials or
 * query in the URL. null = do not connect.
 */
export function pushChannelUrl(serverUrl: string, companyId: string): string | null {
  let base: URL
  try { base = new URL(serverUrl) } catch { return null }
  const loopback = base.hostname === 'localhost' || base.hostname === '127.0.0.1' || base.hostname === '[::1]'
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && loopback)) return null
  if (base.username || base.password) return null
  if (!companyId) return null
  return `${base.origin}${base.pathname.replace(/\/+$/, '')}/api/companies/${encodeURIComponent(companyId)}/me/events`
}

/** Longest line the parser keeps; a longer one ends the connection (nothing legitimate is that long). */
export const SSE_MAX_LINE_BYTES = 1024

export type SseItem =
  | { type: 'event'; event: PushEvent }
  | { type: 'dropped'; name: string }
  | { type: 'heartbeat' }

/**
 * Incremental SSE reader for the push channel: feed it the stream's text,
 * get back what arrived. Only `policy` events whose data is exactly
 * `{ kind, version }` (and whose event name matches the kind) come out as
 * events; everything else is `dropped` (with a printable, cut-down name for
 * the log) and never interpreted further. `overflow` → the caller closes the
 * connection.
 */
export function createSseParser() {
  let buffer = ''
  let name = ''
  let data: string[] = []
  let dataBytes = 0
  let overflow = false
  const dispatch = (out: SseItem[]) => {
    if (data.length === 0 && !name) return
    const joined = data.join('\n')
    const parsed = dataBytes <= PUSH_EVENT_MAX_BYTES ? parsePushEvent(joined) : null
    const eventName = name || 'message'
    if (parsed && parsed.kind === eventName) out.push({ type: 'event', event: parsed })
    else out.push({ type: 'dropped', name: eventName.replace(/[^\x21-\x7e]/g, '?').slice(0, 32) })
    name = ''; data = []; dataBytes = 0
  }
  return {
    get overflow() { return overflow },
    push(text: string): SseItem[] {
      const out: SseItem[] = []
      if (overflow) return out
      buffer += text
      for (;;) {
        const at = buffer.search(/\r\n|\n|\r/)
        if (at < 0) break
        const line = buffer.slice(0, at)
        buffer = buffer.slice(at + (buffer.startsWith('\r\n', at) ? 2 : 1))
        if (line === '') { dispatch(out); continue }
        if (line.startsWith(':')) { out.push({ type: 'heartbeat' }); continue }
        const colon = line.indexOf(':')
        const field = colon < 0 ? line : line.slice(0, colon)
        const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '')
        if (field === 'event') name = value
        else if (field === 'data') { data.push(value); dataBytes += value.length + 1 }
        // id / retry / anything else: ignored (the app keeps its own reconnect schedule).
      }
      if (buffer.length > SSE_MAX_LINE_BYTES || dataBytes > PUSH_EVENT_MAX_BYTES * 4) overflow = true
      return out
    },
  }
}
