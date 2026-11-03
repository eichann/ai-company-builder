import { LinkedColumn } from '../../../shared/ui/LinkedColumn'
import { useFileRecords } from '../hooks/useFileRecords'
import { recordRow } from './linkRows'

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
  if (result === null || !result.success) {
    return (
      <section aria-label="つながっているもの">
        <p className="text-[11px] text-gray-400">{result === null ? '読み込んでいます' : result.error}</p>
      </section>
    )
  }
  return <LinkedColumn rows={result.records.map(r => recordRow(r))} />
}
