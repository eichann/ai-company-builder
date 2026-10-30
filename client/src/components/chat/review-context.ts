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
}

export const ReviewActionsContext = createContext<ReviewActions>({ confirm: () => {}, requestChanges: () => {} })
