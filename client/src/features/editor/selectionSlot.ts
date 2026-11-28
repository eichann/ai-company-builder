// What the screen (app/) plugs into the editor's selected words (files-and-editor.md "The selection
// bubble"): the editor holds the selection and the review's state; how a part another feature owns
// looks — the review's comment box, the consultation the AI fix is asked of — is handed in here, so the
// editor imports no other feature's parts.
import type { ReactNode } from 'react'
import type { CommentSeverity } from '../doc-review/model'
import type { InlineFixRequest } from '../../../shared/inline-fix'

export interface CommentBoxProps {
  /** Under the selected words (viewport pixels). */
  position: { x: number; y: number }
  /** The words the comment is about, as the member selected them. */
  selectedText: string
  /** False when the comment could not be saved: the box keeps the text for another try. */
  onSubmit: (body: string, severity: CommentSeverity) => Promise<boolean>
  onClose: () => void
}

/** 「AI に直してもらう」 (files-and-editor.md "Asking the AI to fix a passage"): who is asked, and how the answer is shown. */
export interface AiFixPart {
  /** Asks the AI of the current consultation; the fix's Markdown, or the sentence to show instead. */
  ask(request: InlineFixRequest): Promise<{ ok: true; markdown: string } | { ok: false; message: string }>
  /** The fix drawn as the chat draws a reply (no raw HTML, no remote images). */
  preview(markdown: string): ReactNode
}

export interface SelectionSlot {
  /** The review's comment box. Without it, no ［コメント］ (and no comment from a review's selection). */
  commentBox?: (props: CommentBoxProps) => ReactNode
  /** The consultation's AI. Without it, no ［AI に直してもらう］ nor ［AI に反映してもらう］. */
  aiFix?: AiFixPart
}
