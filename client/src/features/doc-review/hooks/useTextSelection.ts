import { useState, useCallback, useRef, useEffect } from 'react'
import { findTextInMarkdown, type CommentSeverity } from '../model'

export function useTextSelection(
  isReviewing: boolean,
  markdownContent: string,
  // Resolves to false when the comment could not be saved: the popover then stays open with the text.
  onAddComment: (selectedText: string, startOffset: number, endOffset: number, body: string, severity: CommentSeverity) => Promise<boolean> | void,
) {
  const [popover, setPopover] = useState<{ x: number; y: number; text: string; start: number; end: number } | null>(null)
  const isReviewingRef = useRef(isReviewing)
  useEffect(() => { isReviewingRef.current = isReviewing }, [isReviewing])

  const handleMouseUp = useCallback(() => {
    if (!isReviewingRef.current) return

    const selection = window.getSelection()
    if (!selection || selection.isCollapsed || !selection.toString().trim()) {
      return
    }

    const text = selection.toString().trim()
    const offsets = findTextInMarkdown(markdownContent, text)

    const range = selection.getRangeAt(0)
    const rect = range.getBoundingClientRect()

    setPopover({
      x: Math.min(rect.left, window.innerWidth - 300),
      y: rect.bottom,
      text,
      start: offsets?.start ?? 0,
      end: offsets?.end ?? 0,
    })
  }, [markdownContent])

  const handleSubmitComment = useCallback(async (body: string, severity: CommentSeverity): Promise<boolean> => {
    if (!popover) return false
    const saved = await onAddComment(popover.text, popover.start, popover.end, body, severity)
    if (saved === false) return false
    setPopover(null)
    window.getSelection()?.removeAllRanges()
    return true
  }, [popover, onAddComment])

  const closePopover = useCallback(() => {
    setPopover(null)
    window.getSelection()?.removeAllRanges()
  }, [])

  useEffect(() => {
    if (!popover) return
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      if (target.closest('.fixed.z-50')) return
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [popover])

  return { popover, handleMouseUp, handleSubmitComment, closePopover }
}
