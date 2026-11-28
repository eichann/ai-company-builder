// The cleaning of a rich reply's HTML (chat-ui-and-history.md "Rich replies"), run in a real browser: the spec
// tests/ui/chat-reply-cleaning.spec.ts calls it through window.__acbReplyCleaning (it needs DOMParser and the
// browser's CSS parser, which node tests do not have). Nothing of the chat is drawn here.
import { createRoot } from 'react-dom/client'
import { sanitizeReplyHtml } from '../src/features/chat/replyHtmlCleaning'

declare global {
  interface Window {
    __acbReplyCleaning?: { sanitizeReplyHtml: typeof sanitizeReplyHtml }
  }
}

window.__acbReplyCleaning = { sanitizeReplyHtml }
createRoot(document.getElementById('root')!).render(<p>返事の HTML の掃除（確かめ用のページ）</p>)
