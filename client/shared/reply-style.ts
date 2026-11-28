/**
 * 「返事の形」 of a consultation (pure; the renderer's switch, the stored conversation and the chat
 * server read it). `plain` is today's reply and adds nothing to what the AI is told; `rich` adds one
 * line that diagrams are welcome. Whether a diagram in a reply is drawn does not depend on it: the
 * chat draws a ```mermaid / ```svg block in every reply (chat-ui-and-history.md "Diagrams in a reply").
 */
export type ReplyStyle = 'plain' | 'rich'

/** Anything other than exactly 'rich' (an older app's conversation, a bad value) is the plain reply. */
export function replyStyleOf(value: unknown): ReplyStyle {
  return value === 'rich' ? 'rich' : 'plain'
}

/** The one line a rich reply adds to the turn (the owner: few words; the app, not the prompt, keeps diagrams safe). */
export const RICH_REPLY_INSTRUCTION = '図があると分かりやすいときは、```mermaid か ```svg のコードブロックで図を入れてかまいません（アプリが図として表示します）。'

/** What this turn adds for the reply's form: nothing unless it is rich and the agent takes it (`capabilities.richReplies`). */
export function replyStyleInstruction(value: unknown, agentTakesIt: boolean): string {
  return agentTakesIt && replyStyleOf(value) === 'rich' ? `\n\n${RICH_REPLY_INSTRUCTION}` : ''
}
