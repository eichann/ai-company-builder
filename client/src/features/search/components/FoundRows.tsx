// The rows of 探す: a 相手 / 案件's summary card, a section of things grouped by kind (top 3 each,
// 「ほか N件」), one row per thing with its best sentence, and a やること / 案件's consultations folded
// under it. Props in, JSX out; opening goes through the callbacks.
import { useState, type DragEvent, type ReactNode } from 'react'
import { FILE_PATHS_DRAG_TYPE, LINK_EFFECT_ALLOWED, startConsultationDrag, startRecordDrag } from '../../../shared/lib/dragTypes'
import { ArrowsOutSimple, CaretDown, CaretRight, LinkSimple } from '@phosphor-icons/react'
import { foldAsciiCase } from '../../../../../shared/core/paths'
import type { RecordFindHub } from '../../../../../shared/types/records'
import { getFileIcon } from '../../../shared/ui/fileIcon'
import { ThingIcon } from '../../../shared/ui/ThingIcon'
import {
  dateWords, foldWords, groupByKind, hubCounts, kindLabel, kindLook, sentenceOf, shortDate, whereOf,
  type FindConsultation, type FoundThing,
} from '../find'

const TOP = 3

/** The text with each match marked (A–Z folded). */
export function Marked({ text, q }: { text: string; q: string }) {
  const w = foldWords(q)
  if (!w) return <>{text}</>
  const ft = foldAsciiCase(text)
  const out: ReactNode[] = []
  let at = 0
  for (let i = ft.indexOf(w); i >= 0; i = ft.indexOf(w, i + w.length)) {
    out.push(text.slice(at, i), <mark key={i} className="bg-amber-200/80 dark:bg-amber-400/30 text-inherit rounded-sm px-px">{text.slice(i, i + w.length)}</mark>)
    at = i + w.length
  }
  out.push(text.slice(at))
  return <>{out}</>
}

/** A long sentence starts shortly before the match, so the match shows in the narrow column. */
function aroundMatch(s: string, q: string): string {
  const i = foldAsciiCase(s).indexOf(foldWords(q))
  return i > 22 ? '…' + s.slice(i - 14) : s
}

export function FoundIcon({ t, size = 14 }: { t: Pick<FoundThing, 'kind' | 'typeLabel' | 'title'>; size?: number }) {
  if (t.kind === 'file') { const I = getFileIcon(t.title, false); return <I size={size} className="shrink-0" /> }
  return <ThingIcon kind={t.kind} typeLabel={t.typeLabel} size={size} />
}

export interface FoundRowActions {
  open: (t: FoundThing, q: string) => void
  openConsultation: (sessionId: string) => void
  /** The consultations folded under a やること / 案件 row. */
  consultationsOf: (t: FoundThing) => FindConsultation[]
  activeRecordId?: string | null
  /** The department on screen (null = 全社): rows of another get its name. */
  department: string | null
  departmentName: (folder: string | null) => string
  today: string
  /** The company folder: a found file is dragged by its full path, as the file tree does. */
  rootPath: string
}

/** A found thing dragged onto a record's 「つながっているもの」 links it (owner decision 2026-11-03). */
function startDrag(t: FoundThing, a: FoundRowActions, e: DragEvent): void {
  if (t.recordId) startRecordDrag(e.dataTransfer, { id: t.recordId, title: t.title })
  else if (t.sessionId) startConsultationDrag(e.dataTransfer, { sessionId: t.sessionId, title: t.title, ...(t.topicRecordId ? { topicRecordId: t.topicRecordId } : {}) })
  else if (t.path) {
    e.dataTransfer.setData(FILE_PATHS_DRAG_TYPE, JSON.stringify([`${a.rootPath}/${t.path}`]))
    e.dataTransfer.effectAllowed = LINK_EFFECT_ALLOWED
  }
}

export function SummaryCard({ t, hub, q, bundleWord, consults, consultsOn, onConsults, a }: {
  t: FoundThing; hub: RecordFindHub; q: string; bundleWord: string; consults: number; consultsOn: boolean; onConsults: () => void; a: FoundRowActions
}) {
  const counts = hubCounts(hub, bundleWord, consults)
  const active = a.activeRecordId === t.recordId
  return (
    <div role="button" tabIndex={0} onClick={() => a.open(t, q)} onKeyDown={e => { if (e.key === 'Enter') a.open(t, q) }} data-summary-card={t.recordId} draggable onDragStart={e => startDrag(t, a, e)}
      className={`w-full text-left rounded-lg border px-2.5 py-2 transition-colors cursor-pointer ${active ? 'border-accent bg-accent/5' : 'border-gray-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 hover:border-accent/60 hover:bg-gray-50 dark:hover:bg-zinc-800/60'}`}>
      <span className="flex items-center gap-1.5">
        <FoundIcon t={t} size={16} />
        <span className={`flex-1 min-w-0 truncate text-[13px] font-semibold ${t.finished ? 'text-gray-400' : 'text-gray-800 dark:text-zinc-100'}`}><Marked text={t.title} q={q} /></span>
        <span className="shrink-0 rounded bg-gray-100 dark:bg-zinc-800 px-1.5 py-px text-[10px] text-gray-500 dark:text-zinc-400">{t.finished ? `${t.typeLabel}・終わった` : t.typeLabel}</span>
      </span>
      {counts.length > 0 && (
        <span className="mt-1 block text-[11px] text-gray-600 dark:text-zinc-300">
          {counts.map((c, i) => <span key={c.label}>{i > 0 && '・'}{c.label === '相談'
            ? <button type="button" data-card-consults aria-pressed={consultsOn} title="この相談だけを並べる"
                onClick={e => { e.stopPropagation(); onConsults() }}
                className={`rounded px-0.5 underline decoration-dotted underline-offset-2 ${consultsOn ? 'bg-accent/15 text-accent' : 'text-accent hover:bg-accent/10'}`}>{c.label} {c.n}</button>
            : `${c.label} ${c.n}`}</span>)}
        </span>
      )}
      <span className="mt-0.5 flex items-center gap-1.5 text-[10px] text-gray-400 dark:text-zinc-500">
        {t.department !== a.department && <span className="rounded bg-gray-100 dark:bg-zinc-800 px-1">{a.departmentName(t.department)}</span>}
        <span className="truncate">{hub.nextMeetingAt ? `次の会議 ${dateWords(hub.nextMeetingAt)}` : hub.lastMovedAt ? `最後の動き ${shortDate(hub.lastMovedAt, a.today)}` : ''}</span>
        <span className="ml-auto inline-flex items-center gap-0.5 text-accent shrink-0">開く<ArrowsOutSimple size={10} /></span>
      </span>
    </div>
  )
}

export function Section({ id, title, list, q, open, setOpen, a }: {
  id: string; title: string; list: FoundThing[]; q: string; open: ReadonlySet<string>; setOpen: (s: ReadonlySet<string>) => void; a: FoundRowActions
}) {
  if (list.length === 0) return null
  return (
    <section className="pt-2" aria-label={title} data-section={id}>
      <h3 className="px-3 pt-1 pb-0.5 text-[11px] font-semibold text-gray-500 dark:text-zinc-400">{title}<span className="ml-1 font-normal text-gray-400">{list.length}</span></h3>
      {groupByKind(list).map(g => {
        const key = `${id}:${g.key}`
        const expanded = open.has(key)
        const look = kindLook(g.key)
        return (
          <div key={g.key} className="pb-1" data-group={g.key}>
            <div className="flex items-center gap-1 px-3 pt-1.5 pb-0.5 text-[10px] text-gray-400 dark:text-zinc-500">
              <ThingIcon kind={look.kind} typeLabel={look.typeLabel} size={11} />{kindLabel(g.key, g.items)}<span>{g.items.length}</span>
            </div>
            {(expanded ? g.items : g.items.slice(0, TOP)).map(t => <HitRow key={t.key} t={t} q={q} a={a} />)}
            {g.items.length > TOP && (
              <button type="button" data-more={key} onClick={() => { const n = new Set(open); if (expanded) n.delete(key); else n.add(key); setOpen(n) }}
                className="flex items-center gap-0.5 pl-[34px] pr-3 py-0.5 text-[11px] text-accent hover:underline">
                {expanded ? <><CaretDown size={10} />少なくする</> : <><CaretRight size={10} />ほか {g.items.length - TOP}件</>}
              </button>
            )}
          </div>
        )
      })}
    </section>
  )
}

export function HitRow({ t, q, a }: { t: FoundThing; q: string; a: FoundRowActions }) {
  const sentence = q ? sentenceOf(t, q) : null
  // No sentence holds the words (a name hit): say where it lives instead.
  const where = whereOf(t)
  const active = !!t.recordId && a.activeRecordId === t.recordId
  const when = t.kind === 'meeting' && t.meetingAt ? shortDate(t.meetingAt, a.today) : shortDate(t.at, a.today)
  return (
    <div>
      <button type="button" onClick={() => a.open(t, q)} data-hit={t.key} draggable onDragStart={e => startDrag(t, a, e)}
        className={`w-full text-left flex items-start gap-2 px-3 py-1 ${active ? 'bg-accent/10' : 'hover:bg-gray-100 dark:hover:bg-white/[0.04]'}`}>
        <span className="pt-px"><FoundIcon t={t} /></span>
        <span className="flex-1 min-w-0">
          <span className="flex items-center gap-1.5">
            <span className={`flex-1 min-w-0 truncate text-[12px] ${t.finished ? 'text-gray-400 line-through' : 'text-gray-800 dark:text-zinc-200'}`} title={t.path ?? t.title}>
              <Marked text={t.title} q={q} />
            </span>
            {t.department !== a.department && (
              <span className="shrink-0 rounded bg-gray-100 dark:bg-zinc-800 px-1 text-[10px] text-gray-500 dark:text-zinc-400" data-other-department>{a.departmentName(t.department)}</span>
            )}
            {when && <span className="shrink-0 text-[10px] text-gray-400 tabular-nums">{when}</span>}
          </span>
          {t.why && <span className="flex items-center gap-1 text-[10px] text-accent min-w-0" data-why><LinkSimple size={10} className="shrink-0" /><span className="truncate"><Marked text={t.why} q={q} /></span></span>}
          {sentence
            ? <span className="block text-[11px] leading-[16px] text-gray-500 dark:text-zinc-400 line-clamp-2"><Marked text={aroundMatch(sentence, q)} q={q} /></span>
            : !t.why && where && <span className="block truncate text-[10px] text-gray-400 dark:text-zinc-500">{where}</span>}
        </span>
      </button>
      {(t.kind === 'task' || t.kind === 'minutes_check' || t.kind === 'bundle') && <ConsultsUnder t={t} a={a} />}
    </div>
  )
}

/** Under a やること / 案件 row: its AI consultations, folded to one small line until pressed. */
function ConsultsUnder({ t, a }: { t: FoundThing; a: FoundRowActions }) {
  const [shown, setShown] = useState(false)
  const list = a.consultationsOf(t)
  if (list.length === 0) return null
  return (
    <div className="pl-[34px] pr-3 pb-1" data-consults-under={t.recordId}>
      <button type="button" aria-expanded={shown} onClick={() => setShown(s => !s)}
        className="inline-flex items-center gap-1 rounded px-1 -ml-1 text-[11px] text-gray-500 dark:text-zinc-400 hover:text-accent hover:bg-accent/5">
        {shown ? <CaretDown size={10} /> : <CaretRight size={10} />}<ThingIcon kind="consultation" size={11} />AIへの相談 {list.length}
      </button>
      {shown && (
        <div className="mt-0.5 border-l border-gray-200 dark:border-zinc-700 ml-1">
          {list.map(c => (
            <button key={c.id} type="button" onClick={() => a.openConsultation(c.id)} data-consult={c.id} draggable
              onDragStart={e => startConsultationDrag(e.dataTransfer, { sessionId: c.id, title: c.title, ...(t.recordId ? { topicRecordId: t.recordId } : {}) })}
              className="w-full flex items-center gap-1.5 pl-2 pr-1 py-0.5 text-left text-[11px] text-gray-700 dark:text-zinc-300 hover:bg-gray-100 dark:hover:bg-white/[0.04] rounded-r">
              <span className="flex-1 min-w-0 truncate">{c.title}</span>
              <span className="shrink-0 text-[10px] text-gray-400 tabular-nums">{shortDate(c.updatedAt, a.today)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
