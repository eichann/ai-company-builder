// The AI action log (monitoring M1) for one turn of any agent: a tracker
// (shared/agent-events.ts) that sends to the host's `onToolEvent`. Agents
// translate their own hook / notification shapes (claude-tool-events.ts,
// codex-tool-events.ts, chat-tools.ts) and report through it.

import { createToolEventTracker, type ToolEventTracker } from '../../shared/agent-events'
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
  return createToolEventTracker({
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
}
