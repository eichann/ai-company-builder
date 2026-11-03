// The folded 「アーカイブ」 at the bottom of the list (owner decision 2026-11-03): archived tasks,
// newest first, 20 at a time with 「さらに読み込む」. Read when opened (each opening from the start),
// never while folded; a row opens the card, where ［戻す］ brings it back.
import { useState } from 'react'
import { Archive, CaretDown, CaretRight, CircleNotch } from '@phosphor-icons/react'
import { ARCHIVE_SHOWN_DAYS, type ArchiveCursor, type ArchivedTask } from '../../../../shared/tasks'
import { getArchivedTasks } from '../api'
import { companyNow } from '../model'

const HEADER = 'mb-1 flex w-full items-center gap-1.5 px-2.5 text-[11px] font-semibold text-gray-500 dark:text-zinc-400'
const START: ArchiveCursor = { assignee: 0, requester: 0 }

interface Props {
  companyId: string
  activeRecordId: string | null
  onOpen: (recordId: string) => void
}

/** `M/D` of an ISO time in the company's day. */
const shortDate = (iso: string) => {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return ''
  const [, m, d] = companyNow(ms).date.split('-')
  return `${Number(m)}/${Number(d)}`
}

export function ArchiveSection({ companyId, activeRecordId, onOpen }: Props) {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<ArchivedTask[]>([])
  const [next, setNext] = useState<ArchiveCursor | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = async (from: ArchiveCursor, more: boolean) => {
    setLoading(true)
    setError(null)
    try {
      const r = await getArchivedTasks(companyId, from)
      if (!r.success) { setError(r.error); return }
      // A task archived between two presses may come again: shown once.
      setItems(prev => {
        const shown = more ? prev : []
        const seen = new Set(shown.map(i => i.id))
        return [...shown, ...r.items.filter(i => !seen.has(i.id))]
      })
      setNext(r.next)
    } finally {
      setLoading(false)
    }
  }
  const toggle = () => {
    const opening = !open
    setOpen(opening)
    if (opening) void load(START, false)
  }

  return (
    <section aria-label="アーカイブ" data-testid="archive">
      <button type="button" aria-expanded={open} onClick={toggle} className={HEADER}>
        {open ? <CaretDown size={10} /> : <CaretRight size={10} />}アーカイブ
        <span className="ml-auto truncate text-[10px] font-normal text-gray-400">一覧から外したもの</span>
      </button>
      {open && (
        <div className="space-y-0.5">
          {items.map(i => (
            <button key={i.id} type="button" data-record-id={i.id} onClick={() => onOpen(i.id)}
              className={`flex w-full items-start gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-gray-100 dark:hover:bg-zinc-800 ${activeRecordId === i.id ? 'bg-gray-100 dark:bg-zinc-800' : ''}`}>
              <Archive size={15} className="mt-[2px] shrink-0 text-gray-400" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] text-gray-600 dark:text-zinc-300">{i.title}</span>
                <span className="block truncate text-[11px] text-gray-400">{shortDate(i.archivedAt)} アーカイブ{i.personal ? '・あなただけ' : ''}</span>
              </span>
            </button>
          ))}
          {!loading && !error && items.length === 0 && <p className="px-2.5 py-1 text-[11.5px] text-gray-400">アーカイブしたやることはありません。</p>}
          {error && <p role="alert" className="px-2.5 py-1 text-[11.5px] text-amber-700 dark:text-amber-300">{error}</p>}
          {loading && <p className="flex items-center gap-1.5 px-2.5 py-1 text-[11.5px] text-gray-400"><CircleNotch size={12} className="animate-spin" />読み込んでいます</p>}
          {!loading && next && (
            <button type="button" onClick={() => void load(next, true)} className="mx-2.5 mt-1 rounded-md border border-gray-200 px-2 py-0.5 text-[11.5px] text-gray-600 hover:bg-gray-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800">
              さらに読み込む
            </button>
          )}
          {!loading && !next && <p className="px-2.5 pt-0.5 text-[10.5px] text-gray-400 dark:text-zinc-500">{ARCHIVE_SHOWN_DAYS}日より前のものは、探すタブから見つかります</p>}
        </div>
      )}
    </section>
  )
}
