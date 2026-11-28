// The Markdown parts of a rich reply as static HTML for its frame (chat-ui-and-history.md "Rich replies: the reply's
// closed frame"): drawn the chat's way (react-markdown + GFM, raw HTML skipped, code by the chat's highlighter) into a
// detached element, then cleaned like the AI's own HTML (richReplyFrame.ts). Nothing here is ever shown as it is.
import type React from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import Markdown from 'react-markdown'
import { chatMarkdownSafety } from './chatMarkdownSafety'
import { CodeHighlighter, PlainCodeBlock } from './components/codeHighlighter'

function components(isDark: boolean, highlight: boolean) {
  return {
    code({ className, children }: React.HTMLAttributes<HTMLElement>) {
      const lang = /language-([\w-]+)/.exec(className || '')?.[1]
      const text = String(children).replace(/\n$/, '')
      if (!lang && !text.includes('\n')) return <code>{children}</code>
      return highlight
        ? <CodeHighlighter isDark={isDark} language={lang || 'text'}>{text}</CodeHighlighter>
        : <PlainCodeBlock isDark={isDark}>{text}</PlainCodeBlock>
    },
    pre({ children }: { children?: React.ReactNode }) { return <div style={{ margin: '0.5rem 0' }}>{children}</div> },
    // A picture in a reply is never loaded (remoteImage.ts); in the frame there is no button to open it: words only.
    img({ alt, src }: React.ImgHTMLAttributes<HTMLImageElement>) {
      return <span className="acb-muted">[{alt ? `画像「${alt}」` : '画像'}{typeof src === 'string' && src ? `: ${src}` : ''}]</span>
    },
    // A link keeps only its address; the cleaning keeps it when it is a web link (opened in the browser).
    a({ href, children }: React.AnchorHTMLAttributes<HTMLAnchorElement>) { return <a href={href}>{children}</a> },
  }
}

const remarkPlugins = [...chatMarkdownSafety.remarkPlugins]
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})/gm

/**
 * `text` as the chat draws it, as an HTML string (not yet cleaned). A piece whose last code block is not closed yet
 * shows its code plain, like the chat (highlighting waits for the closing fence).
 */
export function markdownHtml(text: string, isDark: boolean): string {
  const highlight = (text.match(FENCE_LINE)?.length ?? 0) % 2 === 0
  const host = document.createElement('div')
  const root = createRoot(host)
  try {
    flushSync(() => root.render(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      <Markdown remarkPlugins={remarkPlugins} skipHtml={chatMarkdownSafety.skipHtml} components={components(isDark, highlight) as any}>
        {text}
      </Markdown>,
    ))
    return host.innerHTML
  } finally {
    root.unmount()
  }
}
