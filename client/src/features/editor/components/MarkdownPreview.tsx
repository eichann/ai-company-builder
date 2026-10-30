import React, { useCallback, useEffect, useMemo, useRef } from 'react'
import { X, MagnifyingGlass, CaretUp, CaretDown } from '@phosphor-icons/react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { LocalImage } from './BinaryPreviews'
import { usePreviewSearch } from '../hooks/usePreviewSearch'

export interface HighlightRange {
  text: string
  resolved: boolean
  commentId: string
}

export const MarkdownPreview = React.forwardRef<HTMLDivElement, {
  content: string
  basePath: string
  initialScrollRatio?: number
  highlightRanges?: HighlightRange[]
  /** The editor pane this preview is in: `editor.find` (⌘F) reaches this one only. */
  paneId: string
}>(
  function MarkdownPreview({ content, basePath, initialScrollRatio, highlightRanges, paneId }, ref) {
    const innerRef = useRef<HTMLDivElement | null>(null)
    const bodyRef = useRef<HTMLDivElement | null>(null)
    const components = useMemo(() => ({
      img: ({ src, alt, ...props }: React.ImgHTMLAttributes<HTMLImageElement>) => {
        const raw = src || ''
        if (raw && !raw.startsWith('http') && !raw.startsWith('data:')) {
          // A company file: versioned URL, so a replaced image shows at once.
          return <LocalImage {...props} filePath={`${basePath}/${raw.replace(/^\.\//, '')}`} alt={alt} className="max-w-full rounded" />
        }
        return <img src={raw} alt={alt} {...props} className="max-w-full rounded" />
      },
      a: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
        <a href={href} {...props} target="_blank" rel="noopener noreferrer">{children}</a>
      ),
    }), [basePath])

    const search = usePreviewSearch(innerRef, bodyRef, content, paneId)

    // Restore scroll position by ratio after mount
    useEffect(() => {
      if (!innerRef.current || initialScrollRatio == null || initialScrollRatio <= 0) return
      const el = innerRef.current
      requestAnimationFrame(() => {
        const maxScroll = el.scrollHeight - el.clientHeight
        el.scrollTop = maxScroll * initialScrollRatio
      })
    }, []) // Only on mount

    // Apply text highlights for review comments
    useEffect(() => {
      if (!bodyRef.current) return

      // Remove existing highlights first (always clean up)
      bodyRef.current.querySelectorAll('mark[data-review-highlight]').forEach(el => {
        const parent = el.parentNode
        if (parent) {
          parent.replaceChild(document.createTextNode(el.textContent || ''), el)
          parent.normalize()
        }
      })

      if (!highlightRanges || highlightRanges.length === 0) return

      // Apply new highlights using TreeWalker (skip nodes inside search highlights)
      for (const range of highlightRanges) {
        const walker = document.createTreeWalker(bodyRef.current, NodeFilter.SHOW_TEXT)
        let node: Text | null
        while ((node = walker.nextNode() as Text | null)) {
          if (node.parentElement?.hasAttribute('data-search-highlight')) continue
          const idx = node.textContent?.indexOf(range.text) ?? -1
          if (idx === -1) continue

          const before = node.splitText(idx)
          const highlighted = before.splitText(range.text.length)
          const mark = document.createElement('mark')
          mark.setAttribute('data-review-highlight', 'true')
          mark.setAttribute('data-comment-id', range.commentId)
          mark.className = range.resolved
            ? 'bg-green-500/20 rounded px-0.5 transition-all'
            : 'bg-amber-500/30 rounded px-0.5 transition-all'
          mark.textContent = before.textContent
          before.parentNode?.replaceChild(mark, before)
          // walker continues with `highlighted` node
          void highlighted
          break // Only highlight first occurrence per range
        }
      }
    }, [highlightRanges, content])

    const setRefs = useCallback((el: HTMLDivElement | null) => {
      innerRef.current = el
      if (typeof ref === 'function') ref(el)
      else if (ref) (ref as React.MutableRefObject<HTMLDivElement | null>).current = el
    }, [ref])

    return (
      <div ref={setRefs} className="h-full overflow-auto px-8 py-6 relative">
        {search.searchOpen && (
          <div className="sticky top-0 z-10 mb-4 flex items-center gap-2 px-3 py-2 rounded-lg border border-gray-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 shadow-md max-w-md mx-auto">
            <MagnifyingGlass size={14} className="text-gray-400 dark:text-zinc-500 flex-shrink-0" />
            <input
              ref={search.searchInputRef}
              type="text"
              value={search.searchText}
              onChange={(e) => search.changeText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); search.goPrevMatch() }
                else if (e.key === 'Enter') { e.preventDefault(); search.goNextMatch() }
                else if (e.key === 'Escape') { e.preventDefault(); search.closeSearch() }
              }}
              placeholder="検索..."
              className="flex-1 min-w-0 bg-transparent text-sm text-gray-800 dark:text-zinc-200 placeholder-gray-400 dark:placeholder-zinc-500 outline-none"
              autoFocus
            />
            {search.searchText && (
              <span className="text-[11px] text-gray-400 dark:text-zinc-500 tabular-nums flex-shrink-0">
                {search.matchCount > 0 ? `${search.currentMatch + 1}/${search.matchCount}` : '0件'}
              </span>
            )}
            <button onClick={search.goPrevMatch} className="p-0.5 text-gray-400 dark:text-zinc-500 hover:text-gray-600 dark:hover:text-zinc-300 disabled:opacity-30" disabled={search.matchCount === 0}>
              <CaretUp size={14} />
            </button>
            <button onClick={search.goNextMatch} className="p-0.5 text-gray-400 dark:text-zinc-500 hover:text-gray-600 dark:hover:text-zinc-300 disabled:opacity-30" disabled={search.matchCount === 0}>
              <CaretDown size={14} />
            </button>
            <button onClick={search.closeSearch} className="p-0.5 text-gray-400 dark:text-zinc-500 hover:text-gray-600 dark:hover:text-zinc-300">
              <X size={14} />
            </button>
          </div>
        )}
        <div ref={bodyRef} className="max-w-3xl mx-auto markdown-body">
          <Markdown remarkPlugins={[remarkGfm]} components={components}>
            {content}
          </Markdown>
        </div>
      </div>
    )
  }
)
