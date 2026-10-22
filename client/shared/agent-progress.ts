/**
 * Subagent one-line progress (Claude Code `agentProgressSummaries`).
 *
 * With the option on, the CLI forks a running subagent about every 30 s to
 * write a short present-tense line and sends it as a `system` / `task_progress`
 * message whose `tool_use_id` is the Agent (Task) tool call — the same id as
 * the subagent group row in the transcript. Observed (CLI 2.1.304):
 *   { type: 'system', subtype: 'task_progress', task_id, tool_use_id: 'toolu_…',
 *     description: 'Counting lines in probe.mjs', summary: 'Counting lines in probe.mjs',
 *     usage: { total_tokens, tool_uses, duration_ms }, … }
 * Without `summary` the message only carries the CLI's own `description`
 * ("Running <tool>"), which is not shown. A `task_notification` for the same
 * tool call ends it.
 *
 * The chat server forwards these as transient `data-agent-progress` parts
 * (never stored in the transcript); the renderer keeps the latest line per
 * tool call while the row is running.
 */

export const AGENT_PROGRESS_PART_TYPE = 'data-agent-progress'

export interface AgentProgressEvent {
  toolCallId: string
  /** The latest line, or null when the subagent finished. */
  summary: string | null
}

const MAX_SUMMARY = 200

/** SDK message → progress event, or undefined when it is not one. */
export function agentProgressFromSdkMessage(message: unknown): AgentProgressEvent | undefined {
  if (!message || typeof message !== 'object') return undefined
  const m = message as Record<string, unknown>
  if (m.type !== 'system' || typeof m.tool_use_id !== 'string' || !m.tool_use_id) return undefined
  if (m.subtype === 'task_progress') {
    const summary = typeof m.summary === 'string' ? m.summary.replace(/\s+/g, ' ').trim() : ''
    if (!summary) return undefined
    return { toolCallId: m.tool_use_id, summary: summary.length > MAX_SUMMARY ? `${summary.slice(0, MAX_SUMMARY - 1)}…` : summary }
  }
  if (m.subtype === 'task_notification') return { toolCallId: m.tool_use_id, summary: null }
  return undefined
}

export function readAgentProgress(data: unknown): AgentProgressEvent | undefined {
  if (!data || typeof data !== 'object') return undefined
  const d = data as Record<string, unknown>
  if (typeof d.toolCallId !== 'string' || !d.toolCallId) return undefined
  if (d.summary !== null && typeof d.summary !== 'string') return undefined
  return { toolCallId: d.toolCallId, summary: d.summary as string | null }
}

/** Latest line per tool call; a finished call is dropped. Returns the same map when nothing changed. */
export function applyAgentProgress(state: ReadonlyMap<string, string>, event: AgentProgressEvent): ReadonlyMap<string, string> {
  if (event.summary === null) {
    if (!state.has(event.toolCallId)) return state
    const next = new Map(state)
    next.delete(event.toolCallId)
    return next
  }
  if (state.get(event.toolCallId) === event.summary) return state
  return new Map(state).set(event.toolCallId, event.summary)
}
