import { useCallback, useEffect, useRef, useState } from 'react'
import { chatTabsStorageId, newChatTab, persistedChatTabs, restoreChatTabs, safeReadChatTabs, safeWriteChatTabs, type ChatTab } from '../chatTabsStorage'
import { onChatHistoryChanged } from '../api'
import { useIpcEvent } from '../../../shared/hooks/useIpcEvent'

/**
 * The open chat tabs of a company in one chat pane: restored from
 * localStorage, remembered on every change, a conversation deleted anywhere
 * closes its tab. Every tab stays mounted (streams, drafts and questions keep
 * running). The panel is keyed by company, so `companyId` never changes here.
 *
 * `tabsRef` mirrors `tabs` for callbacks that must stay stable; per-tab
 * callbacks (`tabCallbacks`) are cached by tab id so a memoised chat whose own
 * props did not change does not re-render when another tab's title changes.
 */
export function useChatTabs(companyId: string, paneId: string, newChatTitle: string) {
  const storageId = chatTabsStorageId(companyId, paneId)
  // Synchronously hydrate the tab list from localStorage during the first
  // render so multi-tab users see the right tab count immediately — no
  // 1-tab→N-tab flicker. Uses a ref so tabs and activeTabId share the same
  // freshly-generated UUIDs (the persisted entry only stores titles + session ids).
  const initialChatStateRef = useRef<{ tabs: ChatTab[]; activeTabId: string } | null>(null)
  if (initialChatStateRef.current === null) {
    initialChatStateRef.current = restoreChatTabs(safeReadChatTabs(storageId), newChatTitle)
  }

  // Tab management state
  const [tabs, setTabs] = useState<ChatTab[]>(initialChatStateRef.current.tabs)
  const [activeTabId, setActiveTabId] = useState<string>(initialChatStateRef.current.activeTabId)
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs

  const createNewTab = useCallback(() => {
    const newTab = newChatTab(newChatTitle)
    setTabs(prev => [...prev, newTab])
    setActiveTabId(newTab.id)
  }, [newChatTitle])

  /** `activate: false` adds it behind the shown one (a consultation back from its own window). */
  const openSession = useCallback((sessionId: string, { activate = true }: { activate?: boolean } = {}) => {
    const existing = tabsRef.current.find(tab => tab.sessionId === sessionId)
    if (existing) { if (activate) setActiveTabId(existing.id); return }
    const tab = newChatTab(newChatTitle, sessionId)
    tabsRef.current = [...tabsRef.current, tab]
    setTabs(tabsRef.current)
    if (activate) setActiveTabId(tab.id)
  }, [newChatTitle])

  /**
   * The consultation leaves this window (「別ウィンドウで開く」): its tab goes
   * (unmounting saves it), the next one shows, or a new one when it was the last.
   */
  const detachSession = useCallback((sessionId: string) => {
    const prev = tabsRef.current
    const index = prev.findIndex(tab => tab.sessionId === sessionId)
    if (index === -1) return
    const next = prev.filter((_, i) => i !== index)
    if (!next.length) next.push(newChatTab(newChatTitle))
    tabsRef.current = next
    setTabs(next)
    setActiveTabId(current => next.some(tab => tab.id === current) ? current : next[Math.min(index, next.length - 1)].id)
  }, [newChatTitle])

  useIpcEvent(onChatHistoryChanged, ({ companyId: changedCompanyId, deletedSessionId }) => {
    if (changedCompanyId !== companyId || !deletedSessionId) return
    const remaining = tabsRef.current.filter(tab => tab.sessionId !== deletedSessionId)
    if (remaining.length === tabsRef.current.length) return
    if (!remaining.length) remaining.push(newChatTab(newChatTitle))
    tabsRef.current = remaining
    setTabs(remaining)
    setActiveTabId(id => remaining.some(tab => tab.id === id) ? id : remaining[0].id)
  })

  const closeTab = useCallback((closingTabId: string) => {
    const prev = tabsRef.current
    if (prev.length <= 1) return
    const closedIndex = prev.findIndex(tab => tab.id === closingTabId)
    const newTabs = prev.filter(tab => tab.id !== closingTabId)
    tabsRef.current = newTabs
    setTabs(newTabs)
    setActiveTabId(current => {
      if (closingTabId !== current) return current
      const newActive = newTabs[Math.min(closedIndex, newTabs.length - 1)]
      return newActive.id
    })
  }, [])

  const updateTabTitle = useCallback((targetTabId: string, title: string) => {
    // Same title → same array: no re-render of the tab bar, sidebar or chats.
    setTabs(prev => prev.some(tab => tab.id === targetTabId && tab.title !== title)
      ? prev.map(tab => tab.id === targetTabId ? { ...tab, title } : tab)
      : prev)
  }, [])

  const updateTabSessionId = useCallback((targetTabId: string, sessionId: string | null) => {
    setTabs(prev => {
      const idx = prev.findIndex(tab => tab.id === targetTabId)
      if (idx === -1 || prev[idx].sessionId === sessionId) return prev
      const next = prev.slice()
      next[idx] = { ...next[idx], sessionId }
      return next
    })
  }, [])

  // Stable props for the memoised chats: a tab whose own props did not change
  // (another tab's title, the active tab switching elsewhere) does not re-render.
  const tabCallbacksRef = useRef(new Map<string, { title: (title: string) => void; sessionId: (sessionId: string | null) => void; close: () => void }>())
  const tabCallbacks = (tabId: string) => {
    let callbacks = tabCallbacksRef.current.get(tabId)
    if (!callbacks) {
      callbacks = { title: title => updateTabTitle(tabId, title), sessionId: sessionId => updateTabSessionId(tabId, sessionId), close: () => closeTab(tabId) }
      tabCallbacksRef.current.set(tabId, callbacks)
    }
    return callbacks
  }

  // Remember the tab list whenever it changes.
  useEffect(() => {
    safeWriteChatTabs(storageId, persistedChatTabs(tabs, activeTabId))
  }, [storageId, tabs, activeTabId])

  return { tabs, activeTabId, setActiveTabId, createNewTab, openSession, detachSession, closeTab, tabCallbacks }
}
