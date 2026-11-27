import { memo, useCallback, useEffect, useId, useImperativeHandle, useRef, useState, type MutableRefObject, type ReactNode } from 'react'
import { isolateHistory } from '@codemirror/commands'
import { Transaction } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { handleGhostKey, setSuggestion } from '../ghostSuggestion'
import { suggestionDescription } from '../promptSuggestion'
import { chatInputState, createChatInputCompartments, editableExtensions, measureToNextFrame, placeholderExtension } from '../chatInputEditor'
import { perfMark } from '../../../shared/lib/perfDiagnostics'
import { useLatestRef } from '../../../shared/hooks/useLatestRef'
import { useSlashCommands } from '../hooks/useSlashCommands'
import { SlashCommandDropdown, type SlashCommandItem } from './SlashCommandDropdown'
import type { ChatTextInputApi } from '../hooks/useChatDraft'
import { ComposerRow, SendButton } from './ComposerRow'

interface CodeMirrorChatInputProps {
  initialDraft?: string
  onDraftChange?: (text: string) => void
  keepCursor?: boolean
  onSend: (text: string) => void
  disabled: boolean
  placeholder: string
  /** A short line in the input's row (only while a suggestion is offered); the placeholder says how to send. */
  hint?: string
  /** The input's row, left of the send button: voice input (start) and the model switch (end). */
  toolsStart?: ReactNode
  toolsEnd?: ReactNode
  onCompositionStateChange?: (isComposing: boolean) => void
  onInputActivity?: () => void
  slashCommands?: SlashCommandItem[]
  apiRef?: MutableRefObject<ChatTextInputApi | null>
  suggestion?: string | null
  onSuggestionCleared?: () => void
}

/**
 * The composer's text input. The editor is made once, so its handlers read
 * the latest props through `latest`; only editability, the placeholder and
 * the suggestion are pushed into it when they change.
 */
export const CodeMirrorChatInput = memo(function CodeMirrorChatInput({
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
  slashCommands,
  apiRef,
  suggestion = null,
  onSuggestionCleared,
}: CodeMirrorChatInputProps) {
  const draftBufferRef = useRef(initialDraft ?? '')
  const suggestionId = useId()
  const editorHostRef = useRef<HTMLDivElement>(null)
  const editorViewRef = useRef<EditorView | null>(null)
  const isComposingRef = useRef(false)
  const [compartments] = useState(createChatInputCompartments)
  const latest = useLatestRef({ onSend, disabled, placeholder, onDraftChange, onCompositionStateChange, onInputActivity, onSuggestionCleared })
  const slash = useSlashCommands(slashCommands, editorViewRef)
  const { close: closeSlash, onDocChanged: slashDocChanged, handleKey: slashKey } = slash

  const handleSend = useCallback(() => {
    perfMark('chat.input.send_click')
    const view = editorViewRef.current
    if (!view || latest.current.disabled) return
    const value = view.state.doc.toString().trim()
    if (!value) return
    latest.current.onSend(value)
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '' } })
    view.focus()
  }, [latest])

  useEffect(() => {
    const host = editorHostRef.current
    if (!host) return
    const view = new EditorView({
      parent: host,
      state: chatInputState(draftBufferRef.current, latest.current, compartments, {
        activity: () => latest.current.onInputActivity?.(),
        key: (event, view) => {
          // Next-prompt suggestion: → / Tab accept, Esc dismisses (Enter stays a new line).
          if (handleGhostKey(view, event)) return true
          const slashAnswer = slashKey(event)
          if (slashAnswer !== undefined) return slashAnswer
          measureToNextFrame('chat.input.keydown_to_raf.ms')
          if (!(event.key === 'Enter' && (event.metaKey || event.ctrlKey))) return false
          if (event.isComposing || event.keyCode === 229 || isComposingRef.current) {
            perfMark('chat.input.keydown.composing_skip')
            return false
          }
          event.preventDefault()
          handleSend()
          return true
        },
        composition: composing => {
          isComposingRef.current = composing
          latest.current.onCompositionStateChange?.(composing)
        },
        blur: closeSlash,
        docChanged: text => {
          draftBufferRef.current = text
          latest.current.onDraftChange?.(text)
          slashDocChanged(text)
        },
        suggestionCleared: () => latest.current.onSuggestionCleared?.(),
      }),
    })
    editorViewRef.current = view
    // The parent's latest callback, at unmount: a composition cut short must not leave it "composing".
    const endComposition = () => latest.current.onCompositionStateChange?.(false)
    return () => {
      endComposition()
      view.destroy()
      editorViewRef.current = null
    }
  }, [handleSend, latest, compartments, closeSlash, slashDocChanged, slashKey])

  // What the chat panel may do with the input (per-conversation drafts, voice input, chat.insertText).
  useImperativeHandle(apiRef, () => ({
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
      latest.current.onDraftChange?.(text)
      const view = editorViewRef.current
      if (!view) return
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        selection: { anchor: text.length },
        annotations: Transaction.addToHistory.of(false),
      })
    },
    replaceText: (text: string) => {
      const view = editorViewRef.current
      if (!view) return false
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } })
      view.focus()
      view.dispatch({ selection: { anchor: text.length } })
      return true
    },
  }), [latest])

  useEffect(() => {
    const view = editorViewRef.current
    if (!view) return
    view.dispatch({ effects: compartments.editable.reconfigure(editableExtensions(!disabled || keepCursor, disabled)) })
    if (keepCursor) view.focus()
  }, [compartments, disabled, keepCursor])

  // The suggestion replaces the placeholder while it is offered.
  useEffect(() => {
    editorViewRef.current?.dispatch({ effects: compartments.placeholder.reconfigure(placeholderExtension(suggestion ? '' : placeholder)) })
  }, [compartments, placeholder, suggestion])

  useEffect(() => {
    editorViewRef.current?.dispatch({
      effects: [
        setSuggestion.of(suggestion),
        compartments.describedBy.reconfigure(suggestion ? EditorView.contentAttributes.of({ 'aria-describedby': suggestionId }) : []),
      ],
    })
  }, [compartments, suggestion, suggestionId])

  return (
    <div className="relative">
      {slash.query !== null && slash.items.length > 0 && (
        <SlashCommandDropdown
          items={slash.items}
          query={slash.query}
          selectedIndex={slash.selectedIndex}
          onSelect={slash.select}
          onClose={closeSlash}
        />
      )}

      <div className="relative rounded-card bg-[var(--color-surface)] border border-border-control focus-within:border-focus-border transition-colors">
        <div className="px-3 pt-2.5 text-text min-h-[40px] max-h-[200px] overflow-hidden">
          <div ref={editorHostRef} />
          <div id={suggestionId} className="sr-only" aria-live="polite">{suggestion ? suggestionDescription(suggestion) : ''}</div>
        </div>
        <ComposerRow start={toolsStart} hint={hint} end={toolsEnd}>
          <SendButton onClick={handleSend} disabled={disabled} />
        </ComposerRow>
      </div>
    </div>
  )
})
