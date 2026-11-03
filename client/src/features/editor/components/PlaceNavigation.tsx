import { ArrowLeft, ArrowRight } from '@phosphor-icons/react'

interface Props {
  canBack: boolean
  canForward: boolean
  onBack: () => void
  onForward: () => void
}

const BTN = 'p-1.5 rounded text-gray-500 dark:text-zinc-400 hover:bg-gray-200 dark:hover:bg-zinc-800 disabled:opacity-30 disabled:hover:bg-transparent'

/** ← → in front of the editor's tabs: back to what was shown before (a file or a record card). */
export function PlaceNavigation({ canBack, canForward, onBack, onForward }: Props) {
  return (
    <div className="flex-shrink-0 flex items-center gap-0.5 px-1 border-r border-gray-200 dark:border-zinc-800/50">
      <button type="button" className={BTN} disabled={!canBack} onClick={onBack} title="戻る" aria-label="戻る"><ArrowLeft size={14} /></button>
      <button type="button" className={BTN} disabled={!canForward} onClick={onForward} title="進む" aria-label="進む"><ArrowRight size={14} /></button>
    </div>
  )
}
