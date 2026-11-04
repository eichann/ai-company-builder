import { useCallback, useState } from 'react'
import { Broom, X } from '@phosphor-icons/react'
import { useEventListener } from '../../../shared/hooks/useEventListener'
import { useLatestRef } from '../../../shared/hooks/useLatestRef'
import { getFileIcon } from '../../../shared/ui/fileIcon'
import { RecordIcon } from '../../../shared/ui/ThingIcon'
import { Button } from '../../../shared/ui/primitives'
import { dayLabel, groupsByDay, itemKindName, TIDY_LIMITS, type TidiedGroup, type TidiedItem } from '../tidyTabs'

interface Props {
  groups: readonly TidiedGroup[]
  onClose: () => void
  /** Reopens items; answers the ones whose file is gone (they stay listed). */
  onRestore: (items: readonly TidiedItem[]) => Promise<{ missing: readonly TidiedItem[] }>
  onRemoveItems: (ids: readonly string[]) => void
  onRemoveDay: (day: string) => void
  /** Which items are gone (checked once when the list opens). */
  checkMissing: (items: readonly TidiedItem[]) => Promise<Set<string>>
}

const time = (iso: string) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tokyo' })
}

/**
 * 「片づけたタブ」: the tidied tabs by company day, newest first; a day reopens or goes as a whole,
 * an item opens alone. A file or record no longer there is greyed 「見つかりません」, still removable.
 */
export function TidiedTabsDialog({ groups, onClose, onRestore, onRemoveItems, onRemoveDay, checkMissing }: Props) {
  const [missing, setMissing] = useState<ReadonlySet<string>>(new Set())
  useEventListener<KeyboardEvent>(document, 'keydown', e => { if (e.key === 'Escape' && !e.isComposing) onClose() })
  // Checked once when the list mounts (a callback ref: the renderer's effect count is capped).
  const first = useLatestRef({ checkMissing, groups })
  const checkRef = useCallback((el: HTMLDivElement | null) => {
    if (el) void first.current.checkMissing(first.current.groups.flatMap(g => g.items)).then(setMissing, () => {})
  }, [first])
  const restore = async (items: readonly TidiedItem[]) => {
    const r = await onRestore(items.filter(i => !missing.has(i.id)))
    if (r.missing.length > 0) setMissing(prev => new Set([...prev, ...r.missing.map(i => i.id)]))
  }
  const days = groupsByDay(groups)

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/20 pt-[10vh]" onClick={onClose}>
      <div ref={checkRef} role="dialog" aria-label="片づけたタブ" onClick={e => e.stopPropagation()}
        className="flex max-h-[76vh] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-gray-200 bg-white shadow-2xl dark:border-zinc-700 dark:bg-zinc-900">
        <div className="flex items-center gap-2 border-b border-gray-200 px-4 py-3 dark:border-zinc-800">
          <Broom size={16} className="text-gray-500 dark:text-zinc-400" />
          <h2 className="flex-1 text-[13.5px] font-semibold text-gray-800 dark:text-zinc-100">片づけたタブ</h2>
          <button type="button" aria-label="閉じる" onClick={onClose} className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"><X size={14} /></button>
        </div>
        <div className="flex-1 overflow-auto px-2 py-2">
          {days.length === 0 && (
            <p className="px-3 py-6 text-center text-[12.5px] leading-relaxed text-gray-500 dark:text-zinc-400">
              片づけたタブはまだありません。<br />タブの右の「…」から［タブを片づける］を押すと、固定したタブ以外がここにしまわれます。
            </p>
          )}
          {days.map(({ day, groups: tidies }) => {
            const items = tidies.flatMap(g => g.items)
            return (
              <section key={day} data-tidied-day={day} className="mb-2 rounded-lg border border-gray-100 dark:border-zinc-800">
                <div className="flex flex-wrap items-center gap-2 border-b border-gray-100 px-3 py-2 dark:border-zinc-800">
                  <h3 className="text-[12.5px] font-semibold text-gray-800 dark:text-zinc-100">{dayLabel(day)}</h3>
                  <span className="text-[11px] text-gray-400">{items.length} 件</span>
                  <span className="ml-auto flex gap-1.5">
                    <Button size="sm" onClick={() => { void restore(items) }}>全部開き直す</Button>
                    <Button size="sm" variant="ghost" onClick={() => onRemoveDay(day)}>この日の分を消す</Button>
                  </span>
                </div>
                {tidies.map(g => (
                  <div key={g.id} className="px-1.5 pb-1">
                    <div className="px-1.5 pt-1.5 text-[10.5px] text-gray-400">{time(g.at)} に{g.auto ? '自動で' : ''}片づけ</div>
                    <ul>
                      {g.items.map(i => {
                        const gone = missing.has(i.id)
                        const FileIc = i.kind === 'file' ? getFileIcon(i.title, false) : null
                        return (
                          <li key={i.id} data-tidied-item={i.title} data-missing={gone || undefined} className="group flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-gray-50 dark:hover:bg-zinc-800/50">
                            <button type="button" disabled={gone} onClick={() => { void restore([i]) }} aria-label={gone ? `${i.title}（見つかりません）` : `${i.title} を開く`}
                              className={`flex min-w-0 flex-1 items-center gap-2 text-left ${gone ? 'cursor-default opacity-45' : ''}`}>
                              {FileIc ? <FileIc size={14} className="flex-shrink-0" /> : i.kind === 'record' && i.look ? <RecordIcon record={i.look} size={14} /> : <span className="w-3.5" />}
                              <span className="min-w-0 flex-1">
                                <span className={`block truncate text-[12.5px] text-gray-800 dark:text-zinc-100 ${gone ? 'line-through' : ''}`}>{i.title}</span>
                                {i.kind === 'file' && i.path !== i.title && <span className="block truncate text-[10.5px] text-gray-500">{i.path}</span>}
                              </span>
                              <span className="shrink-0 text-[10.5px] text-gray-400">{gone ? '見つかりません' : itemKindName(i)}</span>
                            </button>
                            <button type="button" aria-label={`${i.title} を一覧から消す`} title="一覧から消す" onClick={() => onRemoveItems([i.id])}
                              className={`rounded p-0.5 text-gray-400 hover:bg-gray-200 hover:text-gray-700 dark:hover:bg-zinc-700 ${gone ? '' : 'opacity-0 group-hover:opacity-100 focus:opacity-100'}`}>
                              <X size={12} />
                            </button>
                          </li>
                        )
                      })}
                    </ul>
                  </div>
                ))}
              </section>
            )
          })}
        </div>
        <div className="border-t border-gray-100 px-4 py-1.5 text-[10.5px] text-gray-400 dark:border-zinc-800">
          この Mac にだけ残ります。直近 {TIDY_LIMITS.groups} 回・{TIDY_LIMITS.items} 件まで（それより古いものは自動で消えます）。開き直したものは一覧から外れます。
        </div>
      </div>
    </div>
  )
}
