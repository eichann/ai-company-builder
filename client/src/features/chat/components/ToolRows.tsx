import { memo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
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
  Sparkle,
  Terminal,
  WarningCircle,
  Wrench,
} from '@phosphor-icons/react'
import { referenceFromTool } from '../../../../shared/consultation-reference'
import { REVIEW_TOOL_ID } from '../../../../shared/review-request'
import { manyLine } from '../../../../shared/tool-display'
import { ConsultationReferenceLink } from './ConsultationReference'
import { useAgentProgress } from '../agentStatusStore'
import { documentToViewOf } from '../documentLink'
import { runCommand, useCommandAvailable } from '../../../shared/commands/commands'
import { useAppStore } from '../../../stores/appStore'
import {
  GROUP_PAGE_SIZE,
  isRunningState,
  signaturePropsEqual,
  toolRowPropsEqual,
  visibleRunItems,
  type AgentItem,
  type RunItem,
  type SameItem,
  type ToolOrAgent,
  type ToolRow,
} from '../toolRows'

// The tool rows of an assistant message (chat-ui-and-history.md 「Tool rows」): plain-Japanese
// lines, subagent groups, same-tool groups and collapsed runs. Memoised by value: @ai-sdk/react
// structuredClones the streaming message on every chunk. See toolRows.ts for the render plan.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const TOOL_ICONS: Record<string, React.ComponentType<any>> = {
  Read: File,
  Write: PencilSimple,
  Edit: PencilSimple,
  MultiEdit: PencilSimple,
  Bash: Terminal,
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
  if (isRunningState(state)) return <CircleNotch size={14} className="animate-spin text-primary flex-shrink-0" />
  if (state === 'output-available') return <Check size={14} weight="bold" className="text-success-icon flex-shrink-0" />
  if (state === 'output-error') return <WarningCircle size={14} weight="fill" className="text-danger-icon flex-shrink-0" />
  return <CircleNotch size={14} className="text-text-subtle flex-shrink-0" />
}

function ToolOutputDetail({ row }: { row: ToolRow }) {
  const { t } = useTranslation()
  return (
    <div className="mt-1 ml-8 text-xs animate-slide-up">
      {row.line.technical && (
        <div className="mb-1 text-text-muted">{t('chat.toolTechnicalName', { name: row.line.technical })}</div>
      )}
      {row.state === 'output-error' && row.errorText && (
        <div className="p-2 rounded-control bg-danger-bg border border-danger-border text-danger-text font-mono whitespace-pre-wrap">
          {row.errorText}
        </div>
      )}
      {row.state === 'output-available' && row.output != null && (
        <div className="p-2 rounded-control bg-bg border border-[color:var(--color-border)] text-text-muted font-mono whitespace-pre-wrap max-h-48 overflow-auto">
          {typeof row.output === 'string' ? row.output : JSON.stringify(row.output, null, 2)}
        </div>
      )}
    </div>
  )
}

/** What a row says: the running / finished line, or 「できませんでした：<the app's reason>」. */
function rowText(row: ToolRow, failed: string): string {
  if (row.failure) return row.failure.reason ? `${failed}：${row.failure.reason}` : failed
  return isRunningState(row.state) ? row.line.running : row.line.label
}

const ToolInvocationPartView = memo(function ToolInvocationPartView({ row }: { row: ToolRow }) {
  const { t } = useTranslation()
  const [isExpanded, setIsExpanded] = useState(false)
  const IconComponent = TOOL_ICONS[row.toolName] || (row.line.muted ? Wrench : Sparkle)
  const isFinished = row.state === 'output-available' || row.state === 'output-error'
  // ［見る］ only where an editor can show it (not in a consultation's own window).
  const canView = useCommandAvailable('editor.viewDocument')
  const rootPath = useAppStore(state => state.currentCompany?.rootPath)
  const documentPath = canView ? documentToViewOf(row, rootPath) : null

  const reference = referenceFromTool(row.toolName, row.output)
  if (reference) return <ConsultationReferenceLink reference={reference} />

  const muted = row.line.muted && !row.failure
  return (
    <div className="my-1.5">
      <div className="flex items-center gap-1 min-w-0">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        title={row.line.label}
        className="flex items-center gap-2 text-small hover:bg-surface-sunken px-2 py-1.5 rounded-control transition-colors flex-1 min-w-0 text-left"
      >
        <StatusIcon state={row.failure ? 'output-error' : row.state} />
        <IconComponent size={14} className="text-text-muted flex-shrink-0" />
        <span className={`min-w-0 truncate ${row.failure ? 'font-medium text-danger-text' : muted ? 'text-text-muted' : 'font-medium text-text'}`}>
          {rowText(row, t('chat.toolFailed'))}
        </span>
        {row.line.detail && (
          <span className="text-text-muted truncate max-w-[240px]">
            {row.line.detail}
          </span>
        )}
        {isFinished && (
          <CaretDown
            size={12}
            className={`text-text-subtle ml-auto transition-transform ${isExpanded ? 'rotate-180' : ''}`}
          />
        )}
      </button>
      {documentPath && (
        <button
          type="button"
          onClick={() => void runCommand('editor.viewDocument', { path: documentPath })}
          title="この HTML の資料を真ん中のタブで見ます"
          className="flex-shrink-0 inline-flex items-center gap-1 h-control-sm px-control-sm-x rounded-control text-small text-link hover:bg-selected-bg focus-visible:outline-none focus-visible:ring-focus focus-visible:ring-focus-ring"
        >
          <Eye size={13} aria-hidden />見る
        </button>
      )}
      </div>
      {isExpanded && isFinished && <ToolOutputDetail row={row} />}
    </div>
  )
}, toolRowPropsEqual)

function ToolCountLabel({ count, running }: { count: number; running: number }) {
  const { t } = useTranslation()
  return (
    <span className="text-text-muted flex-shrink-0">
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
    <div className="ml-[3.25rem] -mt-0.5 mb-1 pr-2 text-caption font-normal text-text-muted truncate" title={summary}>
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
    <div className="my-1.5">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        aria-expanded={isExpanded}
        className="flex items-center gap-2 text-small hover:bg-surface-sunken px-2 py-1.5 rounded-control transition-colors w-full text-left"
      >
        <StatusIcon state={row.state} />
        <Robot size={14} className="text-text-muted flex-shrink-0" />
        <span className="font-medium text-text flex-shrink-0">{t('chat.subagent')}</span>
        {item.description && (
          <span className="text-text-muted truncate">{item.description}</span>
        )}
        <ToolCountLabel count={item.toolCount} running={item.runningCount} />
        <CaretDown
          size={12}
          className={`text-text-subtle ml-auto flex-shrink-0 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
        />
      </button>
      {isRunningState(row.state) && <AgentProgressLine toolCallId={row.toolCallId} />}
      {isExpanded && (
        <div className="ml-4 pl-2 border-l border-[color:var(--color-border)]">
          {hidden > 0 && (
            <button
              onClick={() => setShown(shown + GROUP_PAGE_SIZE)}
              className="my-1 px-2 py-1 text-xs text-link hover:underline"
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

/** Consecutive finished calls of one tool: 「決めたことを 2 件残しました」, expanding to each call. */
const SameToolGroup = memo(function SameToolGroup({ item }: { item: SameItem }) {
  const [isExpanded, setIsExpanded] = useState(false)
  const { row } = item
  const IconComponent = TOOL_ICONS[row.toolName] || (row.line.muted ? Wrench : Sparkle)
  return (
    <div className="my-1.5">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        aria-expanded={isExpanded}
        className="flex items-center gap-2 text-small hover:bg-surface-sunken px-2 py-1.5 rounded-control transition-colors w-full text-left"
      >
        <StatusIcon state={row.state} />
        <IconComponent size={14} className="text-text-muted flex-shrink-0" />
        <span className={`min-w-0 truncate ${row.line.muted ? 'text-text-muted' : 'font-medium text-text'}`}>
          {manyLine(row.line, item.rows.length)}
        </span>
        <CaretDown size={12} className={`text-text-subtle ml-auto flex-shrink-0 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
      </button>
      {isExpanded && (
        <div className="ml-4 pl-2 border-l border-[color:var(--color-border)]">
          {item.rows.map(r => <ToolInvocationPartView key={r.toolCallId} row={r} />)}
        </div>
      )}
    </div>
  )
}, signaturePropsEqual)

function renderToolItem(item: ToolOrAgent) {
  if (item.kind === 'agent') return <AgentToolGroup key={item.key} item={item} />
  if (item.kind === 'same') return <SameToolGroup key={item.key} item={item} />
  return <ToolInvocationPartView key={item.key} row={item.row} />
}

/**
 * A run of consecutive top-level tool rows. Short runs render their rows
 * unchanged. A run longer than RUN_COLLAPSE_THRESHOLD shows the latest few
 * rows, anything still running and every subagent group behind a summary row
 * that expands to the whole run. Both cases return one flat keyed array, so a
 * run that crosses the threshold keeps its rows mounted.
 */
export const ToolRunGroup = memo(function ToolRunGroup({ item }: { item: RunItem }) {
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
      className="my-1.5 flex items-center gap-2 text-small hover:bg-surface-sunken px-2 py-1.5 rounded-control transition-colors w-full text-left"
    >
      <ListChecks size={14} className="text-text-muted flex-shrink-0" />
      <ToolCountLabel count={item.items.reduce((n, i) => n + (i.kind === 'same' ? i.rows.length : 1), 0)} running={item.runningCount} />
      <span className="text-link">
        {isExpanded ? t('chat.collapseTools') : t('chat.showHiddenTools', { n: hidden })}
      </span>
      {isExpanded ? (
        <CaretUp size={12} className="text-text-subtle ml-auto flex-shrink-0" />
      ) : (
        <CaretDown size={12} className="text-text-subtle ml-auto flex-shrink-0" />
      )}
    </button>
  )
  return <>{[summary, ...visible.map(renderToolItem)]}</>
}, signaturePropsEqual)
