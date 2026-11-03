import { memo, useState, type ReactNode } from 'react'
import { ListChecks, X } from '@phosphor-icons/react'
import type { DroppedRecordRef } from '../../../../shared/record-drop'
import type { DraggedRecord } from '../../../shared/lib/dragTypes'
import { droppedRecordLine, dropFrameText } from '../recordDrop'
import { VoiceInputControl } from './VoiceInputControl'
import { CodeMirrorChatInput } from './CodeMirrorChatInput'
import { LegacyTextareaChatInput } from './LegacyTextareaChatInput'
import { ComposerAttachments } from './ComposerAttachments'
import type { SlashCommandItem } from './SlashCommandDropdown'
import { isPerfCutEnabled } from '../../../shared/lib/perfDiagnostics'
import { useComposerAttachments } from '../hooks/useComposerAttachments'
import type { ChatInputApi } from '../hooks/useChatDraft'

interface ChatInputProps {
  initialDraft?: string
  onDraftChange?: (text: string) => void
  voiceActive?: boolean
  voiceScope?: string
  /** The chat pane: the voice key reaches the composer of the pane used last (`chat.toggleVoiceInput`). */
  voicePane?: string
  onSend: (text: string, files?: File[], filePaths?: string[]) => void
  disabled: boolean
  placeholder: string
  hint: string
  onCompositionStateChange?: (isComposing: boolean) => void
  onInputActivity?: () => void
  slashCommands?: SlashCommandItem[]
  /** Filled by the input: drafts, voice input and chat.insertText go through it. */
  apiRef?: React.MutableRefObject<ChatInputApi | null>
  /** Next-prompt suggestion shown as ghost text (promptSuggestion.ts). */
  suggestion?: string | null
  /** The input dropped the suggestion (typed past it, accepted, Esc). */
  onSuggestionCleared?: () => void
  /** How many images and files are attached and not sent yet. */
  onAttachmentsChange?: (count: number) => void
  /** A record (やること, 案件…) dropped on the input: the consultation becomes one about it (recordDrop.ts). */
  onDropRecord?: (record: DraggedRecord & { word: string }) => void
  /** Dropped records waiting to go to the AI with the next message; × takes one off. */
  pendingRecords?: readonly DroppedRecordRef[]
  onRemoveRecord?: (id: string) => void
  /** Shown above the input (the topic switch question). */
  above?: ReactNode
}

/**
 * The chat's composer: voice input, dropped files and images, and the text
 * input (CodeMirror; a plain textarea with the `chatInputBare` perf flag).
 * Exported for the composer preview page (tests/chat-composer-ui.tsx).
 */
export const ChatInput = memo(function ChatInput({
  initialDraft,
  onDraftChange,
  voiceActive = false,
  voiceScope = '',
  voicePane = 'chat',
  onSend,
  disabled,
  placeholder,
  hint,
  onCompositionStateChange,
  onInputActivity,
  slashCommands,
  apiRef,
  suggestion,
  onSuggestionCleared,
  onAttachmentsChange,
  onDropRecord,
  pendingRecords,
  onRemoveRecord,
  above,
}: ChatInputProps) {
  const [voiceBusy, setVoiceBusy] = useState(false)
  const isLegacyTextareaMode = isPerfCutEnabled('chatInputBare')
  const attachments = useComposerAttachments(onSend, onAttachmentsChange, onDropRecord)

  const inputComponent = isLegacyTextareaMode ? (
    <LegacyTextareaChatInput
      initialDraft={initialDraft}
      onDraftChange={onDraftChange}
      onSend={attachments.sendWithAttachments}
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
      onSend={attachments.sendWithAttachments}
      disabled={disabled || voiceBusy}
      keepCursor={voiceBusy}
      placeholder={placeholder}
      hint={hint}
      onCompositionStateChange={onCompositionStateChange}
      onInputActivity={onInputActivity}
      slashCommands={slashCommands}
      apiRef={apiRef}
      suggestion={voiceBusy ? null : suggestion}
      onSuggestionCleared={onSuggestionCleared}
    />
  )

  return (
    <div
      {...attachments.dropHandlers}
      data-composer-drop
      className={`relative rounded-xl border transition-colors ${
        attachments.drag
          ? 'border-accent bg-accent/5'
          : 'border-transparent'
      }`}
    >
      {apiRef && <VoiceInputControl editor={apiRef} active={voiceActive} pane={voicePane} scope={voiceScope} disabled={disabled} onBusy={setVoiceBusy} />}
      {/* Drag overlay: says what dropping does — a file is read, a record becomes the topic. */}
      {attachments.drag && (
        <div data-drop-frame className="absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-accent/10 border-2 border-dashed border-accent pointer-events-none px-3 text-center">
          <span className="rounded-md bg-white/95 px-3 py-1 text-sm font-medium text-accent shadow-sm dark:bg-zinc-900/95">{dropFrameText(attachments.drag)}</span>
        </div>
      )}
      {above}
      {pendingRecords && pendingRecords.length > 0 && (
        <div className="flex flex-wrap gap-1 px-1 pb-1.5" data-pending-records>
          {pendingRecords.map(r => (
            <span key={r.id} className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-md border border-accent/20 bg-accent/10 py-0.5 pl-2 pr-1 text-[11px] text-accent">
              <ListChecks size={11} aria-hidden className="shrink-0" />
              <span className="min-w-0 truncate">{droppedRecordLine(r, false)}</span>
              {onRemoveRecord && (
                <button type="button" onClick={() => onRemoveRecord(r.id)} aria-label={`${r.title || r.word}を渡すのをやめる`} className="shrink-0 rounded p-0.5 hover:bg-accent/20">
                  <X size={10} />
                </button>
              )}
            </span>
          ))}
        </div>
      )}

      <ComposerAttachments
        imageWarning={attachments.imageWarning}
        filePaths={attachments.filePaths}
        images={attachments.images}
        onRemoveFilePath={attachments.removeFilePath}
        onRemoveImage={attachments.removeImage}
      />

      {inputComponent}
    </div>
  )
})
