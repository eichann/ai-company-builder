import { useState, useEffect, useCallback, useRef } from 'react'
import {
  FloppyDisk,
  X,
  FileText,
  Warning
} from '@phosphor-icons/react'
import { CodeEditor } from './CodeEditor'
import { getFileIcon } from './FileIcons'

interface OpenFile {
  path: string
  content: string
  originalContent: string
  isLoading: boolean
}

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp'])

function isImageFile(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase() || ''
  return IMAGE_EXTENSIONS.has(ext)
}

interface TabbedEditorPanelProps {
  openFiles: string[]
  activeFilePath: string | null
  onSelectFile: (path: string) => void
  onCloseFile: (path: string) => void
}

export function TabbedEditorPanel({
  openFiles,
  activeFilePath,
  onSelectFile,
  onCloseFile,
}: TabbedEditorPanelProps) {
  const [fileContents, setFileContents] = useState<Map<string, OpenFile>>(new Map())
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const loadingRef = useRef<Set<string>>(new Set())

  const activeFile = activeFilePath ? fileContents.get(activeFilePath) : null
  const hasChanges = activeFile ? activeFile.content !== activeFile.originalContent : false

  // Ref to access latest fileContents inside onFileChange callback
  const fileContentsRef = useRef<Map<string, OpenFile>>(fileContents)
  fileContentsRef.current = fileContents

  // Reload open files when modified externally (e.g., by AI agent)
  useEffect(() => {
    const unsubscribe = window.electronAPI.onFileChange(async (data) => {
      if (data.type !== 'change') return
      const changedPath = data.path
      const file = fileContentsRef.current.get(changedPath)

      // Only reload if the file is open, not loading, and not an image
      if (!file || file.isLoading || isImageFile(changedPath)) return
      // Don't overwrite unsaved local edits
      if (file.content !== file.originalContent) return

      try {
        const newContent = await window.electronAPI.readFile(changedPath)
        if (newContent !== null && newContent !== file.originalContent) {
          setFileContents(prev => {
            const newMap = new Map(prev)
            newMap.set(changedPath, {
              path: changedPath,
              content: newContent,
              originalContent: newContent,
              isLoading: false,
            })
            return newMap
          })
        }
      } catch {
        // Silently ignore read errors during external change detection
      }
    })

    return () => unsubscribe()
  }, [])

  // Load file content when a new file is opened
  useEffect(() => {
    for (const filePath of openFiles) {
      if (!fileContents.has(filePath) && !loadingRef.current.has(filePath)) {
        // Skip loading for image files (displayed via file:// URL)
        if (isImageFile(filePath)) {
          setFileContents(prev => {
            const newMap = new Map(prev)
            newMap.set(filePath, { path: filePath, content: '', originalContent: '', isLoading: false })
            return newMap
          })
          continue
        }
        loadingRef.current.add(filePath)
        loadFile(filePath)
      }
    }

    // Clean up closed files from state
    const openFilesSet = new Set(openFiles)
    setFileContents(prev => {
      const newMap = new Map(prev)
      for (const path of newMap.keys()) {
        if (!openFilesSet.has(path)) {
          newMap.delete(path)
        }
      }
      return newMap
    })
  }, [openFiles])

  const loadFile = async (filePath: string) => {
    setFileContents(prev => {
      const newMap = new Map(prev)
      newMap.set(filePath, {
        path: filePath,
        content: '',
        originalContent: '',
        isLoading: true,
      })
      return newMap
    })

    try {
      const fileContent = await window.electronAPI.readFile(filePath)
      setFileContents(prev => {
        const newMap = new Map(prev)
        newMap.set(filePath, {
          path: filePath,
          content: fileContent || '',
          originalContent: fileContent || '',
          isLoading: false,
        })
        return newMap
      })
    } catch {
      setError('ファイルの読み込み中にエラーが発生しました')
    } finally {
      loadingRef.current.delete(filePath)
    }
  }

  const handleContentChange = useCallback((newContent: string) => {
    if (!activeFilePath) return
    setFileContents(prev => {
      const newMap = new Map(prev)
      const file = newMap.get(activeFilePath)
      if (file) {
        newMap.set(activeFilePath, {
          ...file,
          content: newContent,
        })
      }
      return newMap
    })
  }, [activeFilePath])

  const saveFile = useCallback(async (filePath: string, content: string) => {
    setIsSaving(true)
    setError(null)
    try {
      const success = await window.electronAPI.writeFile(filePath, content)
      if (success) {
        setFileContents(prev => {
          const newMap = new Map(prev)
          const f = newMap.get(filePath)
          if (f) {
            newMap.set(filePath, {
              ...f,
              originalContent: content,
            })
          }
          return newMap
        })
      } else {
        setError('保存に失敗しました')
      }
    } catch {
      setError('保存中にエラーが発生しました')
    } finally {
      setIsSaving(false)
    }
  }, [])

  // Auto save with debounce (1 second after last keystroke)
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!activeFilePath) return
    const file = fileContents.get(activeFilePath)
    if (!file || file.content === file.originalContent) return

    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current)
    }
    autoSaveTimerRef.current = setTimeout(() => {
      saveFile(activeFilePath, file.content)
    }, 1000)

    return () => {
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current)
      }
    }
  }, [activeFilePath, fileContents, saveFile])

  const handleSave = useCallback(async () => {
    if (!activeFilePath || !hasChanges) return
    // Cancel pending auto save and save immediately
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current)
    }
    const file = fileContents.get(activeFilePath)
    if (!file) return
    await saveFile(activeFilePath, file.content)
  }, [activeFilePath, hasChanges, fileContents, saveFile])

  // Keyboard shortcut for save
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        handleSave()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleSave])

  const handleCloseTab = async (e: React.MouseEvent, path: string) => {
    e.stopPropagation()
    const file = fileContents.get(path)
    if (file && file.content !== file.originalContent) {
      // Auto save before closing
      await saveFile(path, file.content)
    }
    onCloseFile(path)
  }

  const getFileName = (path: string) => path.split('/').pop() || ''

  if (openFiles.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center bg-gray-50 dark:bg-zinc-900/30 text-gray-400 dark:text-zinc-600">
        <FileText size={48} className="mb-4 opacity-50" />
        <p className="text-sm">ファイルを選択してください</p>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col bg-gray-50 dark:bg-zinc-900/30">
      {/* Tab Bar */}
      <div className="flex-shrink-0 flex items-center border-b border-gray-200 dark:border-zinc-800/50 bg-gray-100 dark:bg-zinc-900/50 overflow-x-auto">
        <div className="flex">
          {openFiles.map((filePath) => {
            const fileName = getFileName(filePath)
            const file = fileContents.get(filePath)
            const isActive = filePath === activeFilePath
            const isModified = file && file.content !== file.originalContent
            const FileIcon = getFileIcon(fileName, false)

            return (
              <div
                key={filePath}
                onClick={() => onSelectFile(filePath)}
                className={`
                  group flex items-center gap-2 px-3 py-2 cursor-pointer
                  border-r border-gray-200 dark:border-zinc-800/50 min-w-0 max-w-[200px]
                  ${isActive
                    ? 'bg-white dark:bg-zinc-900/80 text-gray-800 dark:text-zinc-200'
                    : 'bg-gray-50 dark:bg-zinc-900/30 text-gray-500 dark:text-zinc-500 hover:text-gray-700 dark:hover:text-zinc-300 hover:bg-gray-100 dark:hover:bg-zinc-900/50'
                  }
                `}
              >
                <FileIcon size={14} className="flex-shrink-0" />
                <span className="text-xs truncate">{fileName}</span>
                {isModified && (
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-400 flex-shrink-0" />
                )}
                <button
                  onClick={(e) => handleCloseTab(e, filePath)}
                  className={`
                    p-0.5 rounded hover:bg-white/10 flex-shrink-0
                    ${isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}
                  `}
                >
                  <X size={12} />
                </button>
              </div>
            )
          })}
        </div>

        {/* Save button in tab bar (hidden for image files) */}
        {activeFilePath && !isImageFile(activeFilePath) && (
          <div className="ml-auto px-2 flex items-center gap-1">
            <button
              onClick={handleSave}
              disabled={!hasChanges || isSaving}
              className={`
                flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium
                transition-colors
                ${hasChanges
                  ? 'bg-accent text-white hover:bg-accent/90'
                  : 'bg-gray-200 dark:bg-zinc-800 text-gray-400 dark:text-zinc-500 cursor-not-allowed'
                }
              `}
            >
              <FloppyDisk size={12} />
              {isSaving ? '保存中...' : '保存'}
            </button>
          </div>
        )}
      </div>

      {/* Error message */}
      {error && (
        <div className="flex items-center gap-2 px-4 py-2 bg-red-500/10 border-b border-red-500/20 text-red-400 text-xs">
          <Warning size={14} />
          {error}
          <button
            onClick={() => setError(null)}
            className="ml-auto hover:text-red-300"
          >
            <X size={12} />
          </button>
        </div>
      )}

      {/* Editor / Image Preview */}
      <div className="flex-1 overflow-hidden min-w-0">
        {activeFile?.isLoading ? (
          <div className="h-full flex items-center justify-center text-gray-400 dark:text-zinc-500">
            読み込み中...
          </div>
        ) : activeFile && activeFilePath && isImageFile(activeFilePath) ? (
          <div className="h-full flex items-center justify-center overflow-auto p-4 bg-[repeating-conic-gradient(#e5e5e5_0%_25%,#fff_0%_50%)] dark:bg-[repeating-conic-gradient(#333_0%_25%,#222_0%_50%)] bg-[length:16px_16px]">
            <img
              src={`local-file://${activeFilePath}`}
              alt={getFileName(activeFilePath)}
              className="max-w-full max-h-full object-contain"
            />
          </div>
        ) : activeFile ? (
          <CodeEditor
            key={activeFilePath} // Force remount on file change
            value={activeFile.content}
            onChange={handleContentChange}
            fileName={getFileName(activeFilePath || '')}
          />
        ) : null}
      </div>

      {/* Footer hint */}
      <div className="flex-shrink-0 px-4 py-1.5 border-t border-gray-200 dark:border-zinc-800/50 bg-gray-100 dark:bg-zinc-900/50">
        <span className="text-[10px] text-gray-400 dark:text-zinc-600">
          自動保存 {hasChanges ? '(未保存の変更あり)' : ''}
        </span>
      </div>
    </div>
  )
}
