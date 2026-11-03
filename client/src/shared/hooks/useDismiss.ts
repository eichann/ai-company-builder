import { useEventListener } from './useEventListener'

/**
 * Closes a small popover while it is open: a press outside `element` (the popover with its
 * button) or Esc anywhere calls `onClose`.
 */
export function useDismiss(element: HTMLElement | null, open: boolean, onClose: () => void): void {
  const doc = typeof document === 'undefined' ? null : document
  useEventListener<MouseEvent>(doc, 'mousedown', e => { if (element && !element.contains(e.target as Node)) onClose() }, { enabled: open })
  // Esc while a Japanese input is converting only cancels the conversion.
  useEventListener<KeyboardEvent>(doc, 'keydown', e => { if (e.key === 'Escape' && !e.isComposing) onClose() }, { enabled: open })
}
