import { useState } from 'react'
import { UsersThree } from '@phosphor-icons/react'

/** A department the member may put a task into: its folder as the company names it, and its name. */
export interface ShareFolder {
  folder: string
  name: string
}

interface Props {
  /** The departments the member can write to (the screen decides; the server checks again). */
  folders: ShareFolder[]
  busy: boolean
  /** null = shown to the department; else the reason in words. */
  onShare: (folder: string) => Promise<string | null>
}

/**
 * 「部署に出す」 on an owner-only task (records.md "Owner-only records"): the member picks a
 * department and the task becomes visible to its readers. It cannot be made 「あなただけ」 again,
 * so the member confirms with the department named.
 */
export function ShareToDepartment({ folders, busy, onShare }: Props) {
  const [open, setOpen] = useState(false)
  const [folder, setFolder] = useState('')
  const [error, setError] = useState<string | null>(null)
  if (folders.length === 0) return null
  if (!open) {
    return (
      <button type="button" disabled={busy} onClick={() => { setOpen(true); setFolder(folders.length === 1 ? folders[0].folder : '') }}
        className="inline-flex items-center gap-1 rounded-md border border-gray-300 px-2 py-0.5 text-[11.5px] text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-zinc-600 dark:text-zinc-200 dark:hover:bg-zinc-800">
        <UsersThree size={12} />部署に出す
      </button>
    )
  }
  const chosen = folders.find(f => f.folder === folder)
  const submit = async () => {
    if (!chosen) return
    setError(null)
    const failure = await onShare(chosen.folder)
    if (failure) setError(failure)
    else setOpen(false)
  }
  return (
    <div role="group" aria-label="部署に出す" className="w-full space-y-2 rounded-lg border border-gray-200 p-2.5 text-[12.5px] dark:border-zinc-700">
      <label className="flex flex-wrap items-center gap-2">
        <span>出す先の部署</span>
        <select value={folder} onChange={e => setFolder(e.target.value)} className="rounded border border-gray-300 bg-white px-1.5 py-0.5 dark:border-zinc-600 dark:bg-zinc-900">
          <option value="">選んでください</option>
          {folders.map(f => <option key={f.folder} value={f.folder}>{f.name}</option>)}
        </select>
      </label>
      <p className="text-[11.5px] text-gray-500 dark:text-zinc-400">
        {chosen ? `「${chosen.name}」を見られる人みんなに見えるようになります。` : '出すと、その部署を見られる人みんなに見えるようになります。'}
        あとから「あなただけ」には戻せません。
      </p>
      {error && <p role="alert" className="text-red-600 dark:text-red-400">{error}</p>}
      <div className="flex gap-2">
        <button type="button" disabled={busy || !chosen} onClick={() => void submit()} className="rounded bg-accent px-2.5 py-0.5 text-white disabled:opacity-50">この部署に出す</button>
        <button type="button" disabled={busy} onClick={() => { setOpen(false); setError(null) }} className="rounded border border-gray-300 px-2.5 py-0.5 dark:border-zinc-600">やめる</button>
      </div>
    </div>
  )
}
