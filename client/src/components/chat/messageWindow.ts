// Windowed rendering of a conversation (MessageList in ChatPanel.tsx).
//
// Opening a long conversation used to render every message at once: markdown
// costs ~10 ms per 2 KB reply and ~230 ms per 60 KB one, so the largest real
// conversation (564 messages) froze the window for over two seconds — for
// every restored tab at startup. Only the latest MESSAGE_WINDOW messages are
// rendered; 「以前のメッセージを表示」 adds MESSAGE_WINDOW more at a time.
//
// The window is anchored to its first message's id, not to a count from the
// end: messages that arrive while the conversation is open are appended to it
// (nothing unmounts at the top under the reader), and a conversation that is
// replaced (new chat) or truncated past the anchor (edit) starts over with
// the latest messages.

export const MESSAGE_WINDOW = 50

/** Index of the first rendered message. */
export function windowStart(messages: ReadonlyArray<{ id: string }>, anchorId: string | null, size = MESSAGE_WINDOW): number {
  if (anchorId !== null) {
    const index = messages.findIndex(message => message.id === anchorId)
    if (index >= 0) return index
  }
  return Math.max(0, messages.length - size)
}

/** The anchor after 「以前のメッセージを表示」: `size` more messages before `start`. */
export function earlierAnchor(messages: ReadonlyArray<{ id: string }>, start: number, size = MESSAGE_WINDOW): string | null {
  return messages[Math.max(0, start - size)]?.id ?? null
}
