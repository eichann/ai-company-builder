import { LeaveConfirmDialog } from '../features/editor/components/LeaveConfirmDialog'
import { useSaveBeforeLeaving } from '../features/editor/hooks/useSaveBeforeLeaving'

/**
 * Closing the main window (or quitting) saves every open tab first; mounted
 * next to App on every screen, so main always gets its answer at once
 * (electron/services/close-guard.ts).
 */
export function WindowCloseGuard() {
  const leaving = useSaveBeforeLeaving({ guardWindowClose: true })
  return <LeaveConfirmDialog question={leaving.question} onAnswer={leaving.answer} />
}
