import { useAppStore } from '../../stores/appStore'
import { X, File, Robot } from '@phosphor-icons/react'

export function EditorTabs() {
  const { openFiles, activeFile, setActiveFile, closeFile } = useAppStore()

  return (
    <div className="flex bg-activitybar-bg border-b border-border overflow-x-auto">
      {openFiles.map((file) => {
        const isActive = activeFile?.path === file.path
        const isAgentFile = file.name === 'AGENT.md'

        return (
          <div
            key={file.path}
            className={`flex items-center gap-2 px-3 py-2 text-sm cursor-pointer border-r border-border group ${
              isActive
                ? 'bg-editor-bg text-text-primary'
                : 'bg-activitybar-bg text-text-secondary hover:bg-sidebar-bg'
            }`}
            onClick={() => setActiveFile(file)}
          >
            {isAgentFile ? (
              <Robot size={14} className="text-purple-400" />
            ) : (
              <File size={14} />
            )}
            <span className={isAgentFile ? 'text-purple-400' : ''}>
              {file.name}
            </span>
            <button
              className="opacity-0 group-hover:opacity-100 hover:bg-white/10 rounded p-0.5"
              onClick={(e) => {
                e.stopPropagation()
                closeFile(file.path)
              }}
            >
              <X size={12} />
            </button>
          </div>
        )
      })}
    </div>
  )
}
