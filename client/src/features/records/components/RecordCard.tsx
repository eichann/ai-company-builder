import { CircleNotch, Clock, LinkSimple } from '@phosphor-icons/react'
import type { RecordCardLink, RecordCardView } from '../../../../shared/record-views'
import { useRecordCard } from '../hooks/useRecordCard'
import { groupByKind, kindTitle } from '../model'
import { FileLinkRow, RecordRow } from './RecordRows'

interface Props {
  companyId: string
  rootPath: string
  /** The caller keys this component by it. */
  recordId: string
}

function when(at: string): string {
  const d = new Date(at)
  return Number.isNaN(d.getTime()) ? at : d.toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/**
 * The one card every record opens in (design §7-3), read only: what it is, its fields, 経緯 and
 * 「つながっているもの」 to follow. Actions on a record come with its own screen (the task card).
 */
export function RecordCard({ companyId, rootPath, recordId }: Props) {
  const result = useRecordCard(companyId, recordId)
  if (result === null) {
    return <div className="h-full flex items-center justify-center gap-2 text-xs text-gray-400"><CircleNotch size={14} className="animate-spin" />読み込み中...</div>
  }
  if (!result.success) {
    return <div className="h-full flex items-center justify-center px-6 text-center text-sm text-gray-500 dark:text-zinc-400" role="alert">{result.error}</div>
  }
  return <CardBody card={result.card} rootPath={rootPath} />
}

function CardBody({ card, rootPath }: { card: RecordCardView; rootPath: string }) {
  const { record } = card
  return (
    <div className="flex flex-wrap gap-x-6 gap-y-5 p-5 text-gray-900 dark:text-zinc-100" data-testid="record-card">
      <article className="flex-1 min-w-[260px] space-y-5">
        <header className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-gray-500 dark:text-zinc-400">
            <span className="font-medium">{kindTitle(record.kind)}</span>
            {record.typeLabel !== kindTitle(record.kind) && <span>{record.typeLabel}</span>}
            {record.stateLabel && <span className="rounded-full bg-accent/10 px-2 py-px text-accent">{record.stateLabel}</span>}
          </div>
          <h1 className="text-xl font-bold leading-snug">{record.title}</h1>
          {record.summary && <p className="text-[13px] text-gray-600 dark:text-zinc-300 whitespace-pre-wrap">{record.summary}</p>}
        </header>
        {card.fields.length > 0 && (
          <dl className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-2">
            {card.fields.map(f => (
              <div key={f.label} className="rounded-md border border-gray-200 dark:border-zinc-800 px-2.5 py-1.5">
                <dt className="text-[10.5px] text-gray-500 dark:text-zinc-400">{f.label}</dt>
                <dd className="text-[12.5px] whitespace-pre-wrap break-words">{f.value}</dd>
              </div>
            ))}
          </dl>
        )}
        {card.history.length > 0 && (
          <section>
            <h2 className="flex items-center gap-1.5 text-[12px] font-semibold mb-2"><Clock size={13} className="text-accent" />経緯</h2>
            <ol className="ml-1.5 space-y-2 border-l border-gray-200 dark:border-zinc-700 pl-4">
              {card.history.map((h, i) => (
                <li key={i} className="text-[12.5px]">
                  <span className="tabular-nums text-[11px] text-gray-400 mr-2">{when(h.at)}</span>{h.text}
                </li>
              ))}
            </ol>
          </section>
        )}
      </article>
      <aside className="w-[240px] flex-shrink-0 space-y-3">
        <h2 className="flex items-center gap-1.5 text-[12px] font-semibold"><LinkSimple size={13} />つながっているもの</h2>
        <Links links={card.links} rootPath={rootPath} />
      </aside>
    </div>
  )
}

function Links({ links, rootPath }: { links: RecordCardLink[]; rootPath: string }) {
  const records = links.flatMap(l => (l.record ? [{ ...l.record, linkLabel: l.label }] : []))
  const files = links.filter(l => l.path !== undefined)
  if (records.length === 0 && files.length === 0) return <p className="text-[11px] text-gray-400">まだありません</p>
  return (
    <>
      {groupByKind(records).map(g => (
        <section key={g.kind}>
          <h3 className="text-[11px] font-semibold text-gray-500 dark:text-zinc-400 mb-1">{kindTitle(g.kind)}（{g.items.length}）</h3>
          <ul>{g.items.map(r => <li key={r.id}><RecordRow record={r} sub={r.linkLabel === r.typeLabel ? r.typeLabel : `${r.typeLabel}・${r.linkLabel}`} /></li>)}</ul>
        </section>
      ))}
      {files.length > 0 && (
        <section>
          <h3 className="text-[11px] font-semibold text-gray-500 dark:text-zinc-400 mb-1">ファイル（{files.length}）</h3>
          <ul>{files.map(f => <li key={f.path}><FileLinkRow rootPath={rootPath} path={f.path!} broken={f.broken} /></li>)}</ul>
        </section>
      )}
    </>
  )
}
