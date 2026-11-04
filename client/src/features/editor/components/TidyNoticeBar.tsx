import { Broom, X } from '@phosphor-icons/react'

/** One line above the middle's tabs: what a tidy did (or the daily tidy explained), with the way to 「片づけたタブ」. */
export function TidyNoticeBar({ text, onOpenList, onDismiss }: { text: string; onOpenList: () => void; onDismiss: () => void }) {
  return (
    <div role="status" data-tidy-notice className="flex flex-shrink-0 items-center gap-2 border-b border-indigo-100 bg-indigo-50 px-3 py-1.5 text-[12px] text-indigo-900 dark:border-indigo-400/20 dark:bg-indigo-400/[0.08] dark:text-indigo-100">
      <Broom size={14} className="flex-shrink-0 text-indigo-500" />
      <span className="min-w-0 flex-1 truncate" title={text}>{text}</span>
      <button type="button" onClick={onOpenList} className="flex-shrink-0 font-medium text-indigo-700 underline-offset-2 hover:underline dark:text-indigo-300">片づけたタブを見る</button>
      <button type="button" aria-label="閉じる" onClick={onDismiss} className="flex-shrink-0 rounded p-0.5 text-indigo-400 hover:bg-indigo-100 hover:text-indigo-700 dark:hover:bg-indigo-400/20"><X size={12} /></button>
    </div>
  )
}
