// The 案件・プロジェクト field at the head of a record (新しい画面のデモ J): linked → ［変える］［外す］,
// not linked → ［〇〇につなぐ］ (choose an unfinished one the member reads). 〇〇 is the kind's own
// name; the general word never shows.
import { useState } from 'react'
import { MagnifyingGlass, X } from '@phosphor-icons/react'
import type { RecordViewSummary } from '../../../../shared/record-views'
import type { BundleChoice } from '../../../../shared/tasks'
import { runCommand } from '../../../shared/commands/commands'
import { SMALL_BUTTON } from '../../../shared/ui/RecordPage'
import { ThingIcon } from '../../../shared/ui/ThingIcon'
import { useBundleChoices } from '../hooks/useBundleChoices'

const QUIET = 'inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-0.5 text-[11.5px] text-gray-500 hover:bg-gray-100 hover:text-accent disabled:opacity-50 dark:text-zinc-400 dark:hover:bg-zinc-800'

export function BundleField({ companyId, bundle, word, canSet, busy, onSet, onRemove }: {
  companyId: string
  bundle: RecordViewSummary | null
  /** The kind's name where none is linked yet (「案件」「プロジェクト」). */
  word: string
  canSet: boolean
  busy: boolean
  /** null = done; else the reason in words. */
  onSet: (bundle: BundleChoice) => Promise<string | null>
  onRemove: () => Promise<string | null>
}) {
  const [picking, setPicking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!bundle && !canSet) return null
  const name = bundle?.typeLabel ?? word
  return (
    <div role="group" aria-label={name} className="rounded-lg border border-gray-200 px-3 py-2 text-[12.5px] dark:border-zinc-700">
      <div className="flex flex-wrap items-center gap-2">
        <ThingIcon kind="bundle" typeLabel={name} size={14} label="" />
        <span className="text-gray-500">{name}</span>
        {bundle
          ? <button type="button" onClick={() => runCommand('record.open', { recordId: bundle.id })} className="min-w-0 truncate font-medium text-accent hover:underline">{bundle.title}</button>
          : <span className="text-gray-400">なし</span>}
        {canSet && (
          <span className="ml-auto flex gap-1">
            <button type="button" disabled={busy} onClick={() => setPicking(true)} className={SMALL_BUTTON}>{bundle ? '変える' : `${name}につなぐ`}</button>
            {bundle && <button type="button" disabled={busy} onClick={() => void onRemove().then(setError)} className={QUIET}>外す</button>}
          </span>
        )}
      </div>
      {error && <p role="alert" className="mt-1 text-[11.5px] text-red-600 dark:text-red-400">{error}</p>}
      {picking && <BundlePicker companyId={companyId} word={name} current={bundle?.id ?? null} onClose={() => setPicking(false)} onChoose={onSet} />}
    </div>
  )
}

function BundlePicker({ companyId, word, current, onChoose, onClose }: {
  companyId: string
  word: string
  current: string | null
  onChoose: (bundle: BundleChoice) => Promise<string | null>
  onClose: () => void
}) {
  const choices = useBundleChoices(companyId)
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const shown = choices?.success ? choices.bundles.filter(b => !q.trim() || b.title.includes(q.trim())) : []
  const choose = async (b: BundleChoice) => {
    setBusy(true)
    const failure = await onChoose(b)
    setBusy(false)
    if (failure) setError(failure)
    else onClose()
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div role="dialog" aria-label={`${word}につなぐ`} onKeyDown={e => { if (e.key === 'Escape') onClose() }}
        className="w-[400px] overflow-hidden rounded-xl border border-gray-200 bg-white text-gray-800 shadow-xl dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100">
        <div className="flex items-center gap-2 px-3 pb-1 pt-2.5 text-[13px]">
          <span className="flex-1 font-semibold">{word}につなぐ</span>
          <button type="button" onClick={onClose} aria-label="閉じる" className="rounded p-0.5 hover:bg-gray-100 dark:hover:bg-zinc-700"><X size={12} /></button>
        </div>
        <div className="flex items-center gap-1.5 border-b border-gray-100 px-3 py-1.5 dark:border-zinc-700">
          <MagnifyingGlass size={12} className="text-gray-400" />
          <input autoFocus value={q} onChange={e => setQ(e.target.value)} aria-label={`${word}を探す`} placeholder="名前で探す" className="flex-1 bg-transparent text-[12.5px] outline-none" />
        </div>
        <ul className="max-h-[280px] overflow-y-auto p-1">
          {choices === null && <li className="px-2 py-2 text-[12px] text-gray-400">読み込んでいます</li>}
          {choices && !choices.success && <li role="alert" className="px-2 py-2 text-[12px] text-gray-500">{choices.error}</li>}
          {choices?.success && shown.length === 0 && <li className="px-2 py-2 text-[12px] text-gray-500">見つかりませんでした</li>}
          {shown.map(b => (
            <li key={b.id}>
              <button type="button" disabled={busy || b.id === current} onClick={() => void choose(b)} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-gray-100 disabled:opacity-50 dark:hover:bg-zinc-700">
                <ThingIcon kind="bundle" typeLabel={b.typeLabel} size={13} label="" />
                <span className="min-w-0 flex-1 truncate text-[12.5px]">{b.title}</span>
                <span className="text-[10.5px] text-gray-400">{b.id === current ? 'いまのもの' : b.typeLabel}</span>
              </button>
            </li>
          ))}
        </ul>
        {error && <p role="alert" className="border-t border-gray-100 px-3 py-1.5 text-[11.5px] text-red-600 dark:border-zinc-700 dark:text-red-400">{error}</p>}
      </div>
    </div>
  )
}
