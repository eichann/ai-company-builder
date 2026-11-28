import { useCallback, useSyncExternalStore } from 'react'
import { askAfterUnknown, AUTO_WAITS, setUnsure, subscribeUnsure, unsureOf, type AfterUnknown, type PressOutcome } from '../unknownResult'

/**
 * One press whose result is not known (the approval card, the job proposal card), shared by every card of the same request
 * (`key`, the card's store key) and kept while the card is away: `unsure` while it is not known, so no card offers a press
 * meanwhile (never sent twice). `start` reads again by itself a few times; `checkNow` is 「結果を確かめる」.
 */
export function useUnknownResult<P>(key: string) {
  const subscribe = useCallback((listener: () => void) => subscribeUnsure(key, listener), [key])
  const unsure = useSyncExternalStore(subscribe, () => unsureOf<P>(key), () => unsureOf<P>(key))
  const run = async (press: P, read: () => Promise<PressOutcome | null>, waits: readonly number[]): Promise<AfterUnknown> => {
    setUnsure(key, { checking: true, press })
    const outcome = await askAfterUnknown(read, waits)
    setUnsure(key, outcome === 'unreadable' ? { checking: false, press } : null)
    return outcome
  }
  return {
    unsure,
    start: (press: P, read: () => Promise<PressOutcome | null>) => run(press, read, AUTO_WAITS),
    checkNow: (press: P, read: () => Promise<PressOutcome | null>) => run(press, read, [0]),
  }
}
