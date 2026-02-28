import { useEffect } from 'react'
import { useAppStore } from '../../stores/appStore'
import { EditorTabs } from './EditorTabs'
import { MarkdownViewer } from './MarkdownViewer'
import { FolderOpen, Sparkle } from '@phosphor-icons/react'

export function EditorArea() {
  const { activeFile, openFiles, fileContents, setFileContent } = useAppStore()

  useEffect(() => {
    if (activeFile && !fileContents.has(activeFile.path)) {
      loadFileContent(activeFile.path)
    }
  }, [activeFile?.path])

  async function loadFileContent(path: string) {
    const content = await window.electronAPI.readFile(path)
    if (content !== null) {
      setFileContent(path, content)
    }
  }

  if (openFiles.length === 0) {
    return <WelcomeScreen />
  }

  const content = activeFile ? fileContents.get(activeFile.path) || '' : ''

  return (
    <div className="h-full flex flex-col">
      <EditorTabs />
      <div className="flex-1 overflow-auto p-4">
        {activeFile && (
          activeFile.name.endsWith('.md') ? (
            <MarkdownViewer content={content} />
          ) : (
            <pre className="text-sm text-text-primary font-mono whitespace-pre-wrap">
              {content}
            </pre>
          )
        )}
      </div>
    </div>
  )
}

function WelcomeScreen() {
  const { currentCompany } = useAppStore()

  return (
    <div className="h-full flex flex-col items-center justify-center text-text-secondary">
      <FolderOpen size={64} className="mb-4 opacity-50" />
      <h2 className="text-xl mb-2">Welcome to {currentCompany?.name}</h2>
      <p className="text-sm mb-8">左のファイルツリーからファイルを選択してください</p>

      <div className="flex flex-col gap-3 text-sm">
        <div className="flex items-center gap-2 px-4 py-2 bg-accent/10 rounded-lg text-accent">
          <Sparkle size={20} />
          <span>AIエージェントに話しかけて作業を始めましょう</span>
        </div>
      </div>
    </div>
  )
}
