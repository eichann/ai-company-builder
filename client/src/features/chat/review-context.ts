import { createContext } from 'react'

/**
 * The conversation's answers to its pending 「確認をお願いします」 request
 * (ChatConversation.tsx). `pendingId` is the request still waiting; older
 * cards show as answered.
 */
export interface ReviewActions {
  pendingId?: string
  /** Sends 「この内容で進めて」 (REVIEW_CONFIRM_MESSAGE). */
  confirm: () => void
  /** Puts the cursor in the composer to write what to change. */
  requestChanges: () => void
  /**
   * Sends `text` as the member's own message, through the composer's ordinary send (exactly as if they typed it): a card's
   * answer buttons (「ブラウザ操作」's stopped card, agent-browser.md "The stopped card asks one thing"). Absent outside a
   * conversation: such a card then shows no answer button.
   */
  say?: (text: string) => void
}

export const ReviewActionsContext = createContext<ReviewActions>({ confirm: () => {}, requestChanges: () => {} })
