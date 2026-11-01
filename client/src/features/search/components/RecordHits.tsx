import { RECORD_KIND_LABELS, RECORD_KIND_ORDER, type RecordListResult } from '../../../../shared/record-views'
import { runCommand } from '../../../shared/commands/commands'

/**
 * The records a search found (design §7-5), by kind, next to the files: only what the member
 * may read — the server leaves the rest out of the list and the count alike.
 */
export function RecordHits({ result }: { result: RecordListResult | null }) {
  if (!result || (result.success && (!result.available || result.total === 0))) return null
  if (!result.success) return <p className="px-3 py-2 text-[10px] text-gray-400">記録は検索できませんでした（{result.error}）</p>
  const groups = RECORD_KIND_ORDER.map(kind => ({ kind, items: result.records.filter(r => r.kind === kind) })).filter(g => g.items.length > 0)
  return (
    <div className="py-1 border-b border-gray-200 dark:border-zinc-800/50" aria-label="記録の検索結果">
      {groups.map(g => (
        <div key={g.kind} className="mb-1">
          <div className="px-3 py-1 text-[11px] font-medium text-gray-700 dark:text-zinc-300">
            {RECORD_KIND_LABELS[g.kind]} <span className="text-gray-400 dark:text-zinc-500">({g.items.length})</span>
          </div>
          {g.items.map(r => (
            <button
              key={r.id}
              type="button"
              onClick={() => runCommand('record.open', { recordId: r.id })}
              className="w-full text-left px-3 pl-6 py-0.5 hover:bg-gray-100 dark:hover:bg-white/[0.04]"
            >
              <span className="block text-[11px] text-gray-700 dark:text-zinc-300 truncate">{r.title}</span>
              <span className="block text-[10px] text-gray-400 dark:text-zinc-500 truncate">{[r.typeLabel === RECORD_KIND_LABELS[r.kind] ? null : r.typeLabel, r.stateLabel].filter(Boolean).join('・')}</span>
            </button>
          ))}
        </div>
      ))}
      {result.total > result.records.length && (
        <p className="px-3 text-[10px] text-amber-600 dark:text-amber-400/80">ほかに {result.total - result.records.length} 件あります。言葉を増やして絞り込んでください。</p>
      )}
    </div>
  )
}
