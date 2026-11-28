// Which replies are drawn whole in the reply's closed frame, and how such a reply is cut into pieces (pure: no DOM).
// chat-ui-and-history.md "Rich replies: the reply's closed frame". The cleaning is replyHtmlCleaning.ts; the frame
// and its document are richReplyFrame.ts; the component is components/ChatRichReply.tsx.

export type RichPieceKind = 'markdown' | 'html' | 'slide'
export interface RichPiece {
  kind: RichPieceKind
  text: string
  /** An ```acb-html / ```acb-slide block whose closing fence has not arrived yet (the reply is still being written). */
  open: boolean
}

/** A reply being written is drawn again at most this often (owner decision 2026-11-28). */
export const RICH_UPDATE_MS = 80
/** Taller than this, the frame stops here and the rest is for ［大きく見る］ (owner decision 2026-11-28, ⑤). */
export const RICH_MAX_HEIGHT = 20_000
/** A slide is written at this size and scaled to the chat's width. */
export const SLIDE_WIDTH = 1280
export const SLIDE_HEIGHT = 720

/** The classes of the chat's own Markdown (MarkdownMessage), so the frame's text reads like any other reply. */
export const CHAT_MARKDOWN_CLASS = 'markdown-message prose prose-sm dark:prose-invert max-w-none prose-p:my-2 prose-pre:bg-transparent prose-pre:p-0 prose-pre:m-0 prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5 break-words'

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/
const RICH_INFO = new Map<string, RichPieceKind>([['acb-html', 'html'], ['acb-slide', 'slide']])

interface Fence { char: string; length: number }
const closes = (line: string, fence: Fence) => {
  const match = FENCE.exec(line)
  return !!match && match[1][0] === fence.char && match[1].length >= fence.length && !match[2].trim()
}
const opens = (line: string): (Fence & { info: string }) | null => {
  const match = FENCE.exec(line)
  // A backtick fence's info string cannot contain a backtick (that is inline code).
  if (!match || (match[1][0] === '`' && match[2].includes('`'))) return null
  return { char: match[1][0], length: match[1].length, info: match[2].trim().toLowerCase() }
}

/**
 * The reply's pieces in order: its Markdown, and each ```acb-html (an explanation) or ```acb-slide (one 16:9 page)
 * block. ```html and every other fence stay inside their Markdown piece (shown as code); an ```acb-… fence inside
 * another fence is that fence's text.
 */
export function richPiecesOf(content: string): RichPiece[] {
  const pieces: RichPiece[] = []
  let markdown: string[] = []
  let rich: { kind: RichPieceKind; fence: Fence; lines: string[] } | null = null
  let other: Fence | null = null
  const flush = () => {
    if (markdown.some(line => line.trim())) pieces.push({ kind: 'markdown', text: markdown.join('\n'), open: false })
    markdown = []
  }
  for (const line of content.split('\n')) {
    if (rich) {
      if (closes(line, rich.fence)) {
        pieces.push({ kind: rich.kind, text: rich.lines.join('\n'), open: false })
        rich = null
      } else rich.lines.push(line)
      continue
    }
    if (other) {
      if (closes(line, other)) other = null
      markdown.push(line)
      continue
    }
    const fence = opens(line)
    const kind = fence ? RICH_INFO.get(fence.info) : undefined
    if (fence && kind) {
      flush()
      rich = { kind, fence, lines: [] }
      continue
    }
    if (fence) other = fence
    markdown.push(line)
  }
  flush()
  if (rich) pieces.push({ kind: rich.kind, text: rich.lines.join('\n'), open: true })
  return pieces
}

/** Does this reply have a block drawn in the frame (closed or still being written)? */
export const hasRichBlock = (content: string): boolean =>
  /acb-/i.test(content) && richPiecesOf(content).some(piece => piece.kind !== 'markdown')

/**
 * What of a block still being written is drawn: up to its last whole tag, without a `<style>` that is not closed
 * yet (its rules would come and go) or a table row that is not closed yet (a table grows a row at a time). The
 * result is still cleaned like any piece; this only keeps half-written parts from flickering.
 */
export function writtenSoFar(text: string): string {
  let cut = text.slice(0, text.lastIndexOf('>') + 1)
  const openStyle = cut.toLowerCase().lastIndexOf('<style')
  if (openStyle > cut.toLowerCase().lastIndexOf('</style>')) cut = cut.slice(0, openStyle)
  const openRow = cut.toLowerCase().lastIndexOf('<tr')
  if (openRow > cut.toLowerCase().lastIndexOf('</tr>')) cut = cut.slice(0, openRow)
  return cut
}

/**
 * The reply's own CSS for the app's theme: what it wrote for `prefers-color-scheme` follows the app's light / dark
 * switch, not the computer's (a media query that always or never holds; nothing else of the CSS changes).
 */
export function cssForTheme(css: string, isDark: boolean): string {
  return css.replace(/\(\s*prefers-color-scheme\s*:\s*(dark|light)\s*\)/gi, (_, scheme: string) =>
    (scheme.toLowerCase() === 'dark') === isDark ? '(min-width: 0px)' : '(max-width: -1px)')
}
