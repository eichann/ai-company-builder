import { useState } from 'react'
import { Clock, Hash, Plus, Sparkle } from '@phosphor-icons/react'
import type { TaskCreateInput } from '../../../../shared/tasks'
import { dueText, type CompanyNow } from '../model'
import { parseQuickAdd, similarTag, tagChoices } from '../quickAdd'

interface Props {
  now: CompanyNow
  /** Tags in use in the list, most used first. */
  tagsInUse: string[]
  /** null = added; else the reason in words. */
  onAdd: (input: TaskCreateInput) => Promise<string | null>
}

/** The list's one line: a task of the member's own, with a due and tags read from what they type. */
export function QuickAdd({ now, tagsInUse, onAdd }: Props) {
  const [line, setLine] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const draft = parseQuickAdd(line, now)
  const choices = tagChoices(line, tagsInUse) ?? []
  const similar = draft.tags.map(t => ({ from: t, to: similarTag(t, tagsInUse) })).find(s => s.to !== null) ?? null

  const add = async () => {
    if (!draft.title || busy) return
    setBusy(true)
    setError(null)
    try {
      const failure = await onAdd({ title: draft.title, due: draft.due, tags: draft.tags })
      if (failure) setError(failure)
      else setLine('')
    } finally {
      setBusy(false)
    }
  }
  const replaceTag = (from: string, to: string) =>
    setLine(l => l.replace(new RegExp(`[#＃]${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$)`), `#${to}`))

  return (
    <div className="flex-shrink-0 space-y-1.5 border-b border-gray-100 px-3 pb-1.5 pt-2 dark:border-zinc-800">
      <div className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-2 py-1 focus-within:border-accent dark:border-zinc-700">
        <Plus size={13} className="shrink-0 text-gray-400" />
        <input
          value={line}
          onChange={e => setLine(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) void add() }}
          aria-label="やることを追加"
          placeholder="やることを追加（例：見積を直す 明日15時まで #営業）"
          className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-gray-400"
        />
        <button type="button" onClick={() => void add()} disabled={!draft.title || busy} className="shrink-0 rounded-md bg-accent px-2 py-0.5 text-[11px] text-white disabled:opacity-40">追加</button>
      </div>
      {line && (
        <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-gray-500 dark:text-zinc-400" data-testid="quick-add-preview">
          {draft.due && <span className="inline-flex items-center gap-1 rounded bg-sky-500/10 px-1.5 py-px text-sky-700 dark:text-sky-300"><Clock size={10} />期限 {dueText(draft.due, now)}</span>}
          {draft.tags.map(t => <span key={t} className="inline-flex items-center rounded bg-gray-100 px-1.5 py-px dark:bg-zinc-800"><Hash size={10} />{t}</span>)}
          {choices.length > 0 && (
            <span className="inline-flex items-center gap-1">今あるタグ：{choices.map(t => (
              <button key={t} type="button" onClick={() => setLine(l => l.replace(/[#＃][^\s#＃]*$/, `#${t} `))} className="rounded border border-gray-200 px-1 hover:border-accent hover:text-accent dark:border-zinc-700">#{t}</button>
            ))}</span>
          )}
          {similar && (
            <span className="inline-flex items-center gap-1 rounded bg-accent/10 px-1.5 py-px text-accent">
              <Sparkle size={10} weight="fill" />「#{similar.from}」は今ある「#{similar.to}」と同じですか？
              <button type="button" onClick={() => replaceTag(similar.from, similar.to!)} className="underline">#{similar.to} にする</button>
            </span>
          )}
          <span className="text-gray-400">自分だけに見えるやることになります</span>
        </div>
      )}
      {error && <p role="alert" className="text-[11px] text-red-600 dark:text-red-400">{error}</p>}
    </div>
  )
}
