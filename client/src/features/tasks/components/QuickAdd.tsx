import { useRef, useState, type ReactNode } from 'react'
import { CalendarBlank, Hash, Plus, Sparkle, UserCircle } from '@phosphor-icons/react'
import type { BundleChoice, TaskCreateInput } from '../../../../shared/tasks'
import { useEventListener } from '../../../shared/hooks/useEventListener'
import { ThingIcon } from '../../../shared/ui/ThingIcon'
import { getBundleChoices } from '../api'
import { addDays, dueText, type CompanyNow } from '../model'
import { parseQuickAdd, similarTag, tagChoices } from '../quickAdd'
import { useTagSuggestions } from '../hooks/useTagSuggestions'

interface Props {
  companyId: string
  now: CompanyNow
  /** Tags in use in the list, most used first. */
  tagsInUse: string[]
  /** The member's id and the company's members, for 「担当」 (absent: the chip offers only 自分). */
  me?: string
  members?: Array<{ id: string; name: string }>
  /** The name of what a task belongs to when nothing is chosen yet (the department's kind: 案件, プロジェクト). */
  bundleWord?: string
  /** null = added; else the reason in words. */
  onAdd: (input: TaskCreateInput) => Promise<string | null>
}

type Picker = 'due' | 'who' | 'bundle' | 'whenDone'
const TIMES = ['09:00', '12:00', '15:00', '17:00']
const CHIP = 'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]'
const POP = 'absolute left-0 top-full z-40 mt-1 rounded-lg border border-gray-200 bg-white p-1.5 text-[12px] shadow-xl dark:border-zinc-700 dark:bg-zinc-800'
const POP_ROW = 'block w-full rounded px-2 py-1 text-left hover:bg-gray-100 dark:hover:bg-zinc-700'

/**
 * The list's one line (no window, owner 2026-11-02): while it has the focus, chips show under it —
 * ［期限］［担当］［〇〇］, plus ［終わったら］ once someone else is chosen (it is then 「頼む」). What
 * the line already says (「明日15時」, 「#営業」) is in the chips. Enter adds.
 */
export function QuickAdd({ companyId, now, tagsInUse, me, members = [], bundleWord = 'プロジェクト', onAdd }: Props) {
  const [line, setLine] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [focused, setFocused] = useState(false)
  const [open, setOpen] = useState<Picker | null>(null)
  const [pickedDue, setPickedDue] = useState<string | null>(null)
  const [assignee, setAssignee] = useState<string | null>(null)
  const [whenDone, setWhenDone] = useState<'notify' | 'check'>('notify')
  const [bundle, setBundle] = useState<BundleChoice | null>(null)
  const [bundles, setBundles] = useState<BundleChoice[] | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  useEventListener<MouseEvent>(document, 'mousedown', e => { if (!rootRef.current?.contains(e.target as Node)) setOpen(null) }, { enabled: open !== null })

  const draft = parseQuickAdd(line, now)
  const due = pickedDue ?? draft.due
  const choices = tagChoices(line, tagsInUse) ?? []
  const { suggestions, ask } = useTagSuggestions(companyId, tagsInUse)
  // Suggested for the title as typed, without the tags already on the line.
  const suggested = suggestions && suggestions.title === draft.title ? suggestions.tags.filter(t => !draft.tags.includes(t)) : []
  const type = (next: string) => { setLine(next); ask(parseQuickAdd(next, now).title) }
  const similar = draft.tags.map(t => ({ from: t, to: similarTag(t, tagsInUse) })).find(s => s.to !== null) ?? null
  const asking = !!assignee && assignee !== me
  const askedName = members.find(m => m.id === assignee)?.name ?? ''

  const reset = () => { type(''); setPickedDue(null); setAssignee(null); setWhenDone('notify'); setBundle(null); setOpen(null) }
  const add = async () => {
    if (!draft.title || busy) return
    setBusy(true)
    setError(null)
    try {
      const failure = await onAdd({
        title: draft.title, due, tags: draft.tags,
        ...(asking ? { assignee, whenDone } : {}),
        ...(bundle ? { bundleId: bundle.id } : {}),
      })
      if (failure) setError(failure)
      else reset()
    } finally {
      setBusy(false)
    }
  }
  const toggle = (p: Picker) => {
    setOpen(o => (o === p ? null : p))
    if (p === 'bundle' && bundles === null) {
      void getBundleChoices(companyId).then(r => setBundles(r.success ? r.bundles : []), () => setBundles([]))
    }
  }
  const replaceTag = (from: string, to: string) =>
    setLine(l => l.replace(new RegExp(`[#＃]${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$)`), `#${to}`))
  const chip = (p: Picker, on: boolean, children: ReactNode) => (
    <button type="button" data-quick-chip={p} aria-expanded={open === p} onMouseDown={e => e.preventDefault()} onClick={() => toggle(p)}
      className={`${CHIP} ${on ? 'border-accent/40 bg-accent/10 text-accent' : 'border-gray-200 text-gray-500 hover:border-accent hover:text-accent dark:border-zinc-700 dark:text-zinc-400'}`}>
      {children}
    </button>
  )
  const dayOf = (d: string | null) => d?.slice(0, 10) ?? now.date
  const timeOf = (d: string | null) => (d && d.length > 10 ? d.slice(11, 16) : null)

  return (
    <div ref={rootRef} className="flex-shrink-0 space-y-1.5 border-b border-gray-100 px-3 pb-1.5 pt-2 dark:border-zinc-800">
      <div className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-2 py-1 focus-within:border-accent dark:border-zinc-700">
        <Plus size={13} className="shrink-0 text-gray-400" />
        <input
          value={line}
          onChange={e => type(e.target.value)}
          onFocus={() => setFocused(true)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) void add() }}
          aria-label="やることを足す"
          placeholder={asking ? `${askedName}さんに頼む（例：見積を直す 明日15時まで）` : 'やることを足す（例：見積を直す 明日15時まで #営業）'}
          className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-gray-400"
        />
        {line && <span className="shrink-0 whitespace-nowrap text-[10px] text-gray-400">Enter で{asking ? '頼む' : '足す'}</span>}
      </div>
      {(focused || line) && (
        <div data-testid="quick-add-chips" className="flex flex-wrap items-center gap-1 text-[11px] text-gray-500 dark:text-zinc-400">
          <span className="relative">
            {chip('due', !!due, <><CalendarBlank size={11} />{due ? `期限 ${dueText(due, now)}` : '期限'}</>)}
            {open === 'due' && (
              <div className={`${POP} w-[220px] space-y-1.5`} data-quick-pop="due">
                <div className="flex flex-wrap gap-1">
                  {[['今日', now.date], ['明日', addDays(now.date, 1)], ['あさって', addDays(now.date, 2)]].map(([l, d]) => (
                    <button key={l} type="button" onClick={() => setPickedDue(timeOf(due) ? `${d}T${timeOf(due)}` : d)}
                      className={`rounded border px-1.5 ${dayOf(due) === d && due ? 'border-accent bg-accent text-white' : 'border-gray-200 hover:border-accent dark:border-zinc-700'}`}>{l}</button>
                  ))}
                  <input type="date" aria-label="日付" value={due ? dayOf(due) : ''} onChange={e => { if (e.target.value) setPickedDue(timeOf(due) ? `${e.target.value}T${timeOf(due)}` : e.target.value) }}
                    className="rounded border border-gray-200 bg-transparent px-1 text-[11px] dark:border-zinc-700" />
                </div>
                <div className="flex flex-wrap items-center gap-1"><span className="text-[10.5px] text-gray-500">時刻</span>
                  {TIMES.map(t => (
                    <button key={t} type="button" onClick={() => { setPickedDue(`${dayOf(due)}T${t}`); setOpen(null) }}
                      className={`rounded border px-1 text-[10.5px] ${timeOf(due) === t ? 'border-accent text-accent' : 'border-gray-200 hover:border-accent dark:border-zinc-700'}`}>{t}</button>
                  ))}
                  {pickedDue && <button type="button" onClick={() => { setPickedDue(null); setOpen(null) }} className="ml-auto text-[10.5px] text-gray-500 hover:text-accent">選び直す</button>}
                </div>
              </div>
            )}
          </span>
          <span className="relative">
            {chip('who', asking, <><UserCircle size={11} />{asking ? `${askedName}さんに頼む` : '担当 自分'}</>)}
            {open === 'who' && (
              <div className={`${POP} max-h-[240px] w-[180px] overflow-y-auto`} data-quick-pop="who">
                <button type="button" className={POP_ROW} onClick={() => { setAssignee(null); setOpen(null) }}>自分</button>
                {members.filter(m => m.id !== me).map(m => (
                  <button key={m.id} type="button" data-quick-person={m.name} className={POP_ROW} onClick={() => { setAssignee(m.id); setOpen(null) }}>{m.name}さん</button>
                ))}
              </div>
            )}
          </span>
          <span className="relative">
            {chip('bundle', !!bundle, <><ThingIcon kind="bundle" typeLabel={bundle?.typeLabel ?? bundleWord} size={11} />{bundle ? bundle.title : bundleWord}</>)}
            {open === 'bundle' && (
              <div className={`${POP} max-h-[240px] w-[220px] overflow-y-auto`} data-quick-pop="bundle">
                <button type="button" className={POP_ROW} onClick={() => { setBundle(null); setOpen(null) }}>{bundleWord}なし</button>
                {bundles === null && <p className="px-2 py-1 text-gray-400">読み込んでいます</p>}
                {bundles?.map(b => (
                  <button key={b.id} type="button" className={`${POP_ROW} flex items-center gap-1.5`} onClick={() => { setBundle(b); setOpen(null) }}>
                    <ThingIcon kind="bundle" typeLabel={b.typeLabel} size={12} /><span className="truncate">{b.title}</span>
                  </button>
                ))}
              </div>
            )}
          </span>
          {asking && (
            <span className="relative">
              {chip('whenDone', true, <>終わったら：{whenDone === 'notify' ? '知らせるだけ' : '確かめてから'}</>)}
              {open === 'whenDone' && (
                <div className={`${POP} w-[220px]`} data-quick-pop="whenDone">
                  {([['notify', '知らせるだけ', `${askedName}さんが完了にしたら知らせが届きます`], ['check', '確かめてから', 'あなたの OK で完了になります']] as const).map(([k, l, h]) => (
                    <button key={k} type="button" className={POP_ROW} onClick={() => { setWhenDone(k); setOpen(null) }}>
                      <span className="block">{l}</span><span className="block text-[10px] text-gray-500">{h}</span>
                    </button>
                  ))}
                </div>
              )}
            </span>
          )}
          {draft.tags.map(t => <span key={t} className={`${CHIP} border-gray-200 text-gray-600 dark:border-zinc-700 dark:text-zinc-300`}><Hash size={10} />{t}</span>)}
          {choices.length > 0 && (
            <span className="inline-flex items-center gap-1">今あるタグ：{choices.map(t => (
              <button key={t} type="button" onClick={() => setLine(l => l.replace(/[#＃][^\s#＃]*$/, `#${t} `))} className="rounded border border-gray-200 px-1 hover:border-accent hover:text-accent dark:border-zinc-700">#{t}</button>
            ))}</span>
          )}
          {suggested.length > 0 && (
            <span className="inline-flex items-center gap-1" aria-label="タグの候補">
              <Sparkle size={10} weight="fill" className="text-accent" />タグの候補：{suggested.map(t => (
                <button key={t} type="button" onClick={() => setLine(l => `${l.trimEnd()} #${t} `)} className="rounded border border-accent/40 px-1 text-accent hover:bg-accent/10">#{t}</button>
              ))}
            </span>
          )}
          {similar && (
            <span className="inline-flex items-center gap-1 rounded bg-accent/10 px-1.5 py-px text-accent">
              <Sparkle size={10} weight="fill" />「#{similar.from}」は今ある「#{similar.to}」と同じですか？
              <button type="button" onClick={() => replaceTag(similar.from, similar.to!)} className="underline">#{similar.to} にする</button>
            </span>
          )}
          {line && !asking && <span className="text-gray-400">あなただけに見えます</span>}
        </div>
      )}
      {error && <p role="alert" className="text-[11px] text-red-600 dark:text-red-400">{error}</p>}
    </div>
  )
}
