// The AI action log (monitoring M1) for one turn of any agent: a tracker
// (shared/agent-events.ts) that sends to the host's `onToolEvent`. Agents
// translate their own hook / notification shapes (claude-tool-events.ts,
// codex-tool-events.ts, chat-tools.ts) and report through it.

import fs from 'node:fs'
import { createToolEventTracker, type ToolCall, type ToolDecision, type ToolEventTracker } from '../../shared/agent-events'
import { newFilesOfCall } from '../../shared/consultation-task'
import { bashWriteTargets } from '../write-guard'
import type { AuthMode } from '../../shared/agent'
import { sandboxConcern } from '../../shared/agents/sandbox-policy'
import type { AgentHostConfig, ToolEventContextInput, TurnSandbox } from './connection'

let warnedEmit = false

export function turnToolEvents(
  host: Pick<AgentHostConfig, 'onToolEvent' | 'toolEventPaths'>,
  agent: AuthMode,
  request: { appSessionId?: string; modelId?: string; workingDirectory?: string; toolEventContext?: ToolEventContextInput; sandbox?: TurnSandbox },
): ToolEventTracker | undefined {
  const sink = host.onToolEvent
  if (!sink) return undefined
  let paths: { home?: string; appDataDirs?: string[] } = {}
  try { paths = host.toolEventPaths?.() ?? {} } catch { /* no secret-place marks */ }
  const context = request.toolEventContext
  const sandbox = request.sandbox
  const tracker = createToolEventTracker({
    agent,
    ...(sandbox ? { sandbox: { mode: sandbox.mode, concern: call => sandboxConcern(sandbox.resolved, call.tool, call.input, sandbox.home) } } : {}),
    conversationId: request.appSessionId,
    turnId: context?.turnId,
    companyId: context?.companyId,
    department: context?.department,
    model: request.modelId,
    companyRoot: context?.companyRoot,
    cwd: request.workingDirectory,
    home: paths.home,
    appDataDirs: paths.appDataDirs,
  }, event => {
    // The log must never reach into the agent's path.
    try { sink(event) } catch (error) {
      if (!warnedEmit) { warnedEmit = true; console.warn('[agent-events] recorder failed:', error instanceof Error ? error.message : 'unknown') }
    }
  })
  const onFileCreated = context?.onFileCreated
  const companyRoot = context?.companyRoot
  return onFileCreated && companyRoot
    ? watchNewFiles(tracker, { companyRoot, cwd: request.workingDirectory, home: paths.home }, onFileCreated)
    : tracker
}

const REFUSED: ReadonlySet<ToolDecision> = new Set(['member-denied', 'guard-denied', 'policy-denied', 'stopped'])

/**
 * The same tracker, also telling which company files a call created: what a write is about to make
 * is read when the call is decided or starts (before it runs), and told once it finished ok with the
 * file there. The agents report through it unchanged (Claude's PreToolUse, Codex's items, the API
 * key's tools).
 */
export function watchNewFiles(
  tracker: ToolEventTracker,
  ctx: { companyRoot: string; cwd?: string; home?: string },
  onFileCreated: (companyPath: string) => void,
  exists: (absPath: string) => boolean = p => fs.existsSync(p),
): ToolEventTracker {
  const pending = new Map<string, string[]>()
  const note = (callId: string, call: ToolCall) => {
    if (pending.has(callId)) return
    try {
      const paths = newFilesOfCall(call, ctx, exists, bashWriteTargets)
      if (paths.length > 0) pending.set(callId, paths)
    } catch { /* not a write the app can read */ }
  }
  return {
    decide(callId, call, decision, guardReason) {
      const id = tracker.decide(callId, call, decision, guardReason)
      if (REFUSED.has(decision)) pending.delete(id)
      else note(id, call)
      return id
    },
    start(callId, call) {
      tracker.start(callId, call)
      note(callId, call)
    },
    finish(callId, outcome, call, durationMs, violation) {
      tracker.finish(callId, outcome, call, durationMs, violation)
      const paths = pending.get(callId)
      pending.delete(callId)
      if (outcome !== 'ok' || !paths) return
      for (const p of paths) {
        try { if (exists(`${ctx.companyRoot}/${p}`)) onFileCreated(p) } catch { /* the chat goes on */ }
      }
    },
    close() {
      pending.clear()
      tracker.close()
    },
  }
}
