// ACB foundation: 「つながっているもの」 (the right column of every record), used by the records and
// tasks features, which may not import each other.
import { useState, type DragEvent, type ReactNode } from 'react'
import { LinkSimple } from '@phosphor-icons/react'
import { CALM, type ThingKind } from '../../../shared/thing-words'
import { foldLinks, groupLinks } from '../lib/linkGroups'
import { MoreMenu, type MoreMenuItem } from './MoreMenu'
import { ThingIcon } from './ThingIcon'

/** One thing in 「つながっているもの」: a record, a file or a consultation. */
export interface LinkedRow {
  key: string
  /** The kind's plain name (`thingName`): rows with the same name form one group. */
  name: string
  kind: ThingKind
  label: string
  sub?: string
  /** Finished: drawn faint and struck through. */
  done?: boolean
  marks?: ReactNode
  onOpen?: () => void
  /** One small button that does the next thing (［確かめて送る］). */
  act?: ReactNode
  /** The row's 「…」; none for where the record came from (出どころ), which is history. */
  menu?: MoreMenuItem[]
}

/** A group shown even while empty, with what adds to it (［＋ファイルをつなぐ］, ［相談する］). */
export interface LinkedGroupExtra {
  name: string
  kind: ThingKind
  action: ReactNode
  note?: string
}

export interface LinkedDrop {
  /** 「ここにファイルをドロップしてつなぐ」 */
  label: string
  accepts: (e: DragEvent) => boolean
  onDrop: (e: DragEvent) => void
}

/**
 * The right column of every record (言葉の決まり 3b, 5.): a table of contents of what is linked
 * directly, one group per kind, three rows each and the rest under 「ほか n 件」.
 */
export function LinkedColumn({ rows, extras = [], first, drop, notice }: {
  rows: LinkedRow[]
  extras?: LinkedGroupExtra[]
  /** The kind put at the top (a 案件's やること). */
  first?: ThingKind
  drop?: LinkedDrop
  /** 「…とのつながりを外しました［取り消す］」 and the like. */
  notice?: ReactNode
}) {
  const [opened, setOpened] = useState<string[]>([])
  const [over, setOver] = useState(false)
  const all: Array<LinkedRow | { key: string; name: string; kind: ThingKind; placeholder: true }> = [
    ...rows,
    ...extras.filter(x => !rows.some(r => r.name === x.name)).map(x => ({ key: `extra:${x.name}`, name: x.name, kind: x.kind, placeholder: true as const })),
  ]
  const groups = groupLinks(all, first).map(g => ({
    ...g, items: g.items.filter((i): i is LinkedRow => !('placeholder' in i)), extra: extras.find(x => x.name === g.title),
  }))
  const dropProps = drop ? {
    onDragOver: (e: DragEvent) => { if (drop.accepts(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'link'; setOver(true) } },
    onDragLeave: (e: DragEvent) => { if (e.currentTarget === e.target) setOver(false) },
    onDrop: (e: DragEvent) => { setOver(false); if (drop.accepts(e)) { e.preventDefault(); drop.onDrop(e) } },
  } : {}
  return (
    <aside aria-label="つながっているもの" {...dropProps}
      className={`space-y-3.5 rounded-lg ${over ? '-m-1.5 bg-accent/5 p-1.5 outline-dashed outline-2 outline-accent' : ''}`}>
      <h2 className="flex items-center gap-1.5 text-[12.5px] font-semibold text-gray-700 dark:text-zinc-200"><LinkSimple size={13} />つながっているもの</h2>
      {notice}
      {groups.length === 0 && <p className="text-[11px] text-gray-400">{CALM.emptyLinks}</p>}
      {groups.map(g => {
        const isOpen = opened.includes(g.title)
        const { shown, more } = foldLinks(g.items, isOpen)
        const typeLabel = g.kind === 'bundle' ? g.title : undefined
        return (
          <section key={g.title} aria-label={g.title}>
            <h3 className="mb-0.5 flex items-center gap-1.5 text-[11.5px] font-semibold text-gray-500 dark:text-zinc-400">
              <ThingIcon kind={g.kind} typeLabel={typeLabel} label="" size={13} />{g.title}{g.items.length > 0 && <span className="font-normal">（{g.items.length}）</span>}
            </h3>
            <ul>{shown.map(r => <Row key={r.key} row={r} typeLabel={typeLabel} />)}</ul>
            {(more > 0 || (isOpen && g.items.length > 3)) && (
              <button type="button" onClick={() => setOpened(o => (isOpen ? o.filter(k => k !== g.title) : [...o, g.title]))}
                className="ml-2 text-[11px] text-gray-500 hover:text-accent">
                {isOpen ? 'たたむ' : `ほか ${more} 件`}
              </button>
            )}
            {g.extra?.action}
            {g.extra?.note && <p className="px-2 pt-0.5 text-[10.5px] text-gray-400">{g.extra.note}</p>}
          </section>
        )
      })}
      {drop && (
        <div className={`rounded-md border border-dashed px-2 py-2 text-center text-[11px] ${over ? 'border-accent text-accent' : 'border-gray-300 text-gray-400 dark:border-zinc-700'}`}>
          {over ? 'ここに落とすと、つながります' : drop.label}
        </div>
      )}
    </aside>
  )
}

function Row({ row, typeLabel }: { row: LinkedRow; typeLabel?: string }) {
  return (
    <li className="group/link flex items-start">
      <button type="button" onClick={row.onOpen} disabled={!row.onOpen}
        className="min-w-0 flex-1 rounded-md px-2 py-1 text-left hover:bg-gray-100 disabled:hover:bg-transparent dark:hover:bg-zinc-800">
        <span className="flex min-w-0 items-center gap-1.5 text-[12px]">
          <ThingIcon kind={row.kind} typeLabel={typeLabel} label="" size={12} />
          <span className={`min-w-0 truncate ${row.done ? 'text-gray-400 line-through' : row.onOpen ? 'text-accent' : 'text-gray-700 dark:text-zinc-200'}`}>{row.label}</span>
          {row.marks}
        </span>
        {row.sub && <span className="block truncate pl-[18px] text-[10.5px] text-gray-500 dark:text-zinc-400">{row.sub}</span>}
      </button>
      {row.act}
      {row.menu && row.menu.length > 0 && (
        <span className="mt-0.5 opacity-0 focus-within:opacity-100 group-hover/link:opacity-100">
          <MoreMenu compact label={`「${row.label}」の操作`} items={row.menu} />
        </span>
      )}
    </li>
  )
}
