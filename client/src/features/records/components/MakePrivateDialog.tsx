// 「非公開にする」 on a 案件・プロジェクト's 「…」 (records.md "Making a 案件・プロジェクト private", tasks-ui.md): asks
// first, saying who will see it afterwards, which やること follow and what stays where it is. The press
// itself is the screen's (`onConfirm`: the private folder, its participants, then the server's move).
import { useState } from 'react'
import { LockSimple } from '@phosphor-icons/react'
import type { MakePrivateOffer } from '../../../../shared/record-views'
import { MAIN_BUTTON, SMALL_BUTTON } from '../../../shared/ui/RecordPage'
import { makePrivateWords } from '../makePrivate'
import { Dialog, DialogCloseButton, DialogFooter, DialogTitle } from '../../../shared/ui/Dialog'

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
    <Dialog onClose={onClose} label="非公開にする" size="md" dismissible={!busy} className="text-[13px]">
        <div className="flex items-center gap-2"><DialogTitle className="flex flex-1 items-center gap-1.5"><LockSimple size={14} />『{title}』を非公開にする</DialogTitle>
          <DialogCloseButton onClick={onClose} disabled={busy} /></div>
        <div className="mt-3 space-y-3">
          <p className="text-[12.5px] leading-relaxed">{words.who}</p>
          {words.tasks && <p className="text-[12.5px] leading-relaxed">{words.tasks}</p>}
          <p className="text-[12px] text-gray-600 dark:text-zinc-300">{words.stays}</p>
          <p className="text-[12px] text-gray-600 dark:text-zinc-300">{words.once}</p>
          {words.blocked && <p role="note" className="rounded-md bg-amber-500/[0.08] px-2.5 py-2 text-[12px]">{words.blocked}</p>}
          {error && <p role="alert" className="whitespace-pre-line text-[12px] text-red-600 dark:text-red-400">{error}</p>}
        </div>
        <DialogFooter>
          <button type="button" onClick={onClose} disabled={busy} className={SMALL_BUTTON}>やめておく</button>
          <button type="button" disabled={busy || offer.blocked} onClick={() => void run()} className={MAIN_BUTTON}>非公開にする</button>
        </DialogFooter>
    </Dialog>
  )
}
