import { ListChecks } from '@phosphor-icons/react'
import { appInstructionLabel, type AppInstruction } from '../../../../shared/app-instruction'
import { runCommand, useCommandAvailable } from '../../../shared/commands/commands'

/**
 * What a consultation the app started is about (「相談する」 on a task, a plugin's person step), at
 * the top of the chat in place of the app's instruction to the AI. Pressing it opens the record's
 * card where the screen can (`record.open`; a consultation's own window has no card area).
 */
export function AppInstructionChip({ instruction }: { instruction: AppInstruction }) {
  const canOpen = useCommandAvailable('record.open')
  const label = appInstructionLabel(instruction)
  const body = <>
    <ListChecks size={13} aria-hidden className="shrink-0" />
    <span className="min-w-0 truncate">{label}</span>
  </>
  const chip = 'inline-flex max-w-full items-center gap-1.5 rounded-full border border-gray-200 bg-gray-50 px-2.5 py-1 text-xs text-gray-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200'
  return (
    <div className="flex-shrink-0 border-b border-gray-100 px-4 py-1.5 dark:border-zinc-800">
      {canOpen
        ? <button type="button" title={`${label}（カードを開く）`} onClick={() => { void runCommand('record.open', { recordId: instruction.recordId }) }}
            className={`${chip} hover:bg-gray-100 dark:hover:bg-zinc-700`}>{body}</button>
        : <span className={chip} title={label}>{body}</span>}
    </div>
  )
}
