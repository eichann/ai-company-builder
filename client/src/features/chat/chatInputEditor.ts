import { history, historyKeymap } from '@codemirror/commands'
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import { EditorView, keymap, placeholder as codeMirrorPlaceholder } from '@codemirror/view'
import { ghostSuggestion } from './ghostSuggestion'
import { isPerfDiagnosticsEnabled, perfMark, perfMeasure } from '../../shared/lib/perfDiagnostics'

/** The parts of the composer's editor that change after it is made. */
export interface ChatInputCompartments {
  editable: Compartment
  placeholder: Compartment
  describedBy: Compartment
}

export const createChatInputCompartments = (): ChatInputCompartments => ({
  editable: new Compartment(),
  placeholder: new Compartment(),
  describedBy: new Compartment(),
})

export const editableExtensions = (editable: boolean, readOnly: boolean): Extension[] => [
  EditorView.editable.of(editable),
  EditorState.readOnly.of(readOnly),
]

export const placeholderExtension = (text: string): Extension => codeMirrorPlaceholder(text)

/** What the composer does on the editor's events (callbacks read the latest props). */
export interface ChatInputEvents {
  activity: () => void
  /** keydown after the ghost suggestion had its turn; true = handled. */
  key: (event: KeyboardEvent, view: EditorView) => boolean
  composition: (composing: boolean) => void
  blur: () => void
  docChanged: (text: string) => void
  suggestionCleared: () => void
}

const chatInputTheme = EditorView.theme({
  '&': { backgroundColor: 'transparent', color: 'inherit', width: '100%' },
  '&.cm-editor': { outline: 'none' },
  '&.cm-editor.cm-focused': { outline: 'none' },
  '.cm-scroller': { minHeight: '40px', maxHeight: '200px', overflow: 'auto', fontFamily: 'inherit' },
  '.cm-content': { padding: '8px', minHeight: '40px', fontSize: '14px', lineHeight: '1.4' },
  '.cm-line': { padding: '0' },
  '.cm-placeholder': { color: 'currentColor', opacity: '0.5' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'currentColor' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': { backgroundColor: 'rgba(59, 130, 246, 0.28)' },
})

/** Input latency diagnostics (perf flag only). */
export function markDispatchDelay(metricName: string, eventTimestamp: number): void {
  if (!isPerfDiagnosticsEnabled()) return
  let delay = performance.now() - eventTimestamp
  // React/Electron runtime may provide epoch-based timestamps on some event types.
  if (eventTimestamp > 1_000_000_000_000) delay = Date.now() - eventTimestamp
  if (delay >= 0 && delay < 60000) perfMeasure(metricName, delay)
}

export function measureToNextFrame(metricName: string): void {
  if (!isPerfDiagnosticsEnabled()) return
  const start = performance.now()
  window.requestAnimationFrame(() => perfMeasure(metricName, performance.now() - start))
}

/** The composer's editor: history, wrapping, the ghost suggestion and the event wiring. */
export function chatInputState(doc: string, initial: { disabled: boolean; placeholder: string }, compartments: ChatInputCompartments, on: ChatInputEvents): EditorState {
  return EditorState.create({
    doc,
    extensions: [
      chatInputTheme,
      history(),
      keymap.of(historyKeymap),
      EditorView.lineWrapping,
      EditorView.contentAttributes.of({ spellcheck: 'false', autocorrect: 'off', autocapitalize: 'off', 'data-gramm': 'false' }),
      compartments.editable.of(editableExtensions(!initial.disabled, initial.disabled)),
      compartments.placeholder.of(placeholderExtension(initial.placeholder)),
      ghostSuggestion(on.suggestionCleared),
      compartments.describedBy.of([]),
      EditorView.domEventHandlers({
        keydown: (event, view) => {
          on.activity()
          perfMark('chat.input.keydown')
          markDispatchDelay('chat.input.keydown.dispatch_delay.ms', event.timeStamp)
          return on.key(event, view)
        },
        input: (event) => {
          on.activity()
          perfMark('chat.input.input')
          markDispatchDelay('chat.input.input.dispatch_delay.ms', event.timeStamp)
          return false
        },
        compositionstart: (event) => {
          on.activity()
          on.composition(true)
          perfMark('chat.input.composition_start')
          markDispatchDelay('chat.input.composition.dispatch_delay.ms', event.timeStamp)
          return false
        },
        compositionupdate: (event) => {
          on.activity()
          perfMark('chat.input.composition_update')
          markDispatchDelay('chat.input.composition.dispatch_delay.ms', event.timeStamp)
          measureToNextFrame('chat.input.composition_to_raf.ms')
          return false
        },
        compositionend: (event) => {
          on.activity()
          on.composition(false)
          perfMark('chat.input.composition_end')
          markDispatchDelay('chat.input.composition.dispatch_delay.ms', event.timeStamp)
          return false
        },
        mousedown: (event) => {
          perfMark('chat.input.mouse_down')
          markDispatchDelay('chat.input.mouse.dispatch_delay.ms', event.timeStamp)
          measureToNextFrame('chat.input.mouse_to_raf.ms')
          return false
        },
        mouseup: (event) => {
          perfMark('chat.input.mouse_up')
          markDispatchDelay('chat.input.mouse.dispatch_delay.ms', event.timeStamp)
          return false
        },
        blur: () => {
          on.blur()
          return false
        },
      }),
      EditorView.updateListener.of(update => {
        if (update.docChanged) on.docChanged(update.state.doc.toString())
      }),
    ],
  })
}
