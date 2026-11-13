import { memo, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { UIMessage } from 'ai'
import { Brain, CaretUp, CircleNotch, LinkSimple } from '@phosphor-icons/react'
import type { ConsultationReference } from '../../../../shared/consultation-reference'
import { ConsultationReferenceLink } from './ConsultationReference'
import { MarkdownMessage } from './MarkdownMessage'
import { ChoicePromptRecordView } from './ChoicePrompt'
import { CHOICE_PART_TYPE, readChoiceRecord } from '../../../../shared/choice-prompt'
import { STEER_PART_TYPE, readSteerRecord } from '../../../../shared/steer'
import { REVIEW_PART_TYPE, readReviewRecord } from '../../../../shared/review-request'
import { ReviewRequestCard } from './ReviewRequestCard'
import { PLUGIN_OPERATION_PART_TYPE, readPluginOperationCard } from '../../../../shared/plugin-operations'
import { MAIL_DRAFT_PART_TYPE, readMailDraftCard } from '../../../../shared/outbound-mail'
import { FILE_LINKED_PART_TYPE, fileLinkedLine, readFileLinkedPart } from '../../../../shared/consultation-task'
import { MailDraftCard } from './MailDraftCard'
import { DRIVE_OVERWRITE_PART_TYPE, readDriveOverwriteCard } from '../../../../shared/drive-overwrite'
import { DriveOverwriteCard } from './DriveOverwriteCard'
import { PluginOperationCard } from './PluginOperationCard'
import { APPROVAL_PART_TYPE, readApprovalCardRef } from '../../../../shared/approvals'
import { ApprovalCard } from './ApprovalCard'
import { MINUTES_BUNDLE_CHOICE_PART_TYPE, readMinutesBundleChoiceCard } from '../../../../shared/minutes-app'
import { MinutesBundleChoiceCard } from './MinutesBundleChoiceCard'
import { SteerInstructionView } from './SteerInstruction'
import { SecondOpinionQuote } from './SecondOpinionQuote'
import { SECOND_OPINION_PART_TYPE, readSecondOpinionRecord, type SecondOpinionRecord } from '../../../../shared/agents/second-opinion'
import { BrokerKeyNeededCard } from './BrokerKeyNeededCard'
import { brokerKeyNeedsOf } from '../brokerKeyNeeds'
import { planParts } from '../toolRows'
import { ToolRunGroup } from './ToolRows'

// Rendering of an assistant message's parts. Everything here is memoised with
// value-based equality: @ai-sdk/react structuredClones the streaming message
// on every chunk, so part objects are new references on every tick and a
// shallow React.memo would never hit. See toolRows.ts for the render plan.

function StreamingCursor() {
  return (
    <span className="inline-block w-0.5 h-4 bg-accent/70 ml-0.5 animate-pulse-soft align-middle" />
  )
}

const ThinkingBlock = memo(function ThinkingBlock({ content, isStreaming = false }: { content: string; isStreaming?: boolean }) {
  const { t } = useTranslation()
  const [isExpanded, setIsExpanded] = useState(true)

  return (
    <div className="mb-3 animate-fade-in">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex items-center gap-2 text-xs text-ink-muted hover:text-ink transition-colors group"
      >
        <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-purple-500/10 border border-purple-500/20">
          {isStreaming ? (
            <CircleNotch size={12} className="animate-spin text-purple-400" />
          ) : (
            <Brain size={12} weight="fill" className="text-purple-400" />
          )}
          <span className="text-purple-300 font-medium">
            {isStreaming ? t('chat.thinkingInProgress') : t('chat.thought')}
          </span>
          <CaretUp
            size={12}
            className={`text-purple-400 transition-transform duration-200 ${isExpanded ? '' : 'rotate-180'}`}
          />
        </div>
      </button>

      {isExpanded && (
        <div className="mt-2 pl-3 border-l-2 border-purple-500/30 animate-slide-up">
          <div className="text-xs text-ink-muted leading-relaxed whitespace-pre-wrap">
            {content}
            {isStreaming && <StreamingCursor />}
          </div>
        </div>
      )}
    </div>
  )
})

const TextPartView = memo(function TextPartView({ text, markdown, showCursor }: { text: string; markdown: boolean; showCursor: boolean }) {
  return (
    <div className="relative rounded-2xl rounded-tl-md px-4 py-3 text-[14px] leading-relaxed bg-gray-100 dark:bg-zinc-800 text-gray-900 dark:text-zinc-100 border border-gray-200 dark:border-zinc-700 shadow-glass">
      <div className="absolute inset-0 rounded-2xl rounded-tl-md bg-gradient-to-b from-white/[0.02] to-transparent pointer-events-none" />
      <div className="relative break-words">
        {markdown ? (
          <MarkdownMessage content={text} />
        ) : (
          <div className="whitespace-pre-wrap">{text}</div>
        )}
        {showCursor && <StreamingCursor />}
      </div>
    </div>
  )
})

export function AssistantMessageParts({ parts, isStreaming, markdown }: { parts: UIMessage['parts']; isStreaming: boolean; markdown: boolean }) {
  const plan = useMemo(() => planParts(parts), [parts])
  const lastIndex = parts.length - 1
  // Searched once the reply has ended (not per streamed chunk): a "no key" answer → a 「自分の鍵」 card.
  const keyNeeds = useMemo(() => (isStreaming ? [] : brokerKeyNeedsOf(parts)), [parts, isStreaming])
  // 「Codex の答えを全部見る」: after the reply's text, where the AI has summed the answer up.
  const secondOpinions = useMemo(() => parts.flatMap(part => {
    if (part.type !== SECOND_OPINION_PART_TYPE) return []
    const record = readSecondOpinionRecord((part as { data?: unknown }).data)
    return record ? [record] : []
  }).filter((record, i, all) => all.findIndex(r => r.id === record.id) === i), [parts])

  return (
    <>
      {plan.map(item => {
        if (item.kind === 'run') return <ToolRunGroup key={item.key} item={item} />
        const { part, index } = item
        const isLastPart = index === lastIndex
        if (part.type === 'reasoning') {
          return <ThinkingBlock key={item.key} content={part.text} isStreaming={isStreaming && isLastPart} />
        }
        if (part.type === 'text') {
          return <TextPartView key={item.key} text={part.text} markdown={markdown} showCursor={isStreaming && isLastPart} />
        }
        if (part.type === 'data-consultation-reference') {
          return <ConsultationReferenceLink key={item.key} reference={part.data as ConsultationReference} />
        }
        if (part.type === CHOICE_PART_TYPE) {
          const record = readChoiceRecord((part as { data?: unknown }).data)
          return record ? <ChoicePromptRecordView key={item.key} record={record} /> : null
        }
        if (part.type === REVIEW_PART_TYPE) {
          const record = readReviewRecord((part as { data?: unknown }).data)
          return record ? <ReviewRequestCard key={item.key} record={record} /> : null
        }
        if (part.type === PLUGIN_OPERATION_PART_TYPE) {
          const card = readPluginOperationCard((part as { data?: unknown }).data)
          return card ? <PluginOperationCard key={item.key} card={card} /> : null
        }
        if (part.type === APPROVAL_PART_TYPE) {
          const ref = readApprovalCardRef((part as { data?: unknown }).data)
          return ref ? <ApprovalCard key={item.key} card={ref} /> : null
        }
        if (part.type === MINUTES_BUNDLE_CHOICE_PART_TYPE) {
          const card = readMinutesBundleChoiceCard((part as { data?: unknown }).data)
          return card ? <MinutesBundleChoiceCard key={item.key} card={card} /> : null
        }
        if (part.type === MAIL_DRAFT_PART_TYPE) {
          const card = readMailDraftCard((part as { data?: unknown }).data)
          return card ? <MailDraftCard key={item.key} card={card} /> : null
        }
        if (part.type === DRIVE_OVERWRITE_PART_TYPE) {
          const card = readDriveOverwriteCard((part as { data?: unknown }).data)
          return card ? <DriveOverwriteCard key={item.key} card={card} /> : null
        }
        if (part.type === FILE_LINKED_PART_TYPE) {
          const linked = readFileLinkedPart((part as { data?: unknown }).data)
          return linked ? <p key={item.key} data-file-linked className="my-1 flex items-center gap-1 text-[11.5px] text-gray-500 dark:text-zinc-400"><LinkSimple size={11} aria-hidden />{fileLinkedLine(linked)}</p> : null
        }
        if (part.type === STEER_PART_TYPE) {
          const record = readSteerRecord((part as { data?: unknown }).data)
          return record ? <SteerInstructionView key={item.key} record={record} /> : null
        }
        if (part.type === 'step-start') {
          return <div key={item.key} className="my-2 border-t border-gray-200 dark:border-zinc-700/50" />
        }
        return null
      })}
      {secondOpinions.map((record: SecondOpinionRecord) => <SecondOpinionQuote key={`second-opinion:${record.id}`} record={record} />)}
      {keyNeeds.map(service => <BrokerKeyNeededCard key={`key-needed:${service}`} service={service} />)}
    </>
  )
}
