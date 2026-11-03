import { memo, useState } from 'react'
import { Briefcase, CheckCircle } from '@phosphor-icons/react'
import type { MinutesBundleChoiceCard as Card } from '../../../../shared/minutes-app'
import { meetingBundleWords } from '../../../../shared/tasks'
import { bundleWords } from '../../../../shared/thing-words'
import { declineMinutesBundle, linkMinutesBundle } from '../api'

/**
 * 「どの〇〇の会議ですか？」 (design §1-8): minutes read with no bundle (a 案件,
 * a 企画…) linked and not exactly one candidate. The person chooses; the app links
 * it with their session. Nothing is written to the outside system by choosing.
 * 〇〇 is the candidates' own kinds (never 「まとまり」).
 */
export const MinutesBundleChoiceCard = memo(function MinutesBundleChoiceCard({ card }: { card: Card }) {
  const word = bundleWords(card.candidates.map(c => c.typeLabel), '案件・プロジェクト')
  const words = meetingBundleWords(word)
  const [chosen, setChosen] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [declined, setDeclined] = useState(false)
  // 「まとまりはない（社内の会議など）」: never asked again for this meeting (no AI turn follows).
  const decline = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await declineMinutesBundle(card.companyId, card.minutesId)
      if (result.success) setDeclined(true)
      else setError(result.error)
    } finally {
      setBusy(false)
    }
  }

  const choose = async () => {
    if (!chosen || busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await linkMinutesBundle(card.companyId, card.minutesId, chosen)
      if (result.success) setDone(card.candidates.find(c => c.id === chosen)?.title ?? '')
      else setError(result.error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div role="group" aria-label={words.question} className="my-2 rounded-xl border border-sky-500/40 bg-sky-500/5 p-3">
      <div className="flex items-center gap-1.5 text-sm font-medium text-gray-900 dark:text-zinc-100">
        <Briefcase size={15} weight="bold" aria-hidden className="text-sky-600" />
        {words.question}
      </div>
      <p className="mt-1 text-xs text-gray-600 dark:text-zinc-400">「{card.meetingTitle}」の議事録です。選ぶまで、外のシステム（HubSpot など）には何も書きません。</p>
      {declined ? (
        <p role="status" className="mt-2 flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-400">
          <CheckCircle size={13} weight="bold" aria-hidden />{words.none}会議として残しました。もう聞きません。
        </p>
      ) : done !== null ? (
        <p role="status" className="mt-2 flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-400">
          <CheckCircle size={13} weight="bold" aria-hidden />「{done}」につなぎました。続きは AI に話しかけてください。
        </p>
      ) : card.candidates.length === 0 ? (
        <>
          <p className="mt-2 text-xs text-gray-700 dark:text-zinc-300">候補が見つかりませんでした。どの{word}の会議か、AI に伝えてください。</p>
          {error && <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
          <button type="button" disabled={busy} onClick={() => void decline()}
            className="mt-2 rounded-lg border border-gray-300 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-100 disabled:opacity-50 dark:border-zinc-600 dark:text-zinc-200 dark:hover:bg-zinc-800">
            {words.noneLong}
          </button>
        </>
      ) : (
        <>
          <ul className="mt-2 space-y-1">
            {card.candidates.map(c => (
              <li key={c.id}>
                <label className="flex cursor-pointer items-center gap-2 text-xs text-gray-800 dark:text-zinc-200">
                  <input type="radio" name={`minutes-deal-${card.id}`} value={c.id} checked={chosen === c.id} onChange={() => setChosen(c.id)} disabled={busy} />
                  {c.title}{c.typeLabel ? <span className="text-gray-500 dark:text-zinc-400">（{c.typeLabel}）</span> : null}
                </label>
              </li>
            ))}
          </ul>
          {error && <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
          <button type="button" disabled={!chosen || busy} onClick={() => void choose()}
            className="mt-2 rounded-lg border border-gray-300 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-100 disabled:opacity-50 dark:border-zinc-600 dark:text-zinc-200 dark:hover:bg-zinc-800">
            {busy ? 'つないでいます…' : 'これにする'}
          </button>
          <button type="button" disabled={busy} onClick={() => void decline()}
            className="ml-2 mt-2 rounded-lg px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-100 disabled:opacity-50 dark:text-zinc-300 dark:hover:bg-zinc-800">
            {words.noneLong}
          </button>
        </>
      )}
    </div>
  )
}, (prev, next) => prev.card.id === next.card.id)
