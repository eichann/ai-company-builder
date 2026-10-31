import { memo, useCallback, useEffect, useImperativeHandle, useRef, type MutableRefObject } from 'react'
import { ArrowUp } from '@phosphor-icons/react'
import type { ChatInputApi } from '../hooks/useChatDraft'

interface LegacyTextareaChatInputProps {
  initialDraft?: string
  onDraftChange?: (text: string) => void
  keepCursor?: boolean
  onSend: (text: string) => void
  disabled: boolean
  placeholder: string
  hint: string
  onCompositionStateChange?: (isComposing: boolean) => void
  onInputActivity?: () => void
  apiRef?: MutableRefObject<ChatInputApi | null>
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
