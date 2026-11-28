/**
 * 「返事の形」 of a consultation (pure; the renderer's switch, the stored conversation and the chat
 * server read it). `plain` is today's reply and adds nothing to what the AI is told; `rich` adds one
 * line that diagrams are welcome, the rich-reply line with its ready-made pieces and, when the member
 * has a 今日のフォルダ, one line that a page may be made there and shown as a card. Whether a diagram, a
 * rich reply or a page card is drawn does not depend on it: the chat draws a ```mermaid / ```svg block,
 * an ```acb-html / ```acb-slide block and a link to an HTML file of the company folder in every reply
 * (chat-ui-and-history.md "Diagrams in a reply", "Rich replies", "Page cards in a reply").
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
 * The ready-made pieces of a rich reply's frame, as the AI is told to write them. Their look is the frame's
 * (`richReplyFrame.ts` FRAME_CSS: tokens only, so they read in light and dark); a piece named here without a rule
 * there fails `tests/ui/chat-rich-reply.spec.ts`. The cleaning keeps `class` as it does any (the frame keeps it in).
 */
export const RICH_HTML_PIECES: readonly (readonly [what: string, markup: string])[] = [
  ['Key point, note, warning, done', '<div class="acb-key">…</div> (acb-note, acb-warn, acb-ok)'],
  ['Steps', '<ol class="acb-steps"><li><details><summary>…</summary>…</details></li></ol>'],
  ['Comparison', '<table class="acb-compare"><tr><th>…</th><th class="best">…</th></tr><tr><td><span class="acb-no">×</span></td><td class="best"><span class="acb-yes">○</span></td></tr></table> (best: the recommended column; also acb-mid △)'],
  ['Tabs (≤5; name and ids unique in the reply)', '<div class="acb-tabs"><input type="radio" name="g1" id="g1a" checked><label for="g1a">…</label> (one pair per tab), then <div class="acb-tab">…</div> per tab</div>'],
  ['Explanation on hover', '<span class="acb-tip">term<span class="acb-tip-text">…</span></span>'],
  ['Bar', '<div class="acb-bar"><span style="width: 45%"></span></div>'],
]

/**
 * The rich-reply line (owner decision 2026-11-28; English, as the demo's draft for the AI): when to write HTML, what
 * the app removes, and the pieces. Short on purpose: the cleaning and the closed frame, not these words, keep a reply safe.
 */
export const RICH_HTML_INSTRUCTION = 'When a table, comparison, steps or a small figure would make the answer easier to read, you may write that part'
  + ' as HTML in a ```acb-html code block (one 16:9 slide, 1280×720: ```acb-slide), the rest in Markdown; the app draws it in'
  + ' the chat\'s look. Scripts, forms, outside images, fonts and url() are removed; pictures: inline <svg>; colours: the pieces'
  + ' below or var(--color-text) and the like (they follow light / dark). Pieces: '
  + RICH_HTML_PIECES.map(([what, markup]) => `${what}: ${markup}`).join('; ') + '.'

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
 * (`capabilities.richReplies`); then the diagram line, the rich-reply line, and the page line when there is a page folder.
 */
export function replyStyleInstruction(value: unknown, agentTakesIt: boolean, pageFolder: string | null = null): string {
  if (!agentTakesIt || replyStyleOf(value) !== 'rich') return ''
  return `\n\n${RICH_REPLY_INSTRUCTION}\n${RICH_HTML_INSTRUCTION}${pageFolder ? `\n${replyPageInstruction(pageFolder)}` : ''}`
}
