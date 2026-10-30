import { useCallback, useEffect, useRef, useState } from 'react'
import { useCommandHandler } from '../../../shared/commands/commands'

const MATCH_CLASS = 'bg-yellow-200 dark:bg-yellow-500/40 rounded-sm'
const CURRENT_MATCH_CLASS = 'bg-orange-300 dark:bg-orange-500/60 rounded-sm ring-2 ring-orange-400'

/**
 * Search inside a rendered Markdown preview (`editor.find`, ⌘F in the focused
 * editor): marks every match in the DOM under `bodyRef` (skipping review
 * highlights) and scrolls to the current one.
 */
export function usePreviewSearch(
  innerRef: React.MutableRefObject<HTMLDivElement | null>,
  bodyRef: React.MutableRefObject<HTMLDivElement | null>,
  content: string,
  paneId: string,
) {
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
  }, [searchText, content, bodyRef])

  // Scroll to current match and highlight it
  useEffect(() => {
    if (!bodyRef.current || matchCount === 0) return
    bodyRef.current.querySelectorAll('mark[data-search-highlight]').forEach(el => {
      (el as HTMLElement).className = MATCH_CLASS
    })
    const current = bodyRef.current.querySelector(`mark[data-search-index="${currentMatch}"]`)
    if (current) {
      (current as HTMLElement).className = CURRENT_MATCH_CLASS
      current.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [currentMatch, matchCount, bodyRef])

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
