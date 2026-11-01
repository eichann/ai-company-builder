import { useState } from 'react'
import { CheckCircle, Link, MagnifyingGlass } from '@phosphor-icons/react'
import { dueLabel, filterTaskChoices, type TaskChoice } from '../../../../shared/task-links'
import { useEventListener } from '../../../shared/hooks/useEventListener'
import type { LinkToTaskPhase } from '../hooks/useLinkToTask'

interface Props {
  /** The file or folder, relative to the company folder (`営業部/提案書/見積.md`). */
  companyPath: string
  phase: LinkToTaskPhase
  onChoose: (task: TaskChoice, tasks: TaskChoice[]) => void
  onClose: () => void
}

/** 「やることにつなぐ…」: choose one of the member's open tasks (search by title), then see the result. */
export function LinkToTaskDialog({ companyPath, phase, onChoose, onClose }: Props) {
  const [query, setQuery] = useState('')
  const name = companyPath.slice(companyPath.lastIndexOf('/') + 1)
  useEventListener<KeyboardEvent>(document, 'keydown', e => { if (e.key === 'Escape') onClose() })

  const tasks = phase.kind === 'choose' || phase.kind === 'linking' ? phase.tasks : phase.kind === 'failed' ? phase.tasks : null
  const shown = tasks ? filterTaskChoices(tasks, query) : []

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="link-to-task-title"
        className="w-full max-w-md p-4 bg-sidebar-bg border border-border rounded-lg shadow-xl dark:bg-zinc-900 dark:border-white/10"
        onClick={e => e.stopPropagation()}
      >
        <h3 id="link-to-task-title" className="flex items-center gap-2 text-lg font-medium text-text-primary dark:text-zinc-50">
          <Link size={18} /> やることにつなぐ
        </h3>
        <p className="mt-1 text-sm text-text-secondary dark:text-zinc-300 break-all">「{name}」をつなぐ、やることを選んでください。</p>

        {phase.kind === 'done' ? (
          <p role="status" className="mt-4 flex items-start gap-2 text-sm text-text-primary dark:text-zinc-100">
            <CheckCircle size={18} weight="fill" className="text-green-500 flex-shrink-0" />
            <span>{phase.message}</span>
          </p>
        ) : (
          <>
            <label className="mt-3 flex items-center gap-2 px-2 py-1.5 rounded-md border border-border dark:border-white/10">
              <MagnifyingGlass size={14} className="text-text-secondary" />
              <input
                autoFocus
                aria-label="件名で探す"
                placeholder="件名で探す"
                value={query}
                onChange={e => setQuery(e.target.value)}
                className="flex-1 bg-transparent text-sm outline-none text-text-primary dark:text-zinc-100"
              />
            </label>
            {phase.kind === 'loading' && <p className="mt-3 text-sm text-text-secondary">読み込んでいます…</p>}
            {phase.kind === 'failed' && <p role="alert" className="mt-3 text-sm text-red-500">{phase.message}</p>}
            {tasks && (
              shown.length === 0 ? (
                <p className="mt-3 text-sm text-text-secondary dark:text-zinc-400">
                  {tasks.length === 0 ? 'あなたが担当・依頼・確認しているやることはありません。' : '見つかりませんでした。'}
                </p>
              ) : (
                <ul aria-label="やること" className="mt-3 max-h-72 overflow-auto space-y-1">
                  {shown.map(t => (
                    <li key={t.id}>
                      <button
                        type="button"
                        disabled={phase.kind === 'linking'}
                        onClick={() => onChoose(t, tasks)}
                        className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left text-sm rounded-md hover:bg-activitybar-bg disabled:opacity-50 dark:hover:bg-white/[0.06] text-text-primary dark:text-zinc-100"
                      >
                        <span className="truncate">{t.title}</span>
                        {t.due && <span className="flex-shrink-0 text-xs text-text-secondary dark:text-zinc-400">期限 {dueLabel(t.due)}</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              )
            )}
          </>
        )}

        <div className="flex justify-end mt-4">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary hover:bg-activitybar-bg rounded-md transition-colors dark:text-zinc-400 dark:hover:bg-white/[0.06] dark:hover:text-zinc-100"
          >
            {phase.kind === 'done' ? '閉じる' : 'キャンセル'}
          </button>
        </div>
      </div>
    </div>
  )
}
