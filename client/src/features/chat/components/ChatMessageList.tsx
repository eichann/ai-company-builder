import { useState, useEffect, useLayoutEffect, useRef, memo } from 'react'
import { useTranslation } from 'react-i18next'
import type { UIMessage } from 'ai'
import { Sparkle, CaretUp, File, PencilSimple, ArrowCounterClockwise } from '@phosphor-icons/react'
import { useAppStore } from '../../../stores/appStore'
import { AssistantMessageParts } from './MessageParts'
import { earlierAnchor, windowStart } from '../messageWindow'

// The conversation's messages: only the latest are rendered (messageWindow.ts;
// 「以前のメッセージを表示」 keeps the reading position), each one memoised, and
// older ones skip layout while off screen (content-visibility).

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

export const MessageList = memo(function MessageList({
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
