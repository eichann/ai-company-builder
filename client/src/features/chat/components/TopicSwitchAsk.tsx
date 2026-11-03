import { consultationLinkedRecord } from '../../../../shared/consultation-topics'
import type { DroppedRecordRef } from '../../../../shared/record-drop'
import { useConsultationTopics } from '../consultationTopicsStore'
import { switchTopicQuestion } from '../recordDrop'

/**
 * A record dropped on a consultation already about another one (recordDrop.ts): 「『A』の相談を『B』の
 * 相談に切り替えますか？」 above the input. Either way the dropped record still goes to the AI once.
 */
export function TopicSwitchAsk({ companyId, fromRecordId, to, onSwitch, onKeep }: {
  companyId: string
  fromRecordId: string
  to: DroppedRecordRef
  onSwitch: () => void
  onKeep: () => void
}) {
  const topics = useConsultationTopics(companyId, [fromRecordId])
  const from = consultationLinkedRecord(topics.get(fromRecordId) ?? null)
  const button = 'shrink-0 rounded-md px-2.5 py-1 text-xs font-medium'
  return (
    <div role="group" aria-label="相談の主題" data-topic-switch className="mb-1.5 flex flex-wrap items-center gap-2 rounded-lg border border-accent/30 bg-accent/5 px-3 py-2 text-xs text-gray-700 dark:text-zinc-200">
      <span className="min-w-0 flex-1">{switchTopicQuestion(from?.title ?? 'いまの主題', to.title || to.word)}</span>
      <button type="button" onClick={onSwitch} className={`${button} bg-accent text-white hover:bg-accent/90`}>切り替える</button>
      <button type="button" onClick={onKeep} className={`${button} text-gray-600 hover:bg-gray-100 dark:text-zinc-300 dark:hover:bg-zinc-800`}>このまま</button>
    </div>
  )
}
