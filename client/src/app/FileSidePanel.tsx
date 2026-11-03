import { useState } from 'react'
import { CaretDoubleLeft, CaretDoubleRight } from '@phosphor-icons/react'
import { FileConnections } from '../features/records/components/FileConnections'
import { FileVersions } from '../features/history/components/FileVersions'

const STORAGE_KEY = 'editor:side-open'

function readOpen(): boolean {
  try { return localStorage.getItem(STORAGE_KEY) !== '0' } catch { return true }
}

interface Props {
  companyId: string | undefined
  rootPath: string
  /** The open file's absolute path (inside `rootPath`). */
  filePath: string
}

/** Beside the open file: what it is linked to (records) and its earlier versions (前の版). Can be folded away. */
export function FileSidePanel({ companyId, rootPath, filePath }: Props) {
  const [open, setOpen] = useState(readOpen)
  const toggle = () => {
    setOpen(!open)
    try { localStorage.setItem(STORAGE_KEY, open ? '0' : '1') } catch { /* a convenience only */ }
  }
  if (!filePath.startsWith(rootPath + '/')) return null
  const companyPath = filePath.slice(rootPath.length + 1)
  if (!open) {
    return (
      <button type="button" data-file-side onClick={toggle} title="つながっているもの・前の版を表示" aria-label="つながっているもの・前の版を表示"
        className="flex-shrink-0 w-6 flex items-start justify-center pt-2 border-l border-gray-200 dark:border-zinc-800/50 text-gray-400 hover:text-gray-700 dark:hover:text-zinc-200 hover:bg-gray-100 dark:hover:bg-zinc-800">
        <CaretDoubleLeft size={12} />
      </button>
    )
  }
  return (
    <aside data-file-side className="flex-shrink-0 w-[240px] overflow-y-auto border-l border-gray-200 dark:border-zinc-800/50 bg-white/60 dark:bg-zinc-900/40 px-3 py-2 space-y-4">
      <div className="flex justify-end -mb-2">
        <button type="button" onClick={toggle} title="たたむ" aria-label="つながっているもの・前の版をたたむ" className="p-0.5 rounded text-gray-400 hover:text-gray-700 dark:hover:text-zinc-200"><CaretDoubleRight size={12} /></button>
      </div>
      {companyId && <FileConnections key={`${companyId}:${companyPath}`} companyId={companyId} companyPath={companyPath} />}
      <FileVersions key={companyPath} rootPath={rootPath} companyPath={companyPath} />
    </aside>
  )
}
