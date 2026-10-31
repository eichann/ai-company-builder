// The chat's open tabs, remembered per company and chat pane in localStorage
// (`chatTabs:<companyId>` for the main pane `chat`, `chatTabs:<companyId>:<pane>`
// for another): titles and conversation ids only. Tab ids are ephemeral and
// generated again at every start.

export interface ChatTab {
  id: string  // Ephemeral handle (random UUID), regenerated on each app start
  title: string
  sessionId: string | null  // Persisted chat session id (null until first save)
}

export const CHAT_TABS_KEY_PREFIX = 'chatTabs:'

/** What the tabs of one pane are stored under (the main pane keeps the key older versions wrote). */
export const chatTabsStorageId = (companyId: string, paneId: string): string =>
  paneId === 'chat' ? companyId : `${companyId}:${paneId}`

export type PersistedChatTabs = {
  tabs: Array<{ title: string; sessionId: string | null }>
  activeIndex: number
}

export function safeReadChatTabs(companyId: string, storage: Pick<Storage, 'getItem'> = localStorage): PersistedChatTabs | null {
  try {
    const raw = storage.getItem(`${CHAT_TABS_KEY_PREFIX}${companyId}`)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || !Array.isArray(parsed.tabs)) return null
    const seenSessionIds = new Set<string>()
    const tabs = parsed.tabs
      .filter((t: unknown): t is { title: unknown; sessionId: unknown } =>
        typeof t === 'object' && t !== null)
      .map((t: { title: unknown; sessionId: unknown }) => ({
        title: typeof t.title === 'string' ? t.title : '',
        sessionId: typeof t.sessionId === 'string' ? t.sessionId : null,
      }))
    const uniqueTabs = tabs.filter((tab: { sessionId: string | null }) => {
      if (!tab.sessionId) return true
      if (seenSessionIds.has(tab.sessionId)) return false
      seenSessionIds.add(tab.sessionId)
      return true
    })
    if (uniqueTabs.length === 0) return null
    const activeIndex =
      typeof parsed.activeIndex === 'number' && parsed.activeIndex >= 0 && parsed.activeIndex < tabs.length
        ? parsed.activeIndex
        : 0
    const activeSessionId = tabs[activeIndex]?.sessionId
    const uniqueActiveIndex = Math.max(0, uniqueTabs.findIndex((tab: { sessionId: string | null }) => tab.sessionId === activeSessionId))
    return { tabs: uniqueTabs, activeIndex: uniqueActiveIndex }
  } catch {
    return null
  }
}

export function safeWriteChatTabs(companyId: string, state: PersistedChatTabs, storage: Pick<Storage, 'setItem'> = localStorage): void {
  try {
    storage.setItem(`${CHAT_TABS_KEY_PREFIX}${companyId}`, JSON.stringify(state))
  } catch {
    // Storage may be unavailable; fail silently.
  }
}

export function newChatTab(title: string, sessionId: string | null = null): ChatTab {
  return { id: crypto.randomUUID(), title, sessionId }
}

/** The tabs to open for a company: the remembered ones, else one new chat. */
export function restoreChatTabs(persisted: PersistedChatTabs | null, newChatTitle: string): { tabs: ChatTab[]; activeTabId: string } {
  if (persisted && persisted.tabs.length > 0) {
    const tabs = persisted.tabs.map(tab => newChatTab(tab.title || newChatTitle, tab.sessionId))
    return { tabs, activeTabId: tabs[persisted.activeIndex]?.id ?? tabs[0].id }
  }
  const tab = newChatTab(newChatTitle)
  return { tabs: [tab], activeTabId: tab.id }
}

/** What is remembered for a tab list. */
export function persistedChatTabs(tabs: readonly ChatTab[], activeTabId: string): PersistedChatTabs {
  return {
    tabs: tabs.map(tab => ({ title: tab.title, sessionId: tab.sessionId })),
    activeIndex: Math.max(0, tabs.findIndex(tab => tab.id === activeTabId)),
  }
}
