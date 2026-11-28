/**
 * 「返事の形」 of a consultation (pure; the renderer's switch, the stored conversation and the chat
 * server read it). `plain` is today's reply and adds nothing to what the AI is told; `rich` adds one
 * line that diagrams are welcome and, when the member has a 今日のフォルダ, one line that a page may be
 * made there and shown as a card. Whether a diagram or a page card in a reply is drawn does not depend
 * on it: the chat draws a ```mermaid / ```svg block and a link to an HTML file of the company folder in
 * every reply (chat-ui-and-history.md "Diagrams in a reply", "Page cards in a reply").
 */
import { isTodayFolderPath } from './today-folder'

export type ReplyStyle = 'plain' | 'rich'

/** Anything other than exactly 'rich' (an older app's conversation, a bad value) is the plain reply. */
export function replyStyleOf(value: unknown): ReplyStyle {
  return value === 'rich' ? 'rich' : 'plain'
}

/** The one line a rich reply adds to the turn (the owner: few words; the app, not the prompt, keeps diagrams safe). */
export const RICH_REPLY_INSTRUCTION = '図があると分かりやすいときは、```mermaid か ```svg のコードブロックで図を入れてかまいません（アプリが図として表示します）。'

/**
 * Where a rich reply's pages go, inside the member's 今日のフォルダ (`<department>/.personal/inbox/日付別/…`):
 * on this computer only, never synced (push check `[PERSONAL_PATH]`), so a page the AI makes is the member's
 * alone until the member moves it (ai-made-visibility: what is shared is first the member's own). A folder of
 * its own, so a page's scripts (which may read their own folder: doc-frame.md) reach only other pages.
 */
export const REPLY_PAGE_FOLDER = 'ページ'

/**
 * The page folder's absolute path for this turn, or null: only for a today folder exactly as the app builds it
 * (`isTodayFolderPath`: a request body cannot point the AI anywhere else) and an absolute company root.
 */
export function replyPageFolderOf(companyRoot: unknown, todayFolder: unknown): string | null {
  if (typeof companyRoot !== 'string' || !isTodayFolderPath(todayFolder)) return null
  const root = companyRoot.replace(/[\\/]+$/, '')
  if (!root || !(root.startsWith('/') || /^[A-Za-z]:[\\/]/.test(root))) return null
  return `${root}/${todayFolder}/${REPLY_PAGE_FOLDER}`
}

/** The page line (one sentence; the viewer, not the prompt, keeps a page from reaching anything). */
export function replyPageInstruction(pageFolder: string): string {
  return `説明・比べる表・図解などをページで見せると分かりやすいときは、インターネットの部品を使わない 1 つの HTML ファイルを「${pageFolder}/」に作り、返事に [ページの題名](そのファイルのパス) のリンクを書いてかまいません（アプリがカードで出し、本人だけが見られます）。`
}

/**
 * What this turn adds for the reply's form: nothing unless it is rich and the agent takes it
 * (`capabilities.richReplies`); then the diagram line, and the page line when there is a page folder.
 */
export function replyStyleInstruction(value: unknown, agentTakesIt: boolean, pageFolder: string | null = null): string {
  if (!agentTakesIt || replyStyleOf(value) !== 'rich') return ''
  return `\n\n${RICH_REPLY_INSTRUCTION}${pageFolder ? `\n${replyPageInstruction(pageFolder)}` : ''}`
}
