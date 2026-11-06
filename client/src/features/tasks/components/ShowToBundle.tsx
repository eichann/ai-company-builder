import { useState } from 'react'
import { UsersThree } from '@phosphor-icons/react'
import type { RecordViewSummary } from '../../../../shared/record-views'

/**
 * ［〇〇の人に見せる］ (records.md "A task and its 案件・プロジェクト"): a task only the member — or a
 * list — sees that belongs to a 案件・プロジェクト becomes visible to the people who see that 案件.
 * Widening is always the person's own act, and it cannot be made 「あなただけ」 again, so the member
 * confirms first.
 */
export function ShowToBundle({ bundle, busy, onShow }: {
  bundle: RecordViewSummary
  busy: boolean
  /** null = shown; else the reason in words. */
  onShow: () => Promise<string | null>
}) {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const word = bundle.typeLabel || 'プロジェクト'
  if (!open) {
    return (
      <button type="button" disabled={busy} onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1 rounded-md border border-gray-300 px-2 py-0.5 text-[11.5px] text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-zinc-600 dark:text-zinc-200 dark:hover:bg-zinc-800">
        <UsersThree size={12} />{word}の人に見せる
      </button>
    )
  }
  const submit = async () => {
    setError(null)
    const failure = await onShow()
    if (failure) setError(failure)
    else setOpen(false)
  }
  return (
    <div role="group" aria-label={`${word}の人に見せる`} className="w-full space-y-2 rounded-lg border border-gray-200 p-2.5 text-[12.5px] dark:border-zinc-700">
      <p>「{bundle.title}」を見られる人みんなに、このやることが見えるようになります。あとから元には戻せません。</p>
      {error && <p role="alert" className="text-red-600 dark:text-red-400">{error}</p>}
      <div className="flex gap-2">
        <button type="button" disabled={busy} onClick={() => void submit()} className="rounded bg-accent px-2.5 py-0.5 text-white disabled:opacity-50">見せる</button>
        <button type="button" disabled={busy} onClick={() => { setOpen(false); setError(null) }} className="rounded border border-gray-300 px-2.5 py-0.5 dark:border-zinc-600">やめる</button>
      </div>
    </div>
  )
}
