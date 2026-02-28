import { useAppStore } from '../../stores/appStore'
import { Sidebar } from '../sidebar/Sidebar'
import { EditorArea } from '../editor/EditorArea'
import { ChatPanel } from '../chat/ChatPanel'
import { TitleBar } from './TitleBar'

export function MainLayout() {
  const { sidebarWidth, chatPanelWidth } = useAppStore()

  return (
    <div className="h-full flex flex-col bg-editor-bg">
      <TitleBar />
      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar - File Tree */}
        <div
          className="h-full bg-sidebar-bg border-r border-border flex-shrink-0"
          style={{ width: sidebarWidth }}
        >
          <Sidebar />
        </div>

        {/* Editor Area - Center */}
        <div className="flex-1 h-full overflow-hidden">
          <EditorArea />
        </div>

        {/* Chat Panel - Right */}
        <div
          className="h-full bg-sidebar-bg border-l border-border flex-shrink-0"
          style={{ width: chatPanelWidth }}
        >
          <ChatPanel />
        </div>
      </div>
    </div>
  )
}
