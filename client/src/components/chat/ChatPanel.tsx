import { OpenConsultationContext } from './consultation-context'
import { referenceFromTool, type ConsultationReference } from '../../../shared/consultation-reference'
import { restoreTextWithChoices, storedChoiceFromPart, storedSteerFromPart, type StoredChoicePrompt, type StoredSteer } from './choiceHistory'
import { HandoffControl } from './HandoffControl'
import { AgentInteractionCard } from './AgentInteractionCard'
import type { AgentInteractionRequest } from '../../../shared/agent-interaction'
import { CODEX_LOGIN_HELP } from '../../../shared/agent'
import type { AgentSession, CodexStatus } from '../../../shared/agent'
import { DEFAULT_PERMISSION_MODE, type PermissionMode } from '../../../shared/permission-mode'
import { VoiceShortcutSettings } from '../settings/VoiceShortcutSettings'
import { VoiceInputControl } from './VoiceInputControl'
import { ghostSuggestion, handleGhostKey, setSuggestion } from './ghostSuggestion'
import { canOfferSuggestion, shouldRequestSuggestion, suggestionDescription } from './promptSuggestion'
import { promptSuggestionSetting } from '../../lib/promptSuggestionSetting'
import { normalizeSuggestion } from '../../../shared/prompt-suggestion'
import { STEER_PART_TYPE, canSteerText, type SteerResponse } from '../../../shared/steer'
import { useState, useEffect, useLayoutEffect, useRef, useCallback, memo, useMemo, useId } from 'react'
import { useTranslation } from 'react-i18next'
import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport, type UIMessage } from 'ai'
import { history, historyKeymap, isolateHistory } from '@codemirror/commands'
import { Compartment, EditorState, Transaction } from '@codemirror/state'
import { EditorView, keymap, placeholder as codeMirrorPlaceholder } from '@codemirror/view'
import {
  Sparkle,
  GearSix,
  Check,
  Lightning,
  CircleNotch,
  CaretDown,
  ArrowUp,
  CaretUp,
  Plus,
  SidebarSimple,
  X,
  File,
  PencilSimple,
  MarkdownLogo,
  ArrowCounterClockwise,
  ShieldWarning,
  ClockCountdown,
} from '@phosphor-icons/react'
import { useAppStore, MODEL_EFFORT_OPTIONS, CLAUDE_MODELS, type AIModel, type AIEffort } from '../../stores/appStore'
import { isPerfCutEnabled, isPerfDiagnosticsEnabled, perfMark, perfMeasure } from '../../lib/perfDiagnostics'
import { SlashCommandDropdown, type SlashCommandItem } from './SlashCommandDropdown'
import { markChatInputActivity } from '../../lib/chatInputActivity'
import { AssistantMessageParts } from './MessageParts'
import { RateLimitMeter } from './RateLimitMeter'
import { reportAgentProgress, setRateLimits } from './agentStatusStore'
import { RATE_LIMITS_PART_TYPE, type RateLimitSnapshot } from '../../../shared/rate-limits'
import { AGENT_PROGRESS_PART_TYPE, readAgentProgress } from '../../../shared/agent-progress'
import { getToolDisplayName } from './toolRows'
import { ChatSidebar } from './ChatSidebar'
import { earlierAnchor, windowStart } from './messageWindow'
import { streamThrottleMs } from './markdownBlocks'
import { historyThumbnail } from './historyThumbnail'
import { useAuthStore } from '../../stores/authStore'
import type { ChatSession } from '../../../shared/chat-history'

// ============================================================================
// Types
// ============================================================================

type AuthMode = 'claude-code' | 'codex' | 'api-key'

/** A message that waits for the running turn to end (see handleSend). */
interface QueuedSend {
  text: string
  files?: File[]
  filePaths?: string[]
  /** Its `data-steer` part, when the agent took it but did not read it in time. */
  steerPartId?: string
}

/** Push an extra instruction into the conversation's running turn (chat-server `/api/steer`). */
async function steerRunningTurn(server: { port: number; authToken: string }, appSessionId: string, text: string): Promise<SteerResponse> {
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/steer`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${server.authToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ appSessionId, text }),
    })
    const data = res.ok ? await res.json() as Partial<SteerResponse> : null
    return data?.status === 'delivered' || data?.status === 'not-delivered' ? { status: data.status, id: data.id } : { status: 'unavailable' }
  } catch {
    return { status: 'unavailable' }
  }
}

// ============================================================================
// Hooks
// ============================================================================

function useChatServerInfo() {
  const [info, setInfo] = useState<{ port: number; authToken: string } | null>(null)

  useEffect(() => {
    window.electronAPI.getChatServerInfo().then((result: { port: number; authToken: string } | null) => {
      if (result) setInfo(result)
    })
    const unsub = window.electronAPI.onChatServerInfo((serverInfo: { port: number; authToken: string }) => {
      setInfo(serverInfo)
    })
    return unsub
  }, [])

  return info
}

// ============================================================================
// Session Conversion (UIMessage <-> ChatSession)
// ============================================================================

function uiMessageToSessionMessage(
  msg: UIMessage,
  timestamp: Date,
): ChatSession['messages'][0] {
  let content = ''
  let thinking: string | undefined
  const consultationReferences: ConsultationReference[] = []
  const choicePrompts: StoredChoicePrompt[] = []
  const steerInstructions: StoredSteer[] = []
  for (const part of msg.parts) {
    const choice = storedChoiceFromPart(part as { type: string; data?: unknown }, content.length, choicePrompts)
    if (choice) { choicePrompts.push(choice); continue }
    const steer = storedSteerFromPart(part as { type: string; data?: unknown }, content.length, steerInstructions)
    if (steer) { steerInstructions.push(steer); continue }
    const p = part as { type: string; toolName?: string; output?: unknown; data?: ConsultationReference }
    const ref = p.type === 'data-consultation-reference' ? p.data : referenceFromTool(p.toolName || p.type.replace(/^tool-/, ''), p.output)
    if (ref && !consultationReferences.some(r => r.id === ref.id)) consultationReferences.push(ref)
    if (part.type === 'text') content += part.text
    if (part.type === 'reasoning') thinking = (thinking || '') + part.text
    // Summarize tool invocations as text
    if (typeof part.type === 'string' && part.type.startsWith('tool-')) {
      const toolName = part.type.replace('tool-', '')
      content += `\n[Tool: ${toolName}]`
    }
    if (part.type === 'dynamic-tool') {
      const dynPart = part as { toolName: string }
      content += `\n[Tool: ${dynPart.toolName}]`
    }
  }
  return {
    id: msg.id,
    role: msg.role as 'user' | 'assistant',
    content,
    timestamp: timestamp.toISOString(),
    thinking,
    ...(consultationReferences.length ? { consultationReferences } : {}),
    ...(choicePrompts.length ? { choicePrompts } : {}),
    ...(steerInstructions.length ? { steerInstructions } : {}),
  }
}

// Converted messages, per UIMessage object: while a reply streams only its own
// object changes (@ai-sdk/react replaces just the last message), so an
// autosave converts one message instead of the whole conversation.
const sessionMessageCache = new WeakMap<UIMessage, { at: number; images?: string[]; referenceFiles?: string[]; value: ChatSession['messages'][0] }>()

function sessionMessageFor(msg: UIMessage, timestamp: Date, images?: string[], referenceFiles?: string[]): ChatSession['messages'][0] {
  const cached = sessionMessageCache.get(msg)
  if (cached && cached.at === timestamp.getTime() && cached.images === images && cached.referenceFiles === referenceFiles) return cached.value
  const value = {
    ...uiMessageToSessionMessage(msg, timestamp),
    ...(images ? { images } : {}),
    ...(referenceFiles ? { referenceFiles } : {}),
  }
  sessionMessageCache.set(msg, { at: timestamp.getTime(), images, referenceFiles, value })
  return value
}

/** Autosave cadence (was 1 s; every tick re-serialised whole conversations in every tab). */
const AUTOSAVE_INTERVAL_MS = 4000

function sameSaveInputs(a: unknown[] | null, b: unknown[]): boolean {
  return !!a && a.length === b.length && a.every((value, i) => Object.is(value, b[i]))
}

function sessionMessageToUIMessage(
  msg: ChatSession['messages'][0],
): UIMessage {
  const parts: UIMessage['parts'] = []
  if (msg.thinking) {
    parts.push({ type: 'reasoning' as const, text: msg.thinking })
  }
  // Answered (or closed) choice prompts come back collapsed, with the member's answer, where they were asked.
  parts.push(...restoreTextWithChoices(msg.content, msg.choicePrompts, msg.steerInstructions))
  for (const ref of msg.consultationReferences || []) parts.push({ type: 'data-consultation-reference', data: ref })
  return {
    id: msg.id,
    role: msg.role as 'user' | 'assistant',
    parts,
  }
}

// ============================================================================
// Utility Components
// ============================================================================

function ThinkingIndicator() {
  return (
    <div className="flex items-center gap-1.5 py-1">
      <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse-soft" style={{ animationDelay: '0ms' }} />
      <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse-soft" style={{ animationDelay: '300ms' }} />
      <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse-soft" style={{ animationDelay: '600ms' }} />
    </div>
  )
}

// Tool rows, subagent groups, thinking and text parts: see MessageParts.tsx.

// ============================================================================
// Tool Approval Banner
// ============================================================================

interface ToolApprovalRequest {
  toolUseId: string
  toolName: string
  toolInput: Record<string, unknown>
  /** Why the app asks (e.g. private content read in this conversation). */
  reason?: string
}

function ToolApprovalBanner({
  request,
  onRespond,
}: {
  request: ToolApprovalRequest
  onRespond: (toolUseId: string, approved: boolean) => void
}) {
  const { t } = useTranslation()

  const displayName = getToolDisplayName(request.toolName) || request.toolName
  let inputSummary = ''
  if (request.toolInput) {
    const input = request.toolInput
    const first = [input.command, input.file_path, input.notebook_path, input.path, input.url, input.query].find(v => typeof v === 'string' && v)
    if (first) inputSummary = String(first)
  }

  return (
    <div className="flex-shrink-0 px-4 py-3 bg-amber-500/10 border-b border-amber-500/20 animate-fade-in">
      <div className="flex items-start gap-3">
        <ShieldWarning size={18} weight="fill" className="text-amber-400 flex-shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-amber-300 mb-1">
            {t('chat.toolApprovalTitle')}
          </div>
          {request.reason && (
            <div className="text-xs text-amber-700 dark:text-amber-200 mb-1 whitespace-pre-wrap">
              {request.reason}
            </div>
          )}
          <div className="text-xs text-gray-600 dark:text-zinc-300 font-medium">
            {displayName}
          </div>
          {inputSummary && (
            <div className="text-xs text-gray-500 dark:text-zinc-400 font-mono truncate mt-0.5">
              {inputSummary}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            onClick={() => onRespond(request.toolUseId, false)}
            className="px-3 py-1.5 text-xs font-medium rounded-lg border border-gray-300 dark:border-zinc-600 text-gray-600 dark:text-zinc-300 hover:bg-gray-100 dark:hover:bg-zinc-700 transition-colors"
          >
            {t('chat.toolApprovalDeny')}
          </button>
          <button
            onClick={() => onRespond(request.toolUseId, true)}
            className="px-3 py-1.5 text-xs font-medium rounded-lg bg-accent text-white hover:bg-accent/90 transition-colors"
          >
            {t('chat.toolApprovalAllow')}
          </button>
        </div>
      </div>
    </div>
  )
}

// ============================================================================
// User Message Bubble (with edit support)
// ============================================================================

function UserMessageBubble({
  message,
  images,
  referenceFiles,
  canEdit,
  onEditSubmit,
}: {
  message: UIMessage
  images?: string[]
  referenceFiles?: string[]
  canEdit: boolean
  onEditSubmit?: (messageId: string, newText: string) => void
}) {
  const { t } = useTranslation()
  const [isEditing, setIsEditing] = useState(false)
  const [editText, setEditText] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [showAllFiles, setShowAllFiles] = useState(false)
  const VISIBLE_FILE_COUNT = 3

  const originalText = message.parts
    .filter((p): p is Extract<typeof p, { type: 'text' }> => p.type === 'text')
    .map(p => p.text)
    .join('')

  const startEdit = () => {
    setEditText(originalText)
    setIsEditing(true)
  }

  useEffect(() => {
    if (isEditing && textareaRef.current) {
      textareaRef.current.focus()
      textareaRef.current.setSelectionRange(editText.length, editText.length)
    }
  }, [isEditing])

  const submitEdit = () => {
    const trimmed = editText.trim()
    if (trimmed && trimmed !== originalText && onEditSubmit) {
      onEditSubmit(message.id, trimmed)
    }
    setIsEditing(false)
  }

  const handleEditKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setIsEditing(false)
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      submitEdit()
    }
  }

  if (isEditing) {
    return (
      <div className="animate-fade-in">
        <textarea
          ref={textareaRef}
          value={editText}
          onChange={(e) => setEditText(e.target.value)}
          onKeyDown={handleEditKeyDown}
          className="w-full rounded-2xl rounded-br-md px-4 py-3 text-[14px] leading-relaxed bg-accent/20 text-gray-900 dark:text-zinc-100 border border-accent/50 resize-y outline-none focus:border-accent min-h-[60px] max-h-[200px]"
          rows={3}
        />
        <div className="flex justify-end gap-2 mt-1.5">
          <button
            onClick={() => setIsEditing(false)}
            className="px-3 py-1 text-xs rounded-md text-gray-500 dark:text-zinc-400 hover:bg-gray-100 dark:hover:bg-zinc-800 transition-colors"
          >
            {t('chat.cancelEdit')}
          </button>
          <button
            onClick={submitEdit}
            disabled={!editText.trim() || editText.trim() === originalText}
            className="px-3 py-1 text-xs rounded-md bg-accent text-white hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {t('chat.resend')}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="group relative">
      {/* Reference files indicator */}
      {referenceFiles && referenceFiles.length > 0 && (
        <div className="mb-1.5 flex justify-end">
          <div className="flex flex-wrap justify-end gap-1 max-w-[85%]">
            {(showAllFiles ? referenceFiles : referenceFiles.slice(0, VISIBLE_FILE_COUNT)).map((filePath, i) => (
              <span
                key={i}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] bg-accent/15 text-accent dark:bg-accent/20 dark:text-accent/90 border border-accent/20"
                title={filePath}
              >
                <File size={10} className="flex-shrink-0" />
                <span className="truncate max-w-[150px]">{filePath.split('/').pop()}</span>
              </span>
            ))}
            {referenceFiles.length > VISIBLE_FILE_COUNT && !showAllFiles && (
              <button
                onClick={() => setShowAllFiles(true)}
                className="inline-flex items-center px-2 py-0.5 rounded-md text-[11px] bg-accent/10 text-accent/70 hover:bg-accent/20 transition-colors"
              >
                +{referenceFiles.length - VISIBLE_FILE_COUNT}
              </button>
            )}
            {showAllFiles && referenceFiles.length > VISIBLE_FILE_COUNT && (
              <button
                onClick={() => setShowAllFiles(false)}
                className="inline-flex items-center px-2 py-0.5 rounded-md text-[11px] bg-accent/10 text-accent/70 hover:bg-accent/20 transition-colors"
              >
                <CaretUp size={10} />
              </button>
            )}
          </div>
        </div>
      )}
      <div className="relative rounded-2xl px-4 py-3 text-[14px] leading-relaxed bg-accent text-white rounded-br-md">
        {images && images.length > 0 && (
          <div className="flex gap-1.5 mb-2 flex-wrap">
            {images.map((url, i) => (
              <img
                key={i}
                src={url}
                alt=""
                className="w-20 h-20 object-cover rounded-lg border border-white/20"
              />
            ))}
          </div>
        )}
        <div className="relative whitespace-pre-wrap break-words">
          {originalText}
        </div>
      </div>
      {canEdit && (
        <button
          onClick={startEdit}
          className="absolute -left-8 top-1/2 -translate-y-1/2 p-1 rounded-md opacity-0 group-hover:opacity-100 text-gray-400 hover:text-gray-600 dark:hover:text-zinc-300 hover:bg-gray-100 dark:hover:bg-zinc-800 transition-all"
          title={t('chat.edit')}
        >
          <PencilSimple size={14} />
        </button>
      )}
    </div>
  )
}

// ============================================================================
// Message Component (Parts-based rendering)
// ============================================================================

interface MessageItemProps {
  message: UIMessage
  isStreaming: boolean
  timestamp?: Date
  images?: string[]
  referenceFiles?: string[]
  isLastAssistant?: boolean
  canRegenerate?: boolean
  onRegenerate?: () => void
  canEdit?: boolean
  onEditSubmit?: (messageId: string, newText: string) => void
  /** Skip layout and paint while scrolled out of view (older messages only). */
  deferOffscreen?: boolean
}

const MessageItem = memo(function MessageItem({ message, isStreaming, timestamp, images, referenceFiles, isLastAssistant, canRegenerate, onRegenerate, canEdit, onEditSubmit, deferOffscreen }: MessageItemProps) {
  const { t } = useTranslation()
  const isUser = message.role === 'user'
  const markdownRender = useAppStore((s) => s.chatMarkdownRender)

  return (
    // content-visibility: older messages scrolled out of view skip layout and
    // paint (their last rendered height is remembered). The latest ones never
    // do: opening a conversation scrolls to the bottom, and estimated heights
    // there would leave it short of the end.
    <div className={`animate-slide-up ${deferOffscreen ? '[content-visibility:auto] [contain-intrinsic-size:auto_160px]' : ''} ${isUser ? 'flex justify-end' : ''}`}>
      {/* Assistant replies use the full row (the list's px-4 gutter on both
          sides); only the member's own bubbles stay narrower, aligned right. */}
      <div className={isUser ? 'max-w-[85%] ml-auto' : 'min-w-0'}>
        {/* Role indicator for assistant */}
        {!isUser && (
          <div className="flex items-center gap-2 mb-2">
            <div className="w-5 h-5 rounded-md bg-gradient-to-br from-accent to-accent/70 flex items-center justify-center shadow-glow">
              <Sparkle size={11} weight="fill" className="text-white" />
            </div>
            <span className="text-[11px] font-medium tracking-wide uppercase text-gray-500 dark:text-zinc-400">
              {t('chat.assistant')}
            </span>
          </div>
        )}

        {/* Parts rendering for assistant */}
        {!isUser && <AssistantMessageParts parts={message.parts} isStreaming={isStreaming} markdown={markdownRender} />}

        {/* User message */}
        {isUser && (
          <UserMessageBubble
            message={message}
            images={images}
            referenceFiles={referenceFiles}
            canEdit={!!canEdit}
            onEditSubmit={onEditSubmit}
          />
        )}

        {/* Timestamp + action buttons */}
        {timestamp && (
          <div className={`mt-1.5 flex items-center gap-1 text-[10px] text-gray-400 dark:text-zinc-500 ${isUser ? 'justify-end' : ''}`}>
            <span>{timestamp.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}</span>
            {!isUser && isLastAssistant && canRegenerate && (
              <button
                onClick={onRegenerate}
                className="p-0.5 rounded hover:bg-gray-100 dark:hover:bg-zinc-800 text-gray-400 hover:text-gray-600 dark:hover:text-zinc-300 transition-colors"
                title={t('chat.regenerate')}
              >
                <ArrowCounterClockwise size={12} />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
})

// ============================================================================
// Input Component (Optimized - uncontrolled textarea for maximum performance)
// ============================================================================

interface ChatInputApi {
  focus: () => void
  captureInsertion: () => (text: string) => boolean
  getValue: () => string
  setValue: (text: string) => void
}

interface ChatInputProps {
  initialDraft?: string
  onDraftChange?: (text: string) => void
  keepCursor?: boolean
  voiceActive?: boolean
  voiceScope?: string
  onSend: (text: string, files?: File[], filePaths?: string[]) => void
  disabled: boolean
  placeholder: string
  hint: string
  onCompositionStateChange?: (isComposing: boolean) => void
  onInputActivity?: () => void
  pendingText?: string | null
  onPendingTextConsumed?: () => void
  slashCommands?: SlashCommandItem[]
  apiRef?: React.MutableRefObject<ChatInputApi | null>
  /** Next-prompt suggestion shown as ghost text (promptSuggestion.ts). */
  suggestion?: string | null
  /** The input dropped the suggestion (typed past it, accepted, Esc). */
  onSuggestionCleared?: () => void
}

const chatInputCodeMirrorTheme = EditorView.theme({
  '&': {
    backgroundColor: 'transparent',
    color: 'inherit',
    width: '100%',
  },
  '&.cm-editor': {
    outline: 'none',
  },
  '&.cm-editor.cm-focused': {
    outline: 'none',
  },
  '.cm-scroller': {
    minHeight: '40px',
    maxHeight: '200px',
    overflow: 'auto',
    fontFamily: 'inherit',
  },
  '.cm-content': {
    padding: '8px',
    minHeight: '40px',
    fontSize: '14px',
    lineHeight: '1.4',
  },
  '.cm-line': {
    padding: '0',
  },
  '.cm-placeholder': {
    color: 'currentColor',
    opacity: '0.5',
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: 'currentColor',
  },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
    backgroundColor: 'rgba(59, 130, 246, 0.28)',
  },
})

const CodeMirrorChatInput = memo(function CodeMirrorChatInput({
  keepCursor = false,
  initialDraft,
  onDraftChange,
  onSend,
  disabled,
  placeholder,
  hint,
  onCompositionStateChange,
  onInputActivity,
  pendingText,
  onPendingTextConsumed,
  slashCommands,
  apiRef,
  suggestion = null,
  onSuggestionCleared,
}: ChatInputProps) {
  const draftBufferRef = useRef(initialDraft ?? '')
  const onSuggestionClearedRef = useRef(onSuggestionCleared)
  onSuggestionClearedRef.current = onSuggestionCleared
  const suggestionId = useId()
  const describedByCompartmentRef = useRef(new Compartment())
  const onDraftChangeRef = useRef(onDraftChange)
  onDraftChangeRef.current = onDraftChange
  const editorHostRef = useRef<HTMLDivElement>(null)
  const editorViewRef = useRef<EditorView | null>(null)
  const onSendRef = useRef(onSend)
  const disabledRef = useRef(disabled)
  const onCompositionStateChangeRef = useRef(onCompositionStateChange)
  const onInputActivityRef = useRef(onInputActivity)
  const isComposingRef = useRef(false)
  const editableCompartmentRef = useRef(new Compartment())
  const placeholderCompartmentRef = useRef(new Compartment())

  // Slash command autocomplete state
  const [slashQuery, setSlashQuery] = useState<string | null>(null)
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0)
  const slashCommandsRef = useRef(slashCommands)
  useEffect(() => { slashCommandsRef.current = slashCommands }, [slashCommands])

  const filteredSlashCommands = useMemo(() => {
    if (slashQuery === null || !slashCommands?.length) return []
    if (slashQuery === '') return slashCommands
    const q = slashQuery.toLowerCase()
    return slashCommands.filter(item =>
      item.command.toLowerCase().includes(q) ||
      item.name.toLowerCase().includes(q)
    )
  }, [slashQuery, slashCommands])

  // Reset selection when filtered list changes
  useEffect(() => {
    setSlashSelectedIndex(0)
  }, [filteredSlashCommands.length])

  const handleSlashSelect = useCallback((item: SlashCommandItem) => {
    const view = editorViewRef.current
    if (!view) return
    const replacement = `/${item.command} `
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: replacement },
    })
    view.dispatch({ selection: { anchor: replacement.length } })
    view.focus()
    setSlashQuery(null)
  }, [])

  const handleSlashClose = useCallback(() => {
    setSlashQuery(null)
  }, [])

  // Refs for slash state accessible inside CodeMirror handlers
  const slashQueryRef = useRef<string | null>(null)
  const filteredSlashCommandsRef = useRef(filteredSlashCommands)
  const slashSelectedIndexRef = useRef(0)
  const handleSlashSelectRef = useRef(handleSlashSelect)
  useEffect(() => { slashQueryRef.current = slashQuery }, [slashQuery])
  useEffect(() => { filteredSlashCommandsRef.current = filteredSlashCommands }, [filteredSlashCommands])
  useEffect(() => { slashSelectedIndexRef.current = slashSelectedIndex }, [slashSelectedIndex])
  useEffect(() => { handleSlashSelectRef.current = handleSlashSelect }, [handleSlashSelect])

  const markDispatchDelay = useCallback((metricName: string, eventTimestamp: number) => {
    if (!isPerfDiagnosticsEnabled()) return
    let delay = performance.now() - eventTimestamp
    // React/Electron runtime may provide epoch-based timestamps on some event types.
    if (eventTimestamp > 1_000_000_000_000) {
      delay = Date.now() - eventTimestamp
    }
    if (delay >= 0 && delay < 60000) {
      perfMeasure(metricName, delay)
    }
  }, [])

  const handleSend = useCallback(() => {
    perfMark('chat.input.send_click')
    const view = editorViewRef.current
    if (!view || disabledRef.current) return

    const value = view.state.doc.toString().trim()
    if (!value) return

    onSendRef.current(value)
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: '' },
    })
    view.focus()
  }, [])

  useEffect(() => {
    onSendRef.current = onSend
  }, [onSend])

  useEffect(() => {
    disabledRef.current = disabled
  }, [disabled])

  useEffect(() => {
    onCompositionStateChangeRef.current = onCompositionStateChange
  }, [onCompositionStateChange])

  useEffect(() => {
    onInputActivityRef.current = onInputActivity
  }, [onInputActivity])

  useEffect(() => {
    const host = editorHostRef.current
    if (!host) return

    const editableCompartment = editableCompartmentRef.current
    const placeholderCompartment = placeholderCompartmentRef.current

    const state = EditorState.create({
      doc: draftBufferRef.current,
      extensions: [
        chatInputCodeMirrorTheme,
        history(),
        keymap.of(historyKeymap),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({
          spellcheck: 'false',
          autocorrect: 'off',
          autocapitalize: 'off',
          'data-gramm': 'false',
        }),
        editableCompartment.of([
          EditorView.editable.of(!disabledRef.current),
          EditorState.readOnly.of(disabledRef.current),
        ]),
        placeholderCompartment.of(codeMirrorPlaceholder(placeholder)),
        ghostSuggestion(() => onSuggestionClearedRef.current?.()),
        describedByCompartmentRef.current.of([]),
        EditorView.domEventHandlers({
          keydown: (event, view) => {
            onInputActivityRef.current?.()
            perfMark('chat.input.keydown')
            markDispatchDelay('chat.input.keydown.dispatch_delay.ms', event.timeStamp)

            // Next-prompt suggestion: → / Tab accept, Esc dismisses (Enter stays a new line).
            if (handleGhostKey(view, event)) return true

            // Intercept keys when slash command dropdown is open
            if (slashQueryRef.current !== null && filteredSlashCommandsRef.current.length > 0) {
              const items = filteredSlashCommandsRef.current
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setSlashSelectedIndex(i => (i + 1) % items.length)
                return true
              }
              if (event.key === 'ArrowUp') {
                event.preventDefault()
                setSlashSelectedIndex(i => (i - 1 + items.length) % items.length)
                return true
              }
              if (event.key === 'Tab') {
                event.preventDefault()
                const selected = items[slashSelectedIndexRef.current]
                if (selected) handleSlashSelectRef.current(selected)
                return true
              }
              // Enter / Cmd+Enter: close dropdown and let normal behavior through (newline / send)
              if (event.key === 'Enter') {
                setSlashQuery(null)
                return false
              }
              if (event.key === 'Escape') {
                event.preventDefault()
                setSlashQuery(null)
                return true
              }
            }

            if (isPerfDiagnosticsEnabled()) {
              const start = performance.now()
              window.requestAnimationFrame(() => {
                perfMeasure('chat.input.keydown_to_raf.ms', performance.now() - start)
              })
            }

            const isSendShortcut = event.key === 'Enter' && (event.metaKey || event.ctrlKey)
            if (!isSendShortcut) return false

            const isComposing = event.isComposing || event.keyCode === 229 || isComposingRef.current
            if (isComposing) {
              perfMark('chat.input.keydown.composing_skip')
              return false
            }

            event.preventDefault()
            handleSend()
            return true
          },
          input: (event) => {
            onInputActivityRef.current?.()
            perfMark('chat.input.input')
            markDispatchDelay('chat.input.input.dispatch_delay.ms', event.timeStamp)
            return false
          },
          compositionstart: (event) => {
            onInputActivityRef.current?.()
            isComposingRef.current = true
            onCompositionStateChangeRef.current?.(true)
            perfMark('chat.input.composition_start')
            markDispatchDelay('chat.input.composition.dispatch_delay.ms', event.timeStamp)
            return false
          },
          compositionupdate: (event) => {
            onInputActivityRef.current?.()
            perfMark('chat.input.composition_update')
            markDispatchDelay('chat.input.composition.dispatch_delay.ms', event.timeStamp)
            if (isPerfDiagnosticsEnabled()) {
              const start = performance.now()
              window.requestAnimationFrame(() => {
                perfMeasure('chat.input.composition_to_raf.ms', performance.now() - start)
              })
            }
            return false
          },
          compositionend: (event) => {
            onInputActivityRef.current?.()
            isComposingRef.current = false
            onCompositionStateChangeRef.current?.(false)
            perfMark('chat.input.composition_end')
            markDispatchDelay('chat.input.composition.dispatch_delay.ms', event.timeStamp)
            return false
          },
          mousedown: (event) => {
            perfMark('chat.input.mouse_down')
            markDispatchDelay('chat.input.mouse.dispatch_delay.ms', event.timeStamp)
            if (isPerfDiagnosticsEnabled()) {
              const start = performance.now()
              window.requestAnimationFrame(() => {
                perfMeasure('chat.input.mouse_to_raf.ms', performance.now() - start)
              })
            }
            return false
          },
          mouseup: (event) => {
            perfMark('chat.input.mouse_up')
            markDispatchDelay('chat.input.mouse.dispatch_delay.ms', event.timeStamp)
            return false
          },
          blur: () => {
            setSlashQuery(null)
            return false
          },
        }),
        EditorView.updateListener.of(update => {
          if (update.docChanged) {
            draftBufferRef.current = update.state.doc.toString()
            onDraftChangeRef.current?.(draftBufferRef.current)
          }
        }),
        // Slash command detection
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return
          if (!slashCommandsRef.current?.length) return
          const text = update.state.doc.toString()
          const match = text.match(/^\/([a-zA-Z0-9_-]*)$/)
          if (match) {
            setSlashQuery(match[1])
          } else {
            setSlashQuery(null)
          }
        }),
      ],
    })

    const view = new EditorView({
      state,
      parent: host,
    })

    editorViewRef.current = view

    return () => {
      onCompositionStateChangeRef.current?.(false)
      view.destroy()
      editorViewRef.current = null
    }
  }, [handleSend, markDispatchDelay])

  // Insert pending text into the editor
  useEffect(() => {
    const view = editorViewRef.current
    if (!view || !pendingText) return
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: pendingText },
    })
    view.focus()
    // Move cursor to end
    view.dispatch({ selection: { anchor: pendingText.length } })
    onPendingTextConsumed?.()
  }, [pendingText, onPendingTextConsumed])

  // Expose imperative get/set so parent can read/write the input value (used for per-session draft persistence)
  useEffect(() => {
    if (!apiRef) return
    apiRef.current = {
      focus: () => editorViewRef.current?.focus(),
      getValue: () => draftBufferRef.current,
      captureInsertion: () => {
        const view = editorViewRef.current
        const doc = view?.state.doc
        const selection = view?.state.selection.main
        return (text: string) => {
          if (!view || editorViewRef.current !== view || view.state.doc !== doc || !selection) return false
          view.dispatch({ changes: { from: selection.from, to: selection.to, insert: text }, selection: { anchor: selection.from + text.length }, userEvent: 'input.voice', annotations: isolateHistory.of('full') })
          view.focus()
          return true
        }
      },
      setValue: (text: string) => {
        draftBufferRef.current = text
        onDraftChangeRef.current?.(text)
        const view = editorViewRef.current
        if (!view) return
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: text },
          selection: { anchor: text.length },
          annotations: Transaction.addToHistory.of(false),
        })
      },
    }
    return () => {
      if (apiRef) apiRef.current = null
    }
  }, [apiRef])

  useEffect(() => {
    const view = editorViewRef.current
    if (!view) return

    view.dispatch({
      effects: editableCompartmentRef.current.reconfigure([
        EditorView.editable.of(!disabled || keepCursor),
        EditorState.readOnly.of(disabled),
      ]),
    })
    if (keepCursor) view.focus()
  }, [disabled, keepCursor])

  // The suggestion replaces the placeholder while it is offered.
  useEffect(() => {
    const view = editorViewRef.current
    if (!view) return

    view.dispatch({
      effects: placeholderCompartmentRef.current.reconfigure(codeMirrorPlaceholder(suggestion ? '' : placeholder)),
    })
  }, [placeholder, suggestion])

  useEffect(() => {
    const view = editorViewRef.current
    if (!view) return
    view.dispatch({
      effects: [
        setSuggestion.of(suggestion),
        describedByCompartmentRef.current.reconfigure(suggestion ? EditorView.contentAttributes.of({ 'aria-describedby': suggestionId }) : []),
      ],
    })
  }, [suggestion, suggestionId])

  return (
    <div className="relative">
      {/* Slash command autocomplete dropdown */}
      {slashQuery !== null && filteredSlashCommands.length > 0 && (
        <SlashCommandDropdown
          items={filteredSlashCommands}
          query={slashQuery}
          selectedIndex={slashSelectedIndex}
          onSelect={handleSlashSelect}
          onClose={handleSlashClose}
        />
      )}

      <div className="absolute -inset-px rounded-xl bg-gradient-to-r from-accent/20 via-transparent to-accent/20 opacity-0 group-focus-within:opacity-100 transition-opacity blur-sm" />

      <div className="relative flex items-end gap-2 p-2 rounded-xl bg-gray-50 dark:bg-zinc-800 border border-gray-200 dark:border-zinc-700 shadow-glass group focus-within:border-accent/50 transition-colors">
        <div className="flex-1 text-gray-900 dark:text-zinc-100 min-h-[40px] max-h-[200px] overflow-hidden">
          <div ref={editorHostRef} />
          <div id={suggestionId} className="sr-only" aria-live="polite">{suggestion ? suggestionDescription(suggestion) : ''}</div>
        </div>

        <button
          onClick={handleSend}
          disabled={disabled}
          className="
            flex-shrink-0 w-9 h-9 rounded-lg
            bg-accent hover:bg-accent/90
            disabled:bg-ink-faint disabled:cursor-not-allowed
            flex items-center justify-center
            transition-all duration-200
            hover:shadow-glow hover:scale-[1.02]
            active:scale-[0.98]
          "
        >
          <ArrowUp size={18} weight="bold" className="text-white" />
        </button>
      </div>

      <div className="absolute -bottom-5 left-3 text-[10px] text-gray-400 dark:text-zinc-500 opacity-60">
        {hint}
      </div>
    </div>
  )
})

// Legacy textarea fallback (enabled via chatInputBare perf flag for debugging)
const LegacyTextareaChatInput = memo(function LegacyTextareaChatInput({
  keepCursor = false,
  initialDraft,
  onDraftChange,
  onSend,
  disabled,
  placeholder,
  hint,
  onCompositionStateChange,
  onInputActivity,
  apiRef,
}: ChatInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!apiRef) return
    apiRef.current = {
      focus: () => textareaRef.current?.focus(),
      getValue: () => textareaRef.current?.value ?? '',
      captureInsertion: () => {
        const input = textareaRef.current
        const original = input?.value
        const from = input?.selectionStart ?? 0
        const to = input?.selectionEnd ?? 0
        return (text: string) => {
          if (!input || textareaRef.current !== input || input.value !== original) return false
          input.setRangeText(text, from, to, 'end')
          input.dispatchEvent(new Event('input', { bubbles: true }))
          input.focus()
          return true
        }
      },
      setValue: (text: string) => {
        if (textareaRef.current) textareaRef.current.value = text
        onDraftChange?.(text)
      },
    }
    return () => {
      if (apiRef) apiRef.current = null
    }
  }, [apiRef, onDraftChange])

  const handleSend = useCallback(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    const value = textarea.value.trim()
    if (value && !disabled) {
      onSend(value)
      textarea.value = ''
      onDraftChange?.('')
    }
  }, [disabled, onSend, onDraftChange])

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    onInputActivity?.()
    const isSendShortcut = e.key === 'Enter' && (e.metaKey || e.ctrlKey)
    if (!isSendShortcut) return
    const nativeEvent = e.nativeEvent as globalThis.KeyboardEvent
    const isComposing = nativeEvent.isComposing || nativeEvent.keyCode === 229
    if (isComposing) return
    e.preventDefault()
    handleSend()
  }, [handleSend, onInputActivity])

  useEffect(() => {
    return () => { onCompositionStateChange?.(false) }
  }, [onCompositionStateChange])

  return (
    <div className="relative">
      <div className="flex items-end gap-2 p-2 rounded-md bg-white dark:bg-zinc-900 border border-gray-300 dark:border-zinc-700">
        <textarea
          defaultValue={initialDraft}
          onInput={event => onDraftChange?.(event.currentTarget.value)}
          ref={textareaRef}
          onKeyDown={handleKeyDown}
          onCompositionStart={() => { onInputActivity?.(); onCompositionStateChange?.(true) }}
          onCompositionEnd={() => { onInputActivity?.(); onCompositionStateChange?.(false) }}
          placeholder={placeholder}
          disabled={disabled && !keepCursor}
          readOnly={disabled}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          data-gramm="false"
          rows={3}
          className="
            flex-1 bg-transparent text-[14px] text-gray-900 dark:text-zinc-100 placeholder-gray-400 dark:placeholder-zinc-500
            resize-y outline-none py-2 px-2
            disabled:opacity-50 disabled:cursor-not-allowed
            min-h-[72px] max-h-[220px]
          "
        />
        <button
          onClick={handleSend}
          disabled={disabled}
          className="
            flex-shrink-0 w-9 h-9 rounded-md
            bg-accent
            disabled:bg-ink-faint disabled:cursor-not-allowed
            flex items-center justify-center
          "
        >
          <ArrowUp size={18} weight="bold" className="text-white" />
        </button>
      </div>
      <div className="absolute -bottom-5 left-3 text-[10px] text-gray-400 dark:text-zinc-500 opacity-60">
        {hint}
      </div>
    </div>
  )
})

const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
const MAX_IMAGES = 4
const MAX_IMAGE_SIZE = 2 * 1024 * 1024 // 2MB

// Stable blob URL management for image previews
function ImagePreview({ file, onRemove }: { file: File; onRemove: () => void }) {
  const [url, setUrl] = useState<string>('')

  useEffect(() => {
    const objectUrl = URL.createObjectURL(file)
    setUrl(objectUrl)
    return () => URL.revokeObjectURL(objectUrl)
  }, [file])

  if (!url) return null

  return (
    <div className="relative group">
      <img
        src={url}
        alt={file.name}
        className="w-16 h-16 object-cover rounded-lg border border-border overflow-hidden"
      />
      <button
        onClick={onRemove}
        className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-gray-600 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity text-xs"
      >
        ×
      </button>
    </div>
  )
}

// Exported for the composer preview page (tests/chat-composer-ui.tsx).
export const ChatInput = memo(function ChatInput({
  initialDraft,
  onDraftChange,
  voiceActive = false,
  voiceScope = '',
  onSend,
  disabled,
  placeholder,
  hint,
  onCompositionStateChange,
  onInputActivity,
  pendingText,
  onPendingTextConsumed,
  slashCommands,
  apiRef,
  suggestion,
  onSuggestionCleared,
}: ChatInputProps) {
  const [voiceBusy, setVoiceBusy] = useState(false)
  const isLegacyTextareaMode = isPerfCutEnabled('chatInputBare')
  const [attachedImages, setAttachedImages] = useState<File[]>([])
  const [attachedFilePaths, setAttachedFilePaths] = useState<string[]>([])
  const [isDragOver, setIsDragOver] = useState(false)
  const [imageWarning, setImageWarning] = useState('')
  const dragCounterRef = useRef(0)

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current++
    if (e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes('application/x-file-paths')) {
      setIsDragOver(true)
    }
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current--
    if (dragCounterRef.current === 0) {
      setIsDragOver(false)
    }
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
    dragCounterRef.current = 0

    // Handle file paths from file tree D&D
    const rawPaths = e.dataTransfer.getData('application/x-file-paths')
    if (rawPaths) {
      try {
        const paths: string[] = JSON.parse(rawPaths)
        setAttachedFilePaths(prev => {
          const existing = new Set(prev)
          const newPaths = paths.filter(p => !existing.has(p))
          return newPaths.length > 0 ? [...prev, ...newPaths] : prev
        })
        return
      } catch { /* fall through to image handling */ }
    }

    // Handle image files (max 4, max 2MB each)
    const validFiles = Array.from(e.dataTransfer.files).filter(f => IMAGE_MIME_TYPES.includes(f.type))
    const oversized = validFiles.filter(f => f.size > MAX_IMAGE_SIZE)
    const files = validFiles.filter(f => f.size <= MAX_IMAGE_SIZE)
    const warnings: string[] = []
    if (oversized.length > 0) {
      warnings.push(`${oversized.length}件の画像が2MBを超えています`)
    }
    if (files.length > 0) {
      setAttachedImages(prev => {
        const combined = [...prev, ...files]
        const sliced = combined.slice(0, MAX_IMAGES)
        if (combined.length > MAX_IMAGES) {
          warnings.push(`画像は最大${MAX_IMAGES}枚までです`)
        }
        return sliced
      })
    }
    if (warnings.length > 0) {
      setImageWarning(warnings.join('、'))
      setTimeout(() => setImageWarning(''), 4000)
    }
  }, [])

  const removeImage = useCallback((index: number) => {
    setAttachedImages(prev => prev.filter((_, i) => i !== index))
  }, [])

  const removeFilePath = useCallback((index: number) => {
    setAttachedFilePaths(prev => prev.filter((_, i) => i !== index))
  }, [])

  const handleSendWithImages = useCallback((text: string) => {
    const images = attachedImages.length > 0 ? [...attachedImages] : undefined
    const paths = attachedFilePaths.length > 0 ? [...attachedFilePaths] : undefined
    onSend(text, images, paths)
    setAttachedImages([])
    setAttachedFilePaths([])
  }, [onSend, attachedImages, attachedFilePaths])

  const inputComponent = isLegacyTextareaMode ? (
    <LegacyTextareaChatInput
      initialDraft={initialDraft}
      onDraftChange={onDraftChange}
      onSend={handleSendWithImages}
      disabled={disabled || voiceBusy}
      keepCursor={voiceBusy}
      placeholder={placeholder}
      hint={hint}
      onCompositionStateChange={onCompositionStateChange}
      onInputActivity={onInputActivity}
      apiRef={apiRef}
    />
  ) : (
    <CodeMirrorChatInput
      initialDraft={initialDraft}
      onDraftChange={onDraftChange}
      onSend={handleSendWithImages}
      disabled={disabled || voiceBusy}
      keepCursor={voiceBusy}
      placeholder={placeholder}
      hint={hint}
      onCompositionStateChange={onCompositionStateChange}
      onInputActivity={onInputActivity}
      pendingText={pendingText}
      onPendingTextConsumed={onPendingTextConsumed}
      slashCommands={slashCommands}
      apiRef={apiRef}
      suggestion={voiceBusy ? null : suggestion}
      onSuggestionCleared={onSuggestionCleared}
    />
  )

  return (
    <div
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      className={`relative rounded-xl border transition-colors ${
        isDragOver
          ? 'border-accent bg-accent/5'
          : 'border-transparent'
      }`}
    >
      {apiRef && <VoiceInputControl editor={apiRef} active={voiceActive} scope={voiceScope} disabled={disabled} onBusy={setVoiceBusy} />}
      {/* Drag overlay */}
      {isDragOver && (
        <div className="absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-accent/10 border-2 border-dashed border-accent pointer-events-none">
          <span className="text-sm font-medium text-accent">ファイルをドロップして参照</span>
        </div>
      )}

      {/* Image warning */}
      {imageWarning && (
        <div className="px-3 pt-2 text-xs text-amber-500">{imageWarning}</div>
      )}

      {/* File path chips */}
      {attachedFilePaths.length > 0 && (
        <div className="flex gap-1.5 px-3 pt-2 pb-1 flex-wrap">
          {attachedFilePaths.map((filePath, i) => {
            const fileName = filePath.split('/').pop() || filePath
            return (
              <div
                key={filePath}
                className="flex items-center gap-1 px-2 py-0.5 rounded-md bg-accent/10 text-accent text-xs group"
                title={filePath}
              >
                <span className="max-w-[200px] truncate">{fileName}</span>
                <button
                  onClick={() => removeFilePath(i)}
                  className="w-4 h-4 flex items-center justify-center rounded-full hover:bg-accent/20 opacity-60 group-hover:opacity-100 transition-opacity text-[10px]"
                >
                  ×
                </button>
              </div>
            )
          })}
        </div>
      )}

      {/* Image previews */}
      {attachedImages.length > 0 && (
        <div className="flex gap-2 px-3 pt-2 pb-1 flex-wrap">
          {attachedImages.map((file, i) => (
            <ImagePreview key={`${file.name}-${file.size}-${i}`} file={file} onRemove={() => removeImage(i)} />
          ))}
        </div>
      )}

      {inputComponent}
    </div>
  )
})

// ============================================================================
// Message List Component
// ============================================================================

interface MessageListProps {
  messages: UIMessage[]
  status: string
  messagesEndRef: React.RefObject<HTMLDivElement>
  containerRef: React.RefObject<HTMLDivElement>
  timestamps: Map<string, Date>
  messageImages: Map<string, string[]>
  messageReferenceFiles: Map<string, string[]>
  onRegenerate?: () => void
  onEditSubmit?: (messageId: string, newText: string) => void
}

/** The latest messages are always laid out (see MessageItem's content-visibility). */
const ALWAYS_RENDERED_MESSAGES = 20

const MessageList = memo(function MessageList({
  messages,
  status,
  messagesEndRef,
  containerRef,
  timestamps,
  messageImages,
  messageReferenceFiles,
  onRegenerate,
  onEditSubmit,
}: MessageListProps) {
  const { t } = useTranslation()

  // Find the last assistant message index (for regenerate button)
  const lastAssistantIndex = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') return i
    }
    return -1
  })()

  const canRegenerate = (status === 'ready' || status === 'error') && messages.length > 1
  const canEdit = status === 'ready'

  // Only the latest messages are rendered (messageWindow.ts).
  const [anchorId, setAnchorId] = useState<string | null>(null)
  const start = windowStart(messages, anchorId)
  useEffect(() => {
    const id = messages[start]?.id ?? null
    if (id !== anchorId) setAnchorId(id)
  }, [messages, start, anchorId])
  // Keep what the member is reading in place when earlier messages are added above it.
  const scrollRestoreRef = useRef<{ height: number; top: number } | null>(null)
  useLayoutEffect(() => {
    const restore = scrollRestoreRef.current
    const container = containerRef.current
    if (!restore || !container) return
    scrollRestoreRef.current = null
    container.scrollTop = restore.top + (container.scrollHeight - restore.height)
  }, [start, containerRef])
  const showEarlier = () => {
    const container = containerRef.current
    if (container) scrollRestoreRef.current = { height: container.scrollHeight, top: container.scrollTop }
    setAnchorId(earlierAnchor(messages, start))
  }

  return (
    <div ref={containerRef} className="flex-1 overflow-auto px-4 py-6 space-y-6">
      {start > 0 && (
        <div className="flex justify-center">
          <button
            type="button"
            onClick={showEarlier}
            className="rounded-lg border border-gray-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-1.5 text-xs font-medium text-gray-600 dark:text-zinc-300 hover:bg-gray-100 dark:hover:bg-zinc-700 focus-visible:outline-accent"
          >
            {t('chat.showEarlierMessages', { n: start })}
          </button>
        </div>
      )}
      {messages.slice(start).map((message, offset) => {
        const index = start + offset
        return (
        <MessageItem
          key={message.id}
          message={message}
          isStreaming={
            status === 'streaming' &&
            index === messages.length - 1 &&
            message.role === 'assistant'
          }
          timestamp={timestamps.get(message.id)}
          images={messageImages.get(message.id)}
          referenceFiles={messageReferenceFiles.get(message.id)}
          isLastAssistant={index === lastAssistantIndex}
          canRegenerate={canRegenerate}
          onRegenerate={onRegenerate}
          canEdit={canEdit}
          onEditSubmit={onEditSubmit}
          deferOffscreen={index < messages.length - ALWAYS_RENDERED_MESSAGES}
        />
        )
      })}

      {/* Thinking indicator when submitted but no response yet */}
      {status === 'submitted' && (
        <div className="animate-fade-in">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-5 h-5 rounded-md bg-gradient-to-br from-accent to-accent/70 flex items-center justify-center">
              <Sparkle size={11} weight="fill" className="text-white" />
            </div>
            <span className="text-[11px] font-medium tracking-wide uppercase text-ink-muted">
              Assistant
            </span>
          </div>
          <div className="inline-flex items-center gap-2 px-4 py-3 rounded-2xl rounded-tl-md bg-surface-elevated/80 border border-white/[0.04]">
            <ThinkingIndicator />
            <span className="text-sm text-ink-muted">{t('chat.thinking')}</span>
          </div>
        </div>
      )}

      <div ref={messagesEndRef} />
    </div>
  )
})

// ============================================================================
// Chat Panel Inner Component (with useChat)
// ============================================================================

interface ChatPanelChatProps {
  isActive: boolean
  departmentPath?: string
  activeDepartment?: { name: string; folder: string }
  serverInfo: { port: number; authToken: string }
  authMode: AuthMode
  codexStatus: CodexStatus
  slashCommands?: SlashCommandItem[]
  onShowSettings: () => void
  onTitleChange?: (title: string) => void
  onNewTab?: () => void
  onToggleSidebar: () => void
  sidebarOpen: boolean
  initialSessionId?: string | null
  onSessionIdChange?: (sessionId: string | null) => void
}

// Memoised: every tab stays mounted, and the parent re-renders on any tab's
// title change or tab switch. Its props are stable (see CompanyChatPanel).
const ChatPanelChat = memo(function ChatPanelChat({ isActive, departmentPath, activeDepartment, serverInfo, authMode, codexStatus, slashCommands, onShowSettings, onTitleChange, onNewTab, onToggleSidebar, sidebarOpen, initialSessionId, onSessionIdChange }: ChatPanelChatProps) {
  const { t } = useTranslation()
  const currentCompany = useAppStore((state) => state.currentCompany)
  const pendingChatInput = useAppStore((state) => state.pendingChatInput)
  const pendingChatNewSession = useAppStore((state) => state.pendingChatNewSession)
  const setPendingChatInput = useAppStore((state) => state.setPendingChatInput)
  const aiModel = useAppStore((state) => state.aiModel)
  const setAIModel = useAppStore((state) => state.setAIModel)
  const aiEffort = useAppStore((state) => state.aiEffort)
  const setAIEffort = useAppStore((state) => state.setAIEffort)
  const [codexModelId, setCodexModelId] = useState(() => localStorage.getItem('acb-codex-model') || '')
  const [codexEffort, setCodexEffort] = useState(() => localStorage.getItem('acb-codex-effort') || '')
  const codexModel = codexStatus.models.find(m => m.id === codexModelId) || codexStatus.models.find(m => m.isDefault) || codexStatus.models[0]
  const selectedCodexEffort = codexModel?.efforts.includes(codexEffort) ? codexEffort : codexModel?.defaultEffort || ''
  const selectedModel = authMode === 'codex' ? codexModel?.id : aiModel
  const selectedEffort = authMode === 'codex' ? selectedCodexEffort : aiEffort
  const authModeRef = useRef(authMode)
  authModeRef.current = authMode
  const chatMarkdownRender = useAppStore((state) => state.chatMarkdownRender)
  const setChatMarkdownRender = useAppStore((state) => state.setChatMarkdownRender)

  const handlePendingTextConsumed = useCallback(() => {
    setPendingChatInput(null, false)
  }, [setPendingChatInput])

  const [interactions, setInteractions] = useState<AgentInteractionRequest[]>([])
  // App session ID ref (for Claude CLI session resume). Declared before the
  // interaction lookup below, which reads it during render: declared later, the
  // first agent question (AskUserQuestion / ask_user / Codex approval) hit the
  // temporal dead zone and crashed the window.
  // Eagerly assigned on first message send so the server can track the CLI session from the start
  const appSessionIdRef = useRef<string | null>(initialSessionId || crypto.randomUUID())
  const currentInteraction = interactions.find(item => item.appSessionId === appSessionIdRef.current)
  useEffect(() => {
    let active = true
    const closed = new Set<string>()
    // Kept for every conversation (shown only for the one on screen), so a
    // question asked while this tab shows another conversation is still
    // there when the member comes back to it.
    const add = (request: AgentInteractionRequest) => {
      if (!active || closed.has(request.id)) return
      setInteractions(queue => queue.some(item => item.id === request.id) ? queue : [...queue, request])
    }
    const unsubscribe = window.electronAPI.onAgentInteraction(add)
    const unsubscribeClosed = window.electronAPI.onAgentInteractionClosed(request => {
      closed.add(request.id)
      setInteractions(queue => queue.filter(item => item.id !== request.id))
    })
    void window.electronAPI.getAgentInteractions().then(requests => requests.forEach(add)).catch(() => {})
    return () => {
      active = false; unsubscribe(); unsubscribeClosed()
      const sessionId = appSessionIdRef.current
      void window.electronAPI.getAgentInteractions().then(requests => Promise.all(requests
        .filter(item => item.appSessionId === sessionId)
        .map(item => window.electronAPI.respondAgentInteraction(item.id, { cancelled: true })))).catch(() => {})
    }
  }, [])

  // Tool approval state
  const [pendingApprovals, setPendingApprovals] = useState<ToolApprovalRequest[]>([])
  const pendingApproval = pendingApprovals[0]

  useEffect(() => {
    const unsub = window.electronAPI.onToolApprovalRequest((data) => {
      // Only accept approval requests for this tab's session
      if (data.appSessionId && data.appSessionId !== appSessionIdRef.current) {
        return // Not for this tab
      }
      setPendingApprovals(queue => queue.some(p => p.toolUseId === data.toolUseId) ? queue : [...queue, data])
    })
    return unsub
  }, [])

  const handleToolApprovalResponse = useCallback((toolUseId: string, approved: boolean) => {
    window.electronAPI.respondToolApproval(toolUseId, approved)
    setPendingApprovals(queue => queue.filter(p => p.toolUseId !== toolUseId))
  }, [])

  // Refs for dynamic body params
  const workingDirRef = useRef(departmentPath || currentCompany?.rootPath)
  const activeDepartmentRef = useRef(activeDepartment)
  const aiModelRef = useRef<string | undefined>(selectedModel)
  const aiEffortRef = useRef<string>(selectedEffort)

  useEffect(() => {
    workingDirRef.current = departmentPath || currentCompany?.rootPath
  }, [departmentPath, currentCompany?.rootPath])

  useEffect(() => {
    activeDepartmentRef.current = activeDepartment
  }, [activeDepartment])

  useEffect(() => {
    aiModelRef.current = selectedModel
  }, [selectedModel])

  useEffect(() => {
    aiEffortRef.current = selectedEffort
  }, [selectedEffort])

  // Keep the selected effort valid for the current model. If the user switches to a
  // model that doesn't support the current effort (e.g. xhigh on Opus 4.6), demote to
  // 'high' (a level every model supports) instead of relying on silent CLI fallback.
  useEffect(() => {
    if (!MODEL_EFFORT_OPTIONS[aiModel].includes(aiEffort)) {
      setAIEffort('high')
    }
  }, [aiModel, aiEffort, setAIEffort])


  // Pending images to send with next message
  const pendingImagesRef = useRef<Array<{ mediaType: string; data: string }>>([])
  // Pending data URLs to associate with the next user message
  const pendingImageDataUrlsRef = useRef<string[]>([])
  // Store sent images keyed by message ID for display in chat
  const [messageImages, setMessageImages] = useState<Map<string, string[]>>(new Map())
  // Store reference file paths keyed by message ID for display in chat
  const [messageReferenceFiles, setMessageReferenceFiles] = useState<Map<string, string[]>>(new Map())
  // Pending file paths to send as reference context
  const pendingFilePathsRef = useRef<string[]>([])
  // Pending file paths for display (kept separately so transport body clearing doesn't lose them)
  const pendingDisplayFilePathsRef = useRef<string[]>([])

  const lastNotifiedTitleRef = useRef<string | null>(null)
  // Claude CLI session ID (persisted across app restarts via ChatSession)
  const claudeSessionIdRef = useRef<string | null>(null)
  const agentSessionRef = useRef<AgentSession | null | undefined>(undefined)
  const handoffRequestRef = useRef<{ companyId: string; sessionId: string; provider: AuthMode } | null>(null)
  const companyIdRef = useRef(currentCompany?.id)
  companyIdRef.current = currentCompany?.id
  // The company checkout root: the chat's write guard judges paths relative to it.
  const companyRootRef = useRef(currentCompany?.rootPath)
  companyRootRef.current = currentCompany?.rootPath
  // Transport (memoized - only recreated when server info changes)
  const transport = useMemo(() => {
    return new DefaultChatTransport({
      api: `http://127.0.0.1:${serverInfo.port}/api/chat`,
      headers: { Authorization: `Bearer ${serverInfo.authToken}` },
      body: () => {
        const body: Record<string, unknown> = {
          authMode: authModeRef.current,
          agentSession: agentSessionRef.current,
          workingDirectory: workingDirRef.current,
          companyId: companyIdRef.current,
          companyRootPath: companyRootRef.current,
          activeDepartment: activeDepartmentRef.current || undefined,
          modelId: aiModelRef.current,
          effort: aiEffortRef.current,
          // Settings → 入力候補; off → the CLI is not asked for a suggestion.
          promptSuggestions: promptSuggestionSetting.getSnapshot(),
        }
        // Ensure app session ID exists (eagerly create on first request)
        if (!appSessionIdRef.current) {
          appSessionIdRef.current = crypto.randomUUID()
        }
        body.appSessionId = appSessionIdRef.current
        // Include persisted Claude CLI session ID for resume after restart
        if (claudeSessionIdRef.current) {
          body.claudeSessionId = claudeSessionIdRef.current
        }
        if (pendingImagesRef.current.length > 0) {
          body.images = pendingImagesRef.current
          pendingImagesRef.current = []
        }
        if (pendingFilePathsRef.current.length > 0) {
          body.referenceFiles = pendingFilePathsRef.current
          pendingFilePathsRef.current = []
        }
        handoffRequestRef.current = companyIdRef.current && appSessionIdRef.current ? { companyId: companyIdRef.current, sessionId: appSessionIdRef.current, provider: authModeRef.current } : null
        return body
      },
    })
  }, [serverInfo.port, serverInfo.authToken])

  // Plan usage for the header meter (shared/rate-limits.ts): streamed live as
  // transient data parts, and fetched here for a tab that has not streamed yet.
  const fetchRateLimits = useCallback(async () => {
    if (authModeRef.current !== 'claude-code' && authModeRef.current !== 'codex') return
    try {
      const res = await fetch(`http://127.0.0.1:${serverInfo.port}/api/rate-limits?provider=${authModeRef.current}`, { headers: { Authorization: `Bearer ${serverInfo.authToken}` } })
      const data = await res.json() as { rateLimits?: RateLimitSnapshot | null }
      setRateLimits(data.rateLimits)
    } catch {
      // The meter keeps what it has.
    }
  }, [serverInfo.port, serverInfo.authToken])

  // Declared before useChat: its onFinish reports handoff failures here.
  const [historyError, setHistoryError] = useState<string | null>(null)

  // Next-prompt suggestion (promptSuggestion.ts) and messages sent while the
  // AI works (shared/steer.ts). Declared before useChat: its onFinish records
  // how the turn ended.
  const [promptSuggestion, setPromptSuggestion] = useState<string | null>(null)
  const [finishedTurn, setFinishedTurn] = useState<{ n: number; suggest: boolean } | null>(null)
  // Sends that wait for the running turn to end: no steering available, or
  // the agent did not read the instruction before the turn ended.
  const [queuedSends, setQueuedSends] = useState<QueuedSend[]>([])
  // The last turn was stopped or failed: waiting sends go back into the input.
  const lastTurnAbortedRef = useRef(false)

  // Re-render cadence while a reply streams: longer for a long reply, whose
  // last markdown block is parsed again on every tick (markdownBlocks.ts).
  const [streamThrottle, setStreamThrottle] = useState(() => streamThrottleMs(0))

  // useChat hook
  const { messages, sendMessage, status, stop, setMessages, error, regenerate } = useChat({
    transport,
    experimental_throttle: streamThrottle,
    onFinish: ({ messages: finishedMessages, message, isAbort, isDisconnect, isError, finishReason }) => {
      lastTurnAbortedRef.current = isAbort || isDisconnect || isError
      setFinishedTurn(turn => ({ n: (turn?.n ?? 0) + 1, suggest: shouldRequestSuggestion({ aborted: lastTurnAbortedRef.current, authMode: authModeRef.current, enabled: promptSuggestionSetting.getSnapshot() }) }))
      const receipt = handoffRequestRef.current
      if (receipt && !isAbort && !isDisconnect && !isError && finishReason === 'stop') {
        const content = uiMessageToSessionMessage(message, new Date()).content
        void (async () => {
          if (appSessionIdRef.current !== receipt.sessionId || companyIdRef.current !== receipt.companyId) return
          if (!await saveCurrentSession(finishedMessages)) return
          await window.electronAPI.completeHandoffTurn(receipt.companyId, receipt.sessionId, { messageId: message.id, content, provider: receipt.provider })
        })().catch(() => { setHistoryError('履歴は保存されましたが、引き継ぎメモの更新予約ができませんでした。') })
      }
      // Fetch and store Claude CLI session ID for resume persistence
      const finishedSessionId = appSessionIdRef.current
      const finishedCompanyId = currentCompany?.id
      if (finishedSessionId && finishedCompanyId) {
        fetch(`http://127.0.0.1:${serverInfo.port}/api/session/${finishedSessionId}`, {
          headers: { Authorization: `Bearer ${serverInfo.authToken}` },
        })
          .then(res => res.json())
          .then(data => {
            if (data.agentSession) {
              if (appSessionIdRef.current === finishedSessionId) agentSessionRef.current = data.agentSession
              void window.electronAPI.patchChatSession(finishedCompanyId, finishedSessionId, { agentSession: data.agentSession }).catch(() => {})
            }
            if (data.claudeSessionId) {
              if (appSessionIdRef.current === finishedSessionId) claudeSessionIdRef.current = data.claudeSessionId
              void window.electronAPI.patchChatSession(finishedCompanyId, finishedSessionId, { claudeSessionId: data.claudeSessionId }).catch(() => {})
            }
          })
          .catch(() => {})
      }
    },
    onError: (err) => {
      console.error('[useChat] Error:', err)
    },
    onData: (part) => {
      if (part.type === RATE_LIMITS_PART_TYPE) setRateLimits(part.data as RateLimitSnapshot)
      else if (part.type === AGENT_PROGRESS_PART_TYPE) {
        const progress = readAgentProgress(part.data)
        if (progress) reportAgentProgress(progress)
      }
    },
  })

  useEffect(() => { void fetchRateLimits() }, [authMode, fetchRateLimits])

  useEffect(() => {
    const last = messages[messages.length - 1]
    let length = 0
    if (last?.role === 'assistant') for (const part of last.parts) if (part.type === 'text') length += part.text.length
    const next = streamThrottleMs(length)
    if (next !== streamThrottle) setStreamThrottle(next)
  }, [messages, streamThrottle])

  useEffect(() => {
    if (status === 'ready' || status === 'error') setPendingApprovals([])
  }, [status])

  // Model/provider changes start a fresh native session with visible history.
  const modelLocked = status === 'submitted' || status === 'streaming'
  const displayedModel = aiModel

  // Associate pending images with new user messages
  useEffect(() => {
    if (pendingImageDataUrlsRef.current.length === 0) return
    const userMsgs = messages.filter(m => m.role === 'user')
    const lastUserMsg = userMsgs[userMsgs.length - 1]
    if (lastUserMsg && !messageImages.has(lastUserMsg.id)) {
      const urls = pendingImageDataUrlsRef.current
      pendingImageDataUrlsRef.current = []
      setMessageImages(prev => new Map(prev).set(lastUserMsg.id, urls))
    }
  }, [messages, messageImages])

  // Associate pending reference files with new user messages
  useEffect(() => {
    if (pendingDisplayFilePathsRef.current.length === 0) return
    const userMsgs = messages.filter(m => m.role === 'user')
    const lastUserMsg = userMsgs[userMsgs.length - 1]
    if (lastUserMsg && !messageReferenceFiles.has(lastUserMsg.id)) {
      const paths = pendingDisplayFilePathsRef.current
      pendingDisplayFilePathsRef.current = []
      setMessageReferenceFiles(prev => new Map(prev).set(lastUserMsg.id, paths))
    }
  }, [messages, messageReferenceFiles])

  // Timestamp tracking (sync during render for immediate availability)
  const timestampsRef = useRef(new Map<string, Date>())
  const now = new Date()
  for (const msg of messages) {
    if (!timestampsRef.current.has(msg.id)) {
      timestampsRef.current.set(msg.id, now)
    }
  }

  // Session management state
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(appSessionIdRef.current)
  const revisionRef = useRef(0)
  const writerIdRef = useRef(crypto.randomUUID())
  const writeSequenceRef = useRef(0)
  const createdAtRef = useRef(new Date().toISOString())
  const historyReadyRef = useRef(false)
  const deletedRef = useRef(false)
  const savedFingerprintRef = useRef('')
  // The objects the last acknowledged save was built from (sameSaveInputs).
  const savedInputsRef = useRef<unknown[] | null>(null)
  const pendingFingerprintRef = useRef('')
  const acknowledgedSequenceRef = useRef(0)
  const syncSaveFailedRef = useRef(false)
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const saveRef = useRef<(override?: UIMessage[], sync?: boolean, clearDraft?: boolean) => Promise<boolean>>(async () => true)
  // Imperative handle to read/write the chat input value for per-session draft persistence
  const draftInputRef = useRef('')
  const handleDraftChange = useCallback((text: string) => { draftInputRef.current = text }, [])
  const chatInputApiRef = useRef<ChatInputApi | null>(null)
  // Tracks whether title auto-generation has been attempted/completed for the current session
  const titleGenerationDoneRef = useRef(false)
  // Tracks previous status so we can detect "stream just finished" transitions
  const prevStatusRef = useRef<string>('ready')
  // Holds an explicit title (auto-generated or user-edited) for the current session.
  // When null, saveCurrentSession falls back to deriving from the first user message.
  const customTitleRef = useRef<{ title: string; auto: boolean } | null>(null)
  // Composition state for auto-scroll
  const isInputComposingRef = useRef(false)
  const compositionEndTimerRef = useRef<number | null>(null)
  const pendingAutoScrollRef = useRef(false)

  // Auto-scroll refs
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const shouldAutoScrollRef = useRef(true)

  // Shows a spinner over the message list while the persisted session for
  // this tab is being loaded — replaces the brief greeting→messages flicker.
  const [isRestoringSession, setIsRestoringSession] = useState(true)

  // Restore once. The stable ID is retained throughout restoration.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        await loadSessions()
        const session = initialSessionId && currentCompany?.id
          ? await window.electronAPI.getChatSession(currentCompany.id, initialSessionId) : null
        if (cancelled) return
        if (session) {
          revisionRef.current = session.revision ?? 0
          createdAtRef.current = session.createdAt
          claudeSessionIdRef.current = session.claudeSessionId ?? null
          agentSessionRef.current = session.agentSession
          for (const msg of session.messages) timestampsRef.current.set(msg.id, new Date(msg.timestamp))
          setMessages(session.messages.map(sessionMessageToUIMessage))
          setMessageImages(new Map(session.messages.filter(m => m.images).map(m => [m.id, m.images!])))
          setMessageReferenceFiles(new Map(session.messages.filter(m => m.referenceFiles).map(m => [m.id, m.referenceFiles!])))
          draftInputRef.current = session.draftInput ?? ''
          chatInputApiRef.current?.setValue(draftInputRef.current)
          titleGenerationDoneRef.current = session.titleAutoGenerated !== undefined
          customTitleRef.current = session.titleAutoGenerated !== undefined || session.messages.some(m => m.role === 'user')
            ? { title: session.title, auto: session.titleAutoGenerated ?? false } : null
          onTitleChange?.(session.title)
        } else {
          // Missing/deleted history must never reuse an old tombstoned ID.
          if (initialSessionId) {
            appSessionIdRef.current = crypto.randomUUID()
            setCurrentSessionId(appSessionIdRef.current)
          }
          setMessages([{ id: '1', role: 'assistant', parts: [{ type: 'text', text: t('chat.greeting', { company: currentCompany?.name || '' }) }] }])
        }
        historyReadyRef.current = true
      } catch (e) {
        setHistoryError(e instanceof Error ? e.message : '相談の復元に失敗しました。')
      } finally {
        if (!cancelled) setIsRestoringSession(false)
      }
    })()
    return () => { cancelled = true }
    // This instance owns one conversation; opening history is handled by the parent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (currentSessionId) onSessionIdChange?.(currentSessionId)
  }, [currentSessionId, onSessionIdChange])

  // Persist drafts immediately when leaving a conversation, including clearing an old draft.
  useEffect(() => {
    if (!isActive) void saveRef.current(undefined, true)
  }, [isActive])

  // Checkpoint during streaming too. A trailing debounce alone would never fire
  // while tokens keep arriving. Unload and leaving the tab flush synchronously,
  // so the interval only bounds what a crash can lose; typing in the input is
  // picked up by the next tick, not saved per keystroke.
  useEffect(() => {
    const interval = window.setInterval(() => { void saveRef.current() }, AUTOSAVE_INTERVAL_MS)
    return () => window.clearInterval(interval)
  }, [])
  useEffect(() => {
    if (status === 'ready' || status === 'error') void saveRef.current()
  }, [status, messages])

  // Subscribe to cross-tab chat history changes so each tab keeps its sessions cache in sync.
  // Without this, an action in one tab (pin toggle, rename, delete, auto-save) would not
  // be reflected in another tab's history dropdown until that tab triggers its own reload.
  useEffect(() => {
    if (!currentCompany?.id) return
    const unsubscribe = window.electronAPI.onChatHistoryChanged((data) => {
      if (data.companyId === currentCompany.id) {
        if (data.deletedSessionId === appSessionIdRef.current) {
          deletedRef.current = true
          stop()
        }
        // Only a metadata change of this tab's own conversation (title from the
        // sidebar or the AI) concerns it; saves come from the tab itself.
        if (data.sessionId && (data.sessionId !== appSessionIdRef.current || data.kind !== 'patch')) return
        void loadSessions().catch(() => {})
      }
    })
    return unsubscribe
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentCompany?.id])

  // Trigger one-shot title generation when the first AI response finishes streaming
  useEffect(() => {
    const wasStreaming = prevStatusRef.current === 'streaming' || prevStatusRef.current === 'submitted'
    const justFinished = wasStreaming && status === 'ready'
    prevStatusRef.current = status
    if (!justFinished) return
    if (titleGenerationDoneRef.current) return
    if (!currentCompany?.id) return
    // Need at least: greeting + 1 user message + 1 assistant response
    if (messages.length < 3) return
    // Fire-and-forget; failures fall back to the truncated user message title
    generateAndSaveTitle()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, messages.length, currentCompany?.id])

  // Session functions
  async function loadSessions() {
    if (!currentCompany?.id) return
    try {
      // Summaries only: this tab needs its own title, never the other conversations' bodies.
      const loadedSessions = await window.electronAPI.getChatSessionSummaries(currentCompany.id)
      const current = loadedSessions.find(session => session.id === appSessionIdRef.current)
      if (current && historyReadyRef.current && current.titleAutoGenerated !== undefined) {
        customTitleRef.current = { title: current.title, auto: current.titleAutoGenerated }
        onTitleChange?.(current.title)
      }
    } catch (e) {
      setHistoryError(e instanceof Error ? e.message : '相談一覧を読み込めません。')
      throw e
    }
  }

  async function saveCurrentSession(override?: UIMessage[], sync = false, clearDraft = false): Promise<boolean> {
    if (sync) syncSaveFailedRef.current = false
    if (!currentCompany?.id || !historyReadyRef.current || deletedRef.current) return false
    const snapshot = override ?? messagesRef.current
    const draftInput = clearDraft ? '' : draftInputRef.current
    if (!snapshot.some(m => m.role === 'user') && !draftInput.trim() && !initialSessionId && revisionRef.current === 0 && !pendingFingerprintRef.current) return true
    const sessionId = appSessionIdRef.current!
    // Nothing the fingerprint is built from changed since the last acknowledged
    // save (same objects): skip converting and serialising the whole
    // conversation. Every open tab runs the autosave, idle ones included.
    const inputs = [sessionId, snapshot, draftInput, messageImages, messageReferenceFiles, claudeSessionIdRef.current, agentSessionRef.current]
    if (!override && !pendingFingerprintRef.current && savedFingerprintRef.current && sameSaveInputs(savedInputsRef.current, inputs)) return true
    const firstUser = snapshot.find(m => m.role === 'user')
    const title = customTitleRef.current?.title || (firstUser ? extractMessageText(firstUser).slice(0, 60) : t('chat.newChat'))
    const session: ChatSession = {
      id: sessionId, companyId: currentCompany.id, title,
      messages: snapshot.map(m => sessionMessageFor(m, timestampsRef.current.get(m.id) || new Date(), messageImages.get(m.id), messageReferenceFiles.get(m.id))),
      draftInput,
      createdAt: createdAtRef.current, updatedAt: new Date().toISOString(),
      revision: revisionRef.current,
      writerId: writerIdRef.current,
      writeSequence: ++writeSequenceRef.current,
      ...(agentSessionRef.current !== undefined ? { agentSession: agentSessionRef.current } : {}),
      ...(claudeSessionIdRef.current ? { claudeSessionId: claudeSessionIdRef.current } : {}),
      ...(customTitleRef.current ? { titleAutoGenerated: customTitleRef.current.auto } : {}),
    }
    const fingerprint = JSON.stringify([sessionId, session.messages, draftInput, session.claudeSessionId, session.agentSession])
    if (!override && fingerprint === savedFingerprintRef.current && !pendingFingerprintRef.current) return true
    if (!sync && !override && fingerprint === pendingFingerprintRef.current) return true
    pendingFingerprintRef.current = fingerprint
    try {
      const result = sync
        ? window.electronAPI.flushChatSession(currentCompany.id, session)
        : await window.electronAPI.saveChatSession(currentCompany.id, session)
      if (appSessionIdRef.current !== sessionId) return true
      if (result.status === 'deleted') {
        deletedRef.current = true
        return false
      }
      if (result.status === 'conflict') throw new Error('別の画面で相談が更新されました。上書きを止めています。未保存の文章をコピーしてから開き直してください。')
      revisionRef.current = Math.max(revisionRef.current, result.revision)
      if (session.writeSequence! >= acknowledgedSequenceRef.current) {
        acknowledgedSequenceRef.current = session.writeSequence!
        savedFingerprintRef.current = fingerprint
        savedInputsRef.current = inputs
      }
      if (pendingFingerprintRef.current === fingerprint) pendingFingerprintRef.current = ''
      setHistoryError(null)
      if (title !== lastNotifiedTitleRef.current) {
        lastNotifiedTitleRef.current = title
        onTitleChange?.(title)
      }
      return true
    } catch (e) {
      if (sync) syncSaveFailedRef.current = true
      if (appSessionIdRef.current === sessionId) {
        savedFingerprintRef.current = ''
        pendingFingerprintRef.current = ''
        setHistoryError(e instanceof Error ? e.message : '相談を保存できませんでした。')
      }
      return false
    }
  }
  saveRef.current = saveCurrentSession

  // Helper: extract plain text from a UIMessage for title generation
  function extractMessageText(msg: UIMessage): string {
    let text = ''
    for (const part of msg.parts) {
      if (part.type === 'text') text += part.text
    }
    return text
  }

  // Generate a concise title for the current session via the chat-server's Haiku endpoint
  async function generateAndSaveTitle() {
    if (!currentCompany?.id || !serverInfo) return
    if (titleGenerationDoneRef.current) return

    // Skip greeting (first assistant message); take up to 6 subsequent messages
    const transcript = messages.slice(1, 7).map(m => ({
      role: m.role as 'user' | 'assistant',
      content: extractMessageText(m),
    })).filter(m => m.content.trim().length > 0)

    if (transcript.length < 2) return
    const targetSessionId = appSessionIdRef.current!
    titleGenerationDoneRef.current = true

    try {
      const res = await fetch(`http://127.0.0.1:${serverInfo.port}/api/generate-title`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${serverInfo.authToken}`,
        },
        body: JSON.stringify({ messages: transcript, authMode: authModeRef.current, modelId: aiModelRef.current }),
      })
      if (!res.ok) return
      const data = await res.json() as { title?: string; error?: string }
      const newTitle = data.title?.trim()
      if (!newTitle) return

      const saved = await window.electronAPI.patchChatSession(currentCompany.id, targetSessionId, { title: newTitle, titleAutoGenerated: true })
      if (saved && appSessionIdRef.current === targetSessionId) {
        customTitleRef.current = { title: saved.title, auto: saved.titleAutoGenerated ?? false }
        onTitleChange?.(saved.title)
      }
    } catch (e) {
      console.error('Title generation failed:', e)
    }
  }

  async function startNewChat(options?: { skipSave?: boolean }) {
    // Stop any in-flight stream so a partial assistant response is captured before saving
    if (status === 'streaming' || status === 'submitted') {
      stop()
      await new Promise(r => setTimeout(r, 150))
    }
    // Save current session (including draft input) before starting a new one.
    // Skipped when invoked right after deleting the active session, so the
    // deleted session is not re-persisted from the still-populated state.
    if (!options?.skipSave) {
      if (!await saveCurrentSession()) return false
    }
    // Clear Claude CLI session mapping on the server
    if (appSessionIdRef.current) {
      fetch(`http://127.0.0.1:${serverInfo.port}/api/session/${appSessionIdRef.current}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${serverInfo.authToken}` },
      }).catch(() => {})
    }
    appSessionIdRef.current = crypto.randomUUID()
    writerIdRef.current = crypto.randomUUID()
    writeSequenceRef.current = 0
    revisionRef.current = 0
    createdAtRef.current = new Date().toISOString()
    savedFingerprintRef.current = ''
    pendingFingerprintRef.current = ''
    acknowledgedSequenceRef.current = 0
    deletedRef.current = false
    claudeSessionIdRef.current = null
    agentSessionRef.current = null
    timestampsRef.current.clear()
    const greeting: UIMessage[] = [{
      id: '1',
      role: 'assistant' as const,
      parts: [{ type: 'text' as const, text: t('chat.greeting', { company: currentCompany?.name || '' }) }],
    }]
    messagesRef.current = greeting
    setMessages(greeting)
    setCurrentSessionId(appSessionIdRef.current)
    // Clear the input for the fresh chat (per-session draft is empty by default)
    chatInputApiRef.current?.setValue('')
    // Allow auto-title generation for the new session
    titleGenerationDoneRef.current = false
    customTitleRef.current = null
    return true
  }

  // History content mounts after restoration; hidden tabs have no layout.
  // Reset only on opening a chat, so reading older messages stays possible.
  useLayoutEffect(() => {
    if (!isActive || isRestoringSession) return
    shouldAutoScrollRef.current = true
    pendingAutoScrollRef.current = false
    const container = messagesContainerRef.current
    if (container) container.scrollTop = container.scrollHeight
  }, [isActive, isRestoringSession])

  // Attach after the message list actually mounts, not while the spinner is shown.
  useEffect(() => {
    if (!isActive || isRestoringSession) return
    const container = messagesContainerRef.current
    if (!container) return

    const handleScroll = () => {
      const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight
      shouldAutoScrollRef.current = distanceFromBottom < 120
    }

    container.addEventListener('scroll', handleScroll, { passive: true })
    handleScroll()

    return () => {
      container.removeEventListener('scroll', handleScroll)
    }
  }, [isActive, isRestoringSession])

  // Auto-scroll when messages change
  useEffect(() => {
    if (!isActive || isRestoringSession) return
    if (isInputComposingRef.current) {
      pendingAutoScrollRef.current = true
      return
    }
    if (!shouldAutoScrollRef.current) return
    pendingAutoScrollRef.current = false
    messagesEndRef.current?.scrollIntoView({ behavior: 'auto' })
  }, [messages, status, isActive, isRestoringSession])

  // Composition handling
  const flushAfterComposition = useCallback(() => {
    if (pendingAutoScrollRef.current) {
      pendingAutoScrollRef.current = false
      if (shouldAutoScrollRef.current) {
        messagesEndRef.current?.scrollIntoView({ behavior: 'auto' })
      }
    }
  }, [])

  const handleInputCompositionStateChange = useCallback((isComposing: boolean) => {
    if (isComposing) {
      if (compositionEndTimerRef.current != null) {
        window.clearTimeout(compositionEndTimerRef.current)
        compositionEndTimerRef.current = null
      }
      isInputComposingRef.current = true
      return
    }

    if (compositionEndTimerRef.current != null) {
      window.clearTimeout(compositionEndTimerRef.current)
    }
    compositionEndTimerRef.current = window.setTimeout(() => {
      compositionEndTimerRef.current = null
      isInputComposingRef.current = false
      flushAfterComposition()
    }, 180)
  }, [flushAfterComposition])

  const handleInputActivity = useCallback(() => {
    markChatInputActivity()
  }, [])

  // Flush before window reload/close and before an editor is detached on tab close.
  useLayoutEffect(() => {
    const flush = (event?: BeforeUnloadEvent) => {
      // The sync branch finishes before its returned Promise settles.
      void saveRef.current(undefined, true)
      if (event && syncSaveFailedRef.current) {
        event.preventDefault()
        event.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', flush)
    return () => {
      window.removeEventListener('beforeunload', flush)
      flush()
      stop()
      if (compositionEndTimerRef.current != null) {
        window.clearTimeout(compositionEndTimerRef.current)
      }
      // Clean up Claude CLI session on the server when tab is closed
      if (appSessionIdRef.current) {
        fetch(`http://127.0.0.1:${serverInfo.port}/api/session/${appSessionIdRef.current}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${serverInfo.authToken}` },
        }).catch(() => {})
      }
    }
  }, [serverInfo.authToken, serverInfo.port, stop])

  // Send handler (supports interrupt: stop current stream + send new message)
  const handleSend = useCallback(async (text: string, files?: File[], filePaths?: string[]) => {
    if (!text.trim() && (!files || files.length === 0)) return
    perfMark('chat.send.start')

    // Ensure session ID exists before first message (don't wait for auto-save debounce)
    if (!currentSessionId && !appSessionIdRef.current) {
      const newId = crypto.randomUUID()
      setCurrentSessionId(newId)
      appSessionIdRef.current = newId
    }

    setPromptSuggestion(null)
    setFinishedTurn(null)
    // While the AI works the message goes into the running turn (steering),
    // or waits for the turn to end; it no longer stops the AI.
    if (status === 'streaming' || status === 'submitted') {
      const item: QueuedSend = { text, files, filePaths }
      const sessionId = appSessionIdRef.current
      if (authModeRef.current !== 'api-key' && sessionId && !files?.length && !filePaths?.length && canSteerText(text)) {
        void steerRunningTurn(serverInfo, sessionId, text).then(response => {
          if (response.status === 'delivered') return
          setQueuedSends(queue => [...queue, { ...item, ...(response.id ? { steerPartId: `steer-${response.id}` } : {}) }])
        })
      } else {
        setQueuedSends(queue => [...queue, item])
      }
      return
    }
    lastTurnAbortedRef.current = false

    // Convert images to base64 and store in ref for transport body
    if (files && files.length > 0) {
      const imageParts: Array<{ mediaType: string; data: string }> = []
      const dataUrls: string[] = []
      for (const file of files) {
        const dataUrl = await new Promise<string>((resolve) => {
          const reader = new FileReader()
          reader.onload = () => resolve(reader.result as string)
          reader.readAsDataURL(file)
        })
        // The AI gets the full image; the bubble and the history keep a small copy.
        dataUrls.push(await historyThumbnail(dataUrl))
        imageParts.push({ mediaType: file.type, data: dataUrl.split(',')[1] })
      }
      pendingImagesRef.current = imageParts
      pendingImageDataUrlsRef.current = dataUrls
    }

    // Store file paths in ref for transport body (sent as referenceFiles in system prompt)
    if (filePaths && filePaths.length > 0) {
      pendingFilePathsRef.current = [...filePaths]
      pendingDisplayFilePathsRef.current = [...filePaths]
    }

    const message: UIMessage = {
      id: crypto.randomUUID(), role: 'user',
      parts: [{ type: 'text', text: text || '画像を確認してください' }],
    }
    timestampsRef.current.set(message.id, new Date())
    if (!await saveRef.current([...messagesRef.current, message], true, true)) {
      chatInputApiRef.current?.setValue(text)
      return
    }
    try { await sendMessage(message) }
    catch (e) { setHistoryError(e instanceof Error ? e.message : '送信できませんでした。相談は保存されています。') }
  }, [status, sendMessage, currentSessionId, serverInfo])

  // The turn ended: waiting sends go out together as the next message — or,
  // after a stop or an error, back into the input. An instruction the agent did not
  // read leaves the reply first (it is sent again as a normal message).
  useEffect(() => {
    if ((status !== 'ready' && status !== 'error') || queuedSends.length === 0) return
    const unread = new Set(queuedSends.flatMap(item => item.steerPartId ? [item.steerPartId] : []))
    if (unread.size) {
      setMessages(current => current.map(m => m.role !== 'assistant' ? m : { ...m, parts: m.parts.filter(p => !(p.type === STEER_PART_TYPE && unread.has((p as { id?: string }).id ?? ''))) }))
    }
    if (status === 'error' || lastTurnAbortedRef.current) {
      const draft = chatInputApiRef.current?.getValue() ?? ''
      chatInputApiRef.current?.setValue([draft, ...queuedSends.map(item => item.text)].filter(text => text.trim()).join('\n\n'))
      setQueuedSends([])
      return
    }
    // All of them as one message: one more turn, not a race of several.
    const files = queuedSends.flatMap(item => item.files ?? [])
    const filePaths = [...new Set(queuedSends.flatMap(item => item.filePaths ?? []))]
    setQueuedSends([])
    void handleSend(queuedSends.map(item => item.text).join('\n\n'), files.length ? files : undefined, filePaths.length ? filePaths : undefined)
  }, [status, queuedSends, handleSend, setMessages])

  const cancelQueuedSend = useCallback((index: number) => {
    const item = queuedSends[index]
    if (!item) return
    setQueuedSends(queue => queue.filter((_, i) => i !== index))
    const draft = chatInputApiRef.current?.getValue() ?? ''
    chatInputApiRef.current?.setValue([draft, item.text].filter(text => text.trim()).join('\n\n'))
    chatInputApiRef.current?.focus()
  }, [queuedSends])

  // After a reply: ask the chat server for Claude Code's next-prompt
  // suggestion (it follows the reply by about a second) and offer it in the
  // input if the member has not started typing.
  useEffect(() => {
    if (!finishedTurn?.suggest) return
    const sessionId = appSessionIdRef.current
    if (!sessionId) return
    let cancelled = false
    fetch(`http://127.0.0.1:${serverInfo.port}/api/prompt-suggestion/${encodeURIComponent(sessionId)}`, {
      headers: { Authorization: `Bearer ${serverInfo.authToken}` },
    })
      .then(res => res.ok ? res.json() : null)
      .then((data: { suggestion?: unknown } | null) => {
        if (cancelled || appSessionIdRef.current !== sessionId) return
        const suggestion = normalizeSuggestion(data?.suggestion)
        if (suggestion && canOfferSuggestion({ running: false, waitingForMember: false, draft: chatInputApiRef.current?.getValue() ?? '' })) setPromptSuggestion(suggestion)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [finishedTurn, serverInfo.port, serverInfo.authToken])

  useEffect(() => { setPromptSuggestion(null) }, [currentSessionId])
  const clearPromptSuggestion = useCallback(() => setPromptSuggestion(null), [])
  const running = status === 'submitted' || status === 'streaming'
  const offeredSuggestion = !running && !currentInteraction && !pendingApproval ? promptSuggestion : null

  // Start new chat and auto-send when skill execution is triggered (only active tab)
  useEffect(() => {
    if (!isActive || !historyReadyRef.current) return
    if (pendingChatNewSession && pendingChatInput) {
      const text = pendingChatInput
      setPendingChatInput(null, false)
      startNewChat().then(started => {
        if (started) void handleSend(text)
      })
    }
  }, [pendingChatNewSession, pendingChatInput, isRestoringSession])

  // Edit message handler: trim messages after edit point, resend
  // Reads messages through the ref so the callback keeps its identity while
  // streaming; depending on `messages` re-rendered every MessageItem per chunk.
  const handleEditMessage = useCallback((messageId: string, newText: string) => {
    const current = messagesRef.current
    const msgIndex = current.findIndex(m => m.id === messageId)
    if (msgIndex === -1) return
    setMessages(current.slice(0, msgIndex))
    sendMessage({ text: newText })
  }, [setMessages, sendMessage])

  // The usage meter shows only its fullest window when the header is narrow.
  const headerRef = useRef<HTMLElement>(null)
  const [narrowHeader, setNarrowHeader] = useState(false)
  useEffect(() => {
    const header = headerRef.current
    if (!header) return
    const observer = new ResizeObserver(([entry]) => setNarrowHeader(entry.contentRect.width < 600))
    observer.observe(header)
    return () => observer.disconnect()
  }, [])

  // ============================================================================
  // Render
  // ============================================================================

  return (
    <div className="h-full flex flex-col bg-white dark:bg-zinc-900">
      {/* Header */}
      <header ref={headerRef} className="flex-shrink-0 h-12 flex items-center justify-between gap-2 px-4 border-b border-gray-200 dark:border-zinc-800">
        <div className="flex items-center gap-3 flex-shrink-0">
          <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-accent to-accent/70 flex items-center justify-center">
            <Sparkle size={12} weight="fill" className="text-white" />
          </div>
          <div className="flex items-center gap-2">
            {/* The model selector already names the agent when space is short. */}
            {(!narrowHeader || authMode === 'api-key') && (
              <span className="text-[10px] font-medium tracking-wider uppercase px-1.5 py-0.5 rounded-md bg-accent/15 text-accent">
                {authMode === 'codex' ? 'Codex' : authMode === 'claude-code' ? 'Claude' : 'API'}
              </span>
            )}
            {(authMode === 'claude-code' || authMode === 'codex') && <RateLimitMeter provider={authMode} compact={narrowHeader} />}
            {/* Status indicator */}
            {status === 'submitted' && (
              <span className="flex items-center gap-1 text-[10px] text-accent animate-fade-in whitespace-nowrap" title={t('chat.statusSubmitted')}>
                <CircleNotch size={10} className="animate-spin" />
                {!narrowHeader && t('chat.statusSubmitted')}
              </span>
            )}
            {status === 'streaming' && (
              <span className="flex items-center gap-1 text-[10px] text-green-500 dark:text-green-400 animate-fade-in whitespace-nowrap" title={t('chat.statusStreaming')}>
                <span className="w-1.5 h-1.5 rounded-full bg-green-500 dark:bg-green-400 animate-pulse-soft" />
                {!narrowHeader && t('chat.statusStreaming')}
              </span>
            )}
            {status === 'error' && (
              <span className="flex items-center gap-1 text-[10px] text-red-500 dark:text-red-400 animate-fade-in whitespace-nowrap" title={t('chat.statusError')}>
                <span className="w-1.5 h-1.5 rounded-full bg-red-500 dark:bg-red-400" />
                {!narrowHeader && t('chat.statusError')}
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center justify-end gap-1 min-w-0">
          {authMode === 'codex' && <>
            <select aria-label="Codexモデル" value={codexModel?.id || ''} disabled={modelLocked || !codexModel}
              onChange={e => { setCodexModelId(e.target.value); localStorage.setItem('acb-codex-model', e.target.value) }}
              className="h-7 max-w-44 min-w-0 shrink text-[11px] rounded-md border border-gray-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-1.5 disabled:opacity-50">
              {codexStatus.models.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
            <select aria-label="Codex思考の強さ" value={selectedCodexEffort} disabled={modelLocked || !codexModel}
              onChange={e => { setCodexEffort(e.target.value); localStorage.setItem('acb-codex-effort', e.target.value) }}
              className="h-7 min-w-0 shrink text-[11px] rounded-md border border-gray-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-1.5 disabled:opacity-50">
              {codexModel?.efforts.map(e => <option key={e} value={e}>{e}</option>)}
            </select>
          </>}
          {/* Model selection is locked only while a turn is in flight. */}
          {authMode === 'claude-code' && (
            <select
              value={displayedModel}
              disabled={modelLocked}
              title={modelLocked ? '応答中はモデルを変更できません' : undefined}
              onChange={(e) => setAIModel(e.target.value as AIModel)}
              className="h-7 min-w-[5.5rem] shrink text-[11px] font-medium rounded-md border border-gray-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-gray-700 dark:text-zinc-300 px-1.5 pr-6 appearance-none cursor-pointer hover:border-accent/50 focus:outline-none focus:ring-1 focus:ring-accent/50 transition-colors disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:border-gray-200 dark:disabled:hover:border-zinc-700"
              style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M3 5l3 3 3-3' fill='none' stroke='%239CA3AF' stroke-width='1.5'/%3E%3C/svg%3E")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'right 4px center' }}
            >
              {CLAUDE_MODELS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          )}

          {/* Effort Level Selector (Claude Code mode only). Options depend on the model. */}
          {authMode === 'claude-code' && (
            <select
              value={aiEffort}
              onChange={(e) => setAIEffort(e.target.value as AIEffort)}
              className="h-7 min-w-[4.75rem] shrink text-[11px] font-medium rounded-md border border-gray-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-gray-700 dark:text-zinc-300 px-1.5 pr-6 appearance-none cursor-pointer hover:border-accent/50 focus:outline-none focus:ring-1 focus:ring-accent/50 transition-colors"
              style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M3 5l3 3 3-3' fill='none' stroke='%239CA3AF' stroke-width='1.5'/%3E%3C/svg%3E")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'right 4px center' }}
            >
              {MODEL_EFFORT_OPTIONS[aiModel].map((eff) => (
                <option key={eff} value={eff}>
                  {eff === 'xhigh' ? 'xHigh' : eff.charAt(0).toUpperCase() + eff.slice(1)}
                </option>
              ))}
            </select>
          )}

          {/* Stop Button (visible during streaming) */}
          {(status === 'submitted' || status === 'streaming') && (
            <button
              onClick={() => stop()}
              className="w-8 h-8 flex-shrink-0 rounded-lg hover:bg-red-100 dark:hover:bg-red-900/30 flex items-center justify-center transition-colors"
              title={t('chat.stop')}
            >
              <X size={16} className="text-red-500" />
            </button>
          )}

          {/* Markdown Render Toggle: ON = decorated rendering, OFF = raw text */}
          <button
            onClick={() => setChatMarkdownRender(!chatMarkdownRender)}
            className={`w-8 h-8 flex-shrink-0 rounded-lg flex items-center justify-center transition-colors ${
              chatMarkdownRender
                ? 'bg-accent/15 text-accent hover:bg-accent/20'
                : 'hover:bg-gray-100 dark:hover:bg-zinc-800 text-gray-500 dark:text-zinc-400'
            }`}
            title={chatMarkdownRender ? '装飾表示中（クリックでプレーン表示に切替）' : 'プレーン表示中（クリックで装飾表示に切替）'}
          >
            <MarkdownLogo size={16} weight={chatMarkdownRender ? 'fill' : 'regular'} />
          </button>

          {/* New Chat/Tab Button */}
          <button
            onClick={onNewTab || (() => startNewChat())}
            className="w-8 h-8 flex-shrink-0 rounded-lg hover:bg-gray-100 dark:hover:bg-zinc-800 flex items-center justify-center transition-colors"
            title={t('chat.newChat')}
          >
            <Plus size={16} className="text-gray-500 dark:text-zinc-400" />
          </button>

          <button onClick={onToggleSidebar} aria-label="相談一覧を開閉" aria-expanded={sidebarOpen} title="相談一覧" className="w-8 h-8 flex-shrink-0 rounded-lg hover:bg-gray-100 dark:hover:bg-zinc-800 flex items-center justify-center">
            <SidebarSimple size={16} />
          </button>

          {/* Settings Button */}
          <button
            onClick={onShowSettings}
            className="w-8 h-8 flex-shrink-0 rounded-lg hover:bg-gray-100 dark:hover:bg-zinc-800 flex items-center justify-center transition-colors"
          >
            <GearSix size={16} className="text-gray-500 dark:text-zinc-400" />
          </button>
        </div>
      </header>
      {currentCompany?.id && appSessionIdRef.current && <HandoffControl companyId={currentCompany.id} sessionId={appSessionIdRef.current} active={isActive} />}


      {historyError && (
        <div role="alert" className="px-4 py-2 text-sm text-red-600 dark:text-red-400 bg-red-500/10">
          {historyError}
        </div>
      )}
      {/* Error Banner */}
      {status === 'error' && error && (
        <div className="flex-shrink-0 px-4 py-2 bg-red-500/10 border-b border-red-500/20">
          <div className="text-sm text-red-400">
            {t('chat.errorOccurred', { error: error.message })}
          </div>
        </div>
      )}

      {/* Messages Area */}
      {isRestoringSession ? (
        <div className="flex-1 flex items-center justify-center">
          <CircleNotch size={24} className="text-ink-muted animate-spin" />
        </div>
      ) : (
        <MessageList
          messages={messages}
          status={status}
          messagesEndRef={messagesEndRef}
          containerRef={messagesContainerRef}
          timestamps={timestampsRef.current}
          messageImages={messageImages}
          messageReferenceFiles={messageReferenceFiles}
          onRegenerate={regenerate}
          onEditSubmit={handleEditMessage}
        />
      )}

      {authMode === 'codex' && (!codexStatus.authenticated || !codexModel) && (
        <div role="alert" className="px-4 py-2 text-sm text-amber-700 dark:text-amber-300">
          {codexStatus.error || 'Codexの接続を確認してください。'}
          <button onClick={onShowSettings} className="ml-2 underline">設定を開く</button>
        </div>
      )}
      {/* Tool Approval Banner (above input) */}
      {currentInteraction && <AgentInteractionCard key={currentInteraction.id} request={currentInteraction} onRespond={async response => {
        const id = currentInteraction.id
        const accepted = await window.electronAPI.respondAgentInteraction(id, response)
        if (accepted) setInteractions(queue => queue.filter(item => item.id !== id))
        return accepted
      }} />}
      {pendingApproval && (
        <ToolApprovalBanner
          request={pendingApproval}
          onRespond={handleToolApprovalResponse}
        />
      )}

      {/* Input Area */}
      <div className="flex-shrink-0 border-t border-gray-200 dark:border-zinc-800">
        {queuedSends.length > 0 && (
          <ul aria-live="polite" className="px-4 pt-3 space-y-1">
            {queuedSends.map((item, index) => (
              <li key={index} className="flex items-center gap-2 text-xs text-gray-500 dark:text-zinc-400">
                <ClockCountdown size={14} aria-hidden="true" className="flex-shrink-0" />
                <span className="flex-shrink-0">{t('chat.queuedSend')}</span>
                <span className="min-w-0 truncate text-gray-700 dark:text-zinc-300">{item.text}</span>
                <button type="button" onClick={() => cancelQueuedSend(index)} className="ml-auto flex-shrink-0 px-1.5 py-0.5 rounded hover:bg-gray-100 dark:hover:bg-zinc-800">{t('chat.queuedCancel')}</button>
              </li>
            ))}
          </ul>
        )}
        <div className="p-4 pb-7">
          <ChatInput
            initialDraft={draftInputRef.current}
            onDraftChange={handleDraftChange}
            voiceActive={isActive}
            voiceScope={appSessionIdRef.current ?? ''}
            onSend={handleSend}
            disabled={isRestoringSession || !historyReadyRef.current || deletedRef.current || (authMode === 'codex' && (!codexStatus.authenticated || !codexModel))}
            placeholder={running ? t(authMode === 'api-key' ? 'chat.inputPlaceholderQueued' : 'chat.inputPlaceholderWorking') : t('chat.inputPlaceholder')}
            hint={offeredSuggestion ? t('chat.suggestionHint') : t('chat.inputHint')}
            onCompositionStateChange={handleInputCompositionStateChange}
            onInputActivity={handleInputActivity}
            pendingText={pendingChatNewSession ? null : (isActive ? pendingChatInput : null)}
            onPendingTextConsumed={handlePendingTextConsumed}
            slashCommands={slashCommands}
            apiRef={chatInputApiRef}
            suggestion={offeredSuggestion}
            onSuggestionCleared={clearPromptSuggestion}
          />
        </div>
      </div>
    </div>
  )
})

// ============================================================================
// Main ChatPanel Component (Auth & Server wrapper)
// ============================================================================

// ============================================================================
// Chat Tab Bar
// ============================================================================

interface ChatTab {
  id: string  // Ephemeral handle (random UUID), regenerated on each app start
  title: string
  sessionId: string | null  // Persisted chat session id (null until first save)
}

// ============================================================================
// Persisted chat tab state (per company)
// ============================================================================

const CHAT_TABS_KEY_PREFIX = 'chatTabs:'

type PersistedChatTabs = {
  tabs: Array<{ title: string; sessionId: string | null }>
  activeIndex: number
}

function safeReadChatTabs(companyId: string): PersistedChatTabs | null {
  try {
    const raw = localStorage.getItem(`${CHAT_TABS_KEY_PREFIX}${companyId}`)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || !Array.isArray(parsed.tabs)) return null
    const seenSessionIds = new Set<string>()
    const tabs = parsed.tabs
      .filter((t: unknown): t is { title: unknown; sessionId: unknown } =>
        typeof t === 'object' && t !== null)
      .map((t: { title: unknown; sessionId: unknown }) => ({
        title: typeof t.title === 'string' ? t.title : '',
        sessionId: typeof t.sessionId === 'string' ? t.sessionId : null,
      }))
    const uniqueTabs = tabs.filter((tab: { sessionId: string | null }) => {
      if (!tab.sessionId) return true
      if (seenSessionIds.has(tab.sessionId)) return false
      seenSessionIds.add(tab.sessionId)
      return true
    })
    if (uniqueTabs.length === 0) return null
    const activeIndex =
      typeof parsed.activeIndex === 'number' && parsed.activeIndex >= 0 && parsed.activeIndex < tabs.length
        ? parsed.activeIndex
        : 0
    const activeSessionId = tabs[activeIndex]?.sessionId
    const uniqueActiveIndex = Math.max(0, uniqueTabs.findIndex((tab: { sessionId: string | null }) => tab.sessionId === activeSessionId))
    return { tabs: uniqueTabs, activeIndex: uniqueActiveIndex }
  } catch {
    return null
  }
}

function safeWriteChatTabs(companyId: string, state: PersistedChatTabs): void {
  try {
    localStorage.setItem(`${CHAT_TABS_KEY_PREFIX}${companyId}`, JSON.stringify(state))
  } catch {
    // Storage may be unavailable; fail silently.
  }
}

// ============================================================================
// Main ChatPanel Component (Auth & Server wrapper + Tab management)
// ============================================================================

interface ChatPanelProps {
  departmentPath?: string  // Working directory for AI (company root path)
  activeDepartment?: { name: string; folder: string }  // Currently selected department (undefined = company-wide)
  slashCommands?: SlashCommandItem[]
}

export function ChatPanel(props: ChatPanelProps) {
  const userId = useAuthStore(s => s.user?.id)
  const companyId = useAppStore(s => s.currentCompany?.id)
  if (!userId || !companyId) return null
  return <CompanyChatPanel key={`${userId}:${companyId}`} {...props} />
}

function CompanyChatPanel({ departmentPath, activeDepartment, slashCommands }: ChatPanelProps) {
  const { t } = useTranslation()
  const serverInfo = useChatServerInfo()
  const currentCompany = useAppStore((s) => s.currentCompany)

  const panelRef = useRef<HTMLDivElement>(null)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [compact, setCompact] = useState(false)


  // Auth state
  const [isReady, setIsReady] = useState(false)
  const [authMode, setAuthMode] = useState<AuthMode>('claude-code')
  const [codexStatus, setCodexStatus] = useState<CodexStatus>({ available: false, authenticated: false, models: [] })
  const [claudeCodeAvailable, setClaudeCodeAvailable] = useState(false)
  const [claudeCodeError, setClaudeCodeError] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [isChecking, setIsChecking] = useState(true)
  useEffect(() => {
    const panel = panelRef.current
    if (!panel) return
    const observer = new ResizeObserver(([entry]) => setCompact(entry.contentRect.width < 680))
    observer.observe(panel)
    return () => observer.disconnect()
  }, [isChecking, isReady, serverInfo])

  // Synchronously hydrate the tab list from localStorage during the first
  // render so multi-tab users see the right tab count immediately — no
  // 1-tab→N-tab flicker. Uses a ref so tabs and activeTabId share the same
  // freshly-generated UUIDs (the persisted entry only stores titles + session ids).
  const initialChatStateRef = useRef<{ tabs: ChatTab[]; activeTabId: string } | null>(null)
  if (initialChatStateRef.current === null) {
    const persisted = currentCompany?.id ? safeReadChatTabs(currentCompany.id) : null
    if (persisted && persisted.tabs.length > 0) {
      const restored: ChatTab[] = persisted.tabs.map((tab) => ({
        id: crypto.randomUUID(),
        title: tab.title || t('chat.newChat'),
        sessionId: tab.sessionId,
      }))
      initialChatStateRef.current = {
        tabs: restored,
        activeTabId: restored[persisted.activeIndex]?.id ?? restored[0].id,
      }
    } else {
      const tab: ChatTab = { id: crypto.randomUUID(), title: t('chat.newChat'), sessionId: null }
      initialChatStateRef.current = { tabs: [tab], activeTabId: tab.id }
    }
  }

  // Tab management state
  const [tabs, setTabs] = useState<ChatTab[]>(initialChatStateRef.current.tabs)
  const [activeTabId, setActiveTabId] = useState<string>(initialChatStateRef.current.activeTabId)
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs

  const createNewTab = useCallback(() => {
    const newTab: ChatTab = { id: crypto.randomUUID(), title: t('chat.newChat'), sessionId: null }
    setTabs(prev => [...prev, newTab])
    setActiveTabId(newTab.id)
  }, [t])

  const openSession = useCallback((sessionId: string) => {
    const existing = tabsRef.current.find(tab => tab.sessionId === sessionId)
    if (existing) { setActiveTabId(existing.id); return }
    const tab: ChatTab = { id: crypto.randomUUID(), title: t('chat.newChat'), sessionId }
    tabsRef.current = [...tabsRef.current, tab]
    setTabs(tabsRef.current)
    setActiveTabId(tab.id)
  }, [t])

  useEffect(() => {
    if (!currentCompany?.id) return
    return window.electronAPI.onChatHistoryChanged(({ companyId, deletedSessionId }) => {
      if (companyId !== currentCompany.id || !deletedSessionId) return
      const remaining = tabsRef.current.filter(tab => tab.sessionId !== deletedSessionId)
      if (remaining.length === tabsRef.current.length) return
      if (!remaining.length) remaining.push({ id: crypto.randomUUID(), title: t('chat.newChat'), sessionId: null })
      tabsRef.current = remaining
      setTabs(remaining)
      setActiveTabId(id => remaining.some(tab => tab.id === id) ? id : remaining[0].id)
    })
  }, [currentCompany?.id, t])

  const closeTab = useCallback((closingTabId: string) => {
    const prev = tabsRef.current
    if (prev.length <= 1) return
    const closedIndex = prev.findIndex(tab => tab.id === closingTabId)
    const newTabs = prev.filter(tab => tab.id !== closingTabId)
    tabsRef.current = newTabs
    setTabs(newTabs)
    setActiveTabId(current => {
      if (closingTabId !== current) return current
      const newActive = newTabs[Math.min(closedIndex, newTabs.length - 1)]
      return newActive.id
    })
  }, [])

  const updateTabTitle = useCallback((targetTabId: string, title: string) => {
    // Same title → same array: no re-render of the tab bar, sidebar or chats.
    setTabs(prev => prev.some(tab => tab.id === targetTabId && tab.title !== title)
      ? prev.map(tab => tab.id === targetTabId ? { ...tab, title } : tab)
      : prev)
  }, [])

  const updateTabSessionId = useCallback((targetTabId: string, sessionId: string | null) => {
    setTabs(prev => {
      const idx = prev.findIndex(tab => tab.id === targetTabId)
      if (idx === -1 || prev[idx].sessionId === sessionId) return prev
      const next = prev.slice()
      next[idx] = { ...next[idx], sessionId }
      return next
    })
  }, [])

  // Stable props for the memoised chats: a tab whose own props did not change
  // (another tab's title, the active tab switching elsewhere) does not re-render.
  const tabCallbacksRef = useRef(new Map<string, { title: (title: string) => void; sessionId: (sessionId: string | null) => void }>())
  const tabCallbacks = (tabId: string) => {
    let callbacks = tabCallbacksRef.current.get(tabId)
    if (!callbacks) {
      callbacks = { title: title => updateTabTitle(tabId, title), sessionId: sessionId => updateTabSessionId(tabId, sessionId) }
      tabCallbacksRef.current.set(tabId, callbacks)
    }
    return callbacks
  }
  const openSettings = useCallback(() => setShowSettings(true), [])
  const toggleSidebar = useCallback(() => setSidebarOpen(open => !open), [])
  // The layout passes a new object on every render; only its value matters.
  const departmentName = activeDepartment?.name
  const departmentFolder = activeDepartment?.folder
  const stableDepartment = useMemo(
    () => departmentName === undefined && departmentFolder === undefined ? undefined : { name: departmentName ?? '', folder: departmentFolder ?? '' },
    [departmentName, departmentFolder],
  )

  // Handle cross-company changes (not the initial mount — that's already
  // hydrated synchronously above). tabRestoredForId gates the persist effect
  // so a transient state during a switch can't clobber the stored entry.
  const [tabRestoredForId, setTabRestoredForId] = useState<string | null>(null)
  const isFirstTabMountRef = useRef(true)
  useEffect(() => {
    if (!currentCompany?.id) {
      setTabRestoredForId(null)
      return
    }
    if (tabRestoredForId === currentCompany.id) return
    const targetCompanyId = currentCompany.id
    const wasFirstMount = isFirstTabMountRef.current
    isFirstTabMountRef.current = false

    if (!wasFirstMount) {
      const persisted = safeReadChatTabs(targetCompanyId)
      if (persisted && persisted.tabs.length > 0) {
        const restored: ChatTab[] = persisted.tabs.map((tab) => ({
          id: crypto.randomUUID(),
          title: tab.title || t('chat.newChat'),
          sessionId: tab.sessionId,
        }))
        setTabs(restored)
        setActiveTabId(restored[persisted.activeIndex]?.id ?? restored[0].id)
      } else {
        const fresh: ChatTab = { id: crypto.randomUUID(), title: t('chat.newChat'), sessionId: null }
        setTabs([fresh])
        setActiveTabId(fresh.id)
      }
    }
    setTabRestoredForId(targetCompanyId)
  }, [currentCompany?.id, tabRestoredForId, t])

  // Persist the tab list whenever it changes, gated on restoration completion.
  useEffect(() => {
    if (!currentCompany?.id || tabRestoredForId !== currentCompany.id) return
    const activeIndex = Math.max(0, tabs.findIndex(tab => tab.id === activeTabId))
    safeWriteChatTabs(currentCompany.id, {
      tabs: tabs.map(tab => ({ title: tab.title, sessionId: tab.sessionId })),
      activeIndex,
    })
  }, [currentCompany?.id, tabRestoredForId, tabs, activeTabId])


  // Auth check on mount
  const initializedRef = useRef(false)
  if (!initializedRef.current) {
    initializedRef.current = true
    checkAuth()
  }

  async function checkAuth(background = false) {
    if (!background) setIsChecking(true)
    try {
      const [ccStatus, savedAuthMode, hasApiKey] = await Promise.all([
        window.electronAPI.getClaudeCodeStatus(),
        window.electronAPI.getAuthMode(),
        window.electronAPI.hasApiKey(),
      ])

      const ccAvailable = ccStatus.available && ccStatus.authenticated
      setClaudeCodeAvailable(ccAvailable)
      setClaudeCodeError(ccStatus.error)
      setAuthMode(savedAuthMode)

      if (savedAuthMode === 'codex') {
        const status = await window.electronAPI.getCodexStatus()
        setCodexStatus(status)
        // Keep the chat mounted, including drafts; show actionable auth errors in settings.
        setIsReady(true)
      } else if (savedAuthMode === 'claude-code' && ccAvailable) {
        setIsReady(true)
      } else if (savedAuthMode === 'api-key' && hasApiKey) {
        setIsReady(true)
      } else if (!background) setIsReady(false)
    } finally {
      if (!background) setIsChecking(false)
    }
  }

  // ============================================================================
  // Render States
  // ============================================================================

  if (isChecking || !serverInfo) {
    return (
      <div className="h-full flex flex-col items-center justify-center p-8">
        <div className="relative">
          <div className="w-12 h-12 rounded-2xl bg-surface-elevated border border-white/[0.06] flex items-center justify-center">
            <CircleNotch size={20} className="text-accent animate-spin" />
          </div>
        </div>
        <p className="mt-4 text-sm text-ink-muted">{t('auth.checkingAuth')}</p>
      </div>
    )
  }

  if (!isReady) {
    return (
      <div className="h-full flex flex-col items-center justify-center p-8 text-center">
        <div className="w-16 h-16 rounded-2xl bg-surface-elevated border border-white/[0.06] flex items-center justify-center mb-6 shadow-glass">
          <Lightning size={28} weight="fill" className="text-accent" />
        </div>
        <h3 className="text-lg font-medium text-ink mb-2">
          {t('auth.setupAssistant')}
        </h3>
        <p className="text-sm text-ink-muted mb-6 max-w-[240px]">
          {claudeCodeAvailable
            ? t('auth.connectOptions')
            : t('auth.apiKeyRequired')}
        </p>
        {claudeCodeError && (
          <div className="mb-4 p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 max-w-[320px]">
            <p className="text-xs text-amber-400">{claudeCodeError}</p>
          </div>
        )}
        <button
          onClick={() => setShowSettings(true)}
          className="
            flex items-center gap-2
            bg-accent hover:bg-accent/90
            text-white text-sm font-medium
            rounded-xl px-5 py-2.5
            transition-all duration-200
            hover:shadow-glow hover:scale-[1.02]
            active:scale-[0.98]
          "
        >
          <GearSix size={16} weight="bold" />
          {t('auth.openSettings')}
        </button>
      </div>
    )
  }

  return (
    <OpenConsultationContext.Provider value={id => {
      if (!currentCompany) return
      void window.electronAPI.getChatSession(currentCompany.id, id).then(session => {
        if (session) openSession(id)
        else window.alert("この相談は削除されたか、参照できません。")
      }).catch(() => window.alert("相談を開けませんでした。"))
    }}>
    <div ref={panelRef} className="h-full relative flex min-w-0">
      {sidebarOpen && <>
        {compact && <button aria-label="相談一覧を閉じる" className="absolute inset-0 bg-black/20 z-20" onClick={() => setSidebarOpen(false)} />}
        <div className={compact ? 'absolute inset-y-0 left-0 z-30 shadow-xl' : 'shrink-0'}>
          <ChatSidebar companyId={currentCompany!.id} tabs={tabs} activeTabId={activeTabId}
            onSelectTab={id => { setActiveTabId(id); if (compact) setSidebarOpen(false) }}
            onOpenSession={id => { openSession(id); if (compact) setSidebarOpen(false) }}
            onCloseTab={closeTab} onNew={() => { createNewTab(); if (compact) setSidebarOpen(false) }}
            onHide={() => setSidebarOpen(false)} />
        </div>
      </>}

      {/* Chat instances (all mounted, only active visible) */}
      <div className="flex-1 min-h-0 min-w-0 relative">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            // Hidden tabs stay mounted (streams, drafts, questions keep running)
            // but skip style, layout and paint entirely.
            className={`absolute inset-0 ${tab.id === activeTabId ? '' : 'invisible pointer-events-none [content-visibility:hidden]'}`}
          >
            <div className={showSettings && tab.id === activeTabId ? 'h-full invisible' : 'h-full'}>
              <ChatPanelChat
                isActive={tab.id === activeTabId}
                departmentPath={departmentPath}
                activeDepartment={stableDepartment}
                serverInfo={serverInfo}
                authMode={authMode}
                codexStatus={codexStatus}
                slashCommands={slashCommands}
                onShowSettings={openSettings}
                onTitleChange={tabCallbacks(tab.id).title}
                onNewTab={createNewTab}
                onToggleSidebar={toggleSidebar}
                sidebarOpen={sidebarOpen}
                initialSessionId={tab.sessionId}
                onSessionIdChange={tabCallbacks(tab.id).sessionId}
              />
            </div>
          </div>
        ))}
      </div>

      {/* Settings overlay */}
      {showSettings && (
        <div role="dialog" aria-label="相談の設定" className="absolute inset-0 z-10">
          <AuthSettings
            authMode={authMode}
            claudeCodeAvailable={claudeCodeAvailable}
            claudeCodeError={claudeCodeError}
            onClose={() => {
              setShowSettings(false)
              checkAuth(true)
            }}
          />
        </div>
      )}
    </div>
    </OpenConsultationContext.Provider>
  )
}

// ============================================================================
// Auth Settings Component
// ============================================================================

interface AuthSettingsProps {
  authMode: AuthMode
  claudeCodeAvailable: boolean
  claudeCodeError?: string | null
  onClose: () => void
}

function AuthSettings({ authMode: initialAuthMode, claudeCodeAvailable, claudeCodeError, onClose }: AuthSettingsProps) {
  const { t } = useTranslation()
  const [authMode, setAuthMode] = useState<AuthMode>(initialAuthMode)
  const [codexStatus, setCodexStatus] = useState<CodexStatus | null>(null)
  const [checkingCodex, setCheckingCodex] = useState(false)
  const [saveError, setSaveError] = useState('')
  const refreshCodex = async () => {
    setCheckingCodex(true)
    try { setCodexStatus(await window.electronAPI.getCodexStatus()) }
    catch (e) { setCodexStatus({ available: false, authenticated: false, models: [], error: `${String(e)}\n${CODEX_LOGIN_HELP}` }) }
    finally { setCheckingCodex(false) }
  }
  useEffect(() => { if (authMode === 'codex') void refreshCodex() }, [authMode])
  const [apiKey, setApiKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [showApiKey, setShowApiKey] = useState(false)
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(DEFAULT_PERMISSION_MODE)
  // Only persist a mode the user actually picked, so an unset mode keeps following the default.
  const loadedPermissionModeRef = useRef<PermissionMode | null>(null)

  const keyLoadedRef = useRef(false)
  if (!keyLoadedRef.current) {
    keyLoadedRef.current = true
    loadCurrentKey()
    loadPermissionMode()
  }

  async function loadCurrentKey() {
    const key = await window.electronAPI.getApiKey()
    if (key) {
      setApiKey('sk-ant-' + '*'.repeat(20))
    }
  }

  async function loadPermissionMode() {
    const mode = await window.electronAPI.getPermissionMode()
    loadedPermissionModeRef.current = mode
    setPermissionMode(mode)
  }

  async function handleSave() {
    setSaving(true)
    try {
      await window.electronAPI.setAuthMode(authMode)
      if (authMode === 'api-key' && apiKey && !apiKey.includes('*')) {
        await window.electronAPI.setApiKey(apiKey)
      }
      if (permissionMode !== loadedPermissionModeRef.current) await window.electronAPI.setPermissionMode(permissionMode)
      onClose()
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="h-full flex flex-col bg-surface">
      {/* Header */}
      <header className="flex-shrink-0 h-12 flex items-center justify-between px-4 border-b border-white/[0.04]">
        <span className="text-sm font-medium text-ink">{t('chatSettings.title')}</span>
        <button
          onClick={onClose}
          className="w-8 h-8 rounded-lg hover:bg-white/[0.04] flex items-center justify-center transition-colors text-ink-muted hover:text-ink"
        >
          ✕
        </button>
      </header>

      {/* Content */}
      <div className="flex-1 overflow-auto p-4 space-y-4">
        <section className="rounded-xl border border-gray-200 dark:border-zinc-700 p-4"><VoiceShortcutSettings /></section>
        <div className="space-y-3">
          <label className="block text-xs font-medium tracking-wide uppercase text-ink-muted mb-3">
            {t('chatSettings.selectMethod')}
          </label>

          {/* Claude Code Option */}
          <button
            onClick={() => setAuthMode('claude-code')}
            className={`
              w-full text-left p-4 rounded-xl border transition-all duration-200
              ${authMode === 'claude-code'
                ? 'border-accent/50 bg-accent/10 shadow-glow'
                : 'border-white/[0.06] bg-surface-elevated hover:border-white/[0.1]'
              }
            `}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${
                  authMode === 'claude-code' ? 'bg-accent' : 'bg-white/[0.04]'
                }`}>
                  <Lightning size={16} weight="fill" className={authMode === 'claude-code' ? 'text-white' : 'text-ink-muted'} />
                </div>
                <div>
                  <div className="font-medium text-ink text-sm">{t('chatSettings.claudeMax')}</div>
                  <div className="text-xs text-ink-muted mt-0.5">
                    {claudeCodeAvailable ? t('chatSettings.claudeMaxDesc') : t('chatSettings.cliNotFound')}
                  </div>
                </div>
              </div>
              {authMode === 'claude-code' && (
                <Check size={18} weight="bold" className="text-accent" />
              )}
            </div>
          </button>

          <button onClick={() => setAuthMode('codex')}
            className={`w-full text-left p-4 rounded-xl border transition-colors ${authMode === 'codex' ? 'border-accent/50 bg-accent/10' : 'border-white/[0.06] bg-surface-elevated'}`}>
            <div className="flex items-center justify-between">
              <div><div className="font-medium text-ink text-sm">Codex（ChatGPTプラン）</div>
                <div className="text-xs text-ink-muted mt-1">自分のChatGPTアカウントの利用枠で相談します</div></div>
              {authMode === 'codex' && <Check size={18} className="text-accent" />}
            </div>
          </button>
          {/* API Key Option */}
          <button
            onClick={() => setAuthMode('api-key')}
            className={`
              w-full text-left p-4 rounded-xl border transition-all duration-200
              ${authMode === 'api-key'
                ? 'border-accent/50 bg-accent/10 shadow-glow'
                : 'border-white/[0.06] bg-surface-elevated hover:border-white/[0.1]'
              }
            `}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${
                  authMode === 'api-key' ? 'bg-accent' : 'bg-white/[0.04]'
                }`}>
                  <GearSix size={16} weight="fill" className={authMode === 'api-key' ? 'text-white' : 'text-ink-muted'} />
                </div>
                <div>
                  <div className="font-medium text-ink text-sm">{t('chatSettings.apiKey')}</div>
                  <div className="text-xs text-ink-muted mt-0.5">{t('chatSettings.apiKeyDesc')}</div>
                </div>
              </div>
              {authMode === 'api-key' && (
                <Check size={18} weight="bold" className="text-accent" />
              )}
            </div>
          </button>
        </div>

        <p className="text-xs text-ink-muted">変更は次の送信から適用されます。AIやモデルを切り替えると、相談の表示履歴を渡して新しいAIセッションで続けます。元のAIの内部状態やツール実行結果は引き継ぎません。</p>
        {authMode === 'codex' && <section className="rounded-xl border border-white/[0.08] p-4 space-y-2 text-sm">
          <p className="text-xs text-ink-muted">作業フォルダ内の通常作業は自動で進めます。フォルダ外への書き込みや、追加権限が必要な操作では確認します。</p>
          <p>{checkingCodex ? 'Codexを確認しています…' : codexStatus?.authenticated && codexStatus.models.length ? 'ChatGPTでログイン済み' : codexStatus?.unsupported ? 'Windowsでは未対応です' : 'Codexの準備が必要です'}</p>
          {codexStatus?.error && <p className="text-xs text-red-500">{codexStatus.error}</p>}
          {!codexStatus?.unsupported && <p className="text-xs text-ink-muted">接続できない場合は、ターミナルを開いて <code>codex login</code> を実行し、ChatGPTアカウントでログインしてください。その後「接続を再確認」を押してください。</p>}
          <button onClick={() => void refreshCodex()} disabled={checkingCodex || codexStatus?.unsupported} className="text-accent text-xs disabled:opacity-50">接続を再確認</button>
        </section>}
        {saveError && <p role="alert" className="text-sm text-red-500">{saveError}</p>}
        {/* API Key Input */}
        {authMode === 'api-key' && (
          <div className="space-y-3 pt-2 animate-fade-in">
            <label className="block text-xs font-medium tracking-wide uppercase text-ink-muted">
              {t('chatSettings.apiKey')}
            </label>
            <div className="relative">
              <input
                type={showApiKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={t('chatSettings.apiKeyPlaceholder')}
                className="
                  w-full bg-surface-elevated border border-white/[0.06]
                  rounded-xl px-4 py-3 pr-20
                  text-sm text-ink placeholder-ink-faint
                  focus:outline-none focus:border-accent/50
                  transition-colors
                "
              />
              <button
                type="button"
                onClick={() => setShowApiKey(!showApiKey)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-ink-muted hover:text-ink transition-colors"
              >
                {showApiKey ? t('chatSettings.hideKey') : t('chatSettings.showKey')}
              </button>
            </div>

            <details className="text-xs text-ink-muted">
              <summary className="cursor-pointer hover:text-ink transition-colors flex items-center gap-1">
                <CaretDown size={12} />
                {t('chatSettings.howToGetKey')}
              </summary>
              <ol className="list-decimal list-inside space-y-1 mt-2 pl-1 text-ink-faint">
                <li>{t('chatSettings.step1')}</li>
                <li>{t('chatSettings.step2')}</li>
                <li>{t('chatSettings.step3')}</li>
              </ol>
            </details>
          </div>
        )}

        {/* Claude Code Setup Instructions */}
        {authMode === 'claude-code' && !claudeCodeAvailable && (
          <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/20 animate-fade-in">
            {claudeCodeError ? (
              <>
                <p className="text-xs font-medium text-amber-400 mb-2">{claudeCodeError}</p>
                <div className="mt-2 pt-2 border-t border-amber-500/20">
                  <p className="text-[11px] text-ink-muted">{t('chatSettings.setupRequired')}</p>
                </div>
              </>
            ) : (
              <p className="text-xs font-medium text-amber-400 mb-2">{t('chatSettings.setupRequired')}</p>
            )}
            <ol className="list-decimal list-inside space-y-1 text-xs text-ink-muted mt-2">
              <li>{t('chatSettings.setupStep1')}</li>
              <li><code className="bg-black/30 px-1.5 py-0.5 rounded font-mono text-[11px]">{t('chatSettings.setupStep2')}</code></li>
              <li><code className="bg-black/30 px-1.5 py-0.5 rounded font-mono text-[11px]">{t('chatSettings.setupStep3')}</code></li>
              <li>{t('chatSettings.setupStep4')}</li>
            </ol>
          </div>
        )}

        {/* Permission Mode Toggle (Claude Code mode only) */}
        {authMode === 'claude-code' && claudeCodeAvailable && (
          <div className="space-y-3 pt-2 animate-fade-in">
            <label className="block text-xs font-medium tracking-wide uppercase text-ink-muted">
              {t('chatSettings.permissionMode')}
            </label>
            <div className="space-y-2">
              {([
                ['auto', 'permissionAuto'],
                ['default', 'permissionDefault'],
                ['bypassPermissions', 'permissionBypass'],
              ] as const).map(([mode, key]) => (
                <button
                  key={mode}
                  onClick={() => setPermissionMode(mode)}
                  className={`w-full text-left p-3 rounded-lg border transition-all duration-200 ${
                    permissionMode === mode
                      ? 'border-accent/50 bg-accent/10'
                      : 'border-white/[0.06] bg-surface-elevated hover:border-white/[0.1]'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-sm font-medium text-ink">{t(`chatSettings.${key}`)}</div>
                      <div className="text-xs text-ink-muted mt-0.5">{t(`chatSettings.${key}Desc`)}</div>
                    </div>
                    {permissionMode === mode && (
                      <Check size={16} weight="bold" className="text-accent flex-shrink-0" />
                    )}
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="flex-shrink-0 p-4 border-t border-white/[0.04]">
        <button
          onClick={handleSave}
          disabled={saving || (authMode === 'api-key' && !apiKey) || (authMode === 'codex' && (checkingCodex || !codexStatus?.authenticated || !codexStatus.models.length))}
          className="
            w-full py-3 rounded-xl
            bg-accent hover:bg-accent/90
            disabled:bg-ink-faint disabled:cursor-not-allowed
            text-white text-sm font-medium
            transition-all duration-200
            hover:shadow-glow
          "
        >
          {saving ? t('common.saving') : t('common.save')}
        </button>
      </div>
    </div>
  )
}
