// Codex app-server items and approval requests → AI action log reports
// (shared/agent-events.ts). Codex decides most calls itself (approval policy
// `on-request`, sandbox `workspace-write`): a call the app was not asked about
// is `policy-default`; one it asked the member about carries the answer; one
// Codex declined on its own is `policy-denied`. Paired by the item id.

import type { ToolCall, ToolEventTracker } from '../../shared/agent-events'

interface CodexItem { id?: unknown; type?: unknown; command?: unknown; cwd?: unknown; changes?: unknown; server?: unknown; tool?: unknown; arguments?: unknown; status?: unknown }

/** The item as the action log sees it (undefined: not a tool call). */
export function codexToolCall(item: CodexItem): ToolCall | undefined {
  const cwd = typeof item.cwd === 'string' ? item.cwd : undefined
  switch (item.type) {
    case 'commandExecution': return { tool: 'Bash', input: { command: item.command }, cwd }
    case 'fileChange': return { tool: 'Write', input: { changes: item.changes } }
    // The arguments only reach describeTarget, which keeps the web research's host and nothing else.
    case 'mcpToolCall': return { tool: `mcp__${String(item.server)}__${String(item.tool)}`, input: item.arguments }
    case 'webSearch': return { tool: 'WebSearch' }
    default: return undefined
  }
}

/** `item/started` / `item/completed`. */
export function recordCodexItem(tracker: ToolEventTracker | undefined, method: string, item: CodexItem): void {
  if (!tracker || typeof item.id !== 'string') return
  const call = codexToolCall(item)
  if (!call) return
  if (method === 'item/started') tracker.start(item.id, call)
  else if (method === 'item/completed') {
    if (item.status === 'declined') tracker.decide(item.id, call, 'policy-denied')
    else tracker.finish(item.id, item.status === 'failed' ? 'error' : 'ok', call)
  }
}

/** A command / file-change approval and the member's answer (`asked: false` = no one to ask → refused). */
export function recordCodexApproval(tracker: ToolEventTracker | undefined, method: string, params: Record<string, unknown>, answer: { asked: boolean; approved: boolean }): void {
  if (!tracker) return
  const call: ToolCall = method === 'item/commandExecution/requestApproval'
    ? { tool: 'Bash', input: { command: params.command }, cwd: typeof params.cwd === 'string' ? params.cwd : undefined }
    : { tool: 'Write' }
  const callId = typeof params.itemId === 'string' ? params.itemId : undefined
  if (!answer.asked) tracker.decide(callId, call, 'guard-denied', 'needs-approval')
  else tracker.decide(callId, call, answer.approved ? 'member-allowed' : 'member-denied')
}
