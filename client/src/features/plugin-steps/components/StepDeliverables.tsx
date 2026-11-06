import type { ReactNode } from 'react'
import { Sparkle } from '@phosphor-icons/react'
import type { LinkedPath, RecordViewSummary } from '../../../../shared/record-views'
import { runCommand } from '../../../shared/commands/commands'
import { useStepDeliverables } from '../hooks/useStepDeliverables'

interface Props {
  companyId: string
  recordId: string
  /** A mail draft (the consultation's own card: the person checks the attached files and sends) or an approval request. */
  renderPrepared: (record: RecordViewSummary) => ReactNode
  /** A file the step made (opens in the app). */
  renderFile: (file: LinkedPath) => ReactNode
}

/**
 * At the top of a record's card: what a business plugin's step made for it (plugin-steps.md "What
 * the step made"; tasks-ui.md 「AI が用意したもの」 — 成果物は相談をさかのぼらずに届く): the points to
 * check, the files and the cover-mail draft, from the やること the step handed over. Nothing shows
 * while there is none.
 */
export function StepDeliverables({ companyId, recordId, renderPrepared, renderFile }: Props) {
  const view = useStepDeliverables(companyId, recordId)
  if (!view) return null
  return (
    <section aria-label="AI が用意したもの" className="mx-5 mt-5 rounded-lg border border-accent/30 bg-accent/5 px-4 py-3 text-[12.5px]">
      <h3 className="flex items-center gap-1.5 text-[12px] font-medium text-gray-700 dark:text-zinc-200">
        <Sparkle size={13} className="text-accent" />AI が用意したもの
      </h3>
      <button type="button" onClick={() => void runCommand('record.open', { recordId: view.taskId })}
        className="mt-1 text-left text-accent hover:underline">{view.title}</button>
      {view.questions && (
        <div className="mt-2">
          <p className="text-[11px] font-medium text-gray-600 dark:text-zinc-300">確かめる点</p>
          <p className="whitespace-pre-wrap text-gray-700 dark:text-zinc-200">{view.questions}</p>
        </div>
      )}
      {view.files.length > 0 && (
        <div className="mt-2">
          <p className="text-[11px] font-medium text-gray-600 dark:text-zinc-300">ファイル</p>
          {view.files.map(f => <div key={f.path}>{renderFile(f)}</div>)}
        </div>
      )}
      {view.prepared.map(p => <div key={p.id} className="mt-2">{renderPrepared(p)}</div>)}
    </section>
  )
}
