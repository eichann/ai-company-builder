/**
 * Ghost-text rules for the next-prompt suggestion in the chat input (pure;
 * the CodeMirror glue is ghostSuggestion.ts). The suggestion is shown as
 * light text after what the member typed, as long as what they typed is the
 * start of it:
 * - → (Right arrow) or Tab with the caret at the end accepts it (the text is
 *   put into the input; sending stays ⌘/Ctrl+Enter). Enter keeps meaning a
 *   new line.
 * - Typing anything that does not continue the suggestion dismisses it for
 *   good; Esc dismisses it.
 * - Not shown while the AI works, while a question/approval card waits, or
 *   when the input already held other text.
 */

import { agentCan } from '../../../shared/agents/registry'

export interface GhostInput {
  /** The input's text. */
  doc: string
  /** Caret position (selection head). */
  caret: number
  /** True when text is selected. */
  hasSelection: boolean
  /** An IME composition is in progress. */
  composing: boolean
}

/** The part of the suggestion shown after the typed text, or null. */
export function ghostRemainder(suggestion: string | null | undefined, input: GhostInput): string | null {
  if (!suggestion || input.composing || input.hasSelection) return null
  if (input.caret !== input.doc.length) return null
  if (!suggestion.startsWith(input.doc) || suggestion.length === input.doc.length) return null
  return suggestion.slice(input.doc.length)
}

/** After an edit: keep the suggestion only while the text still leads into it. */
export function suggestionAfterEdit(suggestion: string | null, doc: string): string | null {
  if (!suggestion) return null
  return suggestion.startsWith(doc) && suggestion.length > doc.length ? suggestion : null
}

export interface GhostKey {
  key: string
  shiftKey?: boolean
  altKey?: boolean
  metaKey?: boolean
  ctrlKey?: boolean
  isComposing?: boolean
}

export type GhostKeyAction = 'accept' | 'dismiss' | 'pass'

/** What a keydown does to a visible suggestion. Everything else is left to the editor. */
export function ghostKeyAction(event: GhostKey, suggestion: string | null | undefined, input: GhostInput): GhostKeyAction {
  if (event.isComposing || input.composing) return 'pass'
  const remainder = ghostRemainder(suggestion, input)
  if (!remainder) return 'pass'
  const modified = event.shiftKey || event.altKey || event.metaKey || event.ctrlKey
  if ((event.key === 'ArrowRight' || event.key === 'Tab') && !modified) return 'accept'
  if (event.key === 'Escape') return 'dismiss'
  return 'pass'
}

/** Whether a suggestion that just arrived may be offered. */
export function canOfferSuggestion(state: {
  running: boolean
  /** A choice card / approval / agent question is waiting for the member. */
  waitingForMember: boolean
  /** What is in the input right now. */
  draft: string
}): boolean {
  return !state.running && !state.waitingForMember && state.draft.trim() === ''
}

/**
 * Whether a turn should come with a suggestion: Claude Code only (the CLI
 * makes it), not after a stopped or failed turn, and not when the member
 * turned it off in settings (then the CLI is not asked to make one at all).
 */
export function shouldRequestSuggestion(turn: { aborted: boolean; authMode: string; enabled: boolean }): boolean {
  return turn.enabled && !turn.aborted && agentCan(turn.authMode, 'promptSuggestions')
}

/** Screen-reader description while a suggestion is offered. */
export function suggestionDescription(suggestion: string): string {
  return `入力候補：${suggestion}。→キーまたはTabキーで入力欄に入れます。Escキーで消します。`
}
