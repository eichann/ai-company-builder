import { useState } from 'react'
import { Briefcase } from '@phosphor-icons/react'
import { declineMeetingBundle } from '../api'
import { useMeetingBundleQuestion } from '../hooks/useMeetingBundleQuestion'

interface Props {
  companyId: string
  /** The caller keys this component by it (and by a counter it bumps after a まとまり is chosen). */
  meetingId: string
  /** 「まとまりを選ぶ」: the screen opens its chooser. */
  onChoose: (meeting: { id: string; title: string }) => void
  /** Something changed on the server (the list re-reads). */
  onChanged: () => void
}

/**
 * On a meeting's card: 「どのまとまりの会議ですか？」 while it has none — also after it left
 * あなたの番 — with 「まとまりを選ぶ」 and 「まとまりはない（社内の会議など）」. The server decides
 * whether the member may choose; nothing shows when not.
 */
export function MeetingBundleBar({ companyId, meetingId, onChoose, onChanged }: Props) {
  const question = useMeetingBundleQuestion(companyId, meetingId)
  const [declined, setDeclined] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!question?.success || !question.canChoose) return null
  const noBundle = declined || question.noBundle
  const decline = async () => {
    setBusy(true)
    setError(null)
    const r = await declineMeetingBundle(companyId, meetingId)
    setBusy(false)
    if (r.success) { setDeclined(true); onChanged() } else setError(r.error)
  }
  const button = 'rounded-md border border-gray-300 px-2 py-0.5 text-[12px] hover:bg-gray-100 disabled:opacity-50 dark:border-zinc-600 dark:hover:bg-zinc-800'
  return (
    <div role="group" aria-label="どのまとまりの会議ですか？" className="mx-5 mt-5 flex flex-wrap items-center gap-2 rounded-lg border border-sky-500/40 bg-sky-500/5 px-3 py-2 text-[12.5px]">
      <Briefcase size={14} className="text-sky-600" aria-hidden />
      <span className="min-w-0 flex-1">{noBundle ? 'まとまりはない、と決めた会議です。あとからでも選べます。' : 'どのまとまり（案件など）の会議ですか？'}</span>
      <button type="button" disabled={busy} onClick={() => onChoose({ id: meetingId, title: question.title })} className={button}>まとまりを選ぶ</button>
      {!noBundle && <button type="button" disabled={busy} onClick={() => void decline()} className={button}>まとまりはない（社内の会議など）</button>}
      {error && <p role="alert" className="w-full text-[11.5px] text-red-600 dark:text-red-400">{error}</p>}
    </div>
  )
}
