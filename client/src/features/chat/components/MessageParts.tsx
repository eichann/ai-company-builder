import { memo, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { UIMessage } from 'ai'
import {
  Brain,
  CaretDown,
  CaretUp,
  Check,
  CircleNotch,
  Eye,
  File,
  FolderOpen,
  ListChecks,
  PencilSimple,
  Robot,
  Terminal,
  WarningCircle,
} from '@phosphor-icons/react'
import { referenceFromTool, type ConsultationReference } from '../../../../shared/consultation-reference'
import { ConsultationReferenceLink } from './ConsultationReference'
import { MarkdownMessage } from './MarkdownMessage'
import { ChoicePromptRecordView } from './ChoicePrompt'
import { CHOICE_PART_TYPE, readChoiceRecord } from '../../../../shared/choice-prompt'
import { useAgentProgress } from '../agentStatusStore'
import { STEER_PART_TYPE, readSteerRecord } from '../../../../shared/steer'
import { REVIEW_PART_TYPE, REVIEW_TOOL_ID, readReviewRecord } from '../../../../shared/review-request'
import { ReviewRequestCard } from './ReviewRequestCard'
import { SteerInstructionView } from './SteerInstruction'
import { BrokerKeyNeededCard } from './BrokerKeyNeededCard'
import { brokerKeyNeedsOf } from '../brokerKeyNeeds'
import {
  GROUP_PAGE_SIZE,
  getToolDisplayName,
  isRunningState,
  planParts,
  signaturePropsEqual,
  toolRowPropsEqual,
  visibleRunItems,
  type AgentItem,
  type RunItem,
  type ToolOrAgent,
  type ToolRow,
} from '../toolRows'

// Rendering of an assistant message's parts. Everything here is memoised with
// value-based equality: @ai-sdk/react structuredClones the streaming message
// on every chunk, so part objects are new references on every tick and a
// shallow React.memo would never hit. See toolRows.ts for the render plan.

function StreamingCursor() {
  return (
    <span className="inline-block w-0.5 h-4 bg-accent/70 ml-0.5 animate-pulse-soft align-middle" />
  )
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const TOOL_ICONS: Record<string, React.ComponentType<any>> = {
  readFile: File,
  writeFile: PencilSimple,
  listDirectory: FolderOpen,
  executeCommand: Terminal,
  readSkillFile: File,
  Agent: Robot,
  Task: Robot,
  AskUserQuestion: ListChecks,
  mcp__acb_ask__ask_user: ListChecks,
  [REVIEW_TOOL_ID]: Eye,
}

function StatusIcon({ state }: { state: string }) {
  if (isRunningState(state)) return <CircleNotch size={14} className="animate-spin text-accent flex-shrink-0" />
  if (state === 'output-available') return <Check size={14} weight="bold" className="text-green-500 flex-shrink-0" />
  if (state === 'output-error') return <WarningCircle size={14} weight="fill" className="text-red-400 flex-shrink-0" />
  return <CircleNotch size={14} className="text-gray-400 flex-shrink-0" />
}

function ToolOutputDetail({ row }: { row: ToolRow }) {
  return (
    <div className="mt-1 ml-8 text-xs animate-slide-up">
      {row.state === 'output-error' && row.errorText && (
        <div className="p-2 rounded-md bg-red-500/10 border border-red-500/20 text-red-400 font-mono whitespace-pre-wrap">
          {row.errorText}
        </div>
      )}
      {row.state === 'output-available' && row.output != null && (
        <div className="p-2 rounded-md bg-gray-50 dark:bg-zinc-800/50 border border-gray-200 dark:border-zinc-700 text-gray-600 dark:text-zinc-400 font-mono whitespace-pre-wrap max-h-48 overflow-auto">
          {typeof row.output === 'string' ? row.output : JSON.stringify(row.output, null, 2)}
        </div>
      )}
    </div>
  )
}

const ToolInvocationPartView = memo(function ToolInvocationPartView({ row }: { row: ToolRow }) {
  const [isExpanded, setIsExpanded] = useState(false)
  const IconComponent = TOOL_ICONS[row.toolName] || Terminal
  const displayName = getToolDisplayName(row.toolName)
  const isFinished = row.state === 'output-available' || row.state === 'output-error'

  const reference = referenceFromTool(row.toolName, row.output)
  if (reference) return <ConsultationReferenceLink reference={reference} />

  return (
    <div className="my-1.5 animate-fade-in">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex items-center gap-2 text-xs hover:bg-gray-100 dark:hover:bg-zinc-800 px-2 py-1.5 rounded-lg transition-colors w-full text-left"
      >
        <StatusIcon state={row.state} />
        <IconComponent size={14} className="text-gray-500 dark:text-zinc-400 flex-shrink-0" />
        <span className="font-medium text-gray-700 dark:text-zinc-300">{displayName}</span>
        {row.inputSummary && (
          <span className="text-gray-400 dark:text-zinc-500 font-mono truncate max-w-[200px]">
            {row.inputSummary}
          </span>
        )}
        {isFinished && (
          <CaretDown
            size={12}
            className={`text-gray-400 ml-auto transition-transform ${isExpanded ? 'rotate-180' : ''}`}
          />
        )}
      </button>
      {isExpanded && isFinished && <ToolOutputDetail row={row} />}
    </div>
  )
}, toolRowPropsEqual)

function ToolCountLabel({ count, running }: { count: number; running: number }) {
  const { t } = useTranslation()
  return (
    <span className="text-gray-400 dark:text-zinc-500 flex-shrink-0">
      {t('chat.toolCount', { n: count })}
      {running > 0 && t('chat.toolRunningCount', { n: running })}
    </span>
  )
}

/**
 * The running subagent's latest one-line progress (agentProgressSummaries,
 * shared/agent-progress.ts) under its row. Gone once the subagent finishes.
 */
function AgentProgressLine({ toolCallId }: { toolCallId: string }) {
  const summary = useAgentProgress(toolCallId)
  if (!summary) return null
  return (
    <div className="ml-[3.25rem] -mt-0.5 mb-1 pr-2 text-[11px] text-gray-500 dark:text-zinc-400 truncate animate-fade-in" title={summary}>
      {summary}
    </div>
  )
}

/** A subagent's own row: collapsed by default; expands to its inner calls. */
const AgentToolGroup = memo(function AgentToolGroup({ item }: { item: AgentItem }) {
  const { t } = useTranslation()
  const [isExpanded, setIsExpanded] = useState(false)
  const [shown, setShown] = useState(GROUP_PAGE_SIZE)
  const { row, children } = item
  const hidden = Math.max(0, children.length - shown)
  const isFinished = row.state === 'output-available' || row.state === 'output-error'

  return (
    <div className="my-1.5 animate-fade-in">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        aria-expanded={isExpanded}
        className="flex items-center gap-2 text-xs hover:bg-gray-100 dark:hover:bg-zinc-800 px-2 py-1.5 rounded-lg transition-colors w-full text-left"
      >
        <StatusIcon state={row.state} />
        <Robot size={14} className="text-gray-500 dark:text-zinc-400 flex-shrink-0" />
        <span className="font-medium text-gray-700 dark:text-zinc-300 flex-shrink-0">{t('chat.subagent')}</span>
        {item.description && (
          <span className="text-gray-500 dark:text-zinc-400 truncate">{item.description}</span>
        )}
        <ToolCountLabel count={item.toolCount} running={item.runningCount} />
        <CaretDown
          size={12}
          className={`text-gray-400 ml-auto flex-shrink-0 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
        />
      </button>
      {isRunningState(row.state) && <AgentProgressLine toolCallId={row.toolCallId} />}
      {isExpanded && (
        <div className="ml-4 pl-2 border-l border-gray-200 dark:border-zinc-700/60">
          {hidden > 0 && (
            <button
              onClick={() => setShown(shown + GROUP_PAGE_SIZE)}
              className="my-1 px-2 py-1 text-xs text-accent hover:underline"
            >
              {t('chat.showMoreTools', { n: hidden })}
            </button>
          )}
          {children.slice(-shown).map(renderToolItem)}
          {isFinished && <ToolOutputDetail row={row} />}
        </div>
      )}
    </div>
  )
}, signaturePropsEqual)

function renderToolItem(item: ToolOrAgent) {
  return item.kind === 'agent'
    ? <AgentToolGroup key={item.key} item={item} />
    : <ToolInvocationPartView key={item.key} row={item.row} />
}

/**
 * A run of consecutive top-level tool rows. Short runs render their rows
 * unchanged. A run longer than RUN_COLLAPSE_THRESHOLD shows the latest few
 * rows, anything still running and every subagent group behind a summary row
 * that expands to the whole run. Both cases return one flat keyed array, so a
 * run that crosses the threshold keeps its rows mounted.
 */
const ToolRunGroup = memo(function ToolRunGroup({ item }: { item: RunItem }) {
  const { t } = useTranslation()
  const [isExpanded, setIsExpanded] = useState(false)
  if (!item.collapsible) return <>{item.items.map(renderToolItem)}</>

  const visible = isExpanded ? item.items : visibleRunItems(item.items)
  const hidden = item.items.length - visible.length
  const summary = (
    <button
      key="__run-summary"
      onClick={() => setIsExpanded(!isExpanded)}
      aria-expanded={isExpanded}
      className="my-1.5 flex items-center gap-2 text-xs hover:bg-gray-100 dark:hover:bg-zinc-800 px-2 py-1.5 rounded-lg transition-colors w-full text-left"
    >
      <Terminal size={14} className="text-gray-500 dark:text-zinc-400 flex-shrink-0" />
      <ToolCountLabel count={item.items.length} running={item.runningCount} />
      <span className="text-accent">
        {isExpanded ? t('chat.collapseTools') : t('chat.showHiddenTools', { n: hidden })}
      </span>
      {isExpanded ? (
        <CaretUp size={12} className="text-gray-400 ml-auto flex-shrink-0" />
      ) : (
        <CaretDown size={12} className="text-gray-400 ml-auto flex-shrink-0" />
      )}
    </button>
  )
  return <>{[summary, ...visible.map(renderToolItem)]}</>
}, signaturePropsEqual)

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
        if (part.type === STEER_PART_TYPE) {
          const record = readSteerRecord((part as { data?: unknown }).data)
          return record ? <SteerInstructionView key={item.key} record={record} /> : null
        }
        if (part.type === 'step-start') {
          return <div key={item.key} className="my-2 border-t border-gray-200 dark:border-zinc-700/50" />
        }
        return null
      })}
      {keyNeeds.map(service => <BrokerKeyNeededCard key={`key-needed:${service}`} service={service} />)}
    </>
  )
}
