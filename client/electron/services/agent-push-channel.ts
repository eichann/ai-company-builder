/**
 * The app's end of the server → app push channel (GET /me/events, server-sent
 * events; .claude/rules/agent-stop.md). Main process only: the session stays
 * here (Cookie header, never the URL), the renderer never sees it.
 *
 * Defensive by design (owner, 2026-10-31 「かもしれない運転」):
 * - The only thing an event can make happen is `refresh(companyId, version)`:
 *   the caller refetches the policy over the normal authenticated API. This
 *   module has no other capability (no window, no files, no commands).
 * - Only `policy` events whose data is exactly `{ kind, version }` count
 *   (client/shared/agent-stop.ts `createSseParser`); anything else is dropped
 *   and logged by name only; an over-long line ends the connection.
 * - https only (http only for a server on this computer), to the signed-in
 *   server's own URL; redirects are not followed.
 * - No data for 60 s (the server's heartbeat is 25 s) → the connection is
 *   treated as dead. Reconnects wait 1 s doubling to 60 s, each with jitter
 *   (×0.5–1.5), so a server restart is not met by every app at once.
 * - A fallback check every 60 s (`refresh(companyId)`) whether or not the
 *   stream is up; the chat also checks at each conversation start.
 */
import { AGENT_STOP_SUPPORT_HEADER, createSseParser, pushChannelUrl } from '../../shared/agent-stop'

export interface AgentPushChannelDeps {
  baseUrl: () => string
  cookies: () => string[]
  /** Refetch this company's policy (`version`: the one the server announced). The channel's only effect. */
  refresh: (companyId: string, version?: string) => void
  /** A `records` event: something of the company map concerning this member changed (refetch only). */
  onRecords?: (companyId: string) => void
  fetch?: typeof fetch
  log?: Pick<Console, 'log' | 'warn'>
  random?: () => number
  setTimeout?: (fn: () => void, ms: number) => unknown
  clearTimeout?: (handle: unknown) => void
}

export const PUSH_IDLE_TIMEOUT_MS = 60_000
export const PUSH_POLL_MS = 60_000
export const PUSH_BACKOFF_MIN_MS = 1_000
export const PUSH_BACKOFF_MAX_MS = 60_000
/** At most this many companies are watched; the one watched longest ago goes. */
export const PUSH_MAX_COMPANIES = 5

/** The wait before reconnect attempt `attempt` (0-based), with jitter. */
export function reconnectDelay(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(PUSH_BACKOFF_MAX_MS, PUSH_BACKOFF_MIN_MS * 2 ** Math.min(attempt, 10))
  return Math.round(base * (0.5 + random()))
}

interface Watch {
  companyId: string
  abort?: AbortController
  attempt: number
  timer?: unknown
  idle?: unknown
  poll?: unknown
  stopped: boolean
}

export function createAgentPushChannel(deps: AgentPushChannelDeps) {
  const doFetch = deps.fetch ?? fetch
  const log = deps.log ?? console
  const random = deps.random ?? Math.random
  const later = deps.setTimeout ?? ((fn: () => void, ms: number) => { const t = setTimeout(fn, ms); t.unref?.(); return t })
  const cancel = deps.clearTimeout ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  const watches = new Map<string, Watch>()
  let refusedUrlLogged = false

  const safeRefresh = (companyId: string, version?: string) => {
    try { deps.refresh(companyId, version) } catch (error) {
      log.warn(`[push] ${companyId}: refresh failed (${error instanceof Error ? error.message : 'unknown'})`)
    }
  }

  const safeRecords = (companyId: string) => {
    try { deps.onRecords?.(companyId) } catch (error) {
      log.warn(`[push] ${companyId}: records listener failed (${error instanceof Error ? error.message : 'unknown'})`)
    }
  }

  const schedulePoll = (w: Watch) => {
    cancel(w.poll)
    w.poll = later(() => {
      if (w.stopped) return
      safeRefresh(w.companyId)
      schedulePoll(w)
    }, PUSH_POLL_MS)
  }

  const scheduleReconnect = (w: Watch) => {
    if (w.stopped) return
    cancel(w.timer)
    const delay = reconnectDelay(w.attempt++, random)
    w.timer = later(() => { void connect(w) }, delay)
  }

  const armIdle = (w: Watch, abort: AbortController) => {
    cancel(w.idle)
    w.idle = later(() => {
      log.warn(`[push] ${w.companyId}: no data for ${PUSH_IDLE_TIMEOUT_MS / 1000} s; reconnecting`)
      abort.abort()
    }, PUSH_IDLE_TIMEOUT_MS)
  }

  async function connect(w: Watch): Promise<void> {
    if (w.stopped) return
    const url = pushChannelUrl(deps.baseUrl(), w.companyId)
    if (!url) {
      if (!refusedUrlLogged) { refusedUrlLogged = true; log.warn('[push] the server address is not https; no live notices (the 60 s check still runs)') }
      return
    }
    const cookies = deps.cookies()
    if (cookies.length === 0) { scheduleReconnect(w); return }
    const abort = new AbortController()
    w.abort = abort
    let gotEvent = false
    try {
      const res = await doFetch(url, {
        headers: { Cookie: cookies.join('; '), Accept: 'text/event-stream', [AGENT_STOP_SUPPORT_HEADER]: '1' },
        redirect: 'error',
        signal: abort.signal,
      })
      if (res.status === 404 || res.status === 403) {
        // Not (or no longer) a member, or a server without the channel: stop trying for this company.
        log.warn(`[push] ${w.companyId}: HTTP ${res.status}; not watching this company`)
        void res.body?.cancel().catch(() => {})
        stopWatch(w)
        return
      }
      const type = res.headers.get('content-type') ?? ''
      if (!res.ok || !res.body || !type.startsWith('text/event-stream')) {
        log.warn(`[push] ${w.companyId}: HTTP ${res.status}; retrying later`)
        void res.body?.cancel().catch(() => {})
        throw new Error('not an event stream')
      }
      const parser = createSseParser()
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      armIdle(w, abort)
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        armIdle(w, abort)
        for (const item of parser.push(decoder.decode(value, { stream: true }))) {
          if (item.type === 'event') {
            gotEvent = true
            w.attempt = 0
            // Only a policy event refetches the policy; a records event (the company map,
            // records.md) only tells the records view to refetch, when one listens.
            if (item.event.kind === 'policy') safeRefresh(w.companyId, item.event.version)
            else if (item.event.kind === 'records') safeRecords(w.companyId)
          } else if (item.type === 'dropped') {
            log.warn(`[push] ${w.companyId}: dropped an event that is not allowed (${item.name})`)
          }
        }
        if (parser.overflow) {
          log.warn(`[push] ${w.companyId}: oversized data; closing the connection`)
          abort.abort()
          break
        }
      }
    } catch {
      // Network error, abort, idle timeout: reconnect below.
    } finally {
      cancel(w.idle)
      if (w.abort === abort) w.abort = undefined
    }
    if (w.stopped) return
    // A connection that delivered something reconnects soon; one that failed backs off further.
    if (gotEvent) w.attempt = 0
    scheduleReconnect(w)
  }

  function stopWatch(w: Watch) {
    w.stopped = true
    cancel(w.timer); cancel(w.idle); cancel(w.poll)
    w.abort?.abort()
    if (watches.get(w.companyId) === w) watches.delete(w.companyId)
  }

  return {
    /** Keep this company's policy live (idempotent). */
    watch(companyId: string): void {
      if (!companyId || watches.has(companyId)) return
      if (watches.size >= PUSH_MAX_COMPANIES) {
        const oldest = watches.values().next().value as Watch
        stopWatch(oldest)
      }
      const w: Watch = { companyId, attempt: 0, stopped: false }
      watches.set(companyId, w)
      schedulePoll(w)
      void connect(w)
    },
    /** Sign-out / quit: close every connection and forget the companies. */
    stopAll(): void {
      for (const w of [...watches.values()]) stopWatch(w)
    },
    watched: (): string[] => [...watches.keys()],
  }
}

export type AgentPushChannel = ReturnType<typeof createAgentPushChannel>
