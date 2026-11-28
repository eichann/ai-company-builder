// What the screen (app/) plugs into the editor's selected words (files-and-editor.md "The selection
// bubble"): the editor holds the selection and the review's state; how a part another feature owns
// looks — the review's comment box — is handed in here, so the editor imports no other feature's parts.
import type { ReactNode } from 'react'
import type { CommentSeverity } from '../doc-review/model'

export interface CommentBoxProps {
  /** Under the selected words (viewport pixels). */
  position: { x: number; y: number }
  /** The words the comment is about, as the member selected them. */
  selectedText: string
  /** False when the comment could not be saved: the box keeps the text for another try. */
  onSubmit: (body: string, severity: CommentSeverity) => Promise<boolean>
  onClose: () => void
}

export interface SelectionSlot {
  /** The review's comment box. Without it, no ［コメント］ (and no comment from a review's selection). */
  commentBox?: (props: CommentBoxProps) => ReactNode
}
