import type { ChatSessionSummary } from '../../../shared/chat-history'
import { isEmptyConversation } from '../../lib/conversationRows'

/**
 * What a conversation's tab holds at the moment the member leaves it for
 * another conversation. Read live from the tab (the stored summary lags: the
 * draft is saved every few seconds, attachments never).
 */
export interface LeftConversation {
  /** Its history was restored (until then nothing below is known). */
  ready: boolean
  /** Any message besides the greeting: something was sent (or arrived). */
  hasMessages: boolean
  /** Unsent text in its input. */
  draft: string
  /** Images or files attached in its input and not sent. */
  attachments: number
  /** A turn runs, messages wait to go out, the AI waits for an answer, or a hand-off request is open. */
  busy: boolean
}

/** Nothing typed, attached, sent or running: the tab itself holds nothing worth keeping. */
export function isBlankWhenLeft(left: LeftConversation): boolean {
  return left.ready && !left.hasMessages && !left.draft.trim() && left.attachments === 0 && !left.busy
}

/**
 * A conversation the member left for another is removed (tab closed, history
 * deleted) only when it is blank in the tab and its stored copy, if any, is
 * one closing would delete too (never sent, no draft, not renamed, not pinned).
 * `stored` is undefined when it was never saved.
 */
export function discardWhenLeft(left: LeftConversation, stored: ChatSessionSummary | undefined): boolean {
  return isBlankWhenLeft(left) && isEmptyConversation(stored)
}
