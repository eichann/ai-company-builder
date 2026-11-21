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
import type { BrowserSessionRequest } from '../../../shared/browser-runner'

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
  /** One request, no redirect followed, an answer over 5 MiB refused; rejects = no answer. */
  send(request: SessionRequest, signal?: AbortSignal): Promise<SessionAnswer>
}

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
 * aborts (the answer is dropped), while the chunk itself still ends with its clean-up.
 */
export function throughSession(
  lanes: SessionLanes, key: string, session: PagelessSession, request: SessionRequest,
  allow: (request: BrowserSessionRequest) => boolean, signal?: AbortSignal,
): Promise<SessionAnswer> {
  if (signal?.aborted) return Promise.reject(aborted())
  const chunk = lanes.run(key, async () => {
    try {
      await session.wipe()
      if (signal?.aborted) throw aborted()
      await session.guard(allow)
      await session.copyCookies(request.url)
      if (signal?.aborted) throw aborted()
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

/** A read's rule: exactly this address, GET, no body (a query is never part of a read path). */
export function exactRead(url: string): (request: BrowserSessionRequest) => boolean {
  return r => r.method.toUpperCase() === 'GET' && r.url === url && !r.body && !/[?#]/.test(r.url)
}
