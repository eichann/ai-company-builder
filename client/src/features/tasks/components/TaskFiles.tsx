import { useState } from 'react'
import { FileText, FolderSimple, MagnifyingGlass, Plus } from '@phosphor-icons/react'
import { useDismiss } from '../../../shared/hooks/useDismiss'
import { listCompanyFiles } from '../api'
import { linkCandidates } from '../model'

interface Props {
  rootPath: string
  linked: string[]
  busy: boolean
  /** null = done; else the reason in words. */
  onLink: (companyPath: string) => Promise<string | null>
}

/** 「＋ファイル・フォルダをつなぐ」 under the files of 「つながっているもの」: the company's files and folders by name. */
export function TaskFiles({ rootPath, linked, busy, onLink }: Props) {
  const [picking, setPicking] = useState(false)
  const [all, setAll] = useState<Array<{ path: string; folder: boolean }> | null>(null)
  const [q, setQ] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [box, setBox] = useState<HTMLDivElement | null>(null)
  // A press outside the picker or Esc closes it, like the card's other small popovers.
  useDismiss(box, picking, () => setPicking(false))
  const open = () => {
    setPicking(p => !p)
    setError(null)
    if (all === null) void listCompanyFiles(rootPath).then(r => setAll(linkCandidates(r?.success ? r.files : [])), () => setAll([]))
  }
  const link = async (p: string) => {
    setError(null)
    const failure = await onLink(p)
    if (failure) setError(failure)
    else setPicking(false)
  }
  const query = q.trim().normalize('NFC')
  const matches = (all ?? []).filter(c => !query || c.path.normalize('NFC').includes(query)).slice(0, 50)
  return (
    <div ref={setBox}>
      <button type="button" onClick={open} aria-expanded={picking} className="ml-1 mt-0.5 inline-flex items-center gap-0.5 rounded px-1 text-[11.5px] text-accent hover:underline">
        <Plus size={10} />ファイル・フォルダをつなぐ
      </button>
      {picking && (
        <div role="group" aria-label="つなぐファイル・フォルダ" className="mt-1 overflow-hidden rounded-lg border border-gray-200 dark:border-zinc-700">
          <div className="flex items-center gap-1.5 border-b border-gray-100 px-2 py-1 dark:border-zinc-700">
            <MagnifyingGlass size={11} className="text-gray-400" />
            <input autoFocus value={q} onChange={e => setQ(e.target.value)} aria-label="ファイルを探す" placeholder="名前・フォルダで探す" className="min-w-0 flex-1 bg-transparent text-[11.5px] outline-none" />
          </div>
          <ul className="max-h-[220px] overflow-y-auto p-1">
            {all === null && <li className="px-2 py-1 text-[11px] text-gray-400">読み込んでいます</li>}
            {all !== null && matches.length === 0 && <li className="px-2 py-1 text-[11px] text-gray-400">見つかりませんでした</li>}
            {matches.map(({ path: p, folder }) => (
              <li key={p}>
                <button type="button" disabled={busy || linked.includes(p)} onClick={() => void link(p)} className="w-full rounded px-1.5 py-0.5 text-left hover:bg-gray-100 disabled:opacity-50 dark:hover:bg-zinc-800">
                  <span className="flex items-center gap-1 text-[11.5px]">{folder ? <FolderSimple size={11} className="shrink-0 text-amber-500" /> : <FileText size={11} className="shrink-0 text-gray-500" />}<span className="truncate">{p.split('/').pop()}</span>{linked.includes(p) && <span className="ml-auto shrink-0 text-[10px] text-gray-400">つないであります</span>}</span>
                  <span className="block truncate pl-4 text-[10px] text-gray-500">{p}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {error && <p role="alert" className="mt-1 text-[11px] text-red-600 dark:text-red-400">{error}</p>}
    </div>
  )
}
