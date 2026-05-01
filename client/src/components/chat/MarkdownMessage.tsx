import React, { memo, useMemo } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Prism as SyntaxHighlighterRaw } from 'react-syntax-highlighter'
import { oneLight, oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'

// react-syntax-highlighter ships types compatible with older React. Cast for React 19 JSX compatibility.
const SyntaxHighlighter = SyntaxHighlighterRaw as unknown as React.FC<{
  language?: string
  style: Record<string, React.CSSProperties>
  PreTag?: string
  customStyle?: React.CSSProperties
  children: string
}>
import { useAppStore } from '../../stores/appStore'

interface MarkdownMessageProps {
  content: string
}

// Renders assistant message text as decorated markdown with GFM and async-loaded Prism syntax highlighting.
// Links open in new windows; code blocks get themed syntax colors.
export const MarkdownMessage = memo(function MarkdownMessage({ content }: MarkdownMessageProps) {
  const theme = useAppStore((s) => s.theme)
  const isDark = theme === 'dark'

  const components = useMemo(() => ({
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
      // Fenced block: use Prism highlighter. Falls back to "text" when no language was given.
      return (
        <SyntaxHighlighter
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          style={(isDark ? oneDark : oneLight) as any}
          language={lang || 'text'}
          PreTag="div"
          customStyle={{
            margin: 0,
            borderRadius: '0.5rem',
            fontSize: '12.5px',
            lineHeight: '1.5',
            padding: '0.75rem 1rem',
          }}
        >
          {codeText}
        </SyntaxHighlighter>
      )
    },
    pre({ children }: { children?: React.ReactNode }) {
      // SyntaxHighlighter renders its own container; wrap with margin only
      return <div className="my-2">{children}</div>
    },
  }), [isDark])

  return (
    <div
      className="markdown-message prose prose-sm dark:prose-invert max-w-none
        prose-p:my-2
        prose-pre:bg-transparent prose-pre:p-0 prose-pre:m-0
        prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5
        break-words"
    >
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <Markdown remarkPlugins={[remarkGfm]} components={components as any}>
        {content}
      </Markdown>
    </div>
  )
})
