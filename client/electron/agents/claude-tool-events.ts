// Claude Code hook input → AI action log reports (shared/agent-events.ts).
// claude.ts's PreToolUse hook and canUseTool return a `ToolVerdict` (the
// answer for the CLI + the decision it stands for); this module records it,
// and pairs the PostToolUse / PostToolUseFailure / PermissionDenied hooks by
// `tool_use_id`.

import type { GuardReason, ToolCall, ToolDecision, ToolEventTracker } from '../../shared/agent-events'

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
  else if (input.hook_event_name === 'PostToolUseFailure') tracker.finish(input.tool_use_id, 'error', call, duration)
  else if (input.hook_event_name === 'PermissionDenied') tracker.decide(input.tool_use_id, call, 'policy-denied')
}
