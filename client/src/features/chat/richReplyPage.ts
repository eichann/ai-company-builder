// A rich reply as a page of its own (chat-ui-and-history.md "Rich replies: ［大きく見る］［ページとして残す］
// ［コードとして見る］"), for the HTML viewer: the AI's blocks **as it wrote them** (owner decision 2026-11-28 ④: the
// viewer is doc-frame.md's isolated view — no network, nothing of the app, an opaque origin — so what the chat's frame
// had to remove may run there), the reply's Markdown as the chat draws it, in the chat's look (the app's tokens and
// typography, the ready-made boxes). Light / dark follow the computer there, like the reply's own CSS.
import { appCss, FRAME_CSS } from './richReplyFrame'
import { CHAT_MARKDOWN_CLASS, richPiecesOf } from './richReply'
import { markdownHtml } from './richReplyMarkdown'

/** A page, not a box in the chat: it scrolls, has the page's background and a readable width. */
const PAGE_CSS = `
  html, body { overflow: auto; background: var(--color-surface); }
  .acb-page { max-width: 960px; margin: 0 auto; padding: 32px 24px; }
`
/** The app's dark tokens hang on `.dark`: set it from the computer's setting (the viewer lets a page's script run). */
const FOLLOW_SCHEME = "<script>(function(){var m=matchMedia('(prefers-color-scheme: dark)');function s(){document.documentElement.classList.toggle('dark',m.matches)}s();m.addEventListener('change',s)})()</script>"

const escapeText = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** The page's whole document. `title` names the tab; the pieces are not cleaned (the viewer keeps them apart). */
export function replyPageDocument(content: string, title: string, isDark: boolean): string {
  const body = richPiecesOf(content).map(piece => {
    if (piece.kind === 'markdown') return `<div class="acb-piece acb-markdown">${markdownHtml(piece.text, isDark)}</div>`
    if (piece.kind === 'slide') return `<div class="acb-piece acb-slide not-prose"><div class="acb-slide-inner">${piece.text}</div></div>`
    return `<div class="acb-piece acb-html">${piece.text}</div>`
  }).join('\n')
  const font = getComputedStyle(document.body).fontFamily.replace(/[<>{};]/g, '')
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<title>${escapeText(title)}</title>${FOLLOW_SCHEME}`
    + `<style>${appCss()}\nbody { font-family: ${font}; }\n${FRAME_CSS}\n${PAGE_CSS}</style></head>`
    + `<body><main class="acb-root acb-page ${CHAT_MARKDOWN_CLASS}">\n${body}\n</main></body></html>`
}
