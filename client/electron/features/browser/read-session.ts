// Main's own requests to an operated site go through page-less sessions of their own, never the
// window's (agent-browser.md "The operator and the preview", design memo §33 2-4): the read session
// `<window partition>-read` for every read (the preview's, the runner's before and after a write)
// and the write session `<window partition>-write` for a write. No page lives there, so no script,
// worker or WebSocket can add to or answer main's request, and the window's own page — the member's
// work in it — is never touched. No Electron: the shell (browser-window.ts) implements
// `PagelessSession`.
//
// One request is one chunk on the session's lane: prepare (connections closed, storage cleared —
// awaited —, the one request hook set, the window's cookies for exactly this address copied in) →
// the request → clean-up (cleared again). The lanes are one table per app, keyed by the partition's
// name, so a window closed and opened again on the same partition waits for the old chunk's clean-up
// too. A caller that gives up (its request was stopped, its context changed) only drops the answer:
// the chunk still finishes its clean-up before the lane goes on, so an old clean-up never clears a
// newer read's cookies or connection. (A new partition per request is not used: Electron keeps a
// session for the whole app run, so they would pile up.)
import { exploreAddressProblem } from '../../../../shared/core/plugin-browser-declaration'
import type { BrowserSessionRequest, BrowserWriteOutcome, BrowserWriteSteps } from '../../../shared/browser-runner'

export interface SessionRequest {
  method: string
  url: string
  contentType?: string
  body?: string
}

export interface SessionAnswer {
  status: number
  body: string
}

/** A page-less session as the shell provides it. */
export interface PagelessSession {
  /** Closes its connections and clears its storage and cache (awaited). */
  wipe(): Promise<void>
  /** Sets its one request hook (only what `allow` says passes) and its proxy rule. */
  guard(allow: (request: BrowserSessionRequest) => boolean): Promise<void>
  /** Copies the window's cookies for exactly this address in (path-scoped ones included). */
  copyCookies(url: string): Promise<void>
  /**
   * One request, no redirect followed, an answer over 5 MiB refused; rejects = no answer. With
   * `beforeSend`, it is asked synchronously right before the request is ended: false or a throw — or
   * anything failing before the request is ended — rejects with `BrowserNotSentError` (it never left).
   */
  send(request: SessionRequest, signal?: AbortSignal, beforeSend?: () => boolean): Promise<SessionAnswer>
}

/** A write that provably never left: thrown by the shell's send only before it ends the request. */
export class BrowserNotSentError extends Error {
  readonly notSent = true
  constructor(why: string) {
    super(why)
    this.name = 'BrowserNotSentError'
  }
}

export const isNotSent = (error: unknown): boolean => error instanceof Error && (error as { notSent?: unknown }).notSent === true

/** One queue per session name: a chunk starts only after the one before it finished, clean-up included. */
export function createSessionLanes() {
  const tails = new Map<string, Promise<void>>()
  return {
    run<T>(key: string, chunk: () => Promise<T>): Promise<T> {
      const before = tails.get(key) ?? Promise.resolve()
      const result = before.then(chunk)
      const tail = result.then(() => undefined, () => undefined)
      tails.set(key, tail)
      void tail.then(() => { if (tails.get(key) === tail) tails.delete(key) })
      return result
    },
    /** Lanes with a chunk queued or running (for tests and logs). */
    busy(): string[] { return [...tails.keys()] },
  }
}

export type SessionLanes = ReturnType<typeof createSessionLanes>

const aborted = () => Object.assign(new Error('aborted'), { name: 'AbortError' })

/**
 * One request through a page-less session, as one chunk of its lane. Rejects at once when `signal`
 * aborts (the answer is dropped), while the chunk itself still ends with its clean-up. `stillOpen`:
 * the caller's own window is still the one open — asked again when the chunk's turn comes (it may
 * have waited behind another window's chunk), never sent otherwise.
 */
export function throughSession(
  lanes: SessionLanes, key: string, session: PagelessSession, request: SessionRequest,
  allow: (request: BrowserSessionRequest) => boolean, signal?: AbortSignal, stillOpen: () => boolean = () => true,
): Promise<SessionAnswer> {
  if (signal?.aborted) return Promise.reject(aborted())
  const chunk = lanes.run(key, async () => {
    try {
      await session.wipe()
      if (signal?.aborted) throw aborted()
      if (!stillOpen()) throw new Error('window closed')
      await session.guard(allow)
      await session.copyCookies(request.url)
      if (signal?.aborted) throw aborted()
      if (!stillOpen()) throw new Error('window closed')
      return await session.send(request, signal)
    } finally {
      await session.wipe()
    }
  })
  if (!signal) return chunk
  return new Promise<SessionAnswer>((resolve, reject) => {
    const onAbort = () => reject(aborted())
    signal.addEventListener('abort', onAbort, { once: true })
    chunk.then(
      answer => { signal.removeEventListener('abort', onAbort); resolve(answer) },
      error => { signal.removeEventListener('abort', onAbort); reject(error) },
    )
  })
}

/**
 * A run's one write through the window's page-less write session, as one chunk of its lane (6b-2c,
 * design 6b-2 §3 steps 9–11): prepare (connections closed, storage cleared, the one request hook, the
 * window's cookies for exactly this address) → `steps.ready()` (the runner asks the permit here, so the
 * preparation never eats into it) → the send, with `steps.beforeSend` asked synchronously right before
 * the request is ended → cleared again. Never rejects: a write that provably never left is `sent:
 * false` with the stage it stopped at; once the request was ended it is `sent: true` (`answer: null`
 * when no answer came — it may have reached the site).
 */
export function writeThroughSession(
  lanes: SessionLanes, key: string, session: PagelessSession, request: SessionRequest,
  allow: (request: BrowserSessionRequest) => boolean, steps: BrowserWriteSteps, stillOpen: () => boolean,
): Promise<BrowserWriteOutcome> {
  return lanes.run(key, async (): Promise<BrowserWriteOutcome> => {
    let stage: 'prepare' | 'ready' | 'before-send' = 'prepare'
    try {
      await session.wipe()
      if (!stillOpen()) return { sent: false, stage }
      await session.guard(allow)
      await session.copyCookies(request.url)
      if (!stillOpen()) return { sent: false, stage }
      stage = 'ready'
      let go = false
      try { go = (await steps.ready()) === true } catch { go = false }
      if (!go) return { sent: false, stage }
      stage = 'before-send'
      try {
        return { sent: true, answer: await session.send(request, undefined, steps.beforeSend) }
      } catch (error) {
        // Only the shell's own marker says it never left; anything else after the end may have.
        return isNotSent(error) ? { sent: false, stage } : { sent: true, answer: null }
      }
    } catch {
      // The preparation failed (stage 'prepare' or 'ready'): the request was never made.
      return { sent: false, stage }
    } finally {
      await session.wipe().catch(() => {})
    }
  })
}

/**
 * A preview read's rule: GET of exactly this address — the path and the whole query string compared
 * byte for byte with what was built from the declaration (`explorePath`: the parameters' order, their
 * spelling, nothing more, nothing encoded otherwise) —, no body, no fragment, and an address a declared
 * read can have at all (`exploreAddressProblem`: no query unless it is plain `name=value` pairs).
 */
export function exactRead(url: string): (request: BrowserSessionRequest) => boolean {
  const address = /^https:\/\/[^/?#]+(\/[^#]*)$/.exec(url)?.[1]
  const fits = address !== undefined && exploreAddressProblem(address) === null
  return r => fits && r.method.toUpperCase() === 'GET' && r.url === url && !r.body
}
