import { useCallback, useEffect, useRef, useState } from 'react'
import { useCommandHandler } from '../../../shared/commands/commands'

const MATCH_CLASS = 'bg-yellow-200 dark:bg-yellow-500/40 rounded-sm'
const CURRENT_MATCH_CLASS = 'bg-orange-300 dark:bg-orange-500/60 rounded-sm ring-2 ring-orange-400'

/** The browser's own highlights (`::highlight(acb-find)`, index.css): they draw over the text without changing it. */
const FIND = 'acb-find'
const FIND_CURRENT = 'acb-find-current'

function clearHighlights() {
  if (typeof CSS === 'undefined' || !('highlights' in CSS)) return
  CSS.highlights.delete(FIND)
  CSS.highlights.delete(FIND_CURRENT)
}

/**
 * Search inside a rendered Markdown preview (`editor.find`, ⌘F in the focused
 * editor): marks every match under `bodyRef` (skipping review highlights) and
 * scrolls to the current one. `marking: 'highlights'` marks without touching the
 * DOM — for a document edited in place, whose DOM belongs to the editor (a
 * `<mark>` put in there would be read as an edit).
 */
export function usePreviewSearch(
  innerRef: React.MutableRefObject<HTMLDivElement | null>,
  bodyRef: React.MutableRefObject<HTMLDivElement | null>,
  content: string,
  paneId: string,
  marking: 'dom' | 'highlights' = 'dom',
) {
  const rangesRef = useRef<Range[]>([])
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchText, setSearchText] = useState('')
  const [matchCount, setMatchCount] = useState(0)
  const [currentMatch, setCurrentMatch] = useState(0)
  const searchInputRef = useRef<HTMLInputElement>(null)

  // A hidden preview lets the key through.
  useCommandHandler('editor.find', () => {
    setSearchOpen(true)
    requestAnimationFrame(() => searchInputRef.current?.focus())
  }, { target: paneId, acceptsKey: () => !!innerRef.current?.offsetParent })

  // Apply search highlights
  useEffect(() => {
    if (!bodyRef.current) return
    if (marking === 'highlights') {
      clearHighlights()
      rangesRef.current = []
      const query = searchText.trim().toLowerCase()
      if (!query) { setMatchCount(0); setCurrentMatch(0); return }
      const walker = document.createTreeWalker(bodyRef.current, NodeFilter.SHOW_TEXT)
      const ranges: Range[] = []
      for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
        const lower = (node.textContent || '').toLowerCase()
        for (let i = lower.indexOf(query); i !== -1; i = lower.indexOf(query, i + query.length)) {
          const range = document.createRange()
          range.setStart(node, i)
          range.setEnd(node, i + query.length)
          ranges.push(range)
        }
      }
      rangesRef.current = ranges
      if (ranges.length > 0 && 'highlights' in CSS) CSS.highlights.set(FIND, new Highlight(...ranges))
      setMatchCount(ranges.length)
      setCurrentMatch(prev => ranges.length > 0 ? Math.min(prev, ranges.length - 1) : 0)
      return clearHighlights
    }

    // Clear existing search highlights
    bodyRef.current.querySelectorAll('mark[data-search-highlight]').forEach(el => {
      const parent = el.parentNode
      if (parent) {
        parent.replaceChild(document.createTextNode(el.textContent || ''), el)
        parent.normalize()
      }
    })

    if (!searchText.trim()) {
      setMatchCount(0)
      setCurrentMatch(0)
      return
    }

    const query = searchText.trim().toLowerCase()
    const walker = document.createTreeWalker(bodyRef.current, NodeFilter.SHOW_TEXT)
    const matches: { node: Text; idx: number }[] = []

    // Collect all matches first (avoid modifying DOM during walk)
    let node: Text | null
    while ((node = walker.nextNode() as Text | null)) {
      // Skip nodes inside review highlights to avoid conflicts
      if (node.parentElement?.hasAttribute('data-review-highlight')) continue
      const text = node.textContent || ''
      const lower = text.toLowerCase()
      let searchFrom = 0
      let idx: number
      while ((idx = lower.indexOf(query, searchFrom)) !== -1) {
        matches.push({ node, idx })
        searchFrom = idx + query.length
      }
    }

    // Apply highlights from last to first (to preserve indices)
    for (let i = matches.length - 1; i >= 0; i--) {
      const m = matches[i]
      const textNode = m.node
      // Re-check since DOM may have been modified by previous iterations on same node
      if (!textNode.parentNode) continue
      const text = textNode.textContent || ''
      const actualIdx = text.toLowerCase().indexOf(query, m.idx)
      if (actualIdx === -1) continue

      const before = textNode.splitText(actualIdx)
      const after = before.splitText(query.length)
      void after
      const mark = document.createElement('mark')
      mark.setAttribute('data-search-highlight', 'true')
      mark.setAttribute('data-search-index', String(i))
      mark.className = MATCH_CLASS
      mark.textContent = before.textContent
      before.parentNode?.replaceChild(mark, before)
    }

    setMatchCount(matches.length)
    setCurrentMatch(prev => matches.length > 0 ? Math.min(prev, matches.length - 1) : 0)
  }, [searchText, content, bodyRef, marking])

  // Scroll to current match and highlight it
  useEffect(() => {
    if (!bodyRef.current || matchCount === 0) return
    if (marking === 'highlights') {
      const range = rangesRef.current[currentMatch]
      if (!range || !('highlights' in CSS)) return
      CSS.highlights.set(FIND_CURRENT, new Highlight(range))
      range.startContainer.parentElement?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      return
    }
    bodyRef.current.querySelectorAll('mark[data-search-highlight]').forEach(el => {
      (el as HTMLElement).className = MATCH_CLASS
    })
    const current = bodyRef.current.querySelector(`mark[data-search-index="${currentMatch}"]`)
    if (current) {
      (current as HTMLElement).className = CURRENT_MATCH_CLASS
      current.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [currentMatch, matchCount, bodyRef, marking])

  const closeSearch = useCallback(() => {
    setSearchOpen(false)
    setSearchText('')
  }, [])

  const goNextMatch = useCallback(() => {
    if (matchCount === 0) return
    setCurrentMatch(prev => (prev + 1) % matchCount)
  }, [matchCount])

  const goPrevMatch = useCallback(() => {
    if (matchCount === 0) return
    setCurrentMatch(prev => (prev - 1 + matchCount) % matchCount)
  }, [matchCount])

  const changeText = (text: string) => { setSearchText(text); setCurrentMatch(0) }

  return { searchOpen, searchText, matchCount, currentMatch, searchInputRef, changeText, closeSearch, goNextMatch, goPrevMatch }
}
