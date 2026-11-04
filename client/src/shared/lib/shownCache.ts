// Generic: what a view last showed of a server answer, kept in memory so a view mounted again shows it at once.

/** A server answer as the views get it: shown, gone (not found or no longer readable), or failed. */
export type ShownAnswer = { success: true } | { success: false; notFound?: boolean }

/**
 * Stale-while-revalidate for views that read from a server: a view mounted again (a tab switched
 * back to) shows what it showed last while it reads again. Memory only — never disk or storage.
 * One scope at a time (the company on screen): touching another scope forgets everything first, so
 * one scope's answers are never shown for another. At most `max` entries, least recently used first out.
 */
export interface ShownCache<T extends ShownAnswer> {
  /** What was last shown for `key`, if anything (only ever a successful answer). */
  shown(scope: string, key: string): T | undefined
  /** What is shown now: a success is remembered, a gone answer forgets the key, a failure changes nothing. */
  remember(scope: string, key: string, answer: T): void
  clear(): void
}

const caches = new Set<{ clear(): void }>()

export function createShownCache<T extends ShownAnswer>(max = 200): ShownCache<T> {
  let current: string | null = null
  const entries = new Map<string, T>()
  const enter = (scope: string) => {
    if (scope !== current) { entries.clear(); current = scope }
  }
  const cache: ShownCache<T> = {
    shown(scope, key) {
      enter(scope)
      const value = entries.get(key)
      if (value !== undefined) { entries.delete(key); entries.set(key, value) }
      return value
    },
    remember(scope, key, answer) {
      enter(scope)
      if (answer.success) {
        entries.delete(key)
        entries.set(key, answer)
        while (entries.size > max) entries.delete(entries.keys().next().value as string)
      } else if (answer.notFound) {
        entries.delete(key)
      }
    },
    clear() { entries.clear(); current = null },
  }
  caches.add(cache)
  return cache
}

/** Sign-out and a company switch: every view forgets what it showed. */
export function forgetAllShown(): void {
  for (const cache of caches) cache.clear()
}

/**
 * The default rule for a new answer over the shown one: a success or a gone answer replaces it; a
 * failure (offline) keeps what is shown, if anything is.
 */
export function settleShown<T extends ShownAnswer>(shown: T | null, next: T): T {
  if (next.success || next.notFound || !shown?.success) return next
  return shown
}
