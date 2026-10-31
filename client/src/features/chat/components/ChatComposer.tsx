import { memo, useState } from 'react'
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
}: ChatInputProps) {
  const [voiceBusy, setVoiceBusy] = useState(false)
  const isLegacyTextareaMode = isPerfCutEnabled('chatInputBare')
  const attachments = useComposerAttachments(onSend, onAttachmentsChange)

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
      className={`relative rounded-xl border transition-colors ${
        attachments.isDragOver
          ? 'border-accent bg-accent/5'
          : 'border-transparent'
      }`}
    >
      {apiRef && <VoiceInputControl editor={apiRef} active={voiceActive} pane={voicePane} scope={voiceScope} disabled={disabled} onBusy={setVoiceBusy} />}
      {/* Drag overlay */}
      {attachments.isDragOver && (
        <div className="absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-accent/10 border-2 border-dashed border-accent pointer-events-none">
          <span className="text-sm font-medium text-accent">ファイルをドロップして参照</span>
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
