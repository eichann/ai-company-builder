import { useCallback, useEffect, useRef, useState } from 'react'
import { keepUnsavedEdits, saveUnsavedEdits } from '../../../shared/lib/unsavedEdits'
import { answerWindowClose, onWindowCloseRequested } from '../../../shared/ipc/window-close'
import { leaveQuestion, notKeptQuestion, type LeaveQuestion } from '../leaving'

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
        const left = await saveUnsavedEdits()
        if (left.length === 0) return true
        if (!await ask(leaveQuestion(left))) return false
        const notKept = await keepUnsavedEdits(left)
        if (notKept.length === 0) return true
        return await ask(notKeptQuestion(notKept))
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
