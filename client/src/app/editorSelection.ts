// The editor's selected words, composed by the screen (files-and-editor.md "The selection bubble"):
// the review's comment box is doc-review's own part, handed to the editor here, so the editor
// imports no other feature's parts.
import { createElement } from 'react'
import { CommentPopover } from '../features/doc-review/components/CommentPopover'
import type { SelectionSlot } from '../features/editor/selectionSlot'

export const EDITOR_SELECTION: SelectionSlot = {
  commentBox: props => createElement(CommentPopover, props),
}
