import { useCallback, useRef } from 'react'

/** What the chat panel may do with its input (the composer fills `apiRef`). */
export interface ChatInputApi {
  focus: () => void
  captureInsertion: () => (text: string) => boolean
  getValue: () => string
  setValue: (text: string) => void
  /** chat.insertText: replace the text as an edit (undoable), focus, caret at the end; false while there is no input. */
  replaceText: (text: string) => boolean
}

/**
 * The conversation's unsent text. A ref, not state: the input is
 * uncontrolled (CodeMirror owns the text), and keeping every keystroke out of
 * React state keeps typing from re-rendering the whole chat. The draft is
 * read when the conversation is saved; `inputApiRef` writes it back on
 * restore, a new chat and when waiting messages return to the input.
 */
export function useChatDraft() {
  const draftRef = useRef('')
  const onDraftChange = useCallback((text: string) => { draftRef.current = text }, [])
  const inputApiRef = useRef<ChatInputApi | null>(null)
  return { draftRef, onDraftChange, inputApiRef }
}
