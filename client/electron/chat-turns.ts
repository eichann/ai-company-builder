import crypto from 'node:crypto'
import { createTurnSteering, type TurnSteering } from './agents/steering'
import type { ChunkInjector } from './ui-stream-limits'
import { STEER_PART_TYPE, canSteerText, type SteerRecord, type SteerResponse } from '../shared/steer'
import { SUGGESTION_WAIT_MS, normalizeSuggestion } from '../shared/prompt-suggestion'

interface Turn {
  steering: ReturnType<typeof createTurnSteering>
  inject: Pick<ChunkInjector, 'push'>
}
/** Generates the turn's suggestion from its reply text (prompt-suggester.ts); null = none. */
export type SuggestFromReply = (reply: string, signal: AbortSignal) => Promise<string | null>
interface SuggestionSlot {
  suggest: SuggestFromReply
  /** The reply text once the turn finished; null after a failure/stop/new turn. */
  ended: Promise<string | null>
  end: (reply: string | null) => void
  /** Aborts a waiting or running generation (new turn, forget, the renderer gave up). */
  abort: AbortController
  result?: Promise<string | null>
}

/**
 * The chat server's per-conversation state for a running turn:
 * - steering: `POST /api/steer` pushes the member's extra instruction into the
 *   running agent and shows it in the reply (`data-steer` part) once accepted;
 * - prompt suggestions: `GET /api/prompt-suggestion/:id` waits (bounded) for
 *   the conversation's latest turn to finish, then generates one suggestion
 *   from its reply. The generation lives as long as that request: the
 *   renderer aborts it when the member types, sends or leaves the
 *   conversation, and a new turn or `forget` aborts it here.
 */
export function createChatTurns(waitMs = SUGGESTION_WAIT_MS) {
  const turns = new Map<string, Turn>()
  const suggestions = new Map<string, SuggestionSlot>()

  const slot = (suggest: SuggestFromReply): SuggestionSlot => {
    let resolveEnded!: (value: string | null) => void
    let ended = false
    const value = new Promise<string | null>(resolve => { resolveEnded = resolve })
    return { suggest, ended: value, end: next => { if (!ended) { ended = true; resolveEnded(next) } }, abort: new AbortController() }
  }
  const drop = (appSessionId: string) => {
    const current = suggestions.get(appSessionId)
    if (!current) return
    current.end(null)
    current.abort.abort()
    suggestions.delete(appSessionId)
  }

  return {
    /**
     * A turn starts in `appSessionId`. Returns what the agent connection
     * receives, and `end()` for when the response is over. `suggest` is
     * given when this turn may get a next-prompt suggestion.
     */
    open(appSessionId: string, inject: Pick<ChunkInjector, 'push'>, options: { suggest?: SuggestFromReply } = {}) {
      turns.get(appSessionId)?.steering.close()
      const turn: Turn = { steering: createTurnSteering(), inject }
      turns.set(appSessionId, turn)
      drop(appSessionId)
      const suggestion = options.suggest ? slot(options.suggest) : undefined
      if (suggestion) suggestions.set(appSessionId, suggestion)
      return {
        steering: turn.steering as TurnSteering,
        /** The response ended: no more steering; a finished turn's reply text feeds the suggestion. */
        end(outcome: 'finished' | 'failed', reply = '') {
          turn.steering.close()
          if (turns.get(appSessionId) === turn) turns.delete(appSessionId)
          suggestion?.end(outcome === 'finished' && reply.trim() ? reply : null)
        },
      }
    },

    async steer(appSessionId: string, text: string): Promise<SteerResponse> {
      const turn = turns.get(appSessionId)
      if (!turn || !canSteerText(text)) return { status: 'unavailable' }
      const record: SteerRecord = { id: crypto.randomUUID(), text: text.trim() }
      const status = await turn.steering.send(record.text, () => {
        turn.inject.push({ type: STEER_PART_TYPE, id: `steer-${record.id}`, data: record })
      })
      return { status, id: record.id }
    },

    /**
     * The latest turn's suggestion (null: none, or none coming). `signal` is
     * the request's: when the renderer gives up, the generation stops.
     */
    async suggestion(appSessionId: string, signal?: AbortSignal): Promise<string | null> {
      const current = suggestions.get(appSessionId)
      if (!current || signal?.aborted || current.abort.signal.aborted) return null
      const giveUp = () => current.abort.abort()
      signal?.addEventListener('abort', giveUp, { once: true })
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        if (!current.result) {
          const timeout = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), waitMs) })
          const aborted = new Promise<null>(resolve => current.abort.signal.addEventListener('abort', () => resolve(null), { once: true }))
          const reply = await Promise.race([current.ended, timeout, aborted])
          if (reply === null || current.abort.signal.aborted) return null
          current.result ??= current.suggest(reply, current.abort.signal)
            .then(value => current.abort.signal.aborted ? null : normalizeSuggestion(value), () => null)
        }
        return await current.result
      } finally {
        clearTimeout(timer)
        signal?.removeEventListener('abort', giveUp)
      }
    },

    forget(appSessionId: string) {
      turns.get(appSessionId)?.steering.close()
      turns.delete(appSessionId)
      drop(appSessionId)
    },
  }
}
