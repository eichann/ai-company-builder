/**
 * The emergency stop in the app (monitoring M2, .claude/rules/agent-stop.md):
 * what the chat asks before a turn and per tool call, and what happens when a
 * received stop changes. Created in features/agent-control/wire.ts; the chat server gets it through
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
 * - Never received a policy → nothing is stopped in a conversation (a person is there; owner
 *   decision 2026-10-25 / 10-31).
 * - Runs with no person present (「AI の番」, ai-turns.md) start only while the stop policy is
 *   confirmed: the server answered it in this app run within `STOP_POLICY_FRESH_MS`
 *   (`stopPolicyConfirmed`; owner decision 2026-11-09). A stop restored from disk alone, or an
 *   answer older than that, does not count. Running turns are unaffected.
 */
import { AGENT_STOP_MESSAGES, stoppedKind, type AgentStopPolicy, type AgentStopToolKind } from '../../shared/agent-stop'
import type { ToolCategory, TurnStopReason } from '../../shared/agent-events'
import type { AgentPolicyStore } from './agent-policy-store'

/** The chat server's running turns (chat-turns.ts), once it started. */
export interface StoppableTurns {
  abort(filter: (info: { companyId?: string }) => boolean, reason?: TurnStopReason): number
}

/**
 * How recent the server's answer must be for a run with no person present to start. The policy
 * is refreshed every 60 s per watched company (agent-push-channel.ts `PUSH_POLL_MS`) and on each
 * push event, so a connected app stays well inside it; three missed checks (≈ 3 minutes without
 * the server) and nothing new starts by itself.
 */
export const STOP_POLICY_FRESH_MS = 3 * 60_000
/**
 * While unconfirmed, the readiness check asks the server again after this long per company,
 * doubling up to `STOP_POLICY_RETRY_MAX_MS` (a server that is down is not asked every 10 s for
 * hours); a confirmation resets it.
 */
export const STOP_POLICY_RETRY_MS = 10_000
export const STOP_POLICY_RETRY_MAX_MS = 2 * 60_000

export interface AgentStopDeps {
  policy: Pick<AgentPolicyStore, 'refresh' | 'stop' | 'stoppedCompanies' | 'onStopChange' | 'confirmedWithin'>
  /** Keep the company's policy live (the push channel). */
  watch: (companyId: string) => void
  turns: () => StoppableTurns | null
  log?: Pick<Console, 'log' | 'warn'>
  /** The policy refresh budget before a turn. */
  refreshTimeoutMs?: number
  /** A monotonic clock in ms for the re-poll backoff (tests); default performance.now. */
  now?: () => number
}

export interface TurnStop {
  /** The turn must not start: the sentence for the member. */
  refused?: string
  /** The stopped kind covering this category right now ('all', a kind, or null = allowed). */
  toolStopped: (category: ToolCategory) => AgentStopToolKind | 'all' | null
}

export function createAgentStop(deps: AgentStopDeps) {
  const log = deps.log ?? console
  const now = deps.now ?? (() => performance.now())
  /** company → when the readiness check may ask the server again, and the wait after that. */
  const retry = new Map<string, { at: number; wait: number }>()
  const confirmedNow = (companyId: string) => deps.policy.confirmedWithin(companyId, STOP_POLICY_FRESH_MS)

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

    /**
     * A run with no person present (「AI の番」) may start in this company: the server answered
     * the stop policy in this app run, recently (`STOP_POLICY_FRESH_MS`). Not confirmed → the
     * company is watched and the policy asked again (after `STOP_POLICY_RETRY_MS`, doubling to
     * `STOP_POLICY_RETRY_MAX_MS`, reset once confirmed), so the runner starts by itself once the
     * server answers. Whether a confirmed stop refuses the
     * run is the claim's own check (`oneShotAiAllowed`).
     */
    async stopPolicyConfirmed(companyId: string): Promise<boolean> {
      if (confirmedNow(companyId)) {
        retry.delete(companyId)
        return true
      }
      deps.watch(companyId)
      const next = retry.get(companyId)
      const t = now()
      // A clock that went back (it should not: monotonic) asks again rather than waiting forever.
      if (next === undefined || t >= next.at || t < next.at - next.wait) {
        const wait = next === undefined ? STOP_POLICY_RETRY_MS : Math.min(next.wait * 2, STOP_POLICY_RETRY_MAX_MS)
        retry.set(companyId, { at: t + wait, wait })
        await deps.policy.refresh(companyId, { timeoutMs: deps.refreshTimeoutMs ?? 3000 })
      }
      if (!confirmedNow(companyId)) return false
      retry.delete(companyId)
      return true
    },

    /** AI outside conversations may run (no company has the whole AI stopped). */
    oneShotAiAllowed(): boolean {
      return deps.policy.stoppedCompanies().length === 0
    },
  }
}

export type AgentStop = ReturnType<typeof createAgentStop>
