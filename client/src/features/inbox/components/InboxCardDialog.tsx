import { useId, type ReactNode } from 'react'
import { Dialog, DialogCloseButton, DialogTitle } from '../../../shared/ui/Dialog'

interface Props {
  title: string
  /** One line under the title: why the card comes first. */
  note: string
  onClose: () => void
  /** The app's own card (the approval card, the mail draft card), which reads the request itself. */
  children: ReactNode
}

/**
 * The card a row of the inbox opens (［承認する…］, ［確かめて送る…］): nothing is approved or sent from
 * the list; the card shows what, where and when, and only its own buttons act.
 */
export function InboxCardDialog({ title, note, onClose, children }: Props) {
  const titleId = useId()
  const noteId = useId()
  return (
    <Dialog onClose={onClose} labelledBy={titleId} describedBy={noteId} size="lg" padded={false} className="flex max-h-full flex-col">
      <div className="flex flex-shrink-0 items-start gap-2 border-b border-[color:var(--color-border)] p-dialog pb-3">
        <div className="min-w-0 flex-1">
          <DialogTitle id={titleId}>{title}</DialogTitle>
          <p id={noteId} className="mt-1 text-small text-text-muted">{note}</p>
        </div>
        <DialogCloseButton onClick={onClose} />
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-dialog pt-3">{children}</div>
    </Dialog>
  )
}
