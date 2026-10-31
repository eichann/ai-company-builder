import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import type { UIMessage } from 'ai'

export interface ChatAutoScrollOptions {
  isActive: boolean
  isRestoringSession: boolean
  messages: UIMessage[]
  status: string
}

/**
 * Keeps the newest message in view while it streams — unless the member
 * scrolled up to read (more than 120 px from the bottom), and not during IME
 * composition (a scroll there moves the candidate window; it is done 180 ms
 * after composition ends). Opening a conversation (tab shown, history
 * restored) always starts at the bottom.
 *
 * All refs: scroll position and composition change constantly and nothing
 * renders from them.
 */
export function useChatAutoScroll({ isActive, isRestoringSession, messages, status }: ChatAutoScrollOptions) {
  // Composition state for auto-scroll
  const isInputComposingRef = useRef(false)
  const compositionEndTimerRef = useRef<number | null>(null)
  const pendingAutoScrollRef = useRef(false)

  // Auto-scroll refs
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const shouldAutoScrollRef = useRef(true)

  // History content mounts after restoration; hidden tabs have no layout.
  // Reset only on opening a chat, so reading older messages stays possible.
  useLayoutEffect(() => {
    if (!isActive || isRestoringSession) return
    shouldAutoScrollRef.current = true
    pendingAutoScrollRef.current = false
    const container = messagesContainerRef.current
    if (container) container.scrollTop = container.scrollHeight
  }, [isActive, isRestoringSession])

  // Attach after the message list actually mounts, not while the spinner is shown.
  useEffect(() => {
    if (!isActive || isRestoringSession) return
    const container = messagesContainerRef.current
    if (!container) return

    const handleScroll = () => {
      const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight
      shouldAutoScrollRef.current = distanceFromBottom < 120
    }

    container.addEventListener('scroll', handleScroll, { passive: true })
    handleScroll()

    return () => {
      container.removeEventListener('scroll', handleScroll)
    }
  }, [isActive, isRestoringSession])

  // Auto-scroll when messages change
  useEffect(() => {
    if (!isActive || isRestoringSession) return
    if (isInputComposingRef.current) {
      pendingAutoScrollRef.current = true
      return
    }
    if (!shouldAutoScrollRef.current) return
    pendingAutoScrollRef.current = false
    messagesEndRef.current?.scrollIntoView({ behavior: 'auto' })
  }, [messages, status, isActive, isRestoringSession])

  // Composition handling
  const flushAfterComposition = useCallback(() => {
    if (pendingAutoScrollRef.current) {
      pendingAutoScrollRef.current = false
      if (shouldAutoScrollRef.current) {
        messagesEndRef.current?.scrollIntoView({ behavior: 'auto' })
      }
    }
  }, [])

  const onCompositionStateChange = useCallback((isComposing: boolean) => {
    if (isComposing) {
      if (compositionEndTimerRef.current != null) {
        window.clearTimeout(compositionEndTimerRef.current)
        compositionEndTimerRef.current = null
      }
      isInputComposingRef.current = true
      return
    }

    if (compositionEndTimerRef.current != null) {
      window.clearTimeout(compositionEndTimerRef.current)
    }
    compositionEndTimerRef.current = window.setTimeout(() => {
      compositionEndTimerRef.current = null
      isInputComposingRef.current = false
      flushAfterComposition()
    }, 180)
  }, [flushAfterComposition])

  // A pending composition-end timer must not fire after the tab closed.
  useLayoutEffect(() => () => {
    if (compositionEndTimerRef.current != null) {
      window.clearTimeout(compositionEndTimerRef.current)
    }
  }, [])

  return { messagesEndRef, messagesContainerRef, onCompositionStateChange }
}
