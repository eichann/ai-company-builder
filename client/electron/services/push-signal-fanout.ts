// The push channel's `records` and `notifications` signals of one company (no content, 「かもしれない
// 運転」: they only make the app ask again), handled once per burst (plan 「問い合わせを減らす計画」
// 段1; `notifications.md` "The app"):
//
// - the change is marked at once (`changed`: shared reads already on their way are not joined by
//   whoever asks next), the asking again waits at most `windowMs` (`bounded-coalescer.ts`, ≤ 1 s);
// - a burst with a records signal → `records` once (the task list, 「あなたの番」, the received
//   minutes); notifications signals alone → `noticesOnly` once (the title bar's look).
//
// The stop policy is not a signal of this module (agent-control has its own path) and is never delayed.

import { createBoundedCoalescer } from './bounded-coalescer'

export interface PushSignalFanoutDeps {
  windowMs: number
  /** Something of the company changed (called at once, before any wait). */
  changed: (companyId: string) => void
  /** A burst that had a records signal: ask again for what records make. */
  records: (companyId: string) => void
  /** A burst of notifications signals only: ask again for the notices. */
  noticesOnly: (companyId: string) => void
  setTimeout?: (fn: () => void, ms: number) => unknown
  clearTimeout?: (handle: unknown) => void
}

export function createPushSignalFanout(deps: PushSignalFanoutDeps) {
  const bursts = createBoundedCoalescer<'records' | 'notifications'>({
    windowMs: deps.windowMs,
    flush: (companyId, kinds) => (kinds.has('records') ? deps.records(companyId) : deps.noticesOnly(companyId)),
    setTimeout: deps.setTimeout,
    clearTimeout: deps.clearTimeout,
  })
  const signal = (companyId: string, kind: 'records' | 'notifications') => {
    deps.changed(companyId)
    bursts.push(companyId, kind)
  }
  return {
    records: (companyId: string) => signal(companyId, 'records'),
    notifications: (companyId: string) => signal(companyId, 'notifications'),
    stop: () => bursts.stop(),
  }
}
