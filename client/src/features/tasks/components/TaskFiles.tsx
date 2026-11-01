import { useState } from 'react'
import { FileText, MagnifyingGlass, Plus, X } from '@phosphor-icons/react'
import { FileLinkRow } from '../../records/components/RecordRows'
import { listCompanyFiles } from '../api'

interface Props {
  rootPath: string
  files: Array<{ path: string; broken?: boolean }>
  busy: boolean
  /** null = done; else the reason in words. */
  onLink: (companyPath: string) => Promise<string | null>
  onUnlink: (companyPath: string) => Promise<string | null>
}

/** The task card's files: open one, take a link away, or 「＋ファイルをつなぐ」 from the company's files. */
export function TaskFiles({ rootPath, files, busy, onLink, onUnlink }: Props) {
  const [picking, setPicking] = useState(false)
  const [all, setAll] = useState<string[] | null>(null)
  const [q, setQ] = useState('')
  const [error, setError] = useState<string | null>(null)
  const linked = new Set(files.map(f => f.path))
  const open = () => {
    setPicking(p => !p)
    setError(null)
    if (all === null) void listCompanyFiles(rootPath).then(r => setAll(r?.success ? r.files : []), () => setAll([]))
  }
  const act = async (fn: () => Promise<string | null>) => {
    setError(null)
    const failure = await fn()
    if (failure) setError(failure)
    else setPicking(false)
  }
  const query = q.trim().normalize('NFC')
  const matches = (all ?? []).filter(p => !query || p.normalize('NFC').includes(query)).slice(0, 50)
  return (
    <section>
      <h3 className="mb-1 flex items-center text-[11px] font-semibold text-gray-500 dark:text-zinc-400">
        ファイル（{files.length}）
        <button type="button" onClick={open} aria-expanded={picking} className="ml-auto flex items-center gap-0.5 rounded px-1.5 py-0.5 font-normal text-accent hover:bg-accent/10">
          <Plus size={10} />ファイルをつなぐ
        </button>
      </h3>
      {picking && (
        <div role="group" aria-label="つなぐファイル" className="mb-2 overflow-hidden rounded-lg border border-gray-200 dark:border-zinc-700">
          <div className="flex items-center gap-1.5 border-b border-gray-100 px-2 py-1 dark:border-zinc-700">
            <MagnifyingGlass size={11} className="text-gray-400" />
            <input autoFocus value={q} onChange={e => setQ(e.target.value)} aria-label="ファイルを探す" placeholder="名前・フォルダで探す" className="min-w-0 flex-1 bg-transparent text-[11.5px] outline-none" />
          </div>
          <ul className="max-h-[220px] overflow-y-auto p-1">
            {all === null && <li className="px-2 py-1 text-[11px] text-gray-400">読み込み中...</li>}
            {all !== null && matches.length === 0 && <li className="px-2 py-1 text-[11px] text-gray-400">見つかりません</li>}
            {matches.map(p => (
              <li key={p}>
                <button type="button" disabled={busy || linked.has(p)} onClick={() => void act(() => onLink(p))} className="w-full rounded px-1.5 py-0.5 text-left hover:bg-gray-100 disabled:opacity-50 dark:hover:bg-zinc-800">
                  <span className="flex items-center gap-1 text-[11.5px]"><FileText size={11} className="shrink-0 text-gray-500" /><span className="truncate">{p.split('/').pop()}</span>{linked.has(p) && <span className="ml-auto shrink-0 text-[10px] text-gray-400">つないであります</span>}</span>
                  <span className="block truncate pl-4 text-[10px] text-gray-500">{p}</span>
                </button>
              </li>
            ))}
          </ul>
          <p className="border-t border-gray-100 px-2 py-1 text-[10px] text-gray-500 dark:border-zinc-700">ファイルの木からこのカードにドラッグしても、つなげます。</p>
        </div>
      )}
      {error && <p role="alert" className="mb-1 text-[11px] text-red-600 dark:text-red-400">{error}</p>}
      <ul>
        {files.map(f => (
          <li key={f.path} className="group flex items-start">
            <span className="min-w-0 flex-1"><FileLinkRow rootPath={rootPath} path={f.path} broken={f.broken} /></span>
            <button type="button" disabled={busy} onClick={() => void act(() => onUnlink(f.path))} aria-label={`「${f.path.split('/').pop()}」を外す`} title="外す（経緯に残ります）"
              className="mt-1 shrink-0 rounded p-0.5 text-gray-400 opacity-0 hover:bg-gray-200 hover:text-gray-700 focus:opacity-100 group-hover:opacity-100 dark:hover:bg-zinc-700">
              <X size={10} />
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
