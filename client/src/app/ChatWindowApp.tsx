import { useCallback, useEffect, useState } from 'react'
import { SpinnerGap } from '@phosphor-icons/react'
import type { ChatWindowContext } from '../../shared/chat-windows'
import { useAppStore } from '../stores/appStore'
import { ChatPanelChat } from '../components/chat/ChatConversation'
import { AuthSettings } from '../components/chat/ChatAuthSettings'
import { ChatAuthChecking, ChatSetupNeeded } from '../components/chat/ChatAuthGate'
import { useChatServer } from '../components/chat/hooks/useChatServer'
import { useAgentAuth } from '../components/chat/hooks/useAgentAuth'
import { useConsultationStatuses } from '../components/chat/consultationStatusStore'
import { useChatWindowSelf } from '../features/chat/hooks/useChatWindowSelf'
import { useReportWindowStatus } from '../features/chat/hooks/useReportWindowStatus'

// A consultation's own window (「別ウィンドウで開く」, `?window=chat`): only
// the chat of the one consultation main assigned to this window — header,
// messages, composer, cards — no file tree or editor. The main window keeps
// the list, the company and the session; this page only shows and continues
// the conversation.

const TAB_ID = 'window'

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="h-full bg-white dark:bg-zinc-900 flex items-center justify-center p-6 text-sm text-gray-600 dark:text-zinc-300">{children}</div>
}

export function ChatWindowApp() {
  const theme = useAppStore(s => s.theme)
  useEffect(() => { document.documentElement.classList.toggle('dark', theme === 'dark') }, [theme])
  const self = useChatWindowSelf()
  if (self.kind === 'loading') return <Centered><SpinnerGap size={32} className="animate-spin text-accent" /></Centered>
  if (self.kind === 'missing') return <Centered><p role="alert">{self.message}</p></Centered>
  return <ChatWindowChat context={self.context} />
}

function ChatWindowChat({ context }: { context: ChatWindowContext }) {
  // The chat reads the company from the store (its folder for the AI, the history file).
  const [companyReady, setCompanyReady] = useState(false)
  useEffect(() => {
    useAppStore.setState({ currentCompany: { id: context.companyId, name: context.companyName, rootPath: context.rootPath, departments: [], createdAt: new Date() } })
    setCompanyReady(true)
  }, [context])

  const chatServer = useChatServer()
  const auth = useAgentAuth()
  const [showSettings, setShowSettings] = useState(false)
  const openSettings = useCallback(() => setShowSettings(true), [])
  const noop = useCallback(() => {}, [])
  const onTitleChange = useCallback((title: string) => { document.title = title }, [])
  useEffect(() => { if (context.title) document.title = context.title }, [context.title])

  useReportWindowStatus(useConsultationStatuses().get(TAB_ID))

  if (!companyReady || auth.isChecking || !chatServer) return <ChatAuthChecking />
  const settingsOverlay = showSettings && (
    <div role="dialog" aria-label="相談の設定" className="absolute inset-0 z-10">
      <AuthSettings authMode={auth.authMode} claudeCodeAvailable={auth.claudeCodeAvailable} claudeCodeError={auth.claudeCodeError}
        onClose={() => { setShowSettings(false); auth.recheck() }} />
    </div>
  )
  return (
    <div className="h-full relative bg-white dark:bg-zinc-900">
      <div className={showSettings ? 'h-full invisible' : 'h-full'}>
        {auth.isReady
          ? <ChatPanelChat
              tabId={TAB_ID}
              isActive
              standalone
              departmentPath={context.rootPath}
              activeDepartment={context.department}
              chatServer={chatServer}
              authMode={auth.authMode}
              codexStatus={auth.codexStatus}
              slashCommands={context.slashCommands}
              onShowSettings={openSettings}
              onTitleChange={onTitleChange}
              onToggleSidebar={noop}
              sidebarOpen={false}
              initialSessionId={context.sessionId}
            />
          : <ChatSetupNeeded claudeCodeAvailable={auth.claudeCodeAvailable} claudeCodeError={auth.claudeCodeError} onOpenSettings={openSettings} />}
      </div>
      {settingsOverlay}
    </div>
  )
}
