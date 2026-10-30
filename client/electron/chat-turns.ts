import crypto from 'node:crypto'
import { createTurnSteering, type TurnSteering } from './agents/steering'
import type { ChunkInjector } from './ui-stream-limits'
import { STEER_PART_TYPE, canSteerText, type SteerRecord, type SteerResponse } from '../shared/steer'
import { SUGGESTION_WAIT_MS, normalizeSuggestion } from '../shared/prompt-suggestion'
import { TURN_STOPPED_PART_TYPE, type TurnStopReason } from '../shared/agent-events'
import { AGENT_STOP_MESSAGES } from '../shared/agent-stop'

interface Turn {
  steering: ReturnType<typeof createTurnSteering>
  inject: Pick<ChunkInjector, 'push'>
}
interface SuggestionSlot { value: Promise<string | null>; settle: (value: string | null) => void }

/** What `abort` can select a running turn by. */
export interface TurnInfo {
  appSessionId?: string
  companyId?: string
}
interface RunningTurn {
  info: TurnInfo
  controller: AbortController
  inject?: Pick<ChunkInjector, 'push'>
}

export interface ChatTurnsOptions {
  /** Cancel the conversation's pending tool approvals and choice cards (agent-interactions). */
  cancelInteractions?: (appSessionId: string) => void
}

/**
 * The chat server's per-conversation state for a running turn:
 * - steering: `POST /api/steer` pushes the member's extra instruction into the
 *   running agent and shows it in the reply (`data-steer` part) once accepted;
 * - prompt suggestions: `GET /api/prompt-suggestion/:id` waits (bounded) for
 *   the suggestion of the conversation's latest turn, which arrives after
 *   that turn's response stream has closed;
 * - abort handles: every response (any agent) runs under an AbortController
 *   that follows the request's signal (the renderer's stop) and that the main
 *   process can trigger with `abort` / `abortAll` (monitoring M2). The signal
 *   goes into streamText, so each agent stops the way it stops on the
 *   renderer's stop (Claude: the provider kills the CLI; Codex: turn/interrupt).
 */
export function createChatTurns(waitMs = SUGGESTION_WAIT_MS, hooks: ChatTurnsOptions = {}) {
  const turns = new Map<string, Turn>()
  const suggestions = new Map<string, SuggestionSlot>()
  const running = new Set<RunningTurn>()

  const stop = (turn: RunningTurn, reason: TurnStopReason) => {
    if (turn.controller.signal.aborted) return
    // The reason first, while the response is still open (transient: the
    // renderer reads it in onData, history never stores it); the stream then
    // ends with an `abort` chunk carrying the same reason.
    try {
      // An administrator's stop is said in the reply itself (kept with the conversation).
      if (reason === 'stopped-by-admin') {
        const id = `turn-stopped-${crypto.randomUUID()}`
        turn.inject?.push({ type: 'text-start', id })
        turn.inject?.push({ type: 'text-delta', id, delta: `\n\n※ ${AGENT_STOP_MESSAGES.turnStopped}` })
        turn.inject?.push({ type: 'text-end', id })
      }
      turn.inject?.push({ type: TURN_STOPPED_PART_TYPE, data: { reason }, transient: true })
    } catch { /* stream already over */ }
    if (turn.info.appSessionId) {
      try { hooks.cancelInteractions?.(turn.info.appSessionId) } catch (error) { console.warn('[chat-server] cancelling pending questions failed:', error instanceof Error ? error.message : 'unknown') }
    }
    turn.controller.abort(reason)
  }

  const abort = (filter: (info: TurnInfo) => boolean, reason: TurnStopReason = 'stopped-by-admin'): number => {
    let stopped = 0
    for (const turn of [...running]) {
      if (!filter(turn.info) || turn.controller.signal.aborted) continue
      stop(turn, reason)
      stopped++
    }
    return stopped
  }

  const slot = (): SuggestionSlot => {
    let settle!: (value: string | null) => void
    let settled = false
    const value = new Promise<string | null>(resolve => { settle = resolve })
    return { value, settle: next => { if (!settled) { settled = true; settle(next) } } }
  }

  return {
    /**
     * A turn starts in `appSessionId`. Returns what the agent connection
     * receives, and `end()` for when the response is over.
     */
    open(appSessionId: string, inject: Pick<ChunkInjector, 'push'>, options: { suggestions: boolean }) {
      turns.get(appSessionId)?.steering.close()
      const turn: Turn = { steering: createTurnSteering(), inject }
      turns.set(appSessionId, turn)
      suggestions.get(appSessionId)?.settle(null)
      const suggestion = options.suggestions ? slot() : undefined
      if (suggestion) suggestions.set(appSessionId, suggestion)
      else suggestions.delete(appSessionId)
      let timer: ReturnType<typeof setTimeout> | undefined
      return {
        steering: turn.steering as TurnSteering,
        onPromptSuggestion: suggestion ? (value: string | null) => {
          // Content stays out of the log; whether one came is what we need.
          console.log(`[chat-server] Prompt suggestion: ${normalizeSuggestion(value) ? 'received' : 'none from the CLI'}`)
          suggestion.settle(normalizeSuggestion(value))
          clearTimeout(timer)
        } : undefined,
        /** The response ended: no more steering; a suggestion may still come (not after a failure/stop). */
        end(outcome: 'finished' | 'failed') {
          turn.steering.close()
          if (turns.get(appSessionId) === turn) turns.delete(appSessionId)
          if (!suggestion) return
          if (outcome === 'failed') { suggestion.settle(null); return }
          clearTimeout(timer)
          timer = setTimeout(() => {
            console.log('[chat-server] Prompt suggestion: none (timed out)')
            suggestion.settle(null)
          }, waitMs)
          timer.unref?.()
        },
      }
    },

    /**
     * A response starts (any agent). `signal` replaces the request's signal
     * everywhere the turn uses one; call `end()` when the response is over.
     */
    track(info: TurnInfo, requestSignal: AbortSignal, inject?: Pick<ChunkInjector, 'push'>) {
      const controller = new AbortController()
      const turn: RunningTurn = { info, controller, inject }
      const follow = () => controller.abort(requestSignal.reason)
      if (requestSignal.aborted) follow()
      else requestSignal.addEventListener('abort', follow, { once: true })
      running.add(turn)
      return {
        signal: controller.signal,
        end() {
          running.delete(turn)
          requestSignal.removeEventListener('abort', follow)
        },
      }
    },

    /** Stop every running turn `filter` selects; returns how many were stopped. */
    abort,

    abortAll: (reason: TurnStopReason = 'stopped-by-admin'): number => abort(() => true, reason),

    /** Turns currently running (for tests and diagnostics). */
    runningCount: () => running.size,

    async steer(appSessionId: string, text: string): Promise<SteerResponse> {
      const turn = turns.get(appSessionId)
      if (!turn || !canSteerText(text)) return { status: 'unavailable' }
      const record: SteerRecord = { id: crypto.randomUUID(), text: text.trim() }
      const status = await turn.steering.send(record.text, () => {
        turn.inject.push({ type: STEER_PART_TYPE, id: `steer-${record.id}`, data: record })
      })
      return { status, id: record.id }
    },

    /** The latest turn's suggestion (null: none, or none coming). */
    async suggestion(appSessionId: string): Promise<string | null> {
      const current = suggestions.get(appSessionId)
      if (!current) return null
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), waitMs) })
      try { return await Promise.race([current.value, timeout]) } finally { clearTimeout(timer) }
    },

    forget(appSessionId: string) {
      turns.get(appSessionId)?.steering.close()
      turns.delete(appSessionId)
      suggestions.get(appSessionId)?.settle(null)
      suggestions.delete(appSessionId)
    },
  }
}
