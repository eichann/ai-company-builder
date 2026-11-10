import { useState } from 'react'
import { FileText, GoogleDriveLogo, Plus } from '@phosphor-icons/react'
import type { TaskDriveChoice } from '../../../../shared/tasks'
import { useDismiss } from '../../../shared/hooks/useDismiss'
import { getTaskDriveChoices } from '../api'

interface Props {
  companyId: string
  /** Drive files already linked to this task (shown, not chosen again). */
  linked: readonly string[]
  busy: boolean
  /** False when the company has not set Drive up: the button is off (the caller says why). */
  usable: boolean
  /** `chosen` = these files from the list; absent = Google Drive's own window (the Picker). null = done; else the reason in words. */
  onLink: (chosen?: TaskDriveChoice[]) => Promise<string | null>
}

/**
 * 「＋Google Drive のファイルをつなぐ」 (a company without the shared folder): first the member's own files
 * that ACB may already open — the ones they picked before and the ones their AI put into Drive — to tick
 * one or several, with 「Google Drive から探す」 for anything else. Without any, Google's window opens at once.
 * The names are the member's own (the server answers each member only theirs).
 */
export function DriveFiles({ companyId, linked, busy, usable, onLink }: Props) {
  const [choices, setChoices] = useState<TaskDriveChoice[] | null>(null)
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set())
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [box, setBox] = useState<HTMLDivElement | null>(null)
  const close = () => { setChoices(null); setChosen(new Set()) }
  // A press outside the list or Esc closes it, like the card's other small popovers.
  useDismiss(box, choices !== null, close)
  const run = async (files?: TaskDriveChoice[]) => {
    setError(null)
    const failure = await onLink(files)
    if (failure) setError(failure)
    else close()
  }
  const open = async () => {
    if (choices !== null) { close(); return }
    // While Google's chooser is open (busy), a second one is never started.
    if (busy || opening || !usable) return
    setError(null)
    setOpening(true)
    const listed = await getTaskDriveChoices(companyId).catch(() => [] as TaskDriveChoice[])
    setOpening(false)
    if (listed.length === 0) { await run(); return }
    setChoices(listed)
  }
  const toggle = (id: string) => setChosen(prev => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })
  const picked = (choices ?? []).filter(c => chosen.has(c.id) && !linked.includes(c.id))
  return (
    <div ref={setBox}>
      <button type="button" disabled={busy || opening || !usable} onClick={() => void open()} aria-expanded={choices !== null} data-link-drive
        className="mt-0.5 inline-flex items-center gap-0.5 rounded px-1 text-[11.5px] text-accent hover:underline disabled:opacity-50"><Plus size={10} />Google Drive のファイルをつなぐ</button>
      {choices !== null && usable && (
        <div role="group" aria-label="つなぐ Google Drive のファイル" className="mt-1 overflow-hidden rounded-lg border border-gray-200 dark:border-zinc-700">
          <p className="border-b border-gray-100 px-2 py-1 text-[11px] text-gray-500 dark:border-zinc-700 dark:text-zinc-400">前に選んだファイルと、AI が Drive に置いたファイル</p>
          <ul className="max-h-[220px] overflow-y-auto p-1">
            {choices.map(c => {
              const already = linked.includes(c.id)
              return (
                <li key={c.id}>
                  <label className={`flex items-center gap-1.5 rounded px-1.5 py-0.5 text-[11.5px] ${already ? 'opacity-50' : 'cursor-pointer hover:bg-gray-100 dark:hover:bg-zinc-800'}`}>
                    <input type="checkbox" disabled={busy || already} checked={already || chosen.has(c.id)} onChange={() => toggle(c.id)} className="shrink-0" />
                    <FileText size={11} className="shrink-0 text-gray-500" />
                    <span className="min-w-0 truncate">{c.name}</span>
                    <span className="ml-auto shrink-0 text-[10px] text-gray-400">{already ? 'つないであります' : c.source === 'put' ? 'AI が置いたもの' : ''}</span>
                  </label>
                </li>
              )
            })}
          </ul>
          <div className="flex flex-wrap items-center gap-1.5 border-t border-gray-100 px-2 py-1 dark:border-zinc-700">
            <button type="button" disabled={busy || picked.length === 0} onClick={() => void run(picked)}
              className="rounded bg-accent px-2 py-0.5 text-[11.5px] text-white disabled:opacity-50">つなぐ</button>
            <button type="button" disabled={busy} onClick={() => void run()}
              className="inline-flex items-center gap-1 rounded border border-gray-300 px-2 py-0.5 text-[11.5px] dark:border-zinc-600"><GoogleDriveLogo size={11} />Google Drive から探す</button>
          </div>
        </div>
      )}
      {error && <p role="alert" className="mt-1 text-[11px] text-red-600 dark:text-red-400">{error}</p>}
    </div>
  )
}
