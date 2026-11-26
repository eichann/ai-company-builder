import { LinkSimple, ListChecks, X } from '@phosphor-icons/react'
import { consultationLinkedRecord } from '../../../../shared/consultation-topics'
import { runCommand, useCommandAvailable } from '../../../shared/commands/commands'
import { useConsultationTopics } from '../consultationTopicsStore'

/**
 * The record this consultation is about (its topic: 「相談する」 on the task, the task the AI made in
 * it — consultation-task.ts —, a record dropped on the input — recordDrop.ts —, or the record open in the middle when the
 * member started it), under the header. Pressing it opens the card where the screen can;
 * × takes the consultation off the task (no more automatic links or topics). A record the member
 * cannot read shows nothing. `fallbackTitle`: the title the app's instruction named, until the server answers.
 * `place="composer"`: before the member's first message the chip sits above the input (「このやること：…」, on by
 * default); × there means the new consultation is not linked at all.
 */
export function TopicChip({ companyId, recordId, fallbackTitle, onRemove, place = 'header' }: { companyId: string; recordId: string; fallbackTitle?: string; onRemove: () => void; place?: 'header' | 'composer' }) {
  const canOpen = useCommandAvailable('record.open')
  const topics = useConsultationTopics(companyId, [recordId])
  const topic = topics.get(recordId)
  if (topic === null) return null
  const look = consultationLinkedRecord(topic)
  // The topic's own kind (やること, 案件, 会議の記録…): a record dropped on the input may be any of them.
  const kind = look?.kindName ?? 'やること'
  const title = look?.title ?? fallbackTitle ?? '読み込んでいます'
  if (place === 'composer') {
    const label = `この${kind}：${title}`
    return (
      <div className="mb-2 flex min-w-0" data-topic-chip="composer">
        <span className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full border border-selected-border bg-selected-bg py-1 pl-2.5 pr-1 text-small text-selected-text" title={`${label}（この相談は、この${kind}についての相談になります）`}>
          <LinkSimple size={12} aria-hidden className="shrink-0" />
          <span className="min-w-0 truncate">{label}</span>
          <button type="button" onClick={onRemove} aria-label={`この${kind}につなげない`} title={`この${kind}につなげない`}
            className="shrink-0 rounded-full p-0.5 text-text-muted hover:bg-surface-sunken hover:text-text focus-visible:outline-focus-ring">
            <X size={11} />
          </button>
        </span>
      </div>
    )
  }
  const label = `この${kind}についての相談：${title}`
  const chip = 'inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full border border-gray-200 bg-gray-50 py-1 pl-2.5 pr-1 text-xs text-gray-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200'
  return (
    <div className="flex-shrink-0 border-b border-gray-100 px-4 py-1.5 dark:border-zinc-800" data-topic-chip>
      <span className={chip}>
        {canOpen
          ? <button type="button" title={`${label}（カードを開く）`} onClick={() => { void runCommand('record.open', { recordId }) }} className="flex min-w-0 items-center gap-1.5 hover:underline">
              <ListChecks size={13} aria-hidden className="shrink-0" /><span className="min-w-0 truncate">{label}</span>
            </button>
          : <span className="flex min-w-0 items-center gap-1.5" title={label}><ListChecks size={13} aria-hidden className="shrink-0" /><span className="min-w-0 truncate">{label}</span></span>}
        <button type="button" onClick={onRemove} aria-label={`この${kind}から外す`} title={`この${kind}から外す（新しく作ったファイルも、もうつなぎません）`}
          className="shrink-0 rounded-full p-0.5 text-gray-400 hover:bg-gray-200 hover:text-gray-700 dark:hover:bg-zinc-700 dark:hover:text-zinc-200">
          <X size={11} />
        </button>
      </span>
    </div>
  )
}
