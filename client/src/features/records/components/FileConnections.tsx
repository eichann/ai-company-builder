import { LinkSimple } from '@phosphor-icons/react'
import { useFileRecords } from '../hooks/useFileRecords'
import { groupByKind, kindTitle } from '../model'
import { RecordRow } from './RecordRows'

interface Props {
  companyId: string
  /** The open file's path inside the company folder. The caller keys this component by it. */
  companyPath: string
}

/** 「つながっているもの」 of the open file (design §7-6): the records linking to it that the member may read. */
export function FileConnections({ companyId, companyPath }: Props) {
  const result = useFileRecords(companyId, companyPath)
  // Records off for this company: nothing to say about it here.
  if (result?.success && !result.available) return null
  return (
    <section aria-label="つながっているもの">
      <h3 className="flex items-center gap-1.5 text-[12px] font-semibold text-gray-700 dark:text-zinc-200 mb-1.5"><LinkSimple size={13} />つながっているもの</h3>
      {result === null ? (
        <p className="text-[11px] text-gray-400">読み込み中...</p>
      ) : !result.success ? (
        <p className="text-[11px] text-gray-400">{result.error}</p>
      ) : result.records.length === 0 ? (
        <p className="text-[11px] text-gray-400 dark:text-zinc-500">このファイルにつながっているものはありません</p>
      ) : (
        groupByKind(result.records).map(g => (
          <div key={g.kind} className="mb-2">
            <div className="text-[11px] font-semibold text-gray-500 dark:text-zinc-400 mb-0.5">{kindTitle(g.kind)}（{g.items.length}）</div>
            <ul>{g.items.map(r => <li key={r.id}><RecordRow record={r} /></li>)}</ul>
          </div>
        ))
      )}
    </section>
  )
}
