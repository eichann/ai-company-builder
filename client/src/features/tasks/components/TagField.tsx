// The task card's 「タグ」 field (owner 2026-11-02): read only, or — for who may set tags — an inline
// editor: the tags as chips with ×, an input offering the tags in use (picking one is the main
// path, so 「営業」 and 「営業部」 do not both appear), the AI's 「候補を出す」, and a hint when the
// typed word is the name of a 案件・プロジェクト. Each change is one `set_tags`; the server decides.
import { useState } from 'react'
import { Hash, Plus, Sparkle, X } from '@phosphor-icons/react'
import type { BundleChoice } from '../../../../shared/tasks'
import { useEventListener } from '../../../shared/hooks/useEventListener'
import { SMALL_BUTTON } from '../../../shared/ui/RecordPage'
import { getBundleChoices, suggestTaskTags } from '../api'
import { bundleNamed, tagCandidates, tagToAdd } from '../tagEditor'

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

const CHIP = 'inline-flex items-center gap-0.5 rounded-full bg-white px-2 py-px text-[12px] font-medium shadow-sm ring-1 ring-gray-200 dark:bg-zinc-900 dark:ring-zinc-700'

export function TagField({ companyId, title, tags, tagsInUse, canEdit, busy, onSet, onLinkBundle, bundleType, linkedBundleId = null }: Props) {
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState('')
  const [index, setIndex] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [bundles, setBundles] = useState<BundleChoice[] | null>(null)
  const [suggested, setSuggested] = useState<string[] | null>(null)
  const [asking, setAsking] = useState(false)
  const [root, setRoot] = useState<HTMLDivElement | null>(null)
  useEventListener(typeof document === 'undefined' ? null : document, 'mousedown', e => {
    if (root && !root.contains(e.target as Node)) setOpen(false)
  }, { enabled: open })

  const candidates = tagCandidates(typed, tags, tagsInUse)
  const add = tagToAdd(typed, tags, tagsInUse)
  // A word nothing in use matches is a new tag; with matches, Enter picks the highlighted one.
  const exact = add?.kind === 'add' && tagsInUse.includes(add.tag)
  const offerNew = add?.kind === 'add' && !exact
  const rows = [...candidates.map(t => ({ tag: t, isNew: false })), ...(offerNew && add?.kind === 'add' ? [{ tag: add.tag, isNew: true }] : [])]
  const named = onLinkBundle && bundles ? bundleNamed(typed, bundles.filter(b => b.id !== linkedBundleId && (!bundleType || b.id.startsWith(`${bundleType}-`)))) : null

  const run = async (next: string[]) => {
    setError(null)
    const failure = await onSet(next)
    if (failure) setError(failure)
    return failure
  }
  const pick = async (tag: string) => {
    const a = tagToAdd(tag, tags, tagsInUse)
    if (!a) return
    if (a.kind === 'refused') { setError(a.reason); return }
    if (!(await run(a.tags))) { setTyped(''); setIndex(0); setSuggested(s => s?.filter(t => t !== a.tag) ?? null) }
  }
  const remove = (tag: string) => void run(tags.filter(t => t !== tag))
  const start = () => {
    setOpen(true)
    if (onLinkBundle && bundles === null) void getBundleChoices(companyId).then(r => setBundles(r.success ? r.bundles : []), () => setBundles([]))
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
  const askable = tagsInUse.some(t => !tags.includes(t))

  if (!open) {
    const shown = tags.length ? tags.map(t => `#${t}`).join(' ') : <span className="font-normal text-gray-400">なし</span>
    return (
      <div className="rounded-lg bg-gray-50 px-3 py-2 dark:bg-zinc-800/60">
        <div className="flex items-center gap-1 text-[11px] text-gray-500"><Hash size={11} />タグ</div>
        {canEdit
          ? <button type="button" disabled={busy} onClick={start} title="タグを足す・外す" aria-label={`タグ：${tags.length ? tags.join('、') : 'なし'}（押すと変えられます）`}
            className="-mx-1 w-[calc(100%+0.5rem)] rounded px-1 text-left text-[13.5px] font-medium hover:bg-gray-100 dark:hover:bg-zinc-700/60">{shown}</button>
          : <div className="text-[13.5px] font-medium">{shown}</div>}
      </div>
    )
  }
  return (
    <div ref={setRoot} role="group" aria-label="タグを変える" className="relative col-span-2 rounded-lg bg-gray-50 px-3 py-2 ring-1 ring-accent/40 dark:bg-zinc-800/60"
      onKeyDown={e => { if (e.key === 'Escape') setOpen(false) }}>
      <div className="flex items-center gap-1 text-[11px] text-gray-500">
        <Hash size={11} />タグ
        <button type="button" onClick={() => setOpen(false)} className="ml-auto rounded px-1 text-[11px] text-gray-500 hover:bg-gray-100 hover:text-accent dark:hover:bg-zinc-700">閉じる</button>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1">
        {tags.map(t => (
          <span key={t} className={CHIP}>#{t}
            <button type="button" disabled={busy} onClick={() => remove(t)} aria-label={`#${t} を外す`} className="rounded-full p-px text-gray-400 hover:bg-gray-100 hover:text-red-600 disabled:opacity-40 dark:hover:bg-zinc-700"><X size={10} /></button>
          </span>
        ))}
        <input autoFocus value={typed} disabled={busy} aria-label="タグを足す" placeholder={tags.length ? '足すタグ' : 'タグを入れる（例：営業）'}
          onChange={e => { setTyped(e.target.value); setIndex(0); setError(null) }}
          onKeyDown={e => {
            if (e.nativeEvent.isComposing) return
            if (e.key === 'ArrowDown') { e.preventDefault(); setIndex(i => Math.min(i + 1, rows.length - 1)) }
            if (e.key === 'ArrowUp') { e.preventDefault(); setIndex(i => Math.max(i - 1, 0)) }
            if (e.key === 'Enter') {
              e.preventDefault()
              const row = rows[index]
              if (row) void pick(row.tag)
              else if (add?.kind === 'refused') setError(add.reason)
            }
            if (e.key === 'Backspace' && !typed && tags.length) remove(tags[tags.length - 1])
          }}
          className="min-w-[8em] flex-1 bg-transparent py-0.5 text-[12.5px] outline-none placeholder:text-gray-400" />
      </div>
      {rows.length > 0 && (
        <ul role="listbox" aria-label="タグの候補" className="mt-1 max-h-[200px] overflow-y-auto rounded-md border border-gray-200 bg-white p-0.5 text-[12px] dark:border-zinc-700 dark:bg-zinc-900">
          {rows.map((r, i) => (
            <li key={`${r.isNew ? 'new' : 'use'}:${r.tag}`} role="option" aria-selected={i === index}>
              <button type="button" disabled={busy} onMouseEnter={() => setIndex(i)} onClick={() => void pick(r.tag)}
                className={`flex w-full items-center gap-1 rounded px-2 py-1 text-left ${i === index ? 'bg-accent/10 text-accent' : ''}`}>
                {r.isNew ? <><Plus size={10} />「{r.tag}」を新しいタグにする</> : <>#{r.tag}<span className="ml-auto text-[10px] text-gray-400">使われているタグ</span></>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {named && (
        <p role="note" className="mt-1.5 flex flex-wrap items-center gap-1.5 rounded-md bg-indigo-500/10 px-2 py-1 text-[11.5px] text-indigo-900 dark:text-indigo-200">
          『{named.title}』は{named.typeLabel}の名前です。{named.typeLabel}につなぎますか？
          <button type="button" disabled={busy} onClick={() => void onLinkBundle?.(named).then(f => { if (f) setError(f); else setTyped('') })} className={SMALL_BUTTON}>{named.typeLabel}につなぐ</button>
        </p>
      )}
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11.5px] text-gray-500 dark:text-zinc-400">
        {askable && suggested === null && (
          <button type="button" disabled={asking || busy} onClick={() => void ask()} className="inline-flex items-center gap-1 rounded border border-gray-300 px-1.5 py-px hover:border-accent hover:text-accent disabled:opacity-50 dark:border-zinc-600">
            <Sparkle size={10} weight="fill" />{asking ? '候補を探しています…' : 'AI にタグの候補を出してもらう'}
          </button>
        )}
        {suggested !== null && (suggested.length === 0
          ? <span>合いそうなタグは見つかりませんでした。</span>
          : <>AI の候補：{suggested.map(t => (
            <button key={t} type="button" disabled={busy} onClick={() => void pick(t)} className="rounded border border-accent/40 px-1 text-accent hover:bg-accent/10 disabled:opacity-50">#{t} を付ける</button>
          ))}</>)}
      </div>
      {error && <p role="alert" className="mt-1 text-[11.5px] text-red-600 dark:text-red-400">{error}</p>}
    </div>
  )
}
