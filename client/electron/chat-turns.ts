import crypto from 'node:crypto'
import { createTurnSteering, type TurnSteering } from './agents/steering'
import type { ChunkInjector } from './ui-stream-limits'
import { STEER_PART_TYPE, canSteerText, type SteerRecord, type SteerResponse } from '../shared/steer'
import { SUGGESTION_WAIT_MS, normalizeSuggestion } from '../shared/prompt-suggestion'

interface Turn {
  steering: ReturnType<typeof createTurnSteering>
  inject: Pick<ChunkInjector, 'push'>
}
interface SuggestionSlot { value: Promise<string | null>; settle: (value: string | null) => void }

/**
 * The chat server's per-conversation state for a running turn:
 * - steering: `POST /api/steer` pushes the member's extra instruction into the
 *   running agent and shows it in the reply (`data-steer` part) once accepted;
 * - prompt suggestions: `GET /api/prompt-suggestion/:id` waits (bounded) for
 *   the suggestion of the conversation's latest turn, which arrives after
 *   that turn's response stream has closed.
 */
export function createChatTurns(waitMs = SUGGESTION_WAIT_MS) {
  const turns = new Map<string, Turn>()
  const suggestions = new Map<string, SuggestionSlot>()

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
