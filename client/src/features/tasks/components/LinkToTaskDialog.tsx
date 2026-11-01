import { useState } from 'react'
import { CheckCircle, LinkSimple, MagnifyingGlass, X } from '@phosphor-icons/react'
import type { TaskListItem } from '../../../../shared/tasks'
import { linkableTasks } from '../model'

interface Props {
  /** The file or folder, as the company names it (`営業/見積.xlsx`). */
  companyPath: string
  items: readonly TaskListItem[]
  /** null = linked; else the reason in words. */
  onLink: (task: TaskListItem) => Promise<string | null>
  onClose: () => void
}

/** 「やることにつなぐ…」 from the file tree: choose one of the member's open tasks. */
export function LinkToTaskDialog({ companyPath, items, onLink, onClose }: Props) {
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [linked, setLinked] = useState<string | null>(null)
  const name = companyPath.split('/').pop() ?? companyPath
  const tasks = linkableTasks(items).filter(t => !q.trim() || t.title.includes(q.trim()))
  const choose = async (t: TaskListItem) => {
    setBusy(true)
    setError(null)
    const failure = await onLink(t)
    setBusy(false)
    if (failure) setError(failure)
    else setLinked(t.title)
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div role="dialog" aria-label="やることにつなぐ" className="w-[380px] overflow-hidden rounded-xl border border-gray-200 bg-white text-gray-800 shadow-xl dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
        onKeyDown={e => { if (e.key === 'Escape') onClose() }}>
        <div className="flex items-center gap-2 px-3 pb-1 pt-2.5 text-[12px] text-gray-500 dark:text-zinc-400">
          <LinkSimple size={13} /><span className="min-w-0 flex-1 truncate">「{name}」をつなぐやること</span>
          <button type="button" onClick={onClose} aria-label="閉じる" className="rounded p-0.5 hover:bg-gray-100 dark:hover:bg-zinc-700"><X size={12} /></button>
        </div>
        {linked ? (
          <div className="space-y-3 p-3 text-[12.5px]">
            <p className="flex items-start gap-1.5"><CheckCircle size={15} weight="fill" className="mt-px shrink-0 text-emerald-500" />「{name}」を「{linked}」につなぎました。経緯に残り、カードから外せます。</p>
            <button type="button" autoFocus onClick={onClose} className="rounded-lg border border-gray-300 px-3 py-1 text-xs dark:border-zinc-600">閉じる</button>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-1.5 border-b border-gray-100 px-3 py-1.5 dark:border-zinc-700">
              <MagnifyingGlass size={12} className="text-gray-400" />
              <input autoFocus value={q} onChange={e => setQ(e.target.value)} aria-label="やることを探す" placeholder="やることを探す" className="flex-1 bg-transparent text-[12px] outline-none" />
            </div>
            <ul className="max-h-[280px] overflow-y-auto p-1">
              {tasks.length === 0 && <li className="px-2 py-3 text-[12px] text-gray-500">つなげるやることがありません。</li>}
              {tasks.map(t => (
                <li key={t.id}>
                  <button type="button" disabled={busy} onClick={() => void choose(t)} className="w-full rounded-md px-2 py-1 text-left hover:bg-gray-100 disabled:opacity-50 dark:hover:bg-zinc-700">
                    <span className="block truncate text-[12.5px]">{t.title}</span>
                    <span className="block truncate text-[10.5px] text-gray-500">{t.waitingFor ?? (t.turn === 'ai' ? 'AI の番' : 'あなたの番')}</span>
                  </button>
                </li>
              ))}
            </ul>
            {error && <p role="alert" className="border-t border-gray-100 px-3 py-1.5 text-[11.5px] text-red-600 dark:border-zinc-700 dark:text-red-400">{error}</p>}
            <p className="border-t border-gray-100 px-3 py-1.5 text-[10.5px] text-gray-500 dark:border-zinc-700">ファイルをやることの行やカードにドラッグしても、つなげます。</p>
          </>
        )}
      </div>
    </div>
  )
}
