// 「非公開フォルダについて」 — what a private folder does and does not protect.
// The text lives in shared/private-folder-help.ts (the admin shows the same).
import { useId, useRef } from 'react'
import { Question, X } from '@phosphor-icons/react'
import { Button } from '../../../shared/ui/primitives'
import { Dialog, DialogTitle } from '../../../shared/ui/Dialog'
import { PRIVATE_FOLDER_HELP, PRIVATE_FOLDER_HELP_TITLE } from '../../../../shared/private-folder-help'

/** The link that opens the help (inside the 「新しいフォルダ」 dialog). */
export function PrivateFolderHelpLink({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="inline-flex items-center gap-1 rounded-small text-small font-medium text-link underline-offset-2 hover:text-link-hover hover:underline focus-visible:outline-none focus-visible:ring-focus focus-visible:ring-focus-ring"
    >
      <Question size={13} />
      {PRIVATE_FOLDER_HELP_TITLE}
    </button>
  )
}

/** A modal panel above the current dialog; Escape / 閉じる / a click outside close only the help. */
export function PrivateFolderHelpPanel({ onClose }: { onClose: () => void }) {
  const titleId = useId()
  const closeRef = useRef<HTMLButtonElement>(null)

  return (
    <Dialog onClose={onClose} labelledBy={titleId} padded={false} initialFocus={closeRef} className="flex max-h-[calc(100vh-3rem)] flex-col overflow-hidden">
        <div className="flex items-start justify-between gap-3 px-5 pt-5">
          <div>
            <DialogTitle id={titleId}>{PRIVATE_FOLDER_HELP_TITLE}</DialogTitle>
            <p className="mt-1 text-small text-text-muted">選んだ人だけに届くフォルダです。守れることと、守れないことがあります。</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="閉じる"
            className="flex size-7 shrink-0 items-center justify-center rounded-control text-text-subtle hover:bg-surface-sunken hover:text-text"
          >
            <X size={14} />
          </button>
        </div>
        <ol aria-label={PRIVATE_FOLDER_HELP_TITLE} className="space-y-3.5 overflow-y-auto px-5 py-4">
          {PRIVATE_FOLDER_HELP.map((item, i) => (
            <li key={item.title} className="flex gap-3">
              <span aria-hidden="true" className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-caption font-medium tabular-nums text-zinc-500 dark:bg-white/[0.08] dark:text-zinc-400">
                {i + 1}
              </span>
              <div className="min-w-0">
                <p className="text-body font-medium text-zinc-900 dark:text-zinc-100">{item.title}</p>
                <p className="mt-0.5 text-small leading-relaxed text-zinc-600 dark:text-zinc-400">{item.body}</p>
              </div>
            </li>
          ))}
        </ol>
        <div className="flex justify-end border-t border-[color:var(--color-border)] px-5 py-3">
          <Button ref={closeRef} onClick={onClose}>閉じる</Button>
        </div>
    </Dialog>
  )
}
