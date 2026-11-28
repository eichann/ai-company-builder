import { useState } from 'react'
import { askAfterUnknown, AUTO_WAITS, type AfterUnknown, type PressOutcome } from '../unknownResult'

/**
 * Holds one press whose result is not known (the approval card, the job proposal card): `unsure` while it is not, so the
 * card offers no press meanwhile (never sent twice). `start` reads again by itself a few times; `checkNow` is 「結果を確かめる」.
 */
export function useUnknownResult() {
  const [unsure, setUnsure] = useState<{ checking: boolean } | null>(null)
  const run = async (read: () => Promise<PressOutcome | null>, waits: readonly number[]): Promise<AfterUnknown> => {
    setUnsure({ checking: true })
    const outcome = await askAfterUnknown(read, waits)
    setUnsure(outcome === 'unreadable' ? { checking: false } : null)
    return outcome
  }
  return {
    unsure,
    start: (read: () => Promise<PressOutcome | null>) => run(read, AUTO_WAITS),
    checkNow: (read: () => Promise<PressOutcome | null>) => run(read, [0]),
  }
}
