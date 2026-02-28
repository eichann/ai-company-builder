import { useState, useEffect, useRef, useCallback, memo, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport, type UIMessage } from 'ai'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView, placeholder as codeMirrorPlaceholder } from '@codemirror/view'
import {
  Sparkle,
  GearSix,
  Check,
  Lightning,
  CircleNotch,
  CaretDown,
  ArrowUp,
  Brain,
  CaretUp,
  Plus,
  ClockCounterClockwise,
  Trash,
  X,
  Terminal,
  File,
  FolderOpen,
  PencilSimple,
  WarningCircle,
  ArrowCounterClockwise,
  ShieldWarning,
} from '@phosphor-icons/react'
import { useAppStore } from '../../stores/appStore'
import { isPerfCutEnabled, isPerfDiagnosticsEnabled, perfMark, perfMeasure } from '../../lib/perfDiagnostics'
import { markChatInputActivity } from '../../lib/chatInputActivity'

// ============================================================================
// Types
// ============================================================================

interface ChatSession {
  id: string
  companyId: string
  title: string
  messages: Array<{
    id: string
    role: 'user' | 'assistant'
    content: string
    timestamp: string
    thinking?: string
  }>
  createdAt: string
  updatedAt: string
}

type AuthMode = 'claude-code' | 'api-key'

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
  for (const part of msg.parts) {
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
  }
}

function sessionMessageToUIMessage(
  msg: ChatSession['messages'][0],
): UIMessage {
  const parts: UIMessage['parts'] = []
  if (msg.thinking) {
    parts.push({ type: 'reasoning' as const, text: msg.thinking })
  }
  parts.push({ type: 'text' as const, text: msg.content })
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

function StreamingCursor() {
  return (
    <span className="inline-block w-0.5 h-4 bg-accent/70 ml-0.5 animate-pulse-soft align-middle" />
  )
}

// ============================================================================
// Tool Invocation Part Component
// ============================================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const TOOL_ICONS: Record<string, React.ComponentType<any>> = {
  readFile: File,
  writeFile: PencilSimple,
  listDirectory: FolderOpen,
  executeCommand: Terminal,
  readSkillFile: File,
}

function getToolDisplayName(toolName: string): string {
  const names: Record<string, string> = {
    readFile: 'ファイル読取',
    writeFile: 'ファイル書込',
    listDirectory: 'ディレクトリ一覧',
    executeCommand: 'コマンド実行',
    readSkillFile: 'スキルファイル読取',
  }
  return names[toolName] || toolName
}

interface ToolPartProps {
  toolName: string
  state: string
  input?: unknown
  output?: unknown
  errorText?: string
}

function ToolInvocationPartView({ toolName, state, input, output, errorText }: ToolPartProps) {
  const [isExpanded, setIsExpanded] = useState(false)
  const IconComponent = TOOL_ICONS[toolName] || Terminal
  const displayName = getToolDisplayName(toolName)

  const isRunning = state === 'input-streaming' || state === 'input-available'
  const isDone = state === 'output-available'
  const isError = state === 'output-error'

  // Build summary for the tool input
  let inputSummary = ''
  if (input && typeof input === 'object') {
    const inp = input as Record<string, unknown>
    if (inp.path) inputSummary = String(inp.path)
    else if (inp.command) inputSummary = String(inp.command)
  }

  return (
    <div className="my-1.5 animate-fade-in">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex items-center gap-2 text-xs hover:bg-gray-100 dark:hover:bg-zinc-800 px-2 py-1.5 rounded-lg transition-colors w-full text-left"
      >
        {/* Status icon */}
        {isRunning ? (
          <CircleNotch size={14} className="animate-spin text-accent flex-shrink-0" />
        ) : isDone ? (
          <Check size={14} weight="bold" className="text-green-500 flex-shrink-0" />
        ) : isError ? (
          <WarningCircle size={14} weight="fill" className="text-red-400 flex-shrink-0" />
        ) : (
          <CircleNotch size={14} className="text-gray-400 flex-shrink-0" />
        )}

        {/* Tool icon + name */}
        <IconComponent size={14} className="text-gray-500 dark:text-zinc-400 flex-shrink-0" />
        <span className="font-medium text-gray-700 dark:text-zinc-300">{displayName}</span>

        {/* Input summary */}
        {inputSummary && (
          <span className="text-gray-400 dark:text-zinc-500 font-mono truncate max-w-[200px]">
            {inputSummary}
          </span>
        )}

        {/* Expand caret */}
        {(isDone || isError) && (
          <CaretDown
            size={12}
            className={`text-gray-400 ml-auto transition-transform ${isExpanded ? 'rotate-180' : ''}`}
          />
        )}
      </button>

      {/* Expanded content */}
      {isExpanded && (isDone || isError) && (
        <div className="mt-1 ml-8 text-xs animate-slide-up">
          {isError && errorText && (
            <div className="p-2 rounded-md bg-red-500/10 border border-red-500/20 text-red-400 font-mono whitespace-pre-wrap">
              {errorText}
            </div>
          )}
          {isDone && output != null && (
            <div className="p-2 rounded-md bg-gray-50 dark:bg-zinc-800/50 border border-gray-200 dark:border-zinc-700 text-gray-600 dark:text-zinc-400 font-mono whitespace-pre-wrap max-h-48 overflow-auto">
              {typeof output === 'string' ? output : JSON.stringify(output, null, 2)}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function ThinkingBlock({ content, isStreaming = false }: { content: string; isStreaming?: boolean }) {
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
}

// ============================================================================
// Tool Approval Banner
// ============================================================================

interface ToolApprovalRequest {
  toolUseId: string
  toolName: string
  toolInput: Record<string, unknown>
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
    if (request.toolInput.command) inputSummary = String(request.toolInput.command)
    else if (request.toolInput.path) inputSummary = String(request.toolInput.path)
  }

  return (
    <div className="flex-shrink-0 px-4 py-3 bg-amber-500/10 border-b border-amber-500/20 animate-fade-in">
      <div className="flex items-start gap-3">
        <ShieldWarning size={18} weight="fill" className="text-amber-400 flex-shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-amber-300 mb-1">
            {t('chat.toolApprovalTitle')}
          </div>
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
  canEdit,
  onEditSubmit,
}: {
  message: UIMessage
  canEdit: boolean
  onEditSubmit?: (messageId: string, newText: string) => void
}) {
  const { t } = useTranslation()
  const [isEditing, setIsEditing] = useState(false)
  const [editText, setEditText] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

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
      <div className="relative rounded-2xl px-4 py-3 text-[14px] leading-relaxed bg-accent text-white rounded-br-md">
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
  isLastAssistant?: boolean
  canRegenerate?: boolean
  onRegenerate?: () => void
  canEdit?: boolean
  onEditSubmit?: (messageId: string, newText: string) => void
}

const MessageItem = memo(function MessageItem({ message, isStreaming, timestamp, isLastAssistant, canRegenerate, onRegenerate, canEdit, onEditSubmit }: MessageItemProps) {
  const { t } = useTranslation()
  const isUser = message.role === 'user'

  return (
    <div className={`animate-slide-up ${isUser ? 'flex justify-end' : ''}`}>
      <div className={`max-w-[85%] ${isUser ? 'ml-auto' : ''}`}>
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
        {!isUser && message.parts.map((part, index) => {
          const isLastPart = index === message.parts.length - 1

          if (part.type === 'reasoning') {
            return (
              <ThinkingBlock
                key={index}
                content={part.text}
                isStreaming={isStreaming && isLastPart}
              />
            )
          }

          if (part.type === 'text') {
            // Skip empty text parts (common between tool steps)
            if (!part.text) return null
            return (
              <div
                key={index}
                className="relative rounded-2xl rounded-tl-md px-4 py-3 text-[14px] leading-relaxed bg-gray-100 dark:bg-zinc-800 text-gray-900 dark:text-zinc-100 border border-gray-200 dark:border-zinc-700 shadow-glass"
              >
                <div className="absolute inset-0 rounded-2xl rounded-tl-md bg-gradient-to-b from-white/[0.02] to-transparent pointer-events-none" />
                <div className="relative whitespace-pre-wrap break-words">
                  {part.text}
                  {isStreaming && isLastPart && <StreamingCursor />}
                </div>
              </div>
            )
          }

          if (part.type === 'step-start') {
            return (
              <div key={index} className="my-2 border-t border-gray-200 dark:border-zinc-700/50" />
            )
          }

          // Tool invocations: typed tools (tool-readFile, tool-writeFile, etc.)
          if (typeof part.type === 'string' && part.type.startsWith('tool-')) {
            const toolPart = part as { type: string; state: string; toolCallId: string; input?: unknown; output?: unknown; errorText?: string }
            const toolName = part.type.replace('tool-', '')
            return (
              <ToolInvocationPartView
                key={toolPart.toolCallId || index}
                toolName={toolName}
                state={toolPart.state}
                input={toolPart.input}
                output={toolPart.output}
                errorText={toolPart.errorText}
              />
            )
          }

          // Dynamic tools (from Claude Code CLI mode)
          if (part.type === 'dynamic-tool') {
            const dynPart = part as { type: 'dynamic-tool'; toolName: string; toolCallId: string; state: string; input?: unknown; output?: unknown; errorText?: string }
            return (
              <ToolInvocationPartView
                key={dynPart.toolCallId || index}
                toolName={dynPart.toolName}
                state={dynPart.state}
                input={dynPart.input}
                output={dynPart.output}
                errorText={dynPart.errorText}
              />
            )
          }

          return null
        })}

        {/* User message */}
        {isUser && (
          <UserMessageBubble
            message={message}
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

interface ChatInputProps {
  onSend: (text: string, files?: File[]) => void
  disabled: boolean
  placeholder: string
  hint: string
  onCompositionStateChange?: (isComposing: boolean) => void
  onInputActivity?: () => void
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
  onSend,
  disabled,
  placeholder,
  hint,
  onCompositionStateChange,
  onInputActivity,
}: ChatInputProps) {
  const editorHostRef = useRef<HTMLDivElement>(null)
  const editorViewRef = useRef<EditorView | null>(null)
  const onSendRef = useRef(onSend)
  const disabledRef = useRef(disabled)
  const onCompositionStateChangeRef = useRef(onCompositionStateChange)
  const onInputActivityRef = useRef(onInputActivity)
  const isComposingRef = useRef(false)
  const editableCompartmentRef = useRef(new Compartment())
  const placeholderCompartmentRef = useRef(new Compartment())

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
      doc: '',
      extensions: [
        chatInputCodeMirrorTheme,
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
        EditorView.domEventHandlers({
          keydown: (event) => {
            onInputActivityRef.current?.()
            perfMark('chat.input.keydown')
            markDispatchDelay('chat.input.keydown.dispatch_delay.ms', event.timeStamp)
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

  useEffect(() => {
    const view = editorViewRef.current
    if (!view) return

    view.dispatch({
      effects: editableCompartmentRef.current.reconfigure([
        EditorView.editable.of(!disabled),
        EditorState.readOnly.of(disabled),
      ]),
    })
  }, [disabled])

  useEffect(() => {
    const view = editorViewRef.current
    if (!view) return

    view.dispatch({
      effects: placeholderCompartmentRef.current.reconfigure(codeMirrorPlaceholder(placeholder)),
    })
  }, [placeholder])

  return (
    <div className="relative">
      <div className="absolute -inset-px rounded-xl bg-gradient-to-r from-accent/20 via-transparent to-accent/20 opacity-0 group-focus-within:opacity-100 transition-opacity blur-sm" />

      <div className="relative flex items-end gap-2 p-2 rounded-xl bg-gray-50 dark:bg-zinc-800 border border-gray-200 dark:border-zinc-700 shadow-glass group focus-within:border-accent/50 transition-colors">
        <div className="flex-1 text-gray-900 dark:text-zinc-100 min-h-[40px] max-h-[200px] overflow-hidden">
          <div ref={editorHostRef} />
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
  onSend,
  disabled,
  placeholder,
  hint,
  onCompositionStateChange,
  onInputActivity,
}: ChatInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const handleSend = useCallback(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    const value = textarea.value.trim()
    if (value && !disabled) {
      onSend(value)
      textarea.value = ''
    }
  }, [disabled, onSend])

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
          ref={textareaRef}
          onKeyDown={handleKeyDown}
          onCompositionStart={() => { onInputActivity?.(); onCompositionStateChange?.(true) }}
          onCompositionEnd={() => { onInputActivity?.(); onCompositionStateChange?.(false) }}
          placeholder={placeholder}
          disabled={disabled}
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

const ChatInput = memo(function ChatInput({
  onSend,
  disabled,
  placeholder,
  hint,
  onCompositionStateChange,
  onInputActivity,
}: ChatInputProps) {
  const isLegacyTextareaMode = isPerfCutEnabled('chatInputBare')
  const [attachedImages, setAttachedImages] = useState<File[]>([])
  const [isDragOver, setIsDragOver] = useState(false)
  const dragCounterRef = useRef(0)

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current++
    if (e.dataTransfer.types.includes('Files')) {
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

    const files = Array.from(e.dataTransfer.files).filter(f => IMAGE_MIME_TYPES.includes(f.type))
    if (files.length > 0) {
      setAttachedImages(prev => [...prev, ...files])
    }
  }, [])

  const removeImage = useCallback((index: number) => {
    setAttachedImages(prev => prev.filter((_, i) => i !== index))
  }, [])

  const handleSendWithImages = useCallback((text: string) => {
    const images = attachedImages.length > 0 ? [...attachedImages] : undefined
    onSend(text, images)
    setAttachedImages([])
  }, [onSend, attachedImages])

  const inputComponent = isLegacyTextareaMode ? (
    <LegacyTextareaChatInput
      onSend={handleSendWithImages}
      disabled={disabled}
      placeholder={placeholder}
      hint={hint}
      onCompositionStateChange={onCompositionStateChange}
      onInputActivity={onInputActivity}
    />
  ) : (
    <CodeMirrorChatInput
      onSend={handleSendWithImages}
      disabled={disabled}
      placeholder={placeholder}
      hint={hint}
      onCompositionStateChange={onCompositionStateChange}
      onInputActivity={onInputActivity}
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
      {/* Drag overlay */}
      {isDragOver && (
        <div className="absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-accent/10 border-2 border-dashed border-accent pointer-events-none">
          <span className="text-sm font-medium text-accent">画像をドロップ</span>
        </div>
      )}

      {/* Image previews */}
      {attachedImages.length > 0 && (
        <div className="flex gap-2 px-3 pt-2 pb-1 flex-wrap">
          {attachedImages.map((file, i) => (
            <div key={i} className="relative group">
              <img
                src={URL.createObjectURL(file)}
                alt={file.name}
                className="w-16 h-16 object-cover rounded-lg border border-gray-200 dark:border-zinc-700"
              />
              <button
                onClick={() => removeImage(i)}
                className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-gray-600 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity text-xs"
              >
                ×
              </button>
            </div>
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
  onRegenerate?: () => void
  onEditSubmit?: (messageId: string, newText: string) => void
}

const MessageList = memo(function MessageList({
  messages,
  status,
  messagesEndRef,
  containerRef,
  timestamps,
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

  return (
    <div ref={containerRef} className="flex-1 overflow-auto px-4 py-6 space-y-6">
      {messages.map((message, index) => (
        <MessageItem
          key={message.id}
          message={message}
          isStreaming={
            status === 'streaming' &&
            index === messages.length - 1 &&
            message.role === 'assistant'
          }
          timestamp={timestamps.get(message.id)}
          isLastAssistant={index === lastAssistantIndex}
          canRegenerate={canRegenerate}
          onRegenerate={onRegenerate}
          canEdit={canEdit}
          onEditSubmit={onEditSubmit}
        />
      ))}

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
  departmentPath?: string
  serverInfo: { port: number; authToken: string }
  authMode: AuthMode
  onShowSettings: () => void
}

function ChatPanelChat({ departmentPath, serverInfo, authMode, onShowSettings }: ChatPanelChatProps) {
  const { t } = useTranslation()
  const currentCompany = useAppStore((state) => state.currentCompany)
  const activeSkill = useAppStore((state) => state.activeSkill)
  const clearActiveSkill = useAppStore((state) => state.clearActiveSkill)

  // Tool approval state
  const [pendingApproval, setPendingApproval] = useState<ToolApprovalRequest | null>(null)

  useEffect(() => {
    const unsub = window.electronAPI.onToolApprovalRequest((data) => {
      setPendingApproval(data)
    })
    return unsub
  }, [])

  const handleToolApprovalResponse = useCallback((toolUseId: string, approved: boolean) => {
    window.electronAPI.respondToolApproval(toolUseId, approved)
    setPendingApproval(null)
  }, [])

  // Refs for dynamic body params
  const systemPromptRef = useRef<string | undefined>(undefined)
  const workingDirRef = useRef(departmentPath || currentCompany?.rootPath)
  const skillInfoRef = useRef<{ skillFolderPath: string } | undefined>(undefined)

  useEffect(() => {
    workingDirRef.current = departmentPath || currentCompany?.rootPath
  }, [departmentPath, currentCompany?.rootPath])

  // Update system prompt and skillInfo when activeSkill changes
  useEffect(() => {
    if (activeSkill) {
      const skillMdPath = activeSkill.skill.files.skillMd || ''
      const skillFolderPath = skillMdPath.replace(/\/SKILL\.md$/, '')
      skillInfoRef.current = { skillFolderPath }

      // Build file listing sections from actual file arrays
      const { rules, references, scripts } = activeSkill.skill.files
      const ruleFiles = rules?.map(f => f.split('/').pop()).filter(Boolean) || []
      const refFiles = references?.map(f => f.split('/').pop()).filter(Boolean) || []
      const scriptFiles = scripts?.map(f => f.split('/').pop()).filter(Boolean) || []

      let filesSection = '\n## スキルフォルダ内のファイル\n'
      if (ruleFiles.length > 0) {
        filesSection += `\n### rules/\n${ruleFiles.map(f => `- ${f}`).join('\n')}\n`
      }
      if (refFiles.length > 0) {
        filesSection += `\n### references/\n${refFiles.map(f => `- ${f}`).join('\n')}\n`
      }
      if (scriptFiles.length > 0) {
        filesSection += `\n### scripts/\n${scriptFiles.map(f => `- ${f}`).join('\n')}\n`
      }
      if (ruleFiles.length === 0 && refFiles.length === 0 && scriptFiles.length === 0) {
        filesSection += '\n（現在ファイルはありません）\n'
      }

      systemPromptRef.current = `あなたは「${activeSkill.skill.name}」スキルを実行するAIアシスタントです。

## スキル定義（SKILL.md）

${activeSkill.skillMdContent}
${filesSection}
## readSkillFile ツール

スキルフォルダ内のファイルを読むには \`readSkillFile\` ツールを使用してください。
パスはスキルフォルダからの相対パスで指定します。

例:
- rules/ のファイルを読む: \`readSkillFile({ path: "rules/ファイル名" })\`
- references/ のファイルを読む: \`readSkillFile({ path: "references/ファイル名" })\`

SKILL.md の内容を踏まえて、必要に応じて rules/ や references/ のファイルを参照してください。

---

上記のスキル定義に従って、ユーザーの要求に応えてください。`
    } else {
      systemPromptRef.current = undefined
      skillInfoRef.current = undefined
    }
  }, [activeSkill])

  // Pending images to send with next message
  const pendingImagesRef = useRef<Array<{ mediaType: string; data: string }>>([])

  // Transport (memoized - only recreated when server info changes)
  const transport = useMemo(() => {
    return new DefaultChatTransport({
      api: `http://127.0.0.1:${serverInfo.port}/api/chat`,
      headers: { Authorization: `Bearer ${serverInfo.authToken}` },
      body: () => {
        const body: Record<string, unknown> = {
          systemPrompt: systemPromptRef.current,
          workingDirectory: workingDirRef.current,
          skillInfo: skillInfoRef.current,
        }
        if (pendingImagesRef.current.length > 0) {
          body.images = pendingImagesRef.current
          pendingImagesRef.current = []
        }
        return body
      },
    })
  }, [serverInfo.port, serverInfo.authToken])

  // useChat hook
  const { messages, sendMessage, status, stop, setMessages, error, regenerate } = useChat({
    transport,
    experimental_throttle: 50,
    onFinish: () => {
      // Refresh file tree in case AI created/modified files
      window.dispatchEvent(new Event('refresh-file-tree'))
    },
    onError: (err) => {
      console.error('[useChat] Error:', err)
    },
  })

  // Timestamp tracking (sync during render for immediate availability)
  const timestampsRef = useRef(new Map<string, Date>())
  const now = new Date()
  for (const msg of messages) {
    if (!timestampsRef.current.has(msg.id)) {
      timestampsRef.current.set(msg.id, now)
    }
  }

  // Session management state
  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null)
  const [showHistory, setShowHistory] = useState(false)
  const historyRef = useRef<HTMLDivElement>(null)

  // Composition state for auto-scroll
  const isInputComposingRef = useRef(false)
  const compositionEndTimerRef = useRef<number | null>(null)
  const pendingAutoScrollRef = useRef(false)

  // Auto-scroll refs
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const shouldAutoScrollRef = useRef(true)

  // Initialize with greeting and load sessions
  const initializedRef = useRef(false)
  useEffect(() => {
    if (!initializedRef.current) {
      initializedRef.current = true
      if (messages.length === 0) {
        setMessages([{
          id: '1',
          role: 'assistant' as const,
          parts: [{ type: 'text' as const, text: t('chat.greeting', { company: currentCompany?.name || '' }) }],
        }])
      }
      if (currentCompany?.id) {
        loadSessions()
      }
    }
  }, [])

  // Track company changes to reload sessions
  const prevCompanyIdRef = useRef(currentCompany?.id)
  if (currentCompany?.id !== prevCompanyIdRef.current) {
    prevCompanyIdRef.current = currentCompany?.id
    if (currentCompany?.id) {
      loadSessions()
    }
  }

  // Track active skill changes to start new chat with skill context
  const prevActiveSkillRef = useRef(activeSkill)
  if (activeSkill !== prevActiveSkillRef.current) {
    prevActiveSkillRef.current = activeSkill
    if (activeSkill) {
      setMessages([{
        id: Date.now().toString(),
        role: 'assistant' as const,
        parts: [{ type: 'text' as const, text: t('chat.skillGreeting', { skill: activeSkill.skill.name, description: activeSkill.skill.description }) }],
      }])
      setCurrentSessionId(null)
    }
  }

  // Auto-save session when messages change (only when idle)
  useEffect(() => {
    if (status !== 'ready' || !currentCompany?.id || messages.length <= 1) return
    const timeoutId = setTimeout(() => {
      saveCurrentSession()
    }, 1000)
    return () => clearTimeout(timeoutId)
  }, [messages, status, currentCompany?.id])

  // Session functions
  async function loadSessions() {
    if (!currentCompany?.id) return
    try {
      const loadedSessions = await window.electronAPI.getChatSessions(currentCompany.id)
      setSessions(loadedSessions)
    } catch (e) {
      console.error('Failed to load sessions:', e)
    }
  }

  async function saveCurrentSession() {
    if (!currentCompany?.id || messages.length <= 1) return

    const sessionId = currentSessionId || `session-${Date.now()}`
    if (!currentSessionId) {
      setCurrentSessionId(sessionId)
    }

    // Generate title from first user message
    const firstUserMsg = messages.find(m => m.role === 'user')
    let firstUserText = ''
    if (firstUserMsg) {
      for (const part of firstUserMsg.parts) {
        if (part.type === 'text') firstUserText += part.text
      }
    }
    const title = firstUserText
      ? firstUserText.slice(0, 30) + (firstUserText.length > 30 ? '...' : '')
      : t('chat.newChat')

    const session: ChatSession = {
      id: sessionId,
      companyId: currentCompany.id,
      title,
      messages: messages.map(m =>
        uiMessageToSessionMessage(m, timestampsRef.current.get(m.id) || new Date())
      ),
      createdAt: currentSessionId
        ? sessions.find(s => s.id === sessionId)?.createdAt || new Date().toISOString()
        : new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    try {
      await window.electronAPI.saveChatSession(currentCompany.id, session)
      loadSessions()
    } catch (e) {
      console.error('Failed to save session:', e)
    }
  }

  async function loadSession(sessionId: string) {
    if (!currentCompany?.id) return
    try {
      const session = await window.electronAPI.getChatSession(currentCompany.id, sessionId)
      if (session) {
        const uiMessages = session.messages.map(sessionMessageToUIMessage)
        setMessages(uiMessages)
        // Restore timestamps
        for (const msg of session.messages) {
          timestampsRef.current.set(msg.id, new Date(msg.timestamp))
        }
        setCurrentSessionId(session.id)
        setShowHistory(false)
      }
    } catch (e) {
      console.error('Failed to load session:', e)
    }
  }

  async function deleteSession(sessionId: string) {
    if (!currentCompany?.id) return
    try {
      await window.electronAPI.deleteChatSession(currentCompany.id, sessionId)
      loadSessions()
      if (currentSessionId === sessionId) {
        startNewChat()
      }
    } catch (e) {
      console.error('Failed to delete session:', e)
    }
  }

  function startNewChat() {
    timestampsRef.current.clear()
    setMessages([{
      id: '1',
      role: 'assistant' as const,
      parts: [{ type: 'text' as const, text: t('chat.greeting', { company: currentCompany?.name || '' }) }],
    }])
    setCurrentSessionId(null)
    setShowHistory(false)
  }

  // Close history dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (historyRef.current && !historyRef.current.contains(event.target as Node)) {
        setShowHistory(false)
      }
    }
    if (showHistory) {
      document.addEventListener('mousedown', handleClickOutside)
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [showHistory])

  // Scroll tracking
  useEffect(() => {
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
  }, [])

  // Auto-scroll when messages change
  useEffect(() => {
    if (isInputComposingRef.current) {
      pendingAutoScrollRef.current = true
      return
    }
    if (!shouldAutoScrollRef.current) return
    pendingAutoScrollRef.current = false
    messagesEndRef.current?.scrollIntoView({ behavior: 'auto' })
  }, [messages, status])

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

  // Cleanup
  useEffect(() => {
    return () => {
      if (compositionEndTimerRef.current != null) {
        window.clearTimeout(compositionEndTimerRef.current)
      }
    }
  }, [])

  // Send handler (supports interrupt: stop current stream + send new message)
  const handleSend = useCallback(async (text: string, files?: File[]) => {
    if (!text.trim() && (!files || files.length === 0)) return
    perfMark('chat.send.start')

    if (status === 'streaming' || status === 'submitted') {
      stop()
      // Small delay for stream to settle before sending new message
      await new Promise(r => setTimeout(r, 150))
    }

    // Convert images to base64 and store in ref for transport body
    if (files && files.length > 0) {
      const imageParts: Array<{ mediaType: string; data: string }> = []
      for (const file of files) {
        const base64 = await new Promise<string>((resolve) => {
          const reader = new FileReader()
          reader.onload = () => {
            const result = reader.result as string
            resolve(result.split(',')[1])
          }
          reader.readAsDataURL(file)
        })
        imageParts.push({ mediaType: file.type, data: base64 })
      }
      pendingImagesRef.current = imageParts
    }

    await sendMessage({ text: text || '画像を確認してください' })
  }, [status, sendMessage, stop])

  // Edit message handler: trim messages after edit point, resend
  const handleEditMessage = useCallback((messageId: string, newText: string) => {
    const msgIndex = messages.findIndex(m => m.id === messageId)
    if (msgIndex === -1) return
    setMessages(messages.slice(0, msgIndex))
    sendMessage({ text: newText })
  }, [messages, setMessages, sendMessage])

  // ============================================================================
  // Render
  // ============================================================================

  return (
    <div className="h-full flex flex-col bg-white dark:bg-zinc-900">
      {/* Header */}
      <header className="flex-shrink-0 h-12 flex items-center justify-between px-4 border-b border-gray-200 dark:border-zinc-800">
        <div className="flex items-center gap-3">
          <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-accent to-accent/70 flex items-center justify-center">
            <Sparkle size={12} weight="fill" className="text-white" />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-gray-900 dark:text-zinc-100">{t('chat.assistant')}</span>
            <span className="text-[10px] font-medium tracking-wider uppercase px-1.5 py-0.5 rounded-md bg-accent/15 text-accent">
              {authMode === 'claude-code' ? 'Max' : 'API'}
            </span>
            {/* Status indicator */}
            {status === 'submitted' && (
              <span className="flex items-center gap-1 text-[10px] text-accent animate-fade-in">
                <CircleNotch size={10} className="animate-spin" />
                {t('chat.statusSubmitted')}
              </span>
            )}
            {status === 'streaming' && (
              <span className="flex items-center gap-1 text-[10px] text-green-500 dark:text-green-400 animate-fade-in">
                <span className="w-1.5 h-1.5 rounded-full bg-green-500 dark:bg-green-400 animate-pulse-soft" />
                {t('chat.statusStreaming')}
              </span>
            )}
            {status === 'error' && (
              <span className="flex items-center gap-1 text-[10px] text-red-500 dark:text-red-400 animate-fade-in">
                <span className="w-1.5 h-1.5 rounded-full bg-red-500 dark:bg-red-400" />
                {t('chat.statusError')}
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1">
          {/* Stop Button (visible during streaming) */}
          {(status === 'submitted' || status === 'streaming') && (
            <button
              onClick={() => stop()}
              className="w-8 h-8 rounded-lg hover:bg-red-100 dark:hover:bg-red-900/30 flex items-center justify-center transition-colors"
              title={t('chat.stop')}
            >
              <X size={16} className="text-red-500" />
            </button>
          )}

          {/* New Chat Button */}
          <button
            onClick={startNewChat}
            className="w-8 h-8 rounded-lg hover:bg-gray-100 dark:hover:bg-zinc-800 flex items-center justify-center transition-colors"
            title={t('chat.newChat')}
          >
            <Plus size={16} className="text-gray-500 dark:text-zinc-400" />
          </button>

          {/* History Button */}
          <div className="relative" ref={historyRef}>
            <button
              onClick={() => setShowHistory(!showHistory)}
              className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors ${
                showHistory ? 'bg-gray-200 dark:bg-zinc-700' : 'hover:bg-gray-100 dark:hover:bg-zinc-800'
              }`}
              title={t('chat.history')}
            >
              <ClockCounterClockwise size={16} className="text-gray-500 dark:text-zinc-400" />
            </button>

            {/* History Dropdown */}
            {showHistory && (
              <div className="absolute right-0 top-10 w-64 bg-white dark:bg-zinc-800 border border-gray-200 dark:border-zinc-700 rounded-xl shadow-xl z-50 overflow-hidden">
                <div className="p-2 border-b border-gray-200 dark:border-zinc-700">
                  <span className="text-xs text-gray-500 dark:text-zinc-400 px-2">{t('chat.recentChats')}</span>
                </div>
                <div className="max-h-64 overflow-auto">
                  {sessions.length === 0 ? (
                    <div className="p-4 text-center text-sm text-gray-500 dark:text-zinc-400">
                      {t('chat.noHistory')}
                    </div>
                  ) : (
                    sessions.map((session) => (
                      <div
                        key={session.id}
                        className={`group flex items-center justify-between px-3 py-2 hover:bg-gray-100 dark:hover:bg-zinc-700 cursor-pointer ${
                          currentSessionId === session.id ? 'bg-accent/10' : ''
                        }`}
                        onClick={() => loadSession(session.id)}
                      >
                        <div className="flex-1 min-w-0">
                          <div className="text-sm text-gray-900 dark:text-zinc-100 truncate">{session.title}</div>
                          <div className="text-[10px] text-gray-400 dark:text-zinc-500">
                            {new Date(session.updatedAt).toLocaleDateString('ja-JP', {
                              month: 'short',
                              day: 'numeric',
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </div>
                        </div>
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            deleteSession(session.id)
                          }}
                          className="opacity-0 group-hover:opacity-100 p-1 hover:bg-red-500/20 rounded transition-all"
                          title="削除"
                        >
                          <Trash size={12} className="text-red-400" />
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Settings Button */}
          <button
            onClick={onShowSettings}
            className="w-8 h-8 rounded-lg hover:bg-gray-100 dark:hover:bg-zinc-800 flex items-center justify-center transition-colors"
          >
            <GearSix size={16} className="text-gray-500 dark:text-zinc-400" />
          </button>
        </div>
      </header>

      {/* Active Skill Banner */}
      {activeSkill && (
        <div className="flex-shrink-0 px-4 py-2 bg-accent/10 border-b border-accent/20">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Lightning size={14} weight="fill" className="text-accent" />
              <span className="text-sm font-medium text-accent">
                {activeSkill.skill.name}
              </span>
              <span className="text-xs text-ink-muted">
                {t('chat.skillExecuting')}
              </span>
            </div>
            <button
              onClick={() => {
                clearActiveSkill()
                startNewChat()
              }}
              className="p-1 rounded-md hover:bg-white/10 text-ink-muted hover:text-ink transition-colors"
              title={t('chat.endSkill')}
            >
              <X size={14} />
            </button>
          </div>
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
      <MessageList
        messages={messages}
        status={status}
        messagesEndRef={messagesEndRef}
        containerRef={messagesContainerRef}
        timestamps={timestampsRef.current}
        onRegenerate={regenerate}
        onEditSubmit={handleEditMessage}
      />

      {/* Tool Approval Banner (above input) */}
      {pendingApproval && (
        <ToolApprovalBanner
          request={pendingApproval}
          onRespond={handleToolApprovalResponse}
        />
      )}

      {/* Input Area */}
      <div className="flex-shrink-0 p-4 pb-8 border-t border-gray-200 dark:border-zinc-800">
        <ChatInput
          onSend={handleSend}
          disabled={false}
          placeholder={t('chat.inputPlaceholder')}
          hint={t('chat.inputHint')}
          onCompositionStateChange={handleInputCompositionStateChange}
          onInputActivity={handleInputActivity}
        />
      </div>
    </div>
  )
}

// ============================================================================
// Main ChatPanel Component (Auth & Server wrapper)
// ============================================================================

interface ChatPanelProps {
  departmentPath?: string  // Working directory for AI (department folder path)
}

export function ChatPanel({ departmentPath }: ChatPanelProps) {
  const { t } = useTranslation()
  const serverInfo = useChatServerInfo()

  // Auth state
  const [isReady, setIsReady] = useState(false)
  const [authMode, setAuthMode] = useState<AuthMode>('claude-code')
  const [claudeCodeAvailable, setClaudeCodeAvailable] = useState(false)
  const [claudeCodeError, setClaudeCodeError] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [isChecking, setIsChecking] = useState(true)

  // Auth check on mount
  const initializedRef = useRef(false)
  if (!initializedRef.current) {
    initializedRef.current = true
    checkAuth()
  }

  async function checkAuth() {
    setIsChecking(true)
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

      if (savedAuthMode === 'claude-code' && ccAvailable) {
        setIsReady(true)
      } else if (savedAuthMode === 'api-key' && hasApiKey) {
        setIsReady(true)
      } else if (ccAvailable) {
        setAuthMode('claude-code')
        await window.electronAPI.setAuthMode('claude-code')
        setIsReady(true)
      }
    } finally {
      setIsChecking(false)
    }
  }

  // ============================================================================
  // Render States
  // ============================================================================

  if (showSettings) {
    return (
      <AuthSettings
        authMode={authMode}
        claudeCodeAvailable={claudeCodeAvailable}
        claudeCodeError={claudeCodeError}
        onClose={() => {
          setShowSettings(false)
          checkAuth()
        }}
      />
    )
  }

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
    <ChatPanelChat
      departmentPath={departmentPath}
      serverInfo={serverInfo}
      authMode={authMode}
      onShowSettings={() => setShowSettings(true)}
    />
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
  const [apiKey, setApiKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [showApiKey, setShowApiKey] = useState(false)
  const [permissionMode, setPermissionMode] = useState<'bypassPermissions' | 'default'>('bypassPermissions')

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
    setPermissionMode(mode)
  }

  async function handleSave() {
    setSaving(true)
    try {
      await window.electronAPI.setAuthMode(authMode)
      if (authMode === 'api-key' && apiKey && !apiKey.includes('*')) {
        await window.electronAPI.setApiKey(apiKey)
      }
      await window.electronAPI.setPermissionMode(permissionMode)
    } finally {
      setSaving(false)
      onClose()
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
        <div className="space-y-3">
          <label className="block text-xs font-medium tracking-wide uppercase text-ink-muted mb-3">
            {t('chatSettings.selectMethod')}
          </label>

          {/* Claude Code Option */}
          <button
            onClick={() => setAuthMode('claude-code')}
            disabled={!claudeCodeAvailable}
            className={`
              w-full text-left p-4 rounded-xl border transition-all duration-200
              ${authMode === 'claude-code'
                ? 'border-accent/50 bg-accent/10 shadow-glow'
                : 'border-white/[0.06] bg-surface-elevated hover:border-white/[0.1]'
              }
              ${!claudeCodeAvailable ? 'opacity-50 cursor-not-allowed' : ''}
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
              <button
                onClick={() => setPermissionMode('bypassPermissions')}
                className={`w-full text-left p-3 rounded-lg border transition-all duration-200 ${
                  permissionMode === 'bypassPermissions'
                    ? 'border-accent/50 bg-accent/10'
                    : 'border-white/[0.06] bg-surface-elevated hover:border-white/[0.1]'
                }`}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-medium text-ink">{t('chatSettings.permissionBypass')}</div>
                    <div className="text-xs text-ink-muted mt-0.5">{t('chatSettings.permissionBypassDesc')}</div>
                  </div>
                  {permissionMode === 'bypassPermissions' && (
                    <Check size={16} weight="bold" className="text-accent flex-shrink-0" />
                  )}
                </div>
              </button>
              <button
                onClick={() => setPermissionMode('default')}
                className={`w-full text-left p-3 rounded-lg border transition-all duration-200 ${
                  permissionMode === 'default'
                    ? 'border-accent/50 bg-accent/10'
                    : 'border-white/[0.06] bg-surface-elevated hover:border-white/[0.1]'
                }`}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-medium text-ink">{t('chatSettings.permissionDefault')}</div>
                    <div className="text-xs text-ink-muted mt-0.5">{t('chatSettings.permissionDefaultDesc')}</div>
                  </div>
                  {permissionMode === 'default' && (
                    <Check size={16} weight="bold" className="text-accent flex-shrink-0" />
                  )}
                </div>
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="flex-shrink-0 p-4 border-t border-white/[0.04]">
        <button
          onClick={handleSave}
          disabled={saving || (authMode === 'api-key' && !apiKey)}
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
