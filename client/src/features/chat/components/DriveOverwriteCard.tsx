import { memo, useState } from 'react'
import { CheckCircle, FileText } from '@phosphor-icons/react'
import { DRIVE_OVERWRITE_WORDS, DRIVE_PUT_ASK_WORDS, driveAudienceLines, driveOverwriteOutcome, type DriveOverwriteCard as Card, type DriveOverwriteOutcome } from '../../../../shared/drive-overwrite'
import { decideDriveOverwrite } from '../api'

/**
 * 「〇〇さんの直し・コメントが入っています」 (google-drive.md "Continuing a document people edited"): the AI read a Google
 * document someone else edited and wants to replace it with a version that takes their edits in. 「社外の人も見られる
 * 場所に置きます」 ("Asking before a put"): the place is seen by people outside the company — or, for a private folder's
 * file, by other people. Only the person's 「上書きする」 / 「置く」 writes it — exactly the content that waits on the
 * server — with their session; 「やめる」 closes it. 「このフォルダはもう聞かない」 only where the server offered it.
 */
export const DriveOverwriteCard = memo(function DriveOverwriteCard({ card }: { card: Card }) {
  const [busy, setBusy] = useState(false)
  const [trust, setTrust] = useState(false)
  const [outcome, setOutcome] = useState<DriveOverwriteOutcome | null>(null)
  const audience = card.audience
  const title = card.edited ? DRIVE_OVERWRITE_WORDS.title(card) : DRIVE_PUT_ASK_WORDS.title(card)
  const decide = async (action: 'confirm' | 'decline') => {
    if (busy) return
    setBusy(true)
    try {
      setOutcome(driveOverwriteOutcome(await decideDriveOverwrite(card.companyId, card.confirmationId, action, action === 'confirm' && trust && audience?.trustOffered === true), card.update))
    } catch {
      setOutcome(driveOverwriteOutcome(null))
    } finally {
      setBusy(false)
    }
  }
  const finished = outcome !== null && outcome.kind !== 'error'
  return (
    <div role="group" aria-label={title} className="my-2 rounded-xl border border-amber-500/40 bg-amber-500/5 p-3">
      <div className="flex items-center gap-1.5 text-sm font-medium text-gray-900 dark:text-zinc-100">
        <FileText size={15} weight="bold" aria-hidden className="text-amber-600" />
        {title}
      </div>
      <p className="mt-1 text-xs text-gray-700 dark:text-zinc-300">「{card.fileName}」— {card.edited ? DRIVE_OVERWRITE_WORDS.body : DRIVE_PUT_ASK_WORDS.body}</p>
      {card.commented && <p className="mt-1 text-xs text-gray-600 dark:text-zinc-400">{DRIVE_OVERWRITE_WORDS.comments}</p>}
      {audience && (
        <ul className="mt-1 space-y-0.5 text-xs text-gray-700 dark:text-zinc-300" data-testid="drive-audience">
          {driveAudienceLines(audience).map(line => <li key={line}>{line}</li>)}
        </ul>
      )}
      {audience?.trustOffered && !outcome && (
        <label className="mt-2 flex items-center gap-1.5 text-xs text-gray-700 dark:text-zinc-300">
          <input type="checkbox" checked={trust} disabled={busy} onChange={e => setTrust(e.target.checked)} />
          {DRIVE_PUT_ASK_WORDS.trust}
        </label>
      )}
      {outcome && (
        <p role={outcome.kind === 'error' || outcome.kind === 'unknown' ? 'alert' : 'status'}
          className={`mt-2 flex items-center gap-1 text-xs ${outcome.kind === 'error' ? 'text-red-600 dark:text-red-400' : outcome.kind === 'unknown' ? 'text-amber-700 dark:text-amber-400' : 'text-emerald-700 dark:text-emerald-400'}`}>
          {(outcome.kind === 'written' || outcome.kind === 'declined') && <CheckCircle size={13} weight="bold" aria-hidden />}{outcome.text}
        </p>
      )}
      {!finished && (
        <div className="mt-2 flex gap-2">
          <button type="button" disabled={busy} onClick={() => void decide('confirm')}
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs text-gray-800 hover:bg-gray-100 disabled:opacity-50 dark:border-zinc-600 dark:text-zinc-100 dark:hover:bg-zinc-800">
            {busy ? DRIVE_PUT_ASK_WORDS.writing(card) : DRIVE_PUT_ASK_WORDS.confirm(card)}
          </button>
          <button type="button" disabled={busy} onClick={() => void decide('decline')}
            className="rounded-lg px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-100 disabled:opacity-50 dark:text-zinc-300 dark:hover:bg-zinc-800">
            {DRIVE_OVERWRITE_WORDS.decline}
          </button>
        </div>
      )}
    </div>
  )
}, (prev, next) => prev.card.id === next.card.id)
