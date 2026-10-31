import { memo, useState } from 'react'
import { Briefcase, CheckCircle } from '@phosphor-icons/react'
import type { MinutesDealChoiceCard as Card } from '../../../../shared/minutes-app'
import { linkMinutesDeal } from '../api'

/**
 * 「どの案件の議事録ですか？」 (design §1-8): minutes read with no deal linked and
 * not exactly one candidate. The person chooses; the app links it with their
 * session. Nothing is written to HubSpot by choosing.
 */
export const MinutesDealChoiceCard = memo(function MinutesDealChoiceCard({ card }: { card: Card }) {
  const [chosen, setChosen] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const choose = async () => {
    if (!chosen || busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await linkMinutesDeal(card.companyId, card.minutesId, chosen)
      if (result.success) setDone(card.candidates.find(c => c.id === chosen)?.title ?? '')
      else setError(result.error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div role="group" aria-label="どの案件の議事録ですか？" className="my-2 rounded-xl border border-sky-500/40 bg-sky-500/5 p-3">
      <div className="flex items-center gap-1.5 text-sm font-medium text-gray-900 dark:text-zinc-100">
        <Briefcase size={15} weight="bold" aria-hidden className="text-sky-600" />
        どの案件の議事録ですか？
      </div>
      <p className="mt-1 text-xs text-gray-600 dark:text-zinc-400">「{card.meetingTitle}」の議事録です。選ぶまで、HubSpot には何も書きません。</p>
      {done !== null ? (
        <p role="status" className="mt-2 flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-400">
          <CheckCircle size={13} weight="bold" aria-hidden />「{done}」につなぎました。続きは AI に話しかけてください。
        </p>
      ) : card.candidates.length === 0 ? (
        <p className="mt-2 text-xs text-gray-700 dark:text-zinc-300">候補の案件が見つかりませんでした。どの案件か、AI に伝えてください。</p>
      ) : (
        <>
          <ul className="mt-2 space-y-1">
            {card.candidates.map(c => (
              <li key={c.id}>
                <label className="flex cursor-pointer items-center gap-2 text-xs text-gray-800 dark:text-zinc-200">
                  <input type="radio" name={`minutes-deal-${card.id}`} value={c.id} checked={chosen === c.id} onChange={() => setChosen(c.id)} disabled={busy} />
                  {c.title}
                </label>
              </li>
            ))}
          </ul>
          {error && <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
          <button type="button" disabled={!chosen || busy} onClick={() => void choose()}
            className="mt-2 rounded-lg border border-gray-300 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-100 disabled:opacity-50 dark:border-zinc-600 dark:text-zinc-200 dark:hover:bg-zinc-800">
            {busy ? 'つないでいます…' : 'この案件にする'}
          </button>
        </>
      )}
    </div>
  )
}, (prev, next) => prev.card.id === next.card.id)
