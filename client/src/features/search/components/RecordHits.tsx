import type { RecordListResult, RecordViewSummary } from '../../../../shared/record-views'
import { runCommand } from '../../../shared/commands/commands'
import { SeenBy, ThingIcon } from '../../../shared/ui/ThingIcon'
import { ONLY_YOU } from '../../../../shared/thing-words'

/**
 * The records 探す found (design §7-5): one row each — its kind's icon, title and kind name — that
 * opens it in a tab. Only what the member may read: the server leaves the rest out of the list and
 * the count alike. `records` are the ones the chosen kind chip keeps.
 */
export function RecordHits({ result, records }: { result: RecordListResult | null; records: readonly RecordViewSummary[] }) {
  if (!result || (result.success && (!result.available || result.total === 0))) return null
  if (!result.success) return <p className="px-3 py-2 text-[10px] text-gray-400">記録は探せませんでした（{result.error}）</p>
  if (records.length === 0) return null
  return (
    <div className="py-1 border-b border-gray-200 dark:border-zinc-800/50" aria-label="見つかった記録">
      {records.map(r => (
        <button
          key={r.id}
          type="button"
          onClick={() => runCommand('record.open', { recordId: r.id })}
          className="w-full flex items-center gap-2 text-left px-3 py-1 hover:bg-gray-100 dark:hover:bg-white/[0.04]"
        >
          <ThingIcon kind={r.thing} typeLabel={r.typeLabel} label={r.typeLabel} size={14} />
          <span className="min-w-0 flex-1">
            <span className={`block text-[12px] truncate ${r.finished ? 'text-gray-400 line-through' : 'text-gray-700 dark:text-zinc-300'}`}>{r.title}</span>
            <span className="flex items-center gap-1.5 text-[10px] text-gray-400 dark:text-zinc-500">
              <span className="truncate">{r.typeLabel}</span>
              {r.personal && <SeenBy who={ONLY_YOU} small />}
            </span>
          </span>
        </button>
      ))}
      {result.total > result.records.length && (
        <p className="px-3 text-[10px] text-amber-600 dark:text-amber-400/80">ほかに {result.total - result.records.length} 件あります。言葉を増やして絞り込んでください。</p>
      )}
    </div>
  )
}
