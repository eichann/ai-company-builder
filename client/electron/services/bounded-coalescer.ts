// Push signals that come in a burst (one change to a record sends `records` and `notifications`,
// a bulk change sends many) are handled once (plan 「問い合わせを減らす計画」 段1;
// `ipc-and-main-process.md` "Shared reads"). The wait starts at a key's first signal and is never
// moved by the ones after it, so a steady stream of signals is still handled every `windowMs` —
// nothing waits longer than that, and that is at most `COALESCE_MAX_MS`.
//
// Only for signals from outside: the stop policy, a permission or visibility change and the
// member's own actions never go through here.

/** The hard upper bound of any wait (owner-approved plan: 上限 1 秒). */
export const COALESCE_MAX_MS = 1000

export interface BoundedCoalescer<K extends string> {
  /** A signal of `kind` for `key`: handled together with the others of the same window. */
  push(key: string, kind: K): void
  /** Sign-out / quit: forget what waits (nothing is handled for it). */
  stop(): void
}

export interface BoundedCoalescerDeps<K extends string> {
  windowMs: number
  /** Every kind signalled for `key` during the window, once. */
  flush: (key: string, kinds: ReadonlySet<K>) => void
  setTimeout?: (fn: () => void, ms: number) => unknown
  clearTimeout?: (handle: unknown) => void
}

export function createBoundedCoalescer<K extends string>(deps: BoundedCoalescerDeps<K>): BoundedCoalescer<K> {
  if (!(deps.windowMs >= 0 && deps.windowMs <= COALESCE_MAX_MS)) throw new Error(`coalescing window must be 0–${COALESCE_MAX_MS} ms`)
  const later = deps.setTimeout ?? ((fn: () => void, ms: number) => { const t = setTimeout(fn, ms); t.unref?.(); return t })
  const cancel = deps.clearTimeout ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>))
  const waiting = new Map<string, { kinds: Set<K>; timer: unknown }>()

  return {
    push(key, kind) {
      const open = waiting.get(key)
      if (open) { open.kinds.add(kind); return }
      const entry = { kinds: new Set<K>([kind]), timer: null as unknown }
      waiting.set(key, entry)
      entry.timer = later(() => {
        if (waiting.get(key) !== entry) return
        waiting.delete(key)
        deps.flush(key, entry.kinds)
      }, deps.windowMs)
    },
    stop() {
      for (const entry of waiting.values()) cancel(entry.timer)
      waiting.clear()
    },
  }
}
