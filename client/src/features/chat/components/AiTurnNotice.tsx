import { Robot } from '@phosphor-icons/react'

/**
 * Why the member's 「AI の番」 is not running automatically right now (needs Claude, Claude's
 * usage limit, stopped after failures, today's limit). The notifications foundation (S5) will
 * carry the same text; until then it shows at the top of the chat.
 */
export function AiTurnNotice({ text, canResume, onResume }: { text: string; canResume: boolean; onResume: () => void }) {
  return (
    <div role="status" aria-label="AI の番の自動実行" className="flex flex-wrap items-center gap-2 border-b border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-100">
      <Robot size={14} aria-hidden className="shrink-0" />
      <span className="min-w-0 flex-1">{text}</span>
      {canResume && (
        <button type="button" onClick={onResume}
          className="rounded-md border border-amber-300 px-2 py-0.5 hover:bg-amber-100 dark:border-amber-700 dark:hover:bg-amber-900/40">
          もう一度自動で進める
        </button>
      )}
    </div>
  )
}
