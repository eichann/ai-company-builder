import { StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { ghostKeyAction, ghostRemainder, suggestionAfterEdit, type GhostInput } from './promptSuggestion'

/**
 * CodeMirror glue for the next-prompt suggestion (rules: promptSuggestion.ts).
 * The parent sets the suggestion with `setSuggestion`; the editor clears it
 * itself when the member types past it, accepts it, or presses Esc, and
 * reports that through `onCleared` so the parent forgets it too.
 */
export const setSuggestion = StateEffect.define<string | null>()

const suggestionField = StateField.define<string | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setSuggestion)) return effect.value
    return tr.docChanged ? suggestionAfterEdit(value, tr.newDoc.toString()) : value
  },
})

/** The suggestion the editor currently holds (null when none). */
export function currentSuggestion(state: EditorState): string | null {
  return state.field(suggestionField, false) ?? null
}

class GhostWidget extends WidgetType {
  constructor(readonly text: string) { super() }
  eq(other: GhostWidget) { return other.text === this.text }
  toDOM() {
    const span = document.createElement('span')
    span.className = 'cm-ghost-suggestion'
    // Announced through the input's aria-describedby text instead.
    span.setAttribute('aria-hidden', 'true')
    span.textContent = this.text
    return span
  }
  ignoreEvent() { return true }
}

function ghostInput(view: EditorView): GhostInput {
  const selection = view.state.selection.main
  return { doc: view.state.doc.toString(), caret: selection.head, hasSelection: !selection.empty, composing: view.composing }
}

function decorations(view: EditorView): DecorationSet {
  const remainder = ghostRemainder(view.state.field(suggestionField), ghostInput(view))
  if (!remainder) return Decoration.none
  return Decoration.set([Decoration.widget({ widget: new GhostWidget(remainder), side: 1 }).range(view.state.doc.length)])
}

const ghostPlugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet
  constructor(view: EditorView) { this.decorations = decorations(view) }
  update(update: ViewUpdate) { this.decorations = decorations(update.view) }
}, { decorations: plugin => plugin.decorations })

const ghostTheme = EditorView.theme({
  '.cm-ghost-suggestion': { color: 'currentColor', opacity: '0.4', pointerEvents: 'none' },
})

export function ghostSuggestion(onCleared: () => void): Extension {
  return [
    suggestionField,
    ghostPlugin,
    ghostTheme,
    EditorView.updateListener.of(update => {
      if (update.startState.field(suggestionField) && !update.state.field(suggestionField)) onCleared()
    }),
  ]
}

/** Keydown handling for a visible suggestion; true when the key was used. */
export function handleGhostKey(view: EditorView, event: KeyboardEvent): boolean {
  const suggestion = currentSuggestion(view.state)
  if (!suggestion) return false
  const input = ghostInput(view)
  const action = ghostKeyAction(event, suggestion, input)
  if (action === 'pass') return false
  event.preventDefault()
  if (action === 'accept') {
    const remainder = ghostRemainder(suggestion, input)!
    const end = input.doc.length
    view.dispatch({
      changes: { from: end, insert: remainder },
      selection: { anchor: end + remainder.length },
      effects: setSuggestion.of(null),
      userEvent: 'input.complete',
      scrollIntoView: true,
    })
  } else {
    view.dispatch({ effects: setSuggestion.of(null) })
  }
  return true
}
