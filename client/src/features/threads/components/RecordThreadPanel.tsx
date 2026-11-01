import type { ReactNode } from 'react'
import { ChatCircleText, CircleNotch, EnvelopeSimple } from '@phosphor-icons/react'
import { authorLine, THREAD_WORDS, type ThreadMessageView } from '../../../../shared/threads'
import { useRecordThread } from '../hooks/useRecordThread'
import type { ThreadReads } from '../api'

function formatAt(at: string | null): string {
  if (!at) return ''
  const d = new Date(at)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function Message({ m }: { m: ThreadMessageView }) {
  return (
    <li className={`rounded-lg p-2 text-xs ${m.mine ? 'bg-blue-50 dark:bg-blue-950/30' : 'bg-gray-50 dark:bg-zinc-900'}`}>
      <div className="flex flex-wrap items-baseline gap-x-2 text-[11px] text-gray-500 dark:text-zinc-400">
        <span className="font-medium text-gray-800 dark:text-zinc-200">{authorLine(m)}</span>
        <span>{formatAt(m.at)}</span>
      </div>
      {m.subject && <p className="mt-0.5 text-[11px] text-gray-600 dark:text-zinc-300">件名：{m.subject}</p>}
      <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-words font-sans text-gray-800 dark:text-zinc-200">{m.text}</pre>
      {m.truncated && <p className="mt-0.5 text-[11px] text-gray-500">{THREAD_WORDS.truncated}</p>}
    </li>
  )
}

/**
 * The card's 元のスレッド: the original mail or Slack thread of a record that came from outside,
 * read now (the server keeps none of it), and the member's reply drafts drawn by `renderReply`
 * (the mail card: 「確かめて送る」). Nothing for a record without an original 連絡 the member sees.
 */
export function RecordThreadPanel({ companyId, recordId, renderReply, reads }: {
  companyId: string
  recordId: string
  renderReply: (draftId: string) => ReactNode
  reads?: ThreadReads
}) {
  const result = useRecordThread(companyId, recordId, reads)
  if (result === null) return <p className="flex items-center gap-1.5 text-[11px] text-gray-400"><CircleNotch size={12} className="animate-spin" />元の連絡を読み込んでいます...</p>
  if (!result.success) return result.none ? null : <p role="alert" className="text-[11px] text-gray-500">{result.error}</p>
  const t = result.thread
  return (
    <section aria-label={THREAD_WORDS.title[t.channel]} className="mt-2">
      <h4 className="flex items-center gap-1.5 text-xs font-medium text-gray-700 dark:text-zinc-300">
        {t.channel === 'email' ? <EnvelopeSimple size={13} aria-hidden /> : <ChatCircleText size={13} aria-hidden />}
        {THREAD_WORDS.title[t.channel]}
      </h4>
      {t.unavailable
        ? <p role="status" className="mt-1 text-xs text-gray-600 dark:text-zinc-400">{t.unavailable.text}</p>
        : <>
          {t.more && <p className="mt-1 text-[11px] text-gray-500">{THREAD_WORDS.more}</p>}
          <ol className="mt-1 space-y-1.5">{t.messages.map(m => <Message key={m.id} m={m} />)}</ol>
        </>}
      {t.replies.length > 0 && <div className="mt-2">
        <h4 className="text-xs font-medium text-gray-700 dark:text-zinc-300">{THREAD_WORDS.replies}</h4>
        {t.replies.map(r => <div key={r.id}>{renderReply(r.id)}</div>)}
      </div>}
    </section>
  )
}
