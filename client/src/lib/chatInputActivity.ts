type WindowWithChatInputActivity = Window & {
  __acbChatInputActivityAt?: number
}

const DEFAULT_ACTIVE_WINDOW_MS = 1200

export function markChatInputActivity(): void {
  if (typeof window === 'undefined') return
  const target = window as WindowWithChatInputActivity
  target.__acbChatInputActivityAt = Date.now()
}

export function isChatInputRecentlyActive(activeWindowMs = DEFAULT_ACTIVE_WINDOW_MS): boolean {
  if (typeof window === 'undefined') return false
  const target = window as WindowWithChatInputActivity
  const at = target.__acbChatInputActivityAt ?? 0
  return Date.now() - at < activeWindowMs
}
