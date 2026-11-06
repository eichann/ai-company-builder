// 「やることを足す」 on a meeting's card (出どころの枠 §10 step 4, tasks-ui.md "Similar items"): the member
// makes a task of this meeting (its people see it). A person's create is free; when the server names
// a close item of the meeting, one quiet line offers ［まとめる］ (this one put away, the earlier one
// opened, ［元に戻す］ after) or ［このまま］.
import { useState } from 'react'
import { Plus } from '@phosphor-icons/react'
import { mergeActionFor, type SimilarItem, type TaskWriteResult } from '../../../../shared/tasks'
import { slotMergedNote } from '../../../../../shared/core/source-slot-candidates'
import { runCommand } from '../../../shared/commands/commands'
import { SimilarHint } from './SimilarHint'

const QUIET = 'inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11.5px] text-gray-500 hover:bg-gray-100 hover:text-accent disabled:opacity-50 dark:text-zinc-400 dark:hover:bg-zinc-800'

interface Props {
  busy: boolean
  /** Makes a task of the meeting for the member (`tasks:create` with `meetingId`). */
  onCreate: (title: string) => Promise<TaskWriteResult>
  /** Runs `action` on record `id` at `version` with a note; null = done, else the reason in words. */
  onAct: (id: string, action: string, version: number, note?: string) => Promise<string | null>
  /** 元に戻す: the entry at `version` of record `id` undone; null = done. */
  onUndo: (id: string, version: number) => Promise<string | null>
}

export function MeetingTaskAdd({ busy, onCreate, onAct, onUndo }: Props) {
  const [open, setOpen] = useState(false)
  const [line, setLine] = useState('')
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hint, setHint] = useState<{ id: string; state: string | undefined; similar: SimilarItem } | null>(null)
  const [merged, setMerged] = useState<{ id: string; title: string } | null>(null)
  const off = busy || working

  const add = async () => {
    const title = line.trim()
    if (!title || off) return
    setWorking(true); setError(null); setMerged(null); setHint(null)
    try {
      const r = await onCreate(title)
      if (!r.success) { setError(r.error); return }
      setLine('')
      if (r.similar) setHint({ id: r.recordId, state: r.state, similar: r.similar })
    } finally { setWorking(false) }
  }
  const merge = async (h: NonNullable<typeof hint>) => {
    const action = mergeActionFor(h.state ?? 'todo')
    if (!action) return
    setWorking(true); setError(null)
    try {
      // Just made: its first change is version 2 (取り消す undoes that one entry).
      const failure = await onAct(h.id, action, 1, slotMergedNote(h.similar.title))
      if (failure) { setError(failure); return }
      setHint(null)
      setMerged({ id: h.id, title: h.similar.title })
      void runCommand('record.open', { recordId: h.similar.id })
    } finally { setWorking(false) }
  }
  const undo = async (m: NonNullable<typeof merged>) => {
    setWorking(true); setError(null)
    try {
      const failure = await onUndo(m.id, 2)
      if (failure) setError(failure)
      else setMerged(null)
    } finally { setWorking(false) }
  }

  return (
    <div className="mt-2 space-y-1.5">
      {!open
        ? <button type="button" disabled={off} onClick={() => setOpen(true)} className={QUIET}><Plus size={12} />やることを足す</button>
        : (
          <input autoFocus aria-label="この会議のやること" value={line} disabled={off} placeholder="この会議のやること（Enter で足す）"
            onChange={e => setLine(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); void add() }
              if (e.key === 'Escape') { setOpen(false); setLine('') }
            }}
            className="w-full rounded-md border border-gray-300 bg-white px-2 py-1 text-[12.5px] dark:border-zinc-600 dark:bg-zinc-900" />
        )}
      {hint && <SimilarHint similar={hint.similar} busy={off} onMerge={mergeActionFor(hint.state ?? 'todo') ? () => void merge(hint) : null} onKeep={() => setHint(null)} />}
      {merged && (
        <div role="status" className="flex items-center gap-2 text-[11.5px] text-gray-600 dark:text-zinc-300">
          <span className="min-w-0 flex-1">「{merged.title}」とまとめました</span>
          <button type="button" disabled={off} onClick={() => void undo(merged)} className={QUIET}>元に戻す</button>
        </div>
      )}
      {error && <p role="alert" className="text-[12px] text-red-600 dark:text-red-400">{error}</p>}
    </div>
  )
}
