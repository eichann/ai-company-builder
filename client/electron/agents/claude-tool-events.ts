// Claude Code hook input → AI action log reports (shared/agent-events.ts).
// claude.ts's PreToolUse hook and canUseTool return a `ToolVerdict` (the
// answer for the CLI + the decision it stands for); this module records it,
// and pairs the PostToolUse / PostToolUseFailure / PermissionDenied hooks by
// `tool_use_id`.

import type { GuardReason, ToolCall, ToolDecision, ToolEventTracker } from '../../shared/agent-events'
import { parseSandboxViolation } from '../../shared/agents/sandbox-policy'

/** What the CLI gets back, and what the app decided (undefined: nothing to record). */
export interface ToolVerdict<T> {
  result: T
  decision?: ToolDecision
  guardReason?: GuardReason
}

export const verdict = <T>(result: T, decision?: ToolDecision, guardReason?: GuardReason): ToolVerdict<T> => ({ result, decision, guardReason })

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- hook input as the SDK hands it over
type HookInput = any

export function claudeToolCall(input: HookInput): ToolCall {
  return {
    tool: String(input?.tool_name ?? ''),
    input: input?.tool_input,
    cwd: typeof input?.cwd === 'string' ? input.cwd : undefined,
    subagentType: typeof input?.agent_type === 'string' ? input.agent_type : undefined,
  }
}

/** The PreToolUse hook's verdict for this call. */
export function recordPreToolUse(tracker: ToolEventTracker | undefined, input: HookInput, v: ToolVerdict<unknown>): void {
  if (!tracker || !v.decision) return
  tracker.decide(typeof input?.tool_use_id === 'string' ? input.tool_use_id : undefined, claudeToolCall(input), v.decision, v.guardReason)
}

/** canUseTool's verdict (it carries the tool name, input and `toolUseID` separately). */
export function recordCanUseTool(tracker: ToolEventTracker | undefined, toolName: string, toolInput: unknown, toolUseId: unknown, v: ToolVerdict<unknown>): void {
  if (!tracker || !v.decision) return
  tracker.decide(typeof toolUseId === 'string' ? toolUseId : undefined, { tool: toolName, input: toolInput }, v.decision, v.guardReason)
}

/** PostToolUse / PostToolUseFailure / PermissionDenied: how the call ended. */
export function recordToolEnd(tracker: ToolEventTracker | undefined, input: HookInput): void {
  if (!tracker || typeof input?.tool_use_id !== 'string') return
  const call = claudeToolCall(input)
  const duration = typeof input.duration_ms === 'number' ? input.duration_ms : undefined
  if (input.hook_event_name === 'PostToolUse') tracker.finish(input.tool_use_id, 'ok', call, duration)
  // A failed command's error carries the sandbox's `<sandbox_violations>` (enforce).
  else if (input.hook_event_name === 'PostToolUseFailure') tracker.finish(input.tool_use_id, 'error', call, duration, parseSandboxViolation(input.error))
  else if (input.hook_event_name === 'PermissionDenied') tracker.decide(input.tool_use_id, call, 'policy-denied')
}

/**
 * Claude Code's own text for a call its permission rules refused (verified on
 * CLI 2.1.314: `<tool_use_error>File is in a directory that is denied by your
 * permission settings.</tool_use_error>`). Managed settings (the company
 * Macs' Jamf profile) and the sandbox's `Read(...)` denies refuse this way.
 */
const PERMISSION_DENIED_RE = /denied by your permission settings/i

/**
 * Reads the CLI's message stream for refusals no hook reports: a call its
 * permission rules deny runs neither PreToolUse nor PostToolUse(Failure), so
 * the log never saw it (found with the company Macs' managed settings). The
 * `tool_use` block gives the call, its `tool_result` (is_error + the text
 * above) the refusal → `policy-denied` / `denied-read`. A call a hook already
 * reported is left alone (the tracker ignores a finished id).
 */
export function createDeniedCallWatcher(tracker: ToolEventTracker): (message: unknown) => void {
  const calls = new Map<string, ToolCall>()
  return message => {
    const m = message as { type?: unknown; message?: { content?: unknown } } | null
    const content = Array.isArray(m?.message?.content) ? m!.message!.content as Array<Record<string, unknown>> : []
    if (m?.type === 'assistant') {
      for (const block of content) {
        if (block?.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
          if (calls.size >= 500) calls.delete(calls.keys().next().value as string)
          calls.set(block.id, { tool: block.name, input: block.input })
        }
      }
    } else if (m?.type === 'user') {
      for (const block of content) {
        if (block?.type !== 'tool_result' || block.is_error !== true || typeof block.tool_use_id !== 'string') continue
        const call = calls.get(block.tool_use_id)
        calls.delete(block.tool_use_id)
        const text = typeof block.content === 'string' ? block.content
          : Array.isArray(block.content) ? block.content.map(part => (part as { text?: unknown })?.text).filter(t => typeof t === 'string').join('\n') : ''
        if (call && PERMISSION_DENIED_RE.test(text)) tracker.decide(block.tool_use_id, call, 'policy-denied', 'denied-read')
      }
    }
  }
}
