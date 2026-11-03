// 探す, the left tab (never 「検索」; owner-approved redesign 2026-11-03, records.md "探す"): ⌘K opens
// what you can name, this tab is for what you only half remember. Kept whole (~300 lines): the box,
// its narrowing and the list change together.
import { useMemo, useRef, useState } from 'react'
import { Command, Globe, MagnifyingGlass, UserCircle, X } from '@phosphor-icons/react'
import type { BundleKindsResult } from '../../../../../shared/types/records'
import type { ConsultationTopic } from '../../../../shared/consultation-topics'
import { CALM } from '../../../../shared/thing-words'
import { runCommand } from '../../../shared/commands/commands'
import { ThingIcon } from '../../../shared/ui/ThingIcon'
import {
  chipsOf, classify, consultationsOf, consultWhy, foundCount, foundThings, kindKey, lineOf, localDay, onlyKind, withTopics,
  type FindConsultation, type FindFilters, type Found, type FoundThing, type Period,
} from '../find'
import { useFindHome } from '../hooks/useFindHome'
import { useFindSearch } from '../hooks/useFindSearch'
import type { PaletteRecent } from '../model'
import { FindEmpty } from './FindEmpty'
import { HitRow, Section, SummaryCard, type FoundRowActions } from './FoundRows'

interface SearchPanelProps {
  rootPath: string
  /** Records are found with the member's session (what they may read); none without a company. */
  companyId?: string
  /** The department on screen ('' = 全社): the scope starts there. */
  departmentFolder: string
  /** Department folder → its name on screen. */
  departmentNames?: Readonly<Record<string, string>>
  inputRef?: React.RefObject<HTMLInputElement>
  /** A file opens in a tab in the middle (at that line); records open through `record.open`. */
  onOpenFile: (filePath: string, line?: number) => void
  onOpenConsultation?: (sessionId: string) => void
  /** This PC's 「AIへの相談」 (titles and the record each was started from). */
  loadConsultations?: () => Promise<FindConsultation[]>
  /** What each consultation is about, by topic record id (shared with 「AIへの相談」; unreadable = null). */
  consultationTopics?: ReadonlyMap<string, ConsultationTopic | null>
  /** 「最近開いたもの」: the tabs open in the middle, newest first. */
  recent?: readonly PaletteRecent[]
  /** What the department on screen calls its 案件・プロジェクト. */
  bundleWord?: string
  bundleKinds?: BundleKindsResult | null
  activeRecordId?: string | null
  /** Folders not downloaded on this computer (company paths): their files are not searched. */
  notDownloaded?: readonly string[]
}

const DEBOUNCE_MS = 250
const pill = (on: boolean) =>
  `inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] whitespace-nowrap transition-colors ${on
    ? 'border-accent bg-accent/10 text-accent'
    : 'border-gray-200 dark:border-zinc-700 text-gray-600 dark:text-zinc-300 hover:border-accent'}`
const PERIODS: Record<Period, string> = { week: '1週間', month: '1か月', all: 'いつでも' }
const under = (folder: string, p: string) => folder === '' || p === folder || p.startsWith(`${folder}/`) || folder.startsWith(`${p}/`)

export function SearchPanel(props: SearchPanelProps) {
  const { rootPath, companyId, departmentFolder, inputRef, onOpenFile, bundleWord = 'プロジェクト', activeRecordId } = props
  const [text, setText] = useState('')
  const [period, setPeriod] = useState<Period>('all')
  const [mineOnly, setMineOnly] = useState(false)
  const [wide, setWide] = useState(false)
  const [chip, setChip] = useState<string | null>(null)
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  const [hubConsults, setHubConsults] = useState<string | null>(null)
  const composing = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout>>()
  const localRef = useRef<HTMLInputElement>(null)
  const ref = inputRef ?? localRef
  const listRef = useRef<HTMLDivElement>(null)
  const search = useFindSearch({ rootPath, companyId, loadConsultations: props.loadConsultations })
  const home = useFindHome(companyId)
  const today = localDay(new Date())

  const dept = departmentFolder || null
  const scope = dept === null || wide ? null : dept
  const grepFolder = scope ?? ''
  const run = (q: string, folder = grepFolder) => {
    setChip(null); setOpen(new Set()); setHubConsults(null)
    if (listRef.current) listRef.current.scrollTop = 0
    void search.run(q, folder, today)
  }
  // Another department on screen: the scope starts there again, and the words are searched there.
  const [shownDept, setShownDept] = useState(departmentFolder)
  if (shownDept !== departmentFolder) {
    setShownDept(departmentFolder)
    setWide(false)
    if (text.trim()) void search.run(text, departmentFolder, today)
  }
  const setScopeWide = (w: boolean) => { setWide(w); if (text.trim()) run(text, w || !dept ? '' : dept) }
  // Live: ~250 ms after the last key, never while a word is still being converted (IME).
  const typed = (v: string) => {
    setText(v)
    clearTimeout(timer.current)
    if (composing.current) return
    timer.current = setTimeout(() => run(v), v.trim() ? DEBOUNCE_MS : 0)
  }
  const clear = () => { clearTimeout(timer.current); setText(''); run(''); ref.current?.focus() }

  const st = search.state
  const q = st?.query ?? ''
  const consultations = useMemo(() => withTopics(st?.consultations ?? [], props.consultationTopics), [st?.consultations, props.consultationTopics])
  const things = useMemo(() => (st ? foundThings({
    query: st.query, hits: st.hits, hubs: st.hubs, files: st.files, lines: st.lines, fileTimes: st.fileTimes,
    consultations, bundleKinds: props.bundleKinds,
  }) : []), [st, consultations, props.bundleKinds])
  const filters: FindFilters = { scope, period, mineOnly, today }
  const found = classify(things, st?.hubs ?? [], q, filters)
  const elsewhere = scope === null ? 0 : foundCount(classify(things, st?.hubs ?? [], q, { ...filters, scope: null })) - foundCount(found)
  const chips = chipsOf(found)
  const shownChip = chip && chips.some(c => c.key === chip) ? chip : null
  const hubById = new Map((st?.hubs ?? []).map(h => [h.id, h]))
  const consultsOf = (t: FoundThing) => consultationsOf(t, consultations, t.recordId ? hubById.get(t.recordId) : undefined)
  const hub = hubConsults ? found.cards.find(c => c.recordId === hubConsults) ?? null : null
  const hubList = hub ? consultsOf(hub) : []
  const view: Found = hub ? { cards: [hub], byName: [], byContent: [] } : onlyKind(found, shownChip)
  const count = hub ? hubList.length : foundCount(view)
  const searching = text.trim().length > 0
  const pendingWords = text.trim() !== q || (st?.pending ?? 0) > 0
  const nameOf = (folder: string | null) => (folder === null ? '全社' : props.departmentNames?.[folder] ?? folder)
  const notOnDisk = (props.notDownloaded ?? []).some(p => under(grepFolder, p))

  const actions: FoundRowActions = {
    open: (t, words) => {
      if (t.recordId) void runCommand('record.open', { recordId: t.recordId }).catch(() => {})
      else if (t.sessionId) props.onOpenConsultation?.(t.sessionId)
      else if (t.path) onOpenFile(`${rootPath}/${t.path}`, t.lines && t.lines.length > 0 ? lineOf(t, words) : undefined)
    },
    openConsultation: id => props.onOpenConsultation?.(id),
    consultationsOf: consultsOf,
    activeRecordId,
    department: dept,
    departmentName: nameOf,
    today,
    rootPath,
  }
  const consultRow = (c: FindConsultation): FoundThing => {
    const rec = c.linked ? things.find(t => t.recordId === c.linked!.id) : undefined
    return { key: `consultation:${c.id}`, kind: 'consultation', title: c.title, department: rec?.department ?? null, at: c.updatedAt, mine: true, sessionId: c.id, ...(c.linked ? { why: consultWhy(c.linked.kindName, c.linked.title) } : {}) }
  }

  return (
    <div className="h-full flex flex-col min-w-0" data-find-panel>
      <div className="flex-shrink-0 space-y-2 px-3 py-3 border-b border-gray-200 dark:border-zinc-800/50">
        <div className="relative">
          <MagnifyingGlass size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 dark:text-zinc-500" />
          <input
            ref={ref}
            type="text"
            aria-label="探す"
            value={text}
            onChange={e => typed(e.target.value)}
            onCompositionStart={() => { composing.current = true }}
            onCompositionEnd={e => { composing.current = false; typed(e.currentTarget.value) }}
            onKeyDown={e => {
              if (e.key === 'Escape') { e.preventDefault(); clear() }
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); clearTimeout(timer.current); run(text) }
            }}
            placeholder="覚えている言葉で探す"
            className="w-full pl-8 pr-8 py-1.5 text-xs rounded-md border border-gray-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-gray-800 dark:text-zinc-200 placeholder:text-gray-400 dark:placeholder:text-zinc-500 focus:outline-none focus:border-accent"
          />
          {text && (
            <button type="button" aria-label="消す" onClick={clear}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-gray-200 dark:hover:bg-zinc-700 text-gray-400 dark:text-zinc-500">
              <X size={11} />
            </button>
          )}
        </div>

        {searching ? <>
          <div className="flex items-center gap-1.5 text-[11px] text-gray-500 dark:text-zinc-400" data-scope>
            {scope === null ? <Globe size={12} /> : <MagnifyingGlass size={12} />}
            <span><span className="font-medium text-gray-700 dark:text-zinc-200">{scope === null ? '全社' : `${nameOf(scope)}の中`}</span>で {count}件</span>
            {dept !== null && (
              <button type="button" onClick={() => setScopeWide(!wide)} className={`ml-auto ${pill(wide)}`} aria-pressed={wide}>
                <Globe size={11} />{wide ? `${nameOf(dept)}の中だけ` : '全社で探す'}
              </button>
            )}
          </div>
          <div className="flex items-center gap-1" role="group" aria-label="期間と自分">
            {(['week', 'month', 'all'] as const).map(p => (
              <button key={p} type="button" aria-pressed={period === p} onClick={() => setPeriod(p)} className={pill(period === p)}>{PERIODS[p]}</button>
            ))}
            <span className="w-px h-3.5 bg-gray-200 dark:bg-zinc-700 mx-0.5" />
            <button type="button" aria-pressed={mineOnly} onClick={() => setMineOnly(m => !m)} className={pill(mineOnly)}>
              <UserCircle size={11} weight={mineOnly ? 'fill' : 'regular'} />自分が関わった
            </button>
          </div>
          {hub ? (
            <div className="flex items-center gap-1">
              <span className={pill(true)}>
                <ThingIcon kind="consultation" size={11} />「{hub.title}」の AIへの相談
                <button type="button" aria-label="絞り込みをやめる" onClick={() => setHubConsults(null)} className="ml-0.5 rounded-full hover:bg-accent/20"><X size={10} /></button>
              </span>
            </div>
          ) : chips.length > 1 && (
            <div role="group" aria-label="種類で絞る" className="flex flex-wrap gap-1">
              {chips.map(c => {
                const on = shownChip === c.key
                const [k, label] = c.key.split(':')
                return (
                  <button key={c.key} type="button" data-find-chip={c.key} aria-pressed={on} onClick={() => setChip(on ? null : c.key)} className={pill(on)}>
                    <ThingIcon kind={k as FoundThing['kind']} typeLabel={label} size={11} />{c.label}<span className="text-gray-400">{c.count}</span>
                  </button>
                )
              })}
            </div>
          )}
        </> : (
          <p className="flex items-center gap-1 text-[10px] text-gray-400 dark:text-zinc-500">
            名前が分かっているものは <kbd className="inline-flex items-center rounded border border-gray-200 dark:border-zinc-700 px-1 font-sans"><Command size={9} />K</kbd> ですぐ開けます
          </p>
        )}
      </div>

      <div ref={listRef} className={`flex-1 overflow-auto ${pendingWords ? 'opacity-60' : ''} transition-opacity`} aria-busy={pendingWords}>
        {!searching ? (
          <FindEmpty recent={props.recent ?? []} bundles={home?.bundles ?? null} meetings={home?.meetings ?? null} bundleWord={bundleWord} today={today}
            activeRecordId={activeRecordId} onOpenRecord={id => { void runCommand('record.open', { recordId: id }).catch(() => {}) }} onOpenFile={p => onOpenFile(`${rootPath}/${p}`)} />
        ) : !st || (count === 0 && pendingWords) ? (
          <p className="px-4 py-8 text-center text-xs text-gray-400 dark:text-zinc-500">{CALM.loading}</p>
        ) : count === 0 ? (
          <div className="px-4 py-8 text-center text-xs text-gray-400 dark:text-zinc-500 space-y-3" data-not-found>
            <p>{CALM.notFound}</p>
            {elsewhere > 0 && <button type="button" onClick={() => setScopeWide(true)} className={pill(false)}><Globe size={11} />全社で探すと {elsewhere}件</button>}
            {(period !== 'all' || mineOnly) && <button type="button" onClick={() => { setPeriod('all'); setMineOnly(false) }} className={`ml-1 ${pill(false)}`}>期間と「自分」を外す</button>}
          </div>
        ) : <>
          {view.cards.length > 0 && (
            <div className="px-2 pt-2 space-y-1.5" aria-label="相手と案件">
              {view.cards.map(c => (
                <SummaryCard key={c.key} t={c} hub={hubById.get(c.recordId!)!} q={q} bundleWord={bundleWord} consults={consultsOf(c).length} a={actions}
                  consultsOn={hubConsults === c.recordId} onConsults={() => setHubConsults(h => (h === c.recordId ? null : c.recordId!))} />
              ))}
            </div>
          )}
          {hub && (
            <section className="pt-2" aria-label="この相談" data-section="hub-consults">
              <h3 className="px-3 pt-1 pb-0.5 text-[11px] font-semibold text-gray-500 dark:text-zinc-400">「{hub.title}」の AIへの相談<span className="ml-1 font-normal text-gray-400">{hubList.length}</span></h3>
              {hubList.map(c => <HitRow key={c.id} t={consultRow(c)} q="" a={actions} />)}
            </section>
          )}
          <Section id="name" title="名前で見つかったもの" list={view.byName} q={q} open={open} setOpen={setOpen} a={actions} />
          <Section id="content" title="中身で見つかったもの" list={view.byContent} q={q} open={open} setOpen={setOpen} a={actions} />
          {!hub && scope !== null && elsewhere > 0 && (
            <button type="button" onClick={() => setScopeWide(true)} data-elsewhere
              className="w-full flex items-center gap-1.5 px-3 py-3 text-[11px] text-gray-500 dark:text-zinc-400 hover:text-accent border-t border-gray-100 dark:border-zinc-800">
              <Globe size={12} />ほかの部署にも {elsewhere}件 あります（全社で探す）
            </button>
          )}
        </>}
        {searching && st && (
          <div className="px-3 pb-3 space-y-0.5 text-[10px] text-gray-400 dark:text-zinc-500" data-find-notes>
            {st.recordsFailed && <p>{st.recordsFailed}</p>}
            {st.filesFailed && <p>ファイルの中は探せませんでした</p>}
            {st.linesTruncated && (shownChip === null || shownChip === kindKey({ kind: 'file' })) && <p>ファイルの中に見つかったところが多いため、一部だけ出しています。言葉を増やすと絞れます</p>}
            {notOnDisk && <p>ダウンロードしていないフォルダのファイルは探していません</p>}
          </div>
        )}
      </div>
    </div>
  )
}
