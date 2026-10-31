import { useCallback, useEffect, useState } from 'react'
import { SpinnerGap } from '@phosphor-icons/react'
import type { ChatWindowContext } from '../../shared/chat-windows'
import { useAppStore } from '../stores/appStore'
import { ChatPanelChat } from '../features/chat/components/ChatConversation'
import { AuthSettings } from '../features/chat/components/ChatAuthSettings'
import { ChatAuthChecking, ChatSetupNeeded } from '../features/chat/components/ChatAuthGate'
import { useChatServer } from '../features/chat/hooks/useChatServer'
import { useAgentAuth } from '../features/chat/hooks/useAgentAuth'
import { useConsultationStatuses } from '../features/chat/consultationStatusStore'
import { useChatWindowSelf } from '../features/chat/hooks/useChatWindowSelf'
import { useReportWindowStatus } from '../features/chat/hooks/useReportWindowStatus'
import { useOpenFileInMainWindow } from '../features/chat/hooks/useOpenFileInMainWindow'

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
  const chatServer = useChatServer()
  const auth = useAgentAuth()
  const [showSettings, setShowSettings] = useState(false)
  const openSettings = useCallback(() => setShowSettings(true), [])
  const noop = useCallback(() => {}, [])
  const onTitleChange = useCallback((title: string) => { document.title = title }, [])
  useEffect(() => { if (context.title) document.title = context.title }, [context.title])

  useReportWindowStatus(useConsultationStatuses().get(TAB_ID))
  // File links (a review request's files) open in the main window's editor.
  const fileNotice = useOpenFileInMainWindow()

  if (auth.isChecking || !chatServer) return <ChatAuthChecking />
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
              isShown
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
      {fileNotice.notice && (
        <div role="alert" className="absolute inset-x-3 bottom-3 z-20 flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-50 px-3 py-2 text-xs text-amber-900 shadow dark:bg-zinc-800 dark:text-amber-200">
          <span className="flex-1">{fileNotice.notice}</span>
          <button type="button" onClick={fileNotice.dismiss} className="shrink-0 rounded px-1 hover:bg-amber-500/10">閉じる</button>
        </div>
      )}
    </div>
  )
}
