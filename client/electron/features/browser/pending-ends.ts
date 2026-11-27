// Ends the server has not heard yet (agent-browser.md "Letting a domain go"): a frames run's `end` or an operator run's
// `finish` lost to the network keeps the company × domain lock on the server until that run's own time runs out, so the
// next request on the domain — this member's or a colleague's — is refused as busy. Each such end is kept here (main's
// memory, per member and company) and sent again with back-off until the server answers it or the run's own time is
// over (the server then frees the domain by itself), and once more right before this member's next browser task starts.
// Both ends are idempotent on the server: an `end` of an ended run answers the run as it is; a second `finish` changes
// nothing (its log is written once). Any answer of the server settles the end — only "no answer" is retried. No
// Electron; the timers are injected for the tests.
import type { BrowserLinesAnswer } from './lines-api'

export interface PendingEnd {
  /** One end per run (`bf_…` / `bo_…`): a second `keep` of the same run replaces the first. */
  runId: string
  userId: string
  companyId: string
  /** The run's own end (ms): past it the server lets the domain go by itself, so nothing more is sent. */
  until: number
  send(): Promise<BrowserLinesAnswer>
}

export interface PendingEndsDeps {
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  /** The waits between tries (the last one repeats). */
  delaysMs?: readonly number[]
  log?: Pick<Console, 'warn'>
}

/** 2 s, 5 s, 15 s, 30 s, then every minute: a short network drop is over within the first tries. */
export const PENDING_END_DELAYS_MS: readonly number[] = [2_000, 5_000, 15_000, 30_000, 60_000]

export function createPendingEnds(deps: PendingEndsDeps = {}) {
  const now = deps.now ?? Date.now
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => {
    const t = setTimeout(fn, ms)
    t.unref?.()
    return t
  })
  const clearTimer = deps.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>))
  const delays = deps.delaysMs && deps.delaysMs.length > 0 ? deps.delaysMs : PENDING_END_DELAYS_MS
  const log = deps.log ?? console
  interface Kept { end: PendingEnd; tries: number; timer: unknown; sending: Promise<void> | null }
  const kept = new Map<string, Kept>()
  /** Moves on every sign-out: an end whose first try began before it is never kept after it (Codex review). */
  let generation = 0

  const drop = (k: Kept) => {
    if (kept.get(k.end.runId) !== k) return
    clearTimer(k.timer)
    kept.delete(k.end.runId)
  }

  /** One try: settled by any answer of the server, or by the run's own time; else the next try is scheduled. */
  function attempt(k: Kept): Promise<void> {
    if (k.sending) return k.sending
    if (now() >= k.end.until) {
      log.warn(`[browser] the end of run ${k.end.runId} never reached the server; its own time is over (the server frees the domain)`)
      drop(k)
      return Promise.resolve()
    }
    clearTimer(k.timer)
    k.sending = (async () => {
      const answer = await k.end.send().catch((): BrowserLinesAnswer => ({ kind: 'no-answer' }))
      k.tries++
      k.sending = null
      if (kept.get(k.end.runId) !== k) return
      if (answer.kind !== 'no-answer') { drop(k); return }
      // The next try comes no later than the run's own end, where the check above drops it.
      schedule(k)
    })()
    return k.sending
  }

  function schedule(k: Kept): void {
    const wait = Math.min(delays[Math.min(k.tries - 1, delays.length - 1)], Math.max(0, k.end.until - now()))
    k.timer = setTimer(() => { void attempt(k) }, wait)
  }

  return {
    /**
     * The first try already went unanswered: keep the end and try again with back-off. `since`: the `generation()` read
     * before that first try — a sign-out meanwhile drops it (its retries would go with the next account's session).
     */
    keep(end: PendingEnd, since: number = generation): void {
      if (since !== generation) return
      const before = kept.get(end.runId)
      if (before) drop(before)
      if (now() >= end.until) return
      const k: Kept = { end, tries: 1, timer: null, sending: null }
      kept.set(end.runId, k)
      schedule(k)
    },
    /** Right before this member's next browser task in the company: every end still kept is sent once more, awaited. */
    async flush(userId: string, companyId: string): Promise<void> {
      await Promise.all([...kept.values()].filter(k => k.end.userId === userId && k.end.companyId === companyId).map(attempt))
    },
    /** How many ends are kept (tests, diagnostics). */
    size: () => kept.size,
    /** The current sign-in's generation (read before a first try: `sendEnd`). */
    generation: () => generation,
    /** Sign-out: nothing of the previous account is sent with the next one's session — kept or still on its first try. */
    clear(): void {
      generation++
      for (const k of [...kept.values()]) drop(k)
    },
  }
}

export type PendingEnds = ReturnType<typeof createPendingEnds>

/**
 * Send an end once and keep it when the server did not answer (`pending` absent: as before, one try). The first answer
 * is returned so a caller that waits for it (the preview's finish) still sees it.
 */
export async function sendEnd(pending: PendingEnds | undefined, end: Omit<PendingEnd, 'send'>, send: () => Promise<BrowserLinesAnswer>): Promise<BrowserLinesAnswer> {
  const since = pending?.generation()
  const answer = await send().catch((): BrowserLinesAnswer => ({ kind: 'no-answer' }))
  if (answer.kind === 'no-answer') pending?.keep({ ...end, send }, since)
  return answer
}
