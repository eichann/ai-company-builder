import { FileText, LinkBreak, LockSimple } from '@phosphor-icons/react'
import type { RecordViewSummary } from '../../../../shared/record-views'
import { ONLY_YOU } from '../../../../shared/thing-words'
import { runCommand } from '../../../shared/commands/commands'

/**
 * 「あなただけ」 and 「例外（この件だけ）」: what a record's reader must not miss. A card's head leaves
 * 「あなただけ」 out (`personal={false}`): its top right says who sees it (見られる人, owner 2026-11-03).
 */
export function RecordMarks({ record, personal = true }: { record: Pick<RecordViewSummary, 'personal' | 'exception'>; personal?: boolean }) {
  return (
    <>
      {personal && record.personal && <span title="ほかの人には見えません（管理者にも）" className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-gray-200/70 px-1.5 text-[10px] text-gray-600 dark:bg-zinc-700/70 dark:text-zinc-300"><LockSimple size={9} />{ONLY_YOU}</span>}
      {record.exception && <span title="この件だけの判断です。ほかの件の前例にしません" className="shrink-0 rounded-full bg-amber-100 px-1.5 text-[10px] text-amber-800 dark:bg-amber-500/15 dark:text-amber-300">例外（この件だけ）</span>}
    </>
  )
}

/** One record to follow: its title, its type in small letters and its state. */
export function RecordRow({ record, sub }: { record: RecordViewSummary; sub?: string }) {
  return (
    <button
      type="button"
      onClick={() => runCommand('record.open', { recordId: record.id })}
      className="group w-full text-left rounded-md px-2 py-1 hover:bg-gray-100 dark:hover:bg-zinc-800"
    >
      <span className="flex items-center gap-1.5 text-[12px] min-w-0">
        <span className="min-w-0 truncate text-accent group-hover:underline">{record.title}</span>
        <RecordMarks record={record} />
        {record.stateLabel && <span className="shrink-0 rounded-full bg-gray-200/70 dark:bg-zinc-700/70 px-1.5 text-[10px] text-gray-600 dark:text-zinc-300">{record.stateLabel}</span>}
      </span>
      <span className="block text-[10.5px] text-gray-500 dark:text-zinc-400 truncate">{sub ?? record.typeLabel}</span>
    </button>
  )
}

/** A linked file: opens it in the editor; a link whose file is gone says so instead. */
export function FileLinkRow({ rootPath, path, broken }: { rootPath: string; path: string; broken?: boolean }) {
  const name = path.split('/').pop() ?? path
  if (broken) {
    return (
      <div className="px-2 py-1 text-[12px] text-gray-500 dark:text-zinc-400">
        <span className="flex items-center gap-1.5"><LinkBreak size={12} /><span className="truncate">{name}</span></span>
        <span className="block text-[10.5px]">つながりが切れています</span>
      </div>
    )
  }
  return (
    <button
      type="button"
      onClick={() => runCommand('file.open', { path: `${rootPath}/${path}` })}
      className="group w-full text-left rounded-md px-2 py-1 hover:bg-gray-100 dark:hover:bg-zinc-800"
    >
      <span className="flex items-center gap-1.5 text-[12px] min-w-0"><FileText size={12} className="shrink-0 text-gray-500" /><span className="truncate text-accent group-hover:underline">{name}</span></span>
      <span className="block text-[10.5px] text-gray-500 dark:text-zinc-400 truncate">{path}</span>
    </button>
  )
}
