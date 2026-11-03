// ACB foundation: what a drop on a record said (useLinkDrop), shown by the task card, the record
// card and the task list.
import type { LinkDropNotice as Notice } from '../hooks/useLinkDrop'

/** 「…をつなぎました［取り消す］」, the tiny chooser when several links fit, or the one-line refusal. */
export function LinkDropNotice({ notice, busy }: { notice: Notice | null; busy: boolean }) {
  if (!notice) return null
  if (notice.kind === 'error') return <p role="alert" data-link-drop="error" className="text-[11.5px] text-red-600 dark:text-red-400">{notice.text}</p>
  if (notice.kind === 'choose') {
    return (
      <div role="group" aria-label={notice.question} data-link-drop="choose" className="space-y-1 rounded-md bg-gray-100 px-2 py-1.5 text-[11.5px] dark:bg-zinc-800">
        <p>{notice.question}</p>
        <span className="flex flex-wrap gap-1">
          {notice.choices.map(c => (
            <button key={`${c.source}:${c.link}`} type="button" disabled={busy} onClick={() => void notice.pick(c.link)}
              className="rounded border border-accent/40 px-1.5 text-accent hover:bg-accent/10 disabled:opacity-40">{c.label}</button>
          ))}
          <button type="button" onClick={notice.cancel} className="px-1.5 text-gray-500 hover:underline">やめる</button>
        </span>
      </div>
    )
  }
  return (
    <p role="status" data-link-drop="done" className="flex flex-wrap items-center gap-1 rounded-md bg-gray-100 px-2 py-1 text-[11.5px] dark:bg-zinc-800">
      {notice.text}
      {notice.undo && <button type="button" disabled={busy} onClick={() => void notice.undo!()} className="text-accent hover:underline disabled:opacity-40">取り消す</button>}
    </p>
  )
}
