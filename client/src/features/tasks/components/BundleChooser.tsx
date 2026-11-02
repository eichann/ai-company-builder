import { useState } from 'react'
import { MagnifyingGlass, X } from '@phosphor-icons/react'
import type { BundleChoice } from '../../../../shared/tasks'
import { useBundleChoices } from '../hooks/useBundleChoices'

interface Props {
  companyId: string
  meetingTitle: string
  /** null = linked; else the reason in words. */
  onChoose: (bundle: BundleChoice) => Promise<string | null>
  /** 「まとまりはない（社内の会議など）」: null = done; else the reason in words. Absent: not offered. */
  onNoBundle?: () => Promise<string | null>
  onClose: () => void
}

/** 「どのまとまりの会議ですか？」 from 「あなたの番」: the unfinished まとまり the member reads. Nothing goes outside. */
export function BundleChooser({ companyId, meetingTitle, onChoose, onNoBundle, onClose }: Props) {
  const choices = useBundleChoices(companyId)
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const shown = choices?.success ? choices.bundles.filter(b => !q.trim() || b.title.includes(q.trim())) : []
  const choose = async (b: BundleChoice | null) => {
    setBusy(true)
    setError(null)
    const failure = b ? await onChoose(b) : await onNoBundle?.() ?? null
    setBusy(false)
    if (failure) setError(failure)
    else onClose()
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div role="dialog" aria-label="どのまとまりの会議ですか？" onKeyDown={e => { if (e.key === 'Escape') onClose() }}
        className="w-[380px] overflow-hidden rounded-xl border border-gray-200 bg-white text-gray-800 shadow-xl dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100">
        <div className="flex items-center gap-2 px-3 pb-1 pt-2.5 text-[12px]">
          <span className="min-w-0 flex-1 truncate font-semibold">「{meetingTitle}」はどのまとまりの会議ですか？</span>
          <button type="button" onClick={onClose} aria-label="閉じる" className="rounded p-0.5 hover:bg-gray-100 dark:hover:bg-zinc-700"><X size={12} /></button>
        </div>
        <div className="flex items-center gap-1.5 border-b border-gray-100 px-3 py-1.5 dark:border-zinc-700">
          <MagnifyingGlass size={12} className="text-gray-400" />
          <input autoFocus value={q} onChange={e => setQ(e.target.value)} aria-label="まとまりを探す" placeholder="案件・企画の名前で探す" className="flex-1 bg-transparent text-[12px] outline-none" />
        </div>
        <ul className="max-h-[280px] overflow-y-auto p-1">
          {choices === null && <li className="px-2 py-2 text-[12px] text-gray-400">読み込み中...</li>}
          {choices && !choices.success && <li role="alert" className="px-2 py-2 text-[12px] text-gray-500">{choices.error}</li>}
          {choices?.success && shown.length === 0 && <li className="px-2 py-2 text-[12px] text-gray-500">見つかりません。</li>}
          {shown.map(b => (
            <li key={b.id}>
              <button type="button" disabled={busy} onClick={() => void choose(b)} className="w-full rounded-md px-2 py-1 text-left hover:bg-gray-100 disabled:opacity-50 dark:hover:bg-zinc-700">
                <span className="block truncate text-[12.5px]">{b.title}</span>
                <span className="block text-[10.5px] text-gray-500">{b.typeLabel}</span>
              </button>
            </li>
          ))}
        </ul>
        {onNoBundle && (
          <button type="button" disabled={busy} onClick={() => void choose(null)}
            className="w-full border-t border-gray-100 px-3 py-1.5 text-left text-[12px] text-gray-600 hover:bg-gray-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-700">
            まとまりはない（社内の会議など）
          </button>
        )}
        {error && <p role="alert" className="border-t border-gray-100 px-3 py-1.5 text-[11.5px] text-red-600 dark:border-zinc-700 dark:text-red-400">{error}</p>}
        <p className="border-t border-gray-100 px-3 py-1.5 text-[10.5px] text-gray-500 dark:border-zinc-700">選ぶと、この会議がそのまとまりにつながります。外のサービス（HubSpot など）には書きません。</p>
      </div>
    </div>
  )
}
