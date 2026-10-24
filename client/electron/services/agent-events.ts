// The AI action log's recorder in the main process (monitoring M1). Every
// agent's per-turn tracker (shared/agent-events.ts) sends here through the
// chat server's `onToolEvent`. For now it keeps the latest events in memory
// and writes one debug line per event (metadata only — the event holds no
// content). Sending to the server (batched, kept on disk while offline) is
// the next step: it plugs in as a `sink`.

import type { AgentToolEvent, ToolTarget } from '../../shared/agent-events'

export interface AgentEventSink {
  /** Must not throw; called once per event, in order. */
  add(event: AgentToolEvent): void
}

export interface AgentEventRecorder {
  record(event: AgentToolEvent): void
  /** The latest events, oldest first (bounded). */
  recent(): AgentToolEvent[]
  /** Folders an event marks as secret places (the member's home, the app's data). */
  paths(): { home?: string; appDataDirs?: string[] }
}

export interface AgentEventRecorderOptions {
  home?: string
  appDataDirs?: string[]
  capacity?: number
  log?: (line: string) => void
  sinks?: AgentEventSink[]
}

function targetLabel(target: ToolTarget): string {
  switch (target.kind) {
    case 'file': return `${target.path || '.'}${target.sensitive ? ` [${target.sensitive}]` : ''}`
    case 'outside': return `(outside)${target.sensitive ? ` [${target.sensitive}]` : ''}`
    case 'files': return target.files.map(targetLabel).join(', ') + (target.more ? ` +${target.more}` : '')
    case 'command': return target.programs.join(' | ') + (target.more ? ` +${target.more}` : '') + (target.redirect ? ' >' : '')
    case 'web': return target.host ?? '(web)'
    case 'mcp': return `${target.server}${target.tool ? `/${target.tool}` : ''}`
    case 'subagent': return target.subagentType ?? '(subagent)'
    default: return '-'
  }
}

export function formatAgentEvent(event: AgentToolEvent): string {
  return [
    `[agent-events] ${event.agent}`,
    event.subagentType ? `(${event.subagentType})` : '',
    `${event.tool} ${event.category}`,
    targetLabel(event.target),
    `${event.decision}${event.guardReason ? `:${event.guardReason}` : ''}`,
    event.outcome ?? '',
    event.durationMs !== undefined ? `${event.durationMs}ms` : '',
  ].filter(Boolean).join(' ')
}

export function createAgentEventRecorder(options: AgentEventRecorderOptions = {}): AgentEventRecorder {
  const capacity = options.capacity ?? 500
  const log = options.log ?? (line => console.log(line))
  const sinks = options.sinks ?? []
  const ring: AgentToolEvent[] = []
  const paths = { home: options.home, appDataDirs: options.appDataDirs }
  let warned = false
  return {
    record(event) {
      try {
        ring.push(event)
        if (ring.length > capacity) ring.splice(0, ring.length - capacity)
        log(formatAgentEvent(event))
        for (const sink of sinks) sink.add(event)
      } catch (error) {
        if (!warned) { warned = true; console.warn('[agent-events] recording failed:', error instanceof Error ? error.message : 'unknown') }
      }
    },
    recent: () => [...ring],
    paths: () => paths,
  }
}
