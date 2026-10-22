import crypto from 'node:crypto'
import type { SteerStatus } from '../../shared/steer'

/**
 * Extra instructions while the AI works (shared/steer.ts). The chat server
 * opens one `TurnSteering` per running turn; the agent connection attaches a
 * `SteerTarget` once its native session can take input.
 */
export interface SteerTarget {
  /**
   * Push `text` into the running turn. `accepted` is called once the agent
   * has the text (the transcript shows it from then on); the promise resolves
   * when it is known whether the agent read it in this turn.
   */
  send(text: string, accepted: () => void): Promise<Exclude<SteerStatus, 'unavailable'>>
}

export interface TurnSteering {
  attach(target: SteerTarget): void
  /** Only if `target` is still the attached one (a fallback re-run may have replaced it). */
  detach(target: SteerTarget): void
}

export function createTurnSteering() {
  let target: SteerTarget | undefined
  let closed = false
  return {
    attach(next: SteerTarget) { if (!closed) target = next },
    detach(old: SteerTarget) { if (target === old) target = undefined },
    close() { closed = true; target = undefined },
    send(text: string, accepted: () => void): Promise<SteerStatus> {
      return target ? target.send(text, accepted) : Promise.resolve('unavailable')
    },
  }
}

// ---------------------------------------------------------------------------
// Claude Code: streaming input on the running Query
// ---------------------------------------------------------------------------

/** The parts of the SDK's Query the steering uses (a fake in tests). */
export interface SteerableQuery {
  streamInput(stream: AsyncIterable<unknown>): Promise<void>
  cancelAsyncMessage?(uuid: string): Promise<boolean>
  interrupt?(): Promise<unknown>
}

type Settle = (status: 'delivered' | 'not-delivered') => void

/**
 * Steering for one Claude Code query. Each instruction is a streamed user
 * message with its own uuid; the CLI folds it into the running turn at the
 * next step boundary (after the current tool round). The CLI reports what
 * happened to it:
 * - `command_lifecycle` (`queued` → `started` → `completed`): `started` while
 *   the turn runs means it was folded in.
 * - the turn's `result.user_message_uuids`: every client message the turn
 *   consumed.
 * The provider stops reading at the first `result`, so an instruction that
 * arrived too late for this turn (the CLI would run it as its own next turn,
 * whose output nobody reads) is withdrawn with `cancelAsyncMessage` and
 * reported `not-delivered` — the renderer then sends it as a normal message.
 * The CLI usually takes the next queued message the moment the result is
 * out, before the cancel lands (seen with CLI 2.1.304), so when that unseen
 * turn starts it is interrupted at once: it must not run tools while the
 * provider is still draining the query. The text stays in the
 * CLI's transcript, so the model may see it twice after the re-send.
 * Whether the CLI sends lifecycle frames is read from its init message
 * (`capabilities` has `msg_lifecycle_v1`, CLI 2.1.304). A CLI without them
 * cannot tell a fold from a late arrival, so there the instruction counts as
 * delivered.
 */
export function createClaudeSteer(query: SteerableQuery) {
  const pending = new Map<string, Settle>()
  const withdrawn = new Set<string>()
  let lifecycle = false
  const inbox: unknown[] = []
  let wake: (() => void) | undefined
  let ended = false
  let streaming = false
  async function* messages() {
    for (;;) {
      if (inbox.length) { yield inbox.shift(); continue }
      if (ended) return
      await new Promise<void>(resolve => { wake = resolve })
      wake = undefined
    }
  }
  const settle = (uuid: string, status: 'delivered' | 'not-delivered') => {
    const done = pending.get(uuid)
    if (!done) return
    pending.delete(uuid)
    done(status)
  }
  const target: SteerTarget = {
    send(text, accepted) {
      if (ended) return Promise.resolve('not-delivered')
      const uuid = crypto.randomUUID()
      const result = new Promise<'delivered' | 'not-delivered'>(resolve => pending.set(uuid, resolve))
      inbox.push({ type: 'user', uuid, message: { role: 'user', content: [{ type: 'text', text }] }, parent_tool_use_id: null, session_id: '' })
      wake?.()
      // Started lazily: when the iterable ends, streamInput closes the CLI's
      // input, so it runs only once something was sent, and ends with the query.
      if (!streaming) {
        streaming = true
        query.streamInput(messages()).catch(error => console.warn('[steer] streamInput failed:', error instanceof Error ? error.message : 'unknown'))
      }
      accepted()
      return result
    },
  }
  return {
    target,
    /** Every SDK message of the query, in order. */
    observe(message: unknown) {
      const value = message as { type?: string; subtype?: string; capabilities?: unknown; command_uuid?: string; state?: string; user_message_uuids?: unknown; user_message_uuid?: unknown }
      if (value?.type === 'system' && value.subtype === 'init') {
        lifecycle = Array.isArray(value.capabilities) && value.capabilities.includes('msg_lifecycle_v1')
        return
      }
      if (value?.type === 'command_lifecycle' && typeof value.command_uuid === 'string') {
        if (value.state === 'started' && withdrawn.has(value.command_uuid)) {
          withdrawn.delete(value.command_uuid)
          query.interrupt?.().catch(() => {})
          return
        }
        if (value.state === 'started' || value.state === 'completed') settle(value.command_uuid, 'delivered')
        else if (value.state === 'cancelled') settle(value.command_uuid, 'not-delivered')
        return
      }
      if (value?.type !== 'result') return
      const consumed = Array.isArray(value.user_message_uuids) ? value.user_message_uuids
        : typeof value.user_message_uuid === 'string' ? [value.user_message_uuid] : []
      for (const uuid of [...pending.keys()]) {
        if (consumed.includes(uuid) || !lifecycle) { settle(uuid, 'delivered'); continue }
        settle(uuid, 'not-delivered')
        withdrawn.add(uuid)
        query.cancelAsyncMessage?.(uuid).catch(() => {})
      }
    },
    /** The query is over (finished, stopped, failed): nothing more can be read. */
    close() {
      ended = true
      wake?.()
      for (const uuid of [...pending.keys()]) settle(uuid, 'not-delivered')
    },
  }
}

/**
 * Observe every message the provider reads from the SDK's Query without
 * changing what it reads: the provider iterates `query[Symbol.asyncIterator]()`
 * (possibly more than once, e.g. for a post-result drain), so that returns
 * one wrapper around the same underlying iterator. `onEnd` runs once, when the
 * iterator finishes, is returned (provider done, stop) or throws.
 */
export function tapQuery(query: object, observe: (message: unknown) => void, onEnd: () => void) {
  const source = query as { [Symbol.asyncIterator]?: () => AsyncIterator<unknown> }
  if (typeof source[Symbol.asyncIterator] !== 'function') return
  const inner = source[Symbol.asyncIterator]!()
  let ended = false
  const end = () => { if (!ended) { ended = true; try { onEnd() } catch { /* observer only */ } } }
  const wrapper: AsyncIterableIterator<unknown> = {
    async next(...args: [] | [unknown]) {
      let result: IteratorResult<unknown>
      try { result = await inner.next(...args) } catch (error) { end(); throw error }
      if (result.done) end()
      else { try { observe(result.value) } catch { /* observer only */ } }
      return result
    },
    async return(value?: unknown) {
      end()
      return inner.return ? inner.return(value) : { done: true, value }
    },
    async throw(error?: unknown) {
      end()
      if (inner.throw) return inner.throw(error)
      throw error
    },
    [Symbol.asyncIterator]() { return wrapper },
  }
  Object.defineProperty(query, Symbol.asyncIterator, { value: () => wrapper, configurable: true })
}
