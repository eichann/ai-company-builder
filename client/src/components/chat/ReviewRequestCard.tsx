import { memo, useContext } from 'react'
import { CheckCircle, Eye, FileText } from '@phosphor-icons/react'
import type { ReviewRecord } from '../../../shared/review-request'
import { useAppStore } from '../../stores/appStore'
import { OpenFileContext, ReviewActionsContext } from './review-context'

/**
 * 「確認をお願いします」: the AI asked the member to look at its work and
 * stopped (shared/review-request.ts). The latest unanswered request has the
 * two answers; an older one shows as answered.
 */
export const ReviewRequestCard = memo(function ReviewRequestCard({ record }: { record: ReviewRecord }) {
  const actions = useContext(ReviewActionsContext)
  const openFile = useContext(OpenFileContext)
  const rootPath = useAppStore(state => state.currentCompany?.rootPath)
  const pending = actions.pendingId === record.id
  return (
    <div role="group" aria-label="確認をお願いします" className={`my-2 rounded-xl border p-3 ${pending ? 'border-amber-500/40 bg-amber-500/5' : 'border-gray-200 dark:border-zinc-700'}`}>
      <div className="flex items-center gap-1.5 text-sm font-medium text-gray-900 dark:text-zinc-100">
        <Eye size={15} weight="bold" aria-hidden className={pending ? 'text-amber-500' : 'text-gray-400'} />
        確認をお願いします
        {!pending && <span className="ml-auto flex items-center gap-1 text-[11px] font-normal text-gray-500"><CheckCircle size={12} aria-hidden />返事済み</span>}
      </div>
      <p className="mt-1 text-sm text-gray-800 dark:text-zinc-200">{record.title}</p>
      {record.message && <p className="mt-1 whitespace-pre-wrap text-xs text-gray-600 dark:text-zinc-300">{record.message}</p>}
      {record.files.length > 0 && <ul aria-label="見てほしいファイル" className="mt-2 space-y-1">
        {record.files.map(file => <li key={file}>
          {openFile && rootPath
            ? <button type="button" onClick={() => openFile(`${rootPath}/${file}`)} title="エディタで開く"
                className="flex max-w-full items-center gap-1.5 rounded px-1 py-0.5 text-left font-mono text-xs text-accent hover:bg-accent/10">
                <FileText size={13} aria-hidden className="shrink-0" /><span className="truncate">{file}</span>
              </button>
            : <span className="flex items-center gap-1.5 px-1 font-mono text-xs text-gray-600 dark:text-zinc-300"><FileText size={13} aria-hidden className="shrink-0" /><span className="truncate">{file}</span></span>}
        </li>)}
      </ul>}
      {record.points.length > 0 && <>
        <div className="mt-2 text-xs text-gray-600 dark:text-zinc-300">特に見てほしいところ</div>
        <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-gray-800 dark:text-zinc-200">{record.points.map(point => <li key={point}>{point}</li>)}</ul>
      </>}
      {pending && <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" onClick={actions.confirm} className="rounded-lg bg-accent px-3 py-1.5 text-xs text-white hover:bg-accent/90">この内容で進めて</button>
        <button type="button" onClick={actions.requestChanges} className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-100 dark:border-zinc-600 dark:text-zinc-200 dark:hover:bg-zinc-800">直してほしい</button>
        <span className="text-[11px] text-gray-500">直してほしいところは、下の欄に書いて送ってください</span>
      </div>}
    </div>
  )
}, (prev, next) => prev.record.id === next.record.id)
