// ACB foundation: the page every record opens in, used by the records and tasks features (the task
// card and the other record screens), which may not import each other.
import { useState, type ReactNode } from 'react'
import { CaretDown, CaretRight, ClockCounterClockwise, ListBullets } from '@phosphor-icons/react'
import type { RecordCardField, RecordCardHistoryLine } from '../../../shared/record-views'
import { useIsNarrowerThan } from '../hooks/useIsNarrowerThan'
import type { ThingKind } from '../../../shared/thing-words'
import { ThingIcon } from './ThingIcon'

/**
 * The one layout every record opens in (新しい画面のデモ A–C): the kind and its state as small
 * chips, the big title with the one main action and 「…」 beside it, where it came from, the body,
 * fields and 経緯 folded at the bottom, and 「つながっているもの」 on the right (below when narrow).
 */
export function RecordPage({ testId, kind, name, chips, seenBy, top, title, actions, from, children, bottom, links }: {
  testId?: string
  kind: ThingKind
  /** The kind's plain name (`typeLabel`: 会議の記録, 案件…). */
  name: string
  /** State, whose turn, people — short words only. */
  chips?: ReactNode
  /** Who can see it (top right). */
  seenBy?: ReactNode
  /** Above the header: a conflict notice, the AI working, the 案件 it belongs to. */
  top?: ReactNode
  title: string
  actions?: ReactNode
  from?: ReactNode
  children?: ReactNode
  bottom?: ReactNode
  links: ReactNode
}) {
  const [ref, narrow] = useIsNarrowerThan<HTMLDivElement>(720)
  return (
    <div ref={ref} data-testid={testId}
      className={`grid gap-x-5 gap-y-6 p-5 text-gray-900 dark:text-zinc-100 ${narrow ? 'grid-cols-1' : 'grid-cols-[minmax(0,1fr)_240px]'}`}>
      <article className="min-w-0 space-y-5">
        {top}
        <header className="space-y-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <Chip><ThingIcon kind={kind} typeLabel={name} label="" size={12} />{name}</Chip>
            {chips}
            {seenBy && <span className="ml-auto">{seenBy}</span>}
          </div>
          <div className="flex items-start gap-3">
            <h1 className="min-w-0 flex-1 text-[22px] font-bold leading-snug">{title}</h1>
            {actions && <div className="flex shrink-0 items-center gap-1.5 pt-1">{actions}</div>}
          </div>
          {from}
        </header>
        {children}
        {bottom && <div className="space-y-3">{bottom}</div>}
      </article>
      <div className={narrow ? 'border-t border-gray-100 pt-4 dark:border-zinc-800' : 'border-l border-gray-100 pl-5 dark:border-zinc-800'}>{links}</div>
    </div>
  )
}

const CHIP = {
  gray: 'bg-gray-100 text-gray-600 dark:bg-zinc-800 dark:text-zinc-300',
  accent: 'bg-accent/10 text-accent',
  amber: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  green: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
}
export function Chip({ children, tone = 'gray' }: { children: ReactNode; tone?: keyof typeof CHIP }) {
  return <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ${CHIP[tone]}`}>{children}</span>
}

export const MAIN_BUTTON = 'inline-flex shrink-0 items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white hover:bg-accent/90 disabled:opacity-40'
export const SMALL_BUTTON = 'inline-flex shrink-0 items-center gap-1 rounded-md border border-gray-300 bg-white px-2 py-0.5 text-[11.5px] text-gray-700 hover:border-accent hover:text-accent disabled:opacity-50 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-200'

/** A section folded until opened (details on demand). */
export function Fold({ title, icon, count, children }: { title: string; icon?: ReactNode; count?: number; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <section aria-label={title} className="border-t border-gray-100 pt-3 dark:border-zinc-800">
      <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
        className="flex w-full items-center gap-1.5 text-[12.5px] font-semibold text-gray-700 hover:text-accent dark:text-zinc-200">
        {open ? <CaretDown size={12} /> : <CaretRight size={12} />}{icon}{title}
        {count !== undefined && <span className="font-normal text-gray-400">（{count}）</span>}
      </button>
      {open && <div className="pt-2.5">{children}</div>}
    </section>
  )
}

function when(at: string): string {
  const d = new Date(at)
  return Number.isNaN(d.getTime()) ? at : d.toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function HistoryFold({ lines }: { lines: RecordCardHistoryLine[] }) {
  if (lines.length === 0) return null
  return (
    <Fold title="経緯" icon={<ClockCounterClockwise size={13} className="text-gray-400" />} count={lines.length}>
      <ol className="ml-1.5 space-y-2 border-l border-gray-200 pl-4 dark:border-zinc-700">
        {lines.map((h, i) => <li key={i} className="text-[12.5px]"><span className="mr-2 text-[11px] tabular-nums text-gray-400">{when(h.at)}</span>{h.text}</li>)}
      </ol>
    </Fold>
  )
}

export function FieldsFold({ fields }: { fields: RecordCardField[] }) {
  if (fields.length === 0) return null
  return (
    <Fold title="ほかの項目" icon={<ListBullets size={13} className="text-gray-400" />} count={fields.length}>
      <dl className="grid grid-cols-[repeat(auto-fill,minmax(170px,1fr))] gap-2">
        {fields.map(f => (
          <div key={f.label} className="rounded-md border border-gray-200 px-2.5 py-1.5 dark:border-zinc-800">
            <dt className="text-[10.5px] text-gray-500">{f.label}</dt>
            <dd className="whitespace-pre-wrap break-words text-[12.5px]">{f.value}</dd>
          </div>
        ))}
      </dl>
    </Fold>
  )
}
