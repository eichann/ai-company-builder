import React, { memo, useMemo } from 'react'
import Markdown from 'react-markdown'
import { useAppStore } from '../../stores/appStore'
import { chatMarkdownSafety } from './chatMarkdownSafety'
import { splitMarkdownBlocks } from './markdownBlocks'
import { CodeHighlighter, PlainCodeBlock } from './codeHighlighter'

interface MarkdownMessageProps {
  content: string
}

type Components = Record<string, unknown>

const remarkPlugins = [...chatMarkdownSafety.remarkPlugins]

function makeComponents(isDark: boolean, highlight: boolean): Components {
  return {
    ...chatMarkdownSafety.components,
    a: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
      <a href={href} {...props} target="_blank" rel="noopener noreferrer" className="text-accent underline underline-offset-2 hover:opacity-80">
        {children}
      </a>
    ),
    code({ className, children, ...props }: React.HTMLAttributes<HTMLElement> & { className?: string }) {
      const match = /language-(\w+)/.exec(className || '')
      const lang = match?.[1]
      const codeText = String(children).replace(/\n$/, '')
      // react-markdown v10 no longer passes `inline`. Detect block code by:
      // (a) explicit language class (fenced ```lang) or
      // (b) presence of newline in the content (fenced ``` without language).
      const isBlock = !!match || codeText.includes('\n')

      if (!isBlock) {
        return (
          <code
            className="px-1 py-0.5 rounded bg-gray-200/70 dark:bg-zinc-700/70 text-[0.85em] font-mono text-gray-900 dark:text-zinc-100"
            {...props}
          >
            {children}
          </code>
        )
      }
      // A code block still being streamed is shown plain; it is highlighted
      // once, when its closing fence arrives.
      if (!highlight) {
        return <PlainCodeBlock isDark={isDark}>{codeText}</PlainCodeBlock>
      }
      // Fenced block: Prism (curated languages, codeHighlighter.ts). Unknown languages render plain.
      return <CodeHighlighter isDark={isDark} language={lang || 'text'}>{codeText}</CodeHighlighter>
    },
    pre({ children }: { children?: React.ReactNode }) {
      // SyntaxHighlighter renders its own container; wrap with margin only
      return <div className="my-2">{children}</div>
    },
  }
}

/** One top-level block; unchanged blocks of a streaming reply are not parsed again. */
const MarkdownBlockView = memo(function MarkdownBlockView({ text, components }: { text: string; components: Components }) {
  return (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    <Markdown remarkPlugins={remarkPlugins} skipHtml={chatMarkdownSafety.skipHtml} components={components as any}>
      {text}
    </Markdown>
  )
})

// Renders assistant message text as decorated markdown with GFM and Prism syntax highlighting.
// Links open in new windows; code blocks get themed syntax colors.
// Images are never loaded (see chatMarkdownImages.tsx) and raw HTML is skipped.
// The text is rendered block by block (markdownBlocks.ts) so a streaming reply
// re-parses only its last block.
export const MarkdownMessage = memo(function MarkdownMessage({ content }: MarkdownMessageProps) {
  const theme = useAppStore((s) => s.theme)
  const isDark = theme === 'dark'

  const components = useMemo(() => makeComponents(isDark, true), [isDark])
  const streamingComponents = useMemo(() => makeComponents(isDark, false), [isDark])
  const blocks = useMemo(() => splitMarkdownBlocks(content), [content])

  return (
    <div
      className="markdown-message prose prose-sm dark:prose-invert max-w-none
        prose-p:my-2
        prose-pre:bg-transparent prose-pre:p-0 prose-pre:m-0
        prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5
        break-words"
    >
      {blocks.map((block, index) => (
        <MarkdownBlockView key={index} text={block.text} components={block.openFence ? streamingComponents : components} />
      ))}
    </div>
  )
})
