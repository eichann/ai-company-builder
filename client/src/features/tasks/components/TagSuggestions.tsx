import { useState } from 'react'
import { Sparkle } from '@phosphor-icons/react'
import { suggestTaskTags } from '../api'

interface Props {
  companyId: string
  title: string
  /** The task's own tags. */
  tags: string[]
  /** Tags in use in the member's list, most used first. */
  tagsInUse: string[]
  busy: boolean
  /** Sets the task's tags (タグを付ける); null = done, else the reason in words. */
  onSet: (tags: string[]) => Promise<string | null>
}

/**
 * 「タグの候補」 on a task's card: tags in use that fit its title, asked when the member presses
 * (main asks a Haiku model through the company's key, else matches locally). A tag is added only
 * when the member picks it.
 */
export function TagSuggestions({ companyId, title, tags, tagsInUse, busy, onSet }: Props) {
  const [shown, setShown] = useState<string[] | null>(null)
  const [asking, setAsking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const candidates = tagsInUse.filter(t => !tags.includes(t))
  if (candidates.length === 0) return null
  const ask = async () => {
    setAsking(true)
    try {
      setShown((await suggestTaskTags(companyId, title, candidates)).tags)
    } catch {
      setShown([])
    } finally {
      setAsking(false)
    }
  }
  const add = async (tag: string) => {
    setError(await onSet([...tags, tag]))
    setShown(s => s?.filter(t => t !== tag) ?? null)
  }
  return (
    <div role="group" aria-label="タグの候補" className="flex flex-wrap items-center gap-1.5 text-[11.5px] text-gray-500 dark:text-zinc-400">
      {shown === null
        ? (
          <button type="button" disabled={asking || busy} onClick={() => void ask()} className="inline-flex items-center gap-1 rounded border border-gray-300 px-1.5 py-px hover:border-accent hover:text-accent disabled:opacity-50 dark:border-zinc-600">
            <Sparkle size={10} weight="fill" />{asking ? '候補を探しています…' : 'タグの候補を出す'}
          </button>
        )
        : shown.length === 0
          ? <span>合いそうなタグは見つかりませんでした。</span>
          : <>タグの候補：{shown.map(t => (
            <button key={t} type="button" disabled={busy} onClick={() => void add(t)} className="rounded border border-accent/40 px-1 text-accent hover:bg-accent/10 disabled:opacity-50">#{t} を付ける</button>
          ))}</>}
      {error && <span role="alert" className="text-red-600 dark:text-red-400">{error}</span>}
    </div>
  )
}
