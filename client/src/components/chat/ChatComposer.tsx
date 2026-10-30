import { VoiceInputControl } from './VoiceInputControl'
import { ghostSuggestion, handleGhostKey, setSuggestion } from './ghostSuggestion'
import { suggestionDescription } from './promptSuggestion'
import { useState, useEffect, useRef, useCallback, memo, useMemo, useId } from 'react'
import { history, historyKeymap, isolateHistory } from '@codemirror/commands'
import { Compartment, EditorState, Transaction } from '@codemirror/state'
import { EditorView, keymap, placeholder as codeMirrorPlaceholder } from '@codemirror/view'
import { ArrowUp } from '@phosphor-icons/react'
import { isPerfCutEnabled, isPerfDiagnosticsEnabled, perfMark, perfMeasure } from '../../lib/perfDiagnostics'
import { SlashCommandDropdown, type SlashCommandItem } from './SlashCommandDropdown'
import { type ChatInputApi } from './hooks/useChatDraft'

// ============================================================================
// Input Component (Optimized - uncontrolled textarea for maximum performance)
// ============================================================================

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
  /** How many images and files are attached and not sent yet. */
  onAttachmentsChange?: (count: number) => void
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
  onAttachmentsChange,
}: ChatInputProps) {
  const [voiceBusy, setVoiceBusy] = useState(false)
  const isLegacyTextareaMode = isPerfCutEnabled('chatInputBare')
  const [attachedImages, setAttachedImages] = useState<File[]>([])
  const [attachedFilePaths, setAttachedFilePaths] = useState<string[]>([])
  const [isDragOver, setIsDragOver] = useState(false)
  const [imageWarning, setImageWarning] = useState('')
  const dragCounterRef = useRef(0)
  const attachmentCount = attachedImages.length + attachedFilePaths.length
  useEffect(() => { onAttachmentsChange?.(attachmentCount) }, [attachmentCount, onAttachmentsChange])

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
