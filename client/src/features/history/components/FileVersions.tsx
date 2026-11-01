import { useEffect, useState } from 'react'
import { CircleNotch, ClockCounterClockwise } from '@phosphor-icons/react'
import { DiffModal } from '../../../shared/ui/DiffViewer'
import type { GitLogResult } from '../../../../shared/ipc-contract'
import { getFileVersions } from '../api'
import { onFileVersionsRefresh } from '../refresh'

type Version = GitLogResult['commits'][number]

interface Props {
  rootPath: string
  /** The file's path inside the company folder. The caller keys this component by it. */
  companyPath: string
}

function when(date: string): string {
  const d = new Date(date)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** 「前の版」 of the open file: who changed it when, and what each change did (replaces the 履歴 tab). */
export function FileVersions({ rootPath, companyPath }: Props) {
  const [versions, setVersions] = useState<Version[] | null>(null)
  const [shown, setShown] = useState<Version | null>(null)

  // Read now and again after every sync, keeping the list on screen meanwhile.
  useEffect(() => {
    let current = true
    const load = () => {
      getFileVersions(rootPath, companyPath, 30)
        .then(r => { if (current) setVersions(r.success ? r.commits : []) })
        .catch(() => { if (current) setVersions([]) })
    }
    load()
    const stop = onFileVersionsRefresh(load)
    return () => { current = false; stop() }
  }, [rootPath, companyPath])

  return (
    <section aria-label="前の版">
      <h3 className="flex items-center gap-1.5 text-[12px] font-semibold text-gray-700 dark:text-zinc-200 mb-1.5">
        <ClockCounterClockwise size={13} />前の版
      </h3>
      {versions === null ? (
        <p className="flex items-center gap-1.5 text-[11px] text-gray-400"><CircleNotch size={11} className="animate-spin" />読み込み中...</p>
      ) : versions.length === 0 ? (
        <p className="text-[11px] text-gray-400 dark:text-zinc-500">まだ共有された版はありません</p>
      ) : (
        <ul className="space-y-0.5">
          {versions.map(v => (
            <li key={v.hash}>
              <button type="button" onClick={() => setShown(v)} className="w-full text-left rounded-md px-2 py-1 hover:bg-gray-100 dark:hover:bg-zinc-800">
                <span className="block text-[12px] text-gray-800 dark:text-zinc-200 truncate">{v.message.split('\n')[0]}</span>
                <span className="block text-[10.5px] text-gray-500 dark:text-zinc-400">{when(v.date)}・{v.author}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {shown && (
        <DiffModal
          isOpen
          onClose={() => setShown(null)}
          title={`${companyPath.split('/').pop()}（${when(shown.date)} の変更）`}
          diffProps={{ mode: 'commit', rootPath, filePath: companyPath, commitHash: shown.hash }}
        />
      )}
    </section>
  )
}
