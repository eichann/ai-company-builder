// 「非公開にする」 on a 案件・プロジェクト's 「…」 (records.md "Making a 案件・プロジェクト private", tasks-ui.md): asks
// first, saying who will see it afterwards, which やること follow and what stays where it is. The press
// itself is the screen's (`onConfirm`: the private folder, its participants, then the server's move).
import { useState } from 'react'
import { LockSimple, X } from '@phosphor-icons/react'
import type { MakePrivateOffer } from '../../../../shared/record-views'
import { MAIN_BUTTON, SMALL_BUTTON } from '../../../shared/ui/RecordPage'
import { makePrivateWords } from '../makePrivate'

export function MakePrivateDialog({ title, word, offer, onConfirm, onClose }: {
  title: string
  word: string
  offer: MakePrivateOffer
  /** null = done; else the reason in words. */
  onConfirm: () => Promise<string | null>
  onClose: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const words = makePrivateWords(offer, word)
  const run = async () => {
    setBusy(true)
    setError(null)
    const failure = await onConfirm()
    setBusy(false)
    if (failure) setError(failure)
    else onClose()
  }
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/25" onMouseDown={e => { if (e.target === e.currentTarget && !busy) onClose() }}>
      <div role="dialog" aria-label="非公開にする" onKeyDown={e => { if (e.key === 'Escape' && !busy) onClose() }}
        className="w-[460px] space-y-3 rounded-xl bg-white p-4 text-[13px] text-gray-800 shadow-2xl dark:bg-zinc-800 dark:text-zinc-100">
        <div className="flex items-center gap-1.5"><LockSimple size={14} />
          <span className="flex-1 text-[14px] font-semibold">『{title}』を非公開にする</span>
          <button type="button" onClick={onClose} disabled={busy} aria-label="閉じる" className="rounded p-0.5 hover:bg-gray-100 dark:hover:bg-zinc-700"><X size={12} /></button></div>
        <p className="text-[12.5px] leading-relaxed">{words.who}</p>
        {words.tasks && <p className="text-[12.5px] leading-relaxed">{words.tasks}</p>}
        <p className="text-[12px] text-gray-600 dark:text-zinc-300">{words.stays}</p>
        <p className="text-[12px] text-gray-600 dark:text-zinc-300">{words.once}</p>
        {words.blocked && <p role="note" className="rounded-md bg-amber-500/[0.08] px-2.5 py-2 text-[12px]">{words.blocked}</p>}
        {error && <p role="alert" className="whitespace-pre-line text-[12px] text-red-600 dark:text-red-400">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy} className={SMALL_BUTTON}>やめておく</button>
          <button type="button" disabled={busy || offer.blocked} onClick={() => void run()} className={MAIN_BUTTON}>非公開にする</button>
        </div>
      </div>
    </div>
  )
}
