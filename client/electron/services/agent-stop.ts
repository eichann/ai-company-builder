/**
 * The emergency stop in the app (monitoring M2, .claude/rules/agent-stop.md):
 * what the chat asks before a turn and per tool call, and what happens when a
 * received stop changes. Created in main.ts; the chat server gets it through
 * features/chat/server-config.ts.
 *
 * - Before a turn: the company is watched on the push channel, the policy is
 *   refreshed (3 s budget), and a whole-AI stop refuses the turn.
 * - While it runs: every tool call asks `toolStopped(category)` against the
 *   live state (Claude's PreToolUse, Codex's approvals and items, the API-key
 *   mode's tools).
 * - A stop of the whole AI arrives: every running turn of that company stops
 *   with 「管理者が停止しました」, its approval and choice cards cancelled
 *   (chat-turns.ts `abort`).
 * - AI outside conversations (sync's commit message, chat titles, voice
 *   formatting, hand-off memos) is off while any company the account kept a
 *   whole-AI stop for is stopped: those callers fall back quietly (fixed text,
 *   no title, the raw transcript, no memo) and no AI is asked.
 * - Never received a policy → nothing is stopped (owner decision).
 */
import { AGENT_STOP_MESSAGES, stoppedKind, type AgentStopPolicy, type AgentStopToolKind } from '../../shared/agent-stop'
import type { ToolCategory, TurnStopReason } from '../../shared/agent-events'
import type { AgentPolicyStore } from './agent-policy-store'

/** The chat server's running turns (chat-turns.ts), once it started. */
export interface StoppableTurns {
  abort(filter: (info: { companyId?: string }) => boolean, reason?: TurnStopReason): number
}

export interface AgentStopDeps {
  policy: Pick<AgentPolicyStore, 'refresh' | 'stop' | 'stoppedCompanies' | 'onStopChange'>
  /** Keep the company's policy live (the push channel). */
  watch: (companyId: string) => void
  turns: () => StoppableTurns | null
  log?: Pick<Console, 'log' | 'warn'>
  /** The policy refresh budget before a turn. */
  refreshTimeoutMs?: number
}

export interface TurnStop {
  /** The turn must not start: the sentence for the member. */
  refused?: string
  /** The stopped kind covering this category right now ('all', a kind, or null = allowed). */
  toolStopped: (category: ToolCategory) => AgentStopToolKind | 'all' | null
}

export function createAgentStop(deps: AgentStopDeps) {
  const log = deps.log ?? console

  const apply = (companyId: string, stop: AgentStopPolicy | undefined) => {
    if (!stop?.all) {
      if (stop?.tools.length) log.log(`[agent-stop] ${companyId}: stopped kinds ${stop.tools.join(', ')}`)
      return
    }
    const stopped = deps.turns()?.abort(info => info.companyId === companyId, 'stopped-by-admin') ?? 0
    log.log(`[agent-stop] ${companyId}: the AI is stopped; ${stopped} running turn(s) stopped`)
  }
  deps.policy.onStopChange(apply)

  return {
    /** Before a chat turn in this company. */
    async prepareTurn(companyId: string): Promise<TurnStop> {
      deps.watch(companyId)
      await deps.policy.refresh(companyId, { timeoutMs: deps.refreshTimeoutMs ?? 3000 })
      const toolStopped = (category: ToolCategory) => stoppedKind(deps.policy.stop(companyId), category)
      if (deps.policy.stop(companyId)?.all) return { refused: AGENT_STOP_MESSAGES.turnRefused, toolStopped }
      return { toolStopped }
    },

    /** AI outside conversations may run (no company has the whole AI stopped). */
    oneShotAiAllowed(): boolean {
      return deps.policy.stoppedCompanies().length === 0
    },
  }
}

export type AgentStop = ReturnType<typeof createAgentStop>
