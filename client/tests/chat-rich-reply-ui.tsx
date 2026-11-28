// The rich reply's closed frame on its own (chat-ui-and-history.md "Rich replies: the reply's closed frame"): the spec
// tests/ui/chat-rich-reply.spec.ts draws markup in the frame exactly as the chat makes it (shownFrame + frameDocument)
// through window.__acbRichReply — with the cleaning skipped, to show that the frame alone runs and loads nothing.
// The chat itself is tested on chat-header-ui.html?turn=manual.
import { createRoot } from 'react-dom/client'
import '../src/index.css'
import { frameContentOf, frameDocument, shownFrame } from '../src/features/chat/richReplyFrame'
import { richPiecesOf } from '../src/features/chat/richReply'

type Draw = { html: string; css: string; sandbox?: boolean; policy?: boolean }
declare global {
  interface Window {
    __acbRichReply?: { draw(options: Draw): Promise<void>; contentOf(reply: string, isDark: boolean): { body: string; css: string } }
  }
}

window.__acbRichReply = {
  /** What the chat puts in the frame for a whole reply (every piece cleaned, one tree). */
  contentOf: (reply, isDark) => frameContentOf(richPiecesOf(reply), isDark),
  /** Markup as written (not cleaned) in the chat's frame; `sandbox: false` / `policy: false` take one guard off (the checks can fail). */
  draw: ({ html, css, sandbox = true, policy = true }) => new Promise<void>(resolve => {
    document.getElementById('reply')?.remove()
    const frame = shownFrame(600, false)
    frame.id = 'reply'
    if (!sandbox) frame.removeAttribute('sandbox')
    frame.style.position = 'static'
    frame.style.width = '760px'
    frame.onload = () => { frame.style.visibility = 'visible'; resolve() }
    let doc = frameDocument({ body: html, css }, false)
    if (!policy) doc = doc.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '')
    frame.srcdoc = doc
    document.body.append(frame)
  }),
}
createRoot(document.getElementById('root')!).render(<p>返事の閉じた枠（確かめ用のページ）</p>)
