// 「非公開フォルダについて」 — what a private folder does and does not protect.
// The text lives in shared/private-folder-help.ts (the admin shows the same).
import { useEffect, useId, useRef } from 'react'
import { Question, X } from '@phosphor-icons/react'
import { Button } from '../settings/ui'
import { PRIVATE_FOLDER_HELP, PRIVATE_FOLDER_HELP_TITLE } from '../../../shared/private-folder-help'

/** The link that opens the help (inside the 「新しいフォルダ」 dialog). */
export function PrivateFolderHelpLink({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="inline-flex items-center gap-1 rounded text-[12px] font-medium text-indigo-600 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/60 dark:text-indigo-400"
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
  useEffect(() => { closeRef.current?.focus() }, [])

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-zinc-900/30 p-6 dark:bg-black/50"
      onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}
      onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex max-h-[calc(100vh-3rem)] w-full max-w-[460px] flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-xl dark:border-white/10 dark:bg-zinc-900"
      >
        <div className="flex items-start justify-between gap-3 px-5 pt-5">
          <div>
            <h3 id={titleId} className="text-[15px] font-semibold text-zinc-900 dark:text-zinc-50">{PRIVATE_FOLDER_HELP_TITLE}</h3>
            <p className="mt-1 text-[12px] text-zinc-500 dark:text-zinc-400">選んだ人だけに届くフォルダです。守れることと、守れないことがあります。</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="閉じる"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-white/10 dark:hover:text-zinc-200"
          >
            <X size={14} />
          </button>
        </div>
        <ol aria-label={PRIVATE_FOLDER_HELP_TITLE} className="space-y-3.5 overflow-y-auto px-5 py-4">
          {PRIVATE_FOLDER_HELP.map((item, i) => (
            <li key={item.title} className="flex gap-3">
              <span aria-hidden="true" className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-[11px] font-medium tabular-nums text-zinc-500 dark:bg-white/[0.08] dark:text-zinc-400">
                {i + 1}
              </span>
              <div className="min-w-0">
                <p className="text-[13px] font-medium text-zinc-900 dark:text-zinc-100">{item.title}</p>
                <p className="mt-0.5 text-[12px] leading-relaxed text-zinc-600 dark:text-zinc-400">{item.body}</p>
              </div>
            </li>
          ))}
        </ol>
        <div className="flex justify-end border-t border-zinc-100 px-5 py-3 dark:border-white/[0.06]">
          <Button ref={closeRef} onClick={onClose}>閉じる</Button>
        </div>
      </div>
    </div>
  )
}
