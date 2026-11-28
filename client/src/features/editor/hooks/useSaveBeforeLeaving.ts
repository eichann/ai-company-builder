import { useCallback, useEffect, useRef, useState } from 'react'
import { keepUnsavedEdits, saveUnsavedEdits, unsettledEdits } from '../../../shared/lib/unsavedEdits'
import { answerWindowClose, onWindowCloseRequested } from '../../../shared/ipc/window-close'
import { leaveAfterSaving, type LeaveQuestion } from '../leaving'

/**
 * Leaving the company screen (sign-out) or closing the window: every editor
 * first saves all its tabs with edits, not only the shown one; what could not
 * be saved is named and the member decides (`question`, answered with
 * `answer`). ［保存せずに進む］ keeps those edits in the backups first; what
 * cannot be kept either is named again (［それでも進む］). `confirmLeave`
 * resolves true when it is fine to go on.
 */
export function useSaveBeforeLeaving({ guardWindowClose = false }: { guardWindowClose?: boolean } = {}) {
  const [pending, setPending] = useState<{ question: LeaveQuestion; resolve: (ok: boolean) => void } | null>(null)
  const busy = useRef<Promise<boolean> | null>(null)

  const confirmLeave = useCallback((): Promise<boolean> => {
    // A second request (another close while asking) waits for the same answer.
    busy.current ??= (async () => {
      try {
        const ask = (question: LeaveQuestion) => new Promise<boolean>(resolve => setPending({ question, resolve }))
        // Rounds until every tab is saved or kept as it is now (typing goes on meanwhile).
        return await leaveAfterSaving({ save: saveUnsavedEdits, keep: keepUnsavedEdits, unsettled: unsettledEdits, ask })
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
