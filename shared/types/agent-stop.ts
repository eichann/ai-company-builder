/**
 * The emergency stop (monitoring M2, 「AI の緊急停止」): what an owner/admin
 * stops, what each member's app receives in its policy, and the push
 * channel's event (`GET /api/companies/:id/me/events`, SSE).
 *
 * Rules: .claude/rules/agent-stop.md. The push channel follows the owner's
 * 「かもしれない運転」 rule (2026-10-31): an event carries only its kind and
 * a version — never content, never a folder name — and the app may only
 * refetch its policy, stop, or show a notice because of one.
 */

/** Tool kinds that can be stopped on their own (the action log's categories of the same name). */
export const AGENT_STOP_TOOL_KINDS = ['command', 'write', 'web', 'mcp-external'] as const
export type AgentStopToolKind = typeof AGENT_STOP_TOOL_KINDS[number]

export const isAgentStopToolKind = (value: unknown): value is AgentStopToolKind =>
  (AGENT_STOP_TOOL_KINDS as readonly unknown[]).includes(value)

/** At most this many characters of reason. */
export const AGENT_STOP_REASON_MAX = 500

/**
 * The stop part of a member's policy (`GET /me/agent-policy` → `stop`):
 * `all` = no AI at all; `tools` = these kinds are refused. Already merged
 * for the member (company-wide stops and their own).
 */
export interface AgentStopPolicy {
  all: boolean
  tools: AgentStopToolKind[]
}

/** One stop as the admin console lists it. */
export interface AgentStopEntry {
  id: string
  /** null = everyone in the company. */
  userId: string | null
  userName: string | null
  userEmail: string | null
  /** null = the whole AI (not only one kind of tool). */
  tool: AgentStopToolKind | null
  reason: string
  stoppedAt: string
  stoppedBy: string
  stoppedByName: string | null
  /** null while it is in force. */
  releasedAt: string | null
  releasedBy: string | null
  releasedByName: string | null
}

/** A member whose app does not know the emergency stop (an older build). */
export interface AgentStopUnsupportedMember {
  userId: string
  name: string | null
  email: string | null
  /** The build their app last reported (null: unknown). */
  clientVersion: string | null
}

/** GET …/agent-stops (owner/admin). */
export interface AgentStopView {
  /** In force now, newest first. */
  active: AgentStopEntry[]
  /** Stops and releases, newest first (at most 50; released ones included). */
  history: AgentStopEntry[]
  /**
   * Members who use the desktop app but whose app has not reported that it
   * follows the stop (「停止に対応していないアプリ」).
   */
  unsupported: AgentStopUnsupportedMember[]
  /** The key broker's keys (the 「鍵」 unit lives in 「API キー」: POST /broker/stop-all). */
  keys: { enabled: boolean; active: number; stopped: number }
}

/** POST …/agent-stops body. */
export interface AgentStopRequest {
  /** null / absent = everyone. */
  userId?: string | null
  /** null / absent = the whole AI. */
  tool?: AgentStopToolKind | null
  reason?: string
}

// ----------------------------------------------------------------------------
// The push channel (server → app). Only these kinds exist; the app drops any
// other kind, any extra field, and anything larger than PUSH_EVENT_MAX_BYTES.
// ----------------------------------------------------------------------------

export const PUSH_EVENT_KINDS = ['policy'] as const
export type PushEventKind = typeof PUSH_EVENT_KINDS[number]

/** `policy`: the member's AI policy (stop + sandbox) is now at `version`; refetch it if yours differs. */
export interface PushEvent {
  kind: PushEventKind
  version: string
}

/** Largest event (the `data:` payload) the app accepts. */
export const PUSH_EVENT_MAX_BYTES = 256
/** The server's heartbeat (an SSE comment) interval. */
export const PUSH_HEARTBEAT_MS = 25_000
/** Request header the app sends so the server knows its build follows the stop. */
export const AGENT_STOP_SUPPORT_HEADER = 'X-ACB-Agent-Stop'

const VERSION_RE = /^[0-9a-f]{8,64}$/

/**
 * Parse one event's `data` (JSON). Exactly `{ kind, version }` with a known
 * kind and a hex version; anything else (another kind, another field, a
 * wrong type, too large) → null.
 */
export function parsePushEvent(data: string): PushEvent | null {
  if (typeof data !== 'string' || data.length > PUSH_EVENT_MAX_BYTES) return null
  let value: unknown
  try { value = JSON.parse(data) } catch { return null }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const keys = Object.keys(value)
  if (keys.length !== 2 || !keys.includes('kind') || !keys.includes('version')) return null
  const { kind, version } = value as { kind: unknown; version: unknown }
  if (!(PUSH_EVENT_KINDS as readonly unknown[]).includes(kind)) return null
  if (typeof version !== 'string' || !VERSION_RE.test(version)) return null
  return { kind: kind as PushEventKind, version }
}
