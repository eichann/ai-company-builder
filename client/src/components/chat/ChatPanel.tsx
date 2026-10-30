import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '../../stores/appStore'
import { useAuthStore } from '../../stores/authStore'
import { OpenConsultationContext } from './consultation-context'
import { OpenFileContext } from './review-context'
import { type SlashCommandItem } from './SlashCommandDropdown'
import { ChatSidebar } from './ChatSidebar'
import { ChatPanelChat } from './ChatConversation'
import { AuthSettings } from './ChatAuthSettings'
import { ChatAuthChecking, ChatSetupNeeded } from './ChatAuthGate'
import { AgentLogNotice } from './AgentLogNotice'
import { useChatServer } from './hooks/useChatServer'
import { useChatTabs } from './hooks/useChatTabs'
import { useAgentAuth } from './hooks/useAgentAuth'
import { getChatSession } from '../../features/chat/api'

// The chat panel: one company's conversations as tabs (all mounted, only the
// active one visible), the conversation list, and the agent settings overlay.
// Each tab is a ChatPanelChat (ChatConversation.tsx); state lives in hooks/.

interface ChatPanelProps {
  departmentPath?: string  // Working directory for AI (company root path)
  activeDepartment?: { name: string; folder: string }  // Currently selected department (undefined = company-wide)
  slashCommands?: SlashCommandItem[]
  /** Opens a company file (absolute path) in the editor: a review request's files (ReviewRequestCard). */
  onOpenFile?: (absolutePath: string) => void
}

export function ChatPanel(props: ChatPanelProps) {
  const userId = useAuthStore(s => s.user?.id)
  const companyId = useAppStore(s => s.currentCompany?.id)
  if (!userId || !companyId) return null
  return <CompanyChatPanel key={`${userId}:${companyId}`} userId={userId} {...props} />
}

function CompanyChatPanel({ userId, departmentPath, activeDepartment, slashCommands, onOpenFile }: ChatPanelProps & { userId: string }) {
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

  const { tabs, activeTabId, setActiveTabId, createNewTab, openSession, closeTab, tabCallbacks } = useChatTabs(currentCompany?.id, t('chat.newChat'))

  const openSettings = useCallback(() => setShowSettings(true), [])
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
        if (session) openSession(id)
        else window.alert("この相談は削除されたか、参照できません。")
      }).catch(() => window.alert("相談を開けませんでした。"))
    }}>
    <OpenFileContext.Provider value={onOpenFile}>
    <div ref={panelRef} className="h-full relative flex min-w-0">
      {sidebarOpen && <>
        {compact && <button aria-label="AIへの相談の一覧を閉じる" className="absolute inset-0 bg-black/20 z-20" onClick={() => setSidebarOpen(false)} />}
        <div className={compact ? 'absolute inset-y-0 left-0 z-30 shadow-xl' : 'shrink-0'}>
          <ChatSidebar companyId={currentCompany!.id} tabs={tabs} activeTabId={activeTabId}
            onSelectTab={id => { setActiveTabId(id); if (compact) setSidebarOpen(false) }}
            onOpenSession={id => { openSession(id); if (compact) setSidebarOpen(false) }}
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
              />
            </div>
          </div>
        ))}
      </div>

      {settingsOverlay}
      {/* Once per account on this PC: the AI action log goes to the administrators. */}
      {!showSettings && <AgentLogNotice userId={userId} />}
    </div>
    </OpenFileContext.Provider>
    </OpenConsultationContext.Provider>
  )
}
