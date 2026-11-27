import { memo, useCallback, useEffect, useImperativeHandle, useRef, type MutableRefObject, type ReactNode } from 'react'
import type { ChatTextInputApi } from '../hooks/useChatDraft'
import { ComposerRow, SendButton } from './ComposerRow'

interface LegacyTextareaChatInputProps {
  initialDraft?: string
  onDraftChange?: (text: string) => void
  keepCursor?: boolean
  onSend: (text: string) => void
  disabled: boolean
  placeholder: string
  hint?: string
  toolsStart?: ReactNode
  toolsEnd?: ReactNode
  onCompositionStateChange?: (isComposing: boolean) => void
  onInputActivity?: () => void
  apiRef?: MutableRefObject<ChatTextInputApi | null>
}

/** Plain textarea fallback, enabled with the `chatInputBare` perf flag for debugging. */
export const LegacyTextareaChatInput = memo(function LegacyTextareaChatInput({
  keepCursor = false,
  initialDraft,
  onDraftChange,
  onSend,
  disabled,
  placeholder,
  hint,
  toolsStart,
  toolsEnd,
  onCompositionStateChange,
  onInputActivity,
  apiRef,
}: LegacyTextareaChatInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useImperativeHandle(apiRef, () => ({
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
    replaceText: (text: string) => {
      const input = textareaRef.current
      if (!input) return false
      input.value = text
      onDraftChange?.(text)
      input.focus()
      return true
    },
  }), [onDraftChange])

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
      <div className="rounded-card bg-[var(--color-surface)] border border-border-control focus-within:border-focus-border">
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
          className="block w-full bg-transparent text-body text-text placeholder:text-text-subtle resize-y outline-none pt-2.5 px-3 disabled:opacity-disabled disabled:cursor-not-allowed min-h-[72px] max-h-[220px]"
        />
        <ComposerRow start={toolsStart} hint={hint} end={toolsEnd}>
          <SendButton onClick={handleSend} disabled={disabled} />
        </ComposerRow>
      </div>
    </div>
  )
})
