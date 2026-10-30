import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '../../stores/appStore'
import { useAuthStore } from '../../stores/authStore'
import { OpenConsultationContext } from './consultation-context'
import { type SlashCommandItem } from './SlashCommandDropdown'
import { ChatSidebar } from './ChatSidebar'
import { ChatPanelChat, type ChatInputRequest } from './ChatConversation'
import { AuthSettings } from './ChatAuthSettings'
import { ChatAuthChecking, ChatSetupNeeded } from './ChatAuthGate'
import { AgentLogNotice } from './AgentLogNotice'
import { useChatServer } from './hooks/useChatServer'
import { useChatTabs } from './hooks/useChatTabs'
import { useAgentAuth } from './hooks/useAgentAuth'
import { getChatSession } from '../../features/chat/api'
import { useChatWindows } from '../../features/chat/hooks/useChatWindows'
import { useMoveToWindow } from '../../features/chat/hooks/useMoveToWindow'
import { consultationStatusOf } from './consultationStatusStore'
import { commandArea, useCommandHandler } from '../../shared/commands/commands'

// The chat panel: one company's conversations as tabs (all mounted, only the
// active one visible), the conversation list, and the agent settings overlay.
// Each tab is a ChatPanelChat (ChatConversation.tsx); state lives in hooks/.

interface ChatPanelProps {
  departmentPath?: string  // Working directory for AI (company root path)
  activeDepartment?: { name: string; folder: string }  // Currently selected department (undefined = company-wide)
  slashCommands?: SlashCommandItem[]
  /** This pane's id (the layout tree's leaf): what chat commands name in `pane`. */
  paneId?: string
}

export function ChatPanel(props: ChatPanelProps) {
  const userId = useAuthStore(s => s.user?.id)
  const companyId = useAppStore(s => s.currentCompany?.id)
  if (!userId || !companyId) return null
  return <CompanyChatPanel key={`${userId}:${companyId}`} userId={userId} {...props} />
}

function CompanyChatPanel({ userId, departmentPath, activeDepartment, slashCommands, paneId = 'chat' }: ChatPanelProps & { userId: string }) {
  const { t } = useTranslation()
  const chatServer = useChatServer()
  const currentCompany = useAppStore((s) => s.currentCompany)

  const panelRef = useRef<HTMLDivElement>(null)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [compact, setCompact] = useState(false)
  const [showSettings, setShowSettings] = useState(false)

  const auth = useAgentAuth()
  const { isReady, isChecking, authMode, codexStatus } = auth
  useEffect(() => {
    const panel = panelRef.current
    if (!panel) return
    const observer = new ResizeObserver(([entry]) => setCompact(entry.contentRect.width < 680))
    observer.observe(panel)
    return () => observer.disconnect()
  }, [isChecking, isReady, chatServer])

  const { tabs, activeTabId, setActiveTabId, createNewTab, openSession, detachSession, closeTab, tabCallbacks } = useChatTabs(currentCompany?.id, t('chat.newChat'))

  // 「別ウィンドウで開く」: consultations other windows show, and moving one there.
  // One that comes back (its window closed) is listed here again as an open tab.
  const companyId = currentCompany?.id ?? ''
  const returnFromWindow = useCallback((sessionId: string) => {
    void getChatSession(companyId, sessionId).then(session => { if (session) openSession(sessionId, { activate: false }) }).catch(() => {})
  }, [companyId, openSession])
  const chatWindows = useChatWindows(companyId, returnFromWindow)
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs
  const moveToWindow = useMoveToWindow({
    company: currentCompany ? { id: currentCompany.id, name: currentCompany.name, rootPath: currentCompany.rootPath } : null,
    department: activeDepartment,
    slashCommands,
    windows: chatWindows,
    tabOf: sessionId => {
      const tab = tabsRef.current.find(candidate => candidate.sessionId === sessionId)
      return tab && { id: tab.id, status: consultationStatusOf(tab.id) }
    },
    detach: detachSession,
    reopen: sessionId => openSession(sessionId, { activate: false }),
  })
  useCommandHandler('chat.openInWindow', ({ sessionId }) => moveToWindow(sessionId), { target: paneId })
  // A consultation another window shows is brought to the front there, never opened here too.
  const openOrFocus = useCallback((sessionId: string) => {
    if (chatWindows.has(sessionId)) void moveToWindow(sessionId)
    else openSession(sessionId)
  }, [chatWindows, moveToWindow, openSession])

  // chat.newConsultation / chat.insertText for this pane wait here until the active tab can take them.
  const [inputRequest, setInputRequest] = useState<ChatInputRequest | null>(null)
  useCommandHandler('chat.newConsultation', ({ message }) => setInputRequest({ kind: 'newConsultation', message }), { target: paneId })
  useCommandHandler('chat.insertText', ({ text }) => setInputRequest({ kind: 'insertText', text }), { target: paneId })
  const consumeInputRequest = useCallback(() => setInputRequest(null), [])

  const openSettings = useCallback(() => setShowSettings(true), [])
  const openInWindow = useCallback((sessionId: string) => { void moveToWindow(sessionId) }, [moveToWindow])
  const toggleSidebar = useCallback(() => setSidebarOpen(open => !open), [])
  // The layout passes a new object on every render; only its value matters.
  const departmentName = activeDepartment?.name
  const departmentFolder = activeDepartment?.folder
  const stableDepartment = useMemo(
    () => departmentName === undefined && departmentFolder === undefined ? undefined : { name: departmentName ?? '', folder: departmentFolder ?? '' },
    [departmentName, departmentFolder],
  )

  if (isChecking || !chatServer) return <ChatAuthChecking />

  // The agent settings, over the conversations or over the setup screen.
  const settingsOverlay = showSettings && (
    <div role="dialog" aria-label="相談の設定" className="absolute inset-0 z-10">
      <AuthSettings
        authMode={authMode}
        claudeCodeAvailable={auth.claudeCodeAvailable}
        claudeCodeError={auth.claudeCodeError}
        onClose={() => {
          setShowSettings(false)
          auth.recheck()
        }}
      />
    </div>
  )

  if (!isReady) {
    return (
      <div className="h-full relative">
        <div className={showSettings ? 'h-full invisible' : 'h-full'}>
          <ChatSetupNeeded claudeCodeAvailable={auth.claudeCodeAvailable} claudeCodeError={auth.claudeCodeError} onOpenSettings={openSettings} />
        </div>
        {settingsOverlay}
      </div>
    )
  }

  return (
    <OpenConsultationContext.Provider value={id => {
      if (!currentCompany) return
      void getChatSession(currentCompany.id, id).then(session => {
        if (session) openOrFocus(id)
        else window.alert("この相談は削除されたか、参照できません。")
      }).catch(() => window.alert("相談を開けませんでした。"))
    }}>
    <div ref={panelRef} className="h-full relative flex min-w-0" {...commandArea('chat', paneId)}>
      {sidebarOpen && <>
        {compact && <button aria-label="AIへの相談の一覧を閉じる" className="absolute inset-0 bg-black/20 z-20" onClick={() => setSidebarOpen(false)} />}
        <div className={compact ? 'absolute inset-y-0 left-0 z-30 shadow-xl' : 'shrink-0'}>
          <ChatSidebar companyId={currentCompany!.id} tabs={tabs} activeTabId={activeTabId}
            windows={chatWindows} onOpenInWindow={id => void moveToWindow(id)}
            onSelectTab={id => { setActiveTabId(id); if (compact) setSidebarOpen(false) }}
            onOpenSession={id => { openOrFocus(id); if (compact) setSidebarOpen(false) }}
            onCloseTab={closeTab} onNew={() => { createNewTab(); if (compact) setSidebarOpen(false) }}
            onHide={() => setSidebarOpen(false)} />
        </div>
      </>}

      {/* Chat instances (all mounted, only active visible) */}
      <div className="flex-1 min-h-0 min-w-0 relative">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            // Hidden tabs stay mounted (streams, drafts, questions keep running)
            // but skip style, layout and paint entirely.
            className={`absolute inset-0 ${tab.id === activeTabId ? '' : 'invisible pointer-events-none [content-visibility:hidden]'}`}
          >
            <div className={showSettings && tab.id === activeTabId ? 'h-full invisible' : 'h-full'}>
              <ChatPanelChat
                tabId={tab.id}
                isActive={tab.id === activeTabId}
                departmentPath={departmentPath}
                activeDepartment={stableDepartment}
                chatServer={chatServer}
                authMode={authMode}
                codexStatus={codexStatus}
                slashCommands={slashCommands}
                onShowSettings={openSettings}
                onTitleChange={tabCallbacks(tab.id).title}
                onNewTab={createNewTab}
                onToggleSidebar={toggleSidebar}
                sidebarOpen={sidebarOpen}
                initialSessionId={tab.sessionId}
                onSessionIdChange={tabCallbacks(tab.id).sessionId}
                onLeftBlank={tabCallbacks(tab.id).close}
                inputRequest={tab.id === activeTabId ? inputRequest : null}
                onInputRequestConsumed={consumeInputRequest}
                onOpenInWindow={openInWindow}
              />
            </div>
          </div>
        ))}
      </div>

      {settingsOverlay}
      {/* Once per account on this PC: the AI action log goes to the administrators. */}
      {!showSettings && <AgentLogNotice userId={userId} />}
    </div>
    </OpenConsultationContext.Provider>
  )
}
