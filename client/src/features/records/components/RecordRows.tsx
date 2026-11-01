import { FileText, LinkBreak } from '@phosphor-icons/react'
import type { RecordViewSummary } from '../../../../shared/record-views'
import { runCommand } from '../../../shared/commands/commands'

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
