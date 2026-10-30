import { ConfirmDialog } from '../../../shared/ui/ConfirmDialog'
import type { LeaveQuestion } from '../leaving'

/** Asked when leaving with tabs that could not be saved (useSaveBeforeLeaving). Enter does not confirm. */
export function LeaveConfirmDialog({ question, onAnswer }: { question: LeaveQuestion | null; onAnswer: (ok: boolean) => void }) {
  return (
    <ConfirmDialog
      isOpen={question !== null}
      title={question?.title ?? ''}
      message={question?.message ?? ''}
      confirmText={question?.confirmText}
      danger
      confirmOnEnter={false}
      onConfirm={() => onAnswer(true)}
      onCancel={() => onAnswer(false)}
    />
  )
}
