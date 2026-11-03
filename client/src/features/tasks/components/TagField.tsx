// The task card's 「タグ」 field (owner 2026-11-03, 使い心地のメモ #6: 「まともなものにして欲しい」): the tags
// as pills in the field (× takes one off), and — for who may set tags — a small popover anchored to
// it: a search box, the company's tags (most used first, ✓ on the task's own; ↑↓ Enter), 「『〇〇』を
// 作る」 when nothing matches, the AI's suggestions as one quiet row, and the 案件 hint as a quiet line.
// Each change is one `set_tags` with the whole list; the server decides.
import { useId, useState } from 'react'
import { Check, Hash, MagnifyingGlass, Plus, Sparkle, X } from '@phosphor-icons/react'
import type { BundleChoice } from '../../../../shared/tasks'
import { useDismiss } from '../../../shared/hooks/useDismiss'
import { getBundleChoices, suggestTaskTags } from '../api'
import { bundleNamed, newTagOffer, tagOptions, tagToAdd } from '../tagEditor'

interface Props {
  companyId: string
  title: string
  tags: string[]
  /** Tags in use in the member's list, most used first. */
  tagsInUse: string[]
  /** The type's `set_tags` allows the member and the task is not finished (`card.canSetTags`). */
  canEdit: boolean
  busy: boolean
  /** Sets the task's tags; null = done, else the server's refusal in words. */
  onSet: (tags: string[]) => Promise<string | null>
  /** ［〇〇につなぐ］ with a bundle whose name was typed (absent: the task cannot be linked). */
  onLinkBundle?: (bundle: BundleChoice) => Promise<string | null>
  /** Only bundles of this type are named in the hint (the department's kind); absent = every kind. */
  bundleType?: string
  /** The bundle linked now (not offered again). */
  linkedBundleId?: string | null
}

const PILL = 'inline-flex h-[22px] items-center gap-0.5 rounded-md bg-white pl-1.5 pr-1 text-[12px] font-medium text-gray-700 ring-1 ring-gray-200 dark:bg-zinc-900 dark:text-zinc-200 dark:ring-zinc-700'
const POPOVER = 'absolute left-0 top-full z-30 mt-1 w-[290px] overflow-hidden rounded-lg border border-gray-200 bg-white text-[12.5px] text-gray-800 shadow-xl dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100'

type Row = { kind: 'tag'; tag: string; selected: boolean } | { kind: 'new'; tag: string }

export function TagField({ companyId, title, tags, tagsInUse, canEdit, busy, onSet, onLinkBundle, bundleType, linkedBundleId = null }: Props) {
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState('')
  const [index, setIndex] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [bundles, setBundles] = useState<BundleChoice[] | null>(null)
  const [suggested, setSuggested] = useState<string[] | null>(null)
  const [asking, setAsking] = useState(false)
  const [box, setBox] = useState<HTMLDivElement | null>(null)
  const listId = useId()
  const close = () => { setOpen(false); setTyped(''); setIndex(0); setError(null) }
  useDismiss(box, open, close)

  const options = tagOptions(typed, tags, tagsInUse)
  const created = newTagOffer(typed, options)
  const rows: Row[] = [...options.map(o => ({ kind: 'tag' as const, ...o })), ...(created ? [{ kind: 'new' as const, tag: created }] : [])]
  const active = Math.min(index, Math.max(rows.length - 1, 0))
  const named = onLinkBundle && bundles ? bundleNamed(typed, bundles.filter(b => b.id !== linkedBundleId && (!bundleType || b.id.startsWith(`${bundleType}-`)))) : null
  const shownSuggestions = (suggested ?? []).filter(t => !tags.includes(t))

  const run = async (next: string[]) => {
    setError(null)
    const failure = await onSet(next)
    if (failure) setError(failure)
    return failure
  }
  const add = async (tag: string) => {
    const a = tagToAdd(tag, tags, tagsInUse)
    if (!a) return
    if (a.kind === 'refused') { setError(a.reason); return }
    if (!(await run(a.tags))) { setTyped(''); setIndex(0) }
  }
  const remove = (tag: string) => void run(tags.filter(t => t !== tag))
  const choose = (row: Row) => {
    if (row.kind === 'tag' && row.selected) remove(row.tag)
    else void add(row.tag)
  }
  const ask = async () => {
    setAsking(true)
    try {
      setSuggested((await suggestTaskTags(companyId, title, tagsInUse.filter(t => !tags.includes(t)))).tags)
    } catch {
      setSuggested([])
    } finally {
      setAsking(false)
    }
  }
  const start = () => {
    if (!canEdit || busy) return
    setOpen(true)
    if (onLinkBundle && bundles === null) void getBundleChoices(companyId).then(r => setBundles(r.success ? r.bundles : []), () => setBundles([]))
    // Only suggestions: nothing is added until the member picks one (asked once per card).
    if (suggested === null && !asking && tagsInUse.some(t => !tags.includes(t))) void ask()
  }

  return (
    <div ref={setBox} className={`relative rounded-lg bg-gray-50 px-3 py-2 dark:bg-zinc-800/60 ${open ? 'ring-1 ring-accent/40' : ''}`}>
      <div className="flex items-center gap-1 text-[11px] text-gray-500"><Hash size={11} />タグ</div>
      <div className={`mt-0.5 flex min-h-[24px] flex-wrap items-center gap-1 ${canEdit ? 'cursor-text' : ''}`}
        onClick={e => { if (e.target === e.currentTarget) start() }}>
        {tags.map(t => (
          <span key={t} className={PILL}>
            <span className="text-gray-400 dark:text-zinc-500">#</span>{t}
            {canEdit && (
              <button type="button" disabled={busy} onClick={() => remove(t)} aria-label={`#${t} を外す`}
                className="ml-0.5 rounded p-px text-gray-400 hover:bg-gray-100 hover:text-gray-700 disabled:opacity-40 dark:hover:bg-zinc-700 dark:hover:text-zinc-100"><X size={10} weight="bold" /></button>
            )}
          </span>
        ))}
        {tags.length === 0 && !canEdit && <span className="text-[13px] text-gray-400">なし</span>}
        {canEdit && (
          <button type="button" disabled={busy} onClick={() => (open ? close() : start())} aria-expanded={open} aria-haspopup="dialog"
            aria-label={`タグを足す・外す（いま：${tags.length ? tags.join('、') : 'なし'}）`}
            className="inline-flex h-[22px] items-center gap-0.5 rounded-md px-1.5 text-[12px] border border-dashed border-gray-300 text-gray-500 hover:border-accent/60 hover:text-accent disabled:opacity-50 dark:border-zinc-600 dark:text-zinc-400">
            <Plus size={10} weight="bold" />{tags.length === 0 && 'タグ'}
          </button>
        )}
      </div>
      {!open && error && <p role="alert" className="mt-1 text-[11.5px] text-red-600 dark:text-red-400">{error}</p>}

      {open && (
        <div role="dialog" aria-label="タグ" className={POPOVER}>
          <div className="flex items-center gap-1.5 border-b border-gray-100 px-2.5 py-1.5 dark:border-zinc-700">
            <MagnifyingGlass size={12} className="shrink-0 text-gray-400" />
            <input autoFocus value={typed} disabled={busy} role="combobox" aria-label="タグを探す・作る" aria-expanded aria-controls={listId}
              aria-activedescendant={rows.length > 0 ? `${listId}-${active}` : undefined} placeholder="タグを探す・作る"
              onChange={e => { setTyped(e.target.value); setIndex(0); setError(null) }}
              onKeyDown={e => {
                if (e.nativeEvent.isComposing) return
                if (e.key === 'ArrowDown') { e.preventDefault(); setIndex(Math.min(active + 1, rows.length - 1)) }
                if (e.key === 'ArrowUp') { e.preventDefault(); setIndex(Math.max(active - 1, 0)) }
                if (e.key === 'Enter') {
                  e.preventDefault()
                  if (rows[active]) choose(rows[active])
                  else if (typed.trim()) { const a = tagToAdd(typed, tags, tagsInUse); if (a?.kind === 'refused') setError(a.reason) }
                }
                if (e.key === 'Backspace' && !typed && tags.length) remove(tags[tags.length - 1])
              }}
              className="min-w-0 flex-1 bg-transparent py-0.5 outline-none placeholder:text-gray-400" />
          </div>
          <ul id={listId} role="listbox" aria-label="タグ" aria-multiselectable className="max-h-[220px] overflow-y-auto p-1">
            {rows.length === 0 && <li className="px-2 py-1.5 text-[11.5px] text-gray-400">{tagsInUse.length === 0 ? '言葉を入れると、タグを作れます' : '見つかりません'}</li>}
            {rows.map((r, i) => (
              <li key={`${r.kind}:${r.tag}`} id={`${listId}-${i}`} role="option" aria-selected={r.kind === 'tag' && r.selected} data-active={i === active || undefined}
                onMouseEnter={() => setIndex(i)} onMouseDown={e => e.preventDefault()} onClick={() => { if (!busy) choose(r) }}
                className={`flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 ${i === active ? 'bg-gray-100 dark:bg-zinc-700' : ''}`}>
                {r.kind === 'new'
                  ? <><Plus size={12} className="shrink-0 text-accent" /><span className="truncate">「{r.tag}」を作る</span></>
                  : <><span className="flex w-3 shrink-0 justify-center text-accent">{r.selected && <Check size={12} weight="bold" />}</span>
                    <span className="truncate"><span className="text-gray-400 dark:text-zinc-500">#</span>{r.tag}</span></>}
              </li>
            ))}
          </ul>
          {(asking || shownSuggestions.length > 0) && (
            <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 border-t border-gray-100 px-2.5 py-1.5 text-[11.5px] text-gray-500 dark:border-zinc-700 dark:text-zinc-400">
              <Sparkle size={11} weight="fill" className="shrink-0 text-accent/80" />
              {asking ? '合いそうなタグを探しています…' : <>合いそうなタグ：{shownSuggestions.map(t => (
                <button key={t} type="button" disabled={busy} onClick={() => void add(t)} aria-label={`#${t} を付ける（AI の候補）`}
                  className="rounded px-0.5 text-accent hover:bg-accent/10 disabled:opacity-50">#{t}</button>
              ))}</>}
            </div>
          )}
          {named && (
            <p role="note" className="border-t border-gray-100 px-2.5 py-1.5 text-[11.5px] text-gray-500 dark:border-zinc-700 dark:text-zinc-400">
              『{named.title}』は{named.typeLabel}の名前です。
              <button type="button" disabled={busy} onClick={() => void onLinkBundle?.(named).then(f => { if (f) setError(f); else setTyped('') })}
                className="text-accent hover:underline disabled:opacity-50">{named.typeLabel}につなぐ</button>
            </p>
          )}
          {error && <p role="alert" className="border-t border-gray-100 px-2.5 py-1.5 text-[11.5px] text-red-600 dark:border-zinc-700 dark:text-red-400">{error}</p>}
          <p className="border-t border-gray-100 px-2.5 py-1 text-[10.5px] text-gray-400 dark:border-zinc-700 dark:text-zinc-500">↑↓ で選ぶ・Enter で付ける／外す・Esc で閉じる</p>
        </div>
      )}
    </div>
  )
}
