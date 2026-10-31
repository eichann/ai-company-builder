import { useId, useState } from 'react'
import { Info } from '@phosphor-icons/react'
import { AGENT_LOG_NOTICE_MORE, AGENT_LOG_NOTICE_TEXT, markAgentLogNoticeSeen, shouldShowAgentLogNotice } from '../../../shared/lib/agentLogNotice'

// One-time notice over the chat (per account on this PC): the AI action log
// is sent to the company's administrators. Non-modal: the chat stays usable;
// OK (or Esc) dismisses it for good.
export function AgentLogNotice({ userId }: { userId: string }) {
  const [open, setOpen] = useState(() => shouldShowAgentLogNotice(userId))
  const titleId = useId()
  const bodyId = useId()
  if (!open) return null
  const close = () => { markAgentLogNoticeSeen(userId); setOpen(false) }
  return (
    <div className="pointer-events-none absolute inset-x-0 top-3 z-40 flex justify-center px-4">
      <div
        role="dialog"
        aria-modal="false"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); close() } }}
        className="pointer-events-auto flex w-full max-w-md items-start gap-3 rounded-xl border border-zinc-200 bg-white p-4 text-zinc-800 shadow-lg dark:border-white/10 dark:bg-zinc-900 dark:text-zinc-100"
      >
        <Info size={18} className="mt-0.5 shrink-0 text-indigo-600 dark:text-indigo-300" aria-hidden />
        <div className="min-w-0 flex-1">
          <p id={titleId} className="text-[13px] font-semibold">AI の操作の記録について</p>
          <p id={bodyId} className="mt-1 text-[13px] leading-relaxed text-zinc-600 dark:text-zinc-300">
            {AGENT_LOG_NOTICE_TEXT}{AGENT_LOG_NOTICE_MORE}
          </p>
          <div className="mt-3 flex justify-end">
            <button
              autoFocus
              type="button"
              onClick={close}
              className="h-8 rounded-lg bg-indigo-600 px-4 text-[13px] font-medium text-white hover:bg-indigo-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/60 focus-visible:ring-offset-1 dark:bg-indigo-500 dark:hover:bg-indigo-400 dark:focus-visible:ring-offset-zinc-900"
            >
              OK
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
