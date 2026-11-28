// The editor's selected words, composed by the screen (files-and-editor.md "The selection bubble",
// "Asking the AI to fix a passage"): the review's comment box is doc-review's own part, and the AI fix
// goes to the chat pane through its command and is drawn as the chat draws a reply — so the editor
// imports no other feature's parts.
import { createElement } from 'react'
import { CommentPopover } from '../features/doc-review/components/CommentPopover'
import { MarkdownMessage } from '../features/chat/components/MarkdownMessage'
import type { SelectionSlot } from '../features/editor/selectionSlot'
import { runCommand } from '../shared/commands/commands'
import { inlineFixResult } from '../../shared/inline-fix'

export const EDITOR_SELECTION: SelectionSlot = {
  commentBox: props => createElement(CommentPopover, props),
  aiFix: {
    // No chat pane to take it: runCommand resolves undefined, read as 「相談の欄が開いていない」.
    ask: async request => inlineFixResult(await runCommand('chat.askToFix', request)),
    preview: markdown => createElement(MarkdownMessage, { content: markdown }),
  },
}
