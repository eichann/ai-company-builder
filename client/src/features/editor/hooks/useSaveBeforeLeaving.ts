import { useCallback, useEffect, useRef, useState } from 'react'
import { saveUnsavedEdits } from '../../../shared/lib/unsavedEdits'
import { answerWindowClose, onWindowCloseRequested } from '../../../shared/ipc/window-close'
import { leaveQuestion, type LeaveQuestion } from '../leaving'

/**
 * Leaving the company screen (sign-out) or closing the window: every editor
 * first saves all its tabs with edits, not only the shown one; what could not
 * be saved is named and the member decides (`question`, answered with
 * `answer`). `confirmLeave` resolves true when it is fine to go on.
 */
export function useSaveBeforeLeaving({ guardWindowClose = false }: { guardWindowClose?: boolean } = {}) {
  const [pending, setPending] = useState<{ question: LeaveQuestion; resolve: (ok: boolean) => void } | null>(null)
  const busy = useRef<Promise<boolean> | null>(null)

  const confirmLeave = useCallback((): Promise<boolean> => {
    // A second request (another close while asking) waits for the same answer.
    busy.current ??= (async () => {
      try {
        const left = await saveUnsavedEdits()
        if (left.length === 0) return true
        return await new Promise<boolean>(resolve => setPending({ question: leaveQuestion(left), resolve }))
      } finally {
        busy.current = null
      }
    })()
    return busy.current
  }, [])

  // One instance answers main's close requests (App.tsx, mounted on every screen).
  useEffect(() => {
    if (!guardWindowClose) return
    return onWindowCloseRequested(() => {
      void answerWindowClose('ack')
      void confirmLeave().then(ok => answerWindowClose(ok ? 'close' : 'stay'))
    })
  }, [guardWindowClose, confirmLeave])

  const answer = useCallback((ok: boolean) => {
    pending?.resolve(ok)
    setPending(null)
  }, [pending])

  return { confirmLeave, question: pending?.question ?? null, answer }
}
