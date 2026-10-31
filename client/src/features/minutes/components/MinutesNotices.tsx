import { useState } from 'react'
import { Notebook } from '@phosphor-icons/react'
import { minutesConsultationTitle, minutesFirstMessage, minutesNoticeText, type MinutesNotice } from '../../../../shared/minutes-app'
import { runCommand } from '../../../shared/commands/commands'
import { skipMinutes } from '../api'

/**
 * 「議事録が届きました：<件名> <M/D>」 at the top of the screen, one per received
 * minutes record assigned to the member. 「読み取る」 is the person starting the
 * reading once (design §9 q6): a new consultation 「<件名> のあと（M/D）」 linked to
 * the minutes, whose first message (the member's, composed by the app) names
 * the record — never its text. 「今は読まない」 runs the record's `skip`.
 */
export function MinutesNotices({ companyId, notices }: { companyId: string; notices: MinutesNotice[] }) {
  // 「今は読まない」 pressed: hidden at once (the server's answer decides). After 「読み取る」 the
  // notice stays until the AI marks it 「読んでいる」 (with Codex it cannot, and the member can switch).
  const [handled, setHandled] = useState<ReadonlySet<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const shown = notices.filter(n => !handled.has(n.id))
  if (shown.length === 0 && !error) return null

  const hideNotice = (id: string) => setHandled(prev => new Set(prev).add(id))
  const read = (notice: MinutesNotice) => {
    void runCommand('chat.newConsultation', { message: minutesFirstMessage(notice), title: minutesConsultationTitle(notice), minutesId: notice.id })
  }
  const skip = async (notice: MinutesNotice) => {
    hideNotice(notice.id)
    const result = await skipMinutes(companyId, notice.id)
    if (result && !result.success) {
      setError(result.error)
      setHandled(prev => { const next = new Set(prev); next.delete(notice.id); return next })
    } else setError(null)
  }

  return (
    <section aria-label="議事録のお知らせ" className="flex-shrink-0 border-b border-sky-200 bg-sky-50 px-4 py-1.5 dark:border-sky-900/60 dark:bg-sky-950/40">
      {shown.map(notice => (
        <div key={notice.id} role="status" className="flex flex-wrap items-center gap-2 py-0.5 text-sm text-gray-800 dark:text-zinc-100">
          <Notebook size={16} aria-hidden className="text-sky-600" />
          <span className="min-w-0 flex-1 truncate">{minutesNoticeText(notice)}</span>
          <button type="button" onClick={() => read(notice)}
            className="rounded-lg bg-sky-600 px-3 py-1 text-xs font-medium text-white hover:bg-sky-700">
            読み取る
          </button>
          <button type="button" onClick={() => void skip(notice)}
            className="rounded-lg border border-gray-300 px-3 py-1 text-xs text-gray-700 hover:bg-gray-100 dark:border-zinc-600 dark:text-zinc-200 dark:hover:bg-zinc-800">
            今は読まない
          </button>
        </div>
      ))}
      {error && <p role="alert" className="py-0.5 text-xs text-red-600 dark:text-red-400">{error}</p>}
    </section>
  )
}
