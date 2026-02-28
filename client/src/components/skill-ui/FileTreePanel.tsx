import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  CaretRight,
  ArrowClockwise,
  Eye,
  EyeSlash,
  FilePlus,
  FolderPlus,
  PencilSimple,
  Trash,
  Copy,
  SpinnerGap,
} from '@phosphor-icons/react'
import { ContextMenu, type ContextMenuItem } from '../common/ContextMenu'
import { InputDialog } from '../common/InputDialog'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { getFileIcon, FolderIcon } from './FileIcons'
import { isPerfCutEnabled, perfMark, perfMeasure } from '../../lib/perfDiagnostics'
import { isChatInputRecentlyActive } from '../../lib/chatInputActivity'

interface FileEntry {
  name: string
  path: string
  isDirectory: boolean
  children?: FileEntry[]
}

interface FileTreePanelProps {
  rootPath: string
  departmentFolder: string
  selectedFilePath: string | null
  onSelectFile: (path: string) => void
  onCreateFile?: () => void
}

export function FileTreePanel({
  rootPath,
  departmentFolder,
  selectedFilePath,
  onSelectFile,
}: FileTreePanelProps) {
  const { t } = useTranslation()
  const [files, setFiles] = useState<FileEntry[]>([])
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set())
  const [loadedDirs, setLoadedDirs] = useState<Set<string>>(new Set())
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set())
  const [isLoading, setIsLoading] = useState(false)
  const [showDotFiles, setShowDotFiles] = useState(true)

  // Ref to track current expanded dirs without triggering re-renders of loadFiles
  const expandedDirsRef = useRef<Set<string>>(expandedDirs)
  expandedDirsRef.current = expandedDirs

  // Cache for loaded children
  const childrenCache = useRef<Map<string, FileEntry[]>>(new Map())
  const pendingReloadRef = useRef(false)
  const deferredReloadTimerRef = useRef<number | null>(null)

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{
    position: { x: number; y: number }
    entry: FileEntry | null
    parentPath: string
  } | null>(null)

  // Dialog state
  const [inputDialog, setInputDialog] = useState<{
    isOpen: boolean
    title: string
    defaultValue: string
    mode: 'newFile' | 'newFolder' | 'rename'
    targetPath: string
    parentPath: string
  }>({
    isOpen: false,
    title: '',
    defaultValue: '',
    mode: 'newFile',
    targetPath: '',
    parentPath: '',
  })

  const [confirmDialog, setConfirmDialog] = useState<{
    isOpen: boolean
    title: string
    message: string
    targetPath: string
  }>({
    isOpen: false,
    title: '',
    message: '',
    targetPath: '',
  })

  const departmentPath = `${rootPath}/${departmentFolder}`

  // Load single directory (non-recursive)
  const loadSingleDirectory = useCallback(async (dirPath: string, includeDotFiles: boolean): Promise<FileEntry[]> => {
    try {
      const entries = await window.electronAPI.readDirectory(dirPath)
      const result: FileEntry[] = []

      for (const entry of entries) {
        // Skip node_modules and .DS_Store always
        if (entry.name === 'node_modules' || entry.name === '.DS_Store') continue

        // Skip hidden files unless showDotFiles is enabled
        if (entry.name.startsWith('.') && !includeDotFiles) continue

        const fileEntry: FileEntry = {
          name: entry.name,
          path: entry.path,
          isDirectory: entry.isDirectory,
          // Don't load children yet - lazy loading
          children: entry.isDirectory ? undefined : undefined,
        }

        result.push(fileEntry)
      }

      // Sort: directories first, then files, alphabetically
      return result.sort((a, b) => {
        if (a.isDirectory && !b.isDirectory) return -1
        if (!a.isDirectory && b.isDirectory) return 1
        return a.name.localeCompare(b.name)
      })
    } catch {
      return []
    }
  }, [])

  // Load children for a specific directory (lazy loading)
  const loadChildren = useCallback(async (dirPath: string): Promise<FileEntry[]> => {
    // Check cache first
    const cached = childrenCache.current.get(dirPath)
    if (cached && loadedDirs.has(dirPath)) {
      return cached
    }

    setLoadingDirs(prev => new Set(prev).add(dirPath))

    try {
      const children = await loadSingleDirectory(dirPath, showDotFiles)
      childrenCache.current.set(dirPath, children)
      setLoadedDirs(prev => new Set(prev).add(dirPath))
      return children
    } finally {
      setLoadingDirs(prev => {
        const next = new Set(prev)
        next.delete(dirPath)
        return next
      })
    }
  }, [loadSingleDirectory, showDotFiles, loadedDirs])

  // Initial load - just the first level
  const loadFiles = useCallback(async (preserveExpandedState = false) => {
    perfMark('file_tree_panel.load_files.start')
    const startedAt = performance.now()
    setIsLoading(true)

    // Save current expanded dirs before clearing cache
    const previousExpandedDirs = preserveExpandedState ? new Set(expandedDirsRef.current) : null

    // Clear caches when reloading
    childrenCache.current.clear()
    setLoadedDirs(new Set())

    try {
      const entries = await loadSingleDirectory(departmentPath, showDotFiles)
      setFiles(entries)

      if (previousExpandedDirs && previousExpandedDirs.size > 0) {
        // Refresh mode: preserve expanded state and reload expanded directories
        setExpandedDirs(previousExpandedDirs)
        for (const dirPath of previousExpandedDirs) {
          try {
            const children = await loadSingleDirectory(dirPath, showDotFiles)
            childrenCache.current.set(dirPath, children)
            setLoadedDirs(prev => new Set(prev).add(dirPath))
          } catch {
            // Directory may have been deleted; remove from expanded
            setExpandedDirs(prev => {
              const next = new Set(prev)
              next.delete(dirPath)
              return next
            })
          }
        }
      } else {
        // Initial load: auto-expand first level directories
        const firstLevelDirs = entries.filter(e => e.isDirectory).map(e => e.path)
        setExpandedDirs(new Set(firstLevelDirs))

        // Pre-load children of first level directories
        for (const dirPath of firstLevelDirs) {
          const children = await loadSingleDirectory(dirPath, showDotFiles)
          childrenCache.current.set(dirPath, children)
          setLoadedDirs(prev => new Set(prev).add(dirPath))
        }
      }
    } finally {
      perfMeasure('file_tree_panel.load_files.ms', performance.now() - startedAt)
      setIsLoading(false)
    }
  }, [departmentPath, loadSingleDirectory, showDotFiles])

  const requestDeferredReload = useCallback(() => {
    pendingReloadRef.current = true
    if (deferredReloadTimerRef.current != null) return

    const run = () => {
      if (!pendingReloadRef.current) {
        deferredReloadTimerRef.current = null
        return
      }

      if (isChatInputRecentlyActive()) {
        perfMark('file_tree_panel.load_files.deferred_for_chat_input')
        deferredReloadTimerRef.current = window.setTimeout(run, 250)
        return
      }

      pendingReloadRef.current = false
      deferredReloadTimerRef.current = null
      void loadFiles(true)
    }

    deferredReloadTimerRef.current = window.setTimeout(run, 120)
  }, [loadFiles])

  useEffect(() => {
    return () => {
      if (deferredReloadTimerRef.current != null) {
        window.clearTimeout(deferredReloadTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    loadFiles()
  }, [loadFiles])

  // File watching
  useEffect(() => {
    if (!departmentPath) return

    if (isPerfCutEnabled('disableWatchers')) {
      perfMark('file_tree_panel.watch.disabled')
      return
    }

    perfMark('file_tree_panel.watch.start')
    window.electronAPI.watchDirectory(departmentPath)

    const unsubscribe = window.electronAPI.onFileChange((data) => {
      perfMark('file_tree_panel.fs_change')
      if (isPerfCutEnabled('fsEvents')) {
        perfMark('file_tree_panel.fs_change.skipped')
        return
      }
      if (!data.path.startsWith(departmentPath)) {
        return
      }

      // Coalesce fs updates and defer heavy tree reload while user is typing in chat.
      requestDeferredReload()
    })

    return () => {
      unsubscribe()
      window.electronAPI.unwatchDirectory(departmentPath)
      perfMark('file_tree_panel.watch.stop')
    }
  }, [departmentPath, requestDeferredReload])

  // Toggle directory expansion with lazy loading
  const toggleDir = useCallback(async (path: string) => {
    const isCurrentlyExpanded = expandedDirs.has(path)

    if (isCurrentlyExpanded) {
      // Collapse
      setExpandedDirs(prev => {
        const next = new Set(prev)
        next.delete(path)
        return next
      })
    } else {
      // Expand - load children if not loaded
      if (!loadedDirs.has(path)) {
        await loadChildren(path)
      }
      setExpandedDirs(prev => new Set(prev).add(path))
    }
  }, [expandedDirs, loadedDirs, loadChildren])

  const renderFileIcon = (name: string, isDirectory: boolean, isExpanded: boolean) => {
    if (isDirectory) {
      return <FolderIcon size={16} isOpen={isExpanded} className="flex-shrink-0" />
    }
    const IconComponent = getFileIcon(name, false)
    return <IconComponent size={16} className="flex-shrink-0" />
  }

  // Context menu handlers
  const handleContextMenu = useCallback((e: React.MouseEvent, entry: FileEntry | null, parentPath: string) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({
      position: { x: e.clientX, y: e.clientY },
      entry,
      parentPath,
    })
  }, [])

  const closeContextMenu = useCallback(() => {
    setContextMenu(null)
  }, [])

  const handleBackgroundContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setContextMenu({
      position: { x: e.clientX, y: e.clientY },
      entry: null,
      parentPath: departmentPath,
    })
  }, [departmentPath])

  // File operations
  const handleNewFile = useCallback((parentPath: string) => {
    setInputDialog({
      isOpen: true,
      title: t('fileTree.newFile'),
      defaultValue: '',
      mode: 'newFile',
      targetPath: '',
      parentPath,
    })
    closeContextMenu()
  }, [closeContextMenu, t])

  const handleNewFolder = useCallback((parentPath: string) => {
    setInputDialog({
      isOpen: true,
      title: t('fileTree.newFolder'),
      defaultValue: '',
      mode: 'newFolder',
      targetPath: '',
      parentPath,
    })
    closeContextMenu()
  }, [closeContextMenu, t])

  const handleRename = useCallback((entry: FileEntry) => {
    setInputDialog({
      isOpen: true,
      title: t('fileTree.rename'),
      defaultValue: entry.name,
      mode: 'rename',
      targetPath: entry.path,
      parentPath: entry.path.substring(0, entry.path.lastIndexOf('/')),
    })
    closeContextMenu()
  }, [closeContextMenu, t])

  const handleDelete = useCallback((entry: FileEntry) => {
    const message = t('fileTree.deleteMessage', { name: entry.name }) +
      (entry.isDirectory ? ' ' + t('fileTree.deleteFolderMessage') : '') +
      ' ' + t('fileTree.deleteWarning')
    setConfirmDialog({
      isOpen: true,
      title: t('fileTree.deleteConfirm'),
      message,
      targetPath: entry.path,
    })
    closeContextMenu()
  }, [closeContextMenu, t])

  const handleCopyPath = useCallback(async (entry: FileEntry) => {
    try {
      await navigator.clipboard.writeText(entry.path)
    } catch {
      // Fallback for HTTP
      const textArea = document.createElement('textarea')
      textArea.value = entry.path
      textArea.style.position = 'fixed'
      textArea.style.left = '-9999px'
      document.body.appendChild(textArea)
      textArea.select()
      try {
        document.execCommand('copy')
      } catch {
        window.prompt('パスをコピーしてください:', entry.path)
      }
      document.body.removeChild(textArea)
    }
    closeContextMenu()
  }, [closeContextMenu])

  // Dialog confirmations
  const handleInputConfirm = useCallback(async (value: string) => {
    const { mode, targetPath, parentPath } = inputDialog

    if (mode === 'newFile') {
      const newPath = `${parentPath}/${value}`
      await window.electronAPI.writeFile(newPath, '')
    } else if (mode === 'newFolder') {
      const newPath = `${parentPath}/${value}`
      await window.electronAPI.createDirectory(newPath)
    } else if (mode === 'rename') {
      const newPath = `${parentPath}/${value}`
      await window.electronAPI.renameItem(targetPath, newPath)
    }

    // Invalidate cache and reload
    childrenCache.current.delete(parentPath)
    setLoadedDirs(prev => {
      const next = new Set(prev)
      next.delete(parentPath)
      return next
    })

    if (parentPath === departmentPath) {
      loadFiles()
    } else if (expandedDirs.has(parentPath)) {
      loadChildren(parentPath)
    }

    setInputDialog(prev => ({ ...prev, isOpen: false }))
  }, [inputDialog, departmentPath, expandedDirs, loadFiles, loadChildren])

  const handleDeleteConfirm = useCallback(async () => {
    const { targetPath } = confirmDialog
    const parentPath = targetPath.substring(0, targetPath.lastIndexOf('/'))

    await window.electronAPI.deleteItem(targetPath)

    // Invalidate cache and reload
    childrenCache.current.delete(parentPath)
    setLoadedDirs(prev => {
      const next = new Set(prev)
      next.delete(parentPath)
      return next
    })

    if (parentPath === departmentPath) {
      loadFiles()
    } else if (expandedDirs.has(parentPath)) {
      loadChildren(parentPath)
    }

    setConfirmDialog(prev => ({ ...prev, isOpen: false }))
  }, [confirmDialog, departmentPath, expandedDirs, loadFiles, loadChildren])

  // Build context menu items
  const getContextMenuItems = useCallback((entry: FileEntry | null, parentPath: string): ContextMenuItem[] => {
    if (!entry) {
      return [
        {
          label: t('fileTree.newFile'),
          icon: <FilePlus size={16} />,
          onClick: () => handleNewFile(parentPath),
        },
        {
          label: t('fileTree.newFolder'),
          icon: <FolderPlus size={16} />,
          onClick: () => handleNewFolder(parentPath),
        },
      ]
    }

    const items: ContextMenuItem[] = []

    if (entry.isDirectory) {
      items.push(
        {
          label: t('fileTree.newFile'),
          icon: <FilePlus size={16} />,
          onClick: () => handleNewFile(entry.path),
        },
        {
          label: t('fileTree.newFolder'),
          icon: <FolderPlus size={16} />,
          onClick: () => handleNewFolder(entry.path),
        },
        { label: '', divider: true, onClick: () => {} }
      )
    }

    items.push(
      {
        label: t('fileTree.rename'),
        icon: <PencilSimple size={16} />,
        shortcut: 'F2',
        onClick: () => handleRename(entry),
      },
      {
        label: t('common.delete'),
        icon: <Trash size={16} />,
        shortcut: 'Del',
        danger: true,
        onClick: () => handleDelete(entry),
      },
      { label: '', divider: true, onClick: () => {} },
      {
        label: t('fileTree.copyPath'),
        icon: <Copy size={16} />,
        onClick: () => handleCopyPath(entry),
      }
    )

    return items
  }, [handleNewFile, handleNewFolder, handleRename, handleDelete, handleCopyPath, t])

  const renderEntry = (entry: FileEntry, depth: number = 0) => {
    const isExpanded = expandedDirs.has(entry.path)
    const isSelected = selectedFilePath === entry.path
    const isLoadingChildren = loadingDirs.has(entry.path)
    const children = childrenCache.current.get(entry.path) || []

    const handleKeyDown = (e: React.KeyboardEvent) => {
      if (e.key === 'F2') {
        e.preventDefault()
        handleRename(entry)
      } else if (e.key === 'Delete') {
        e.preventDefault()
        handleDelete(entry)
      }
    }

    return (
      <div key={entry.path}>
        <button
          onClick={() => {
            if (entry.isDirectory) {
              toggleDir(entry.path)
            } else {
              onSelectFile(entry.path)
            }
          }}
          onContextMenu={(e) => handleContextMenu(e, entry, entry.path.substring(0, entry.path.lastIndexOf('/')))}
          onKeyDown={handleKeyDown}
          className={`
            w-full flex items-center gap-1.5 px-2 py-1 text-left text-sm
            rounded-md transition-colors outline-none focus:ring-1 focus:ring-accent/50
            ${isSelected
              ? 'bg-accent/20 text-gray-900 dark:text-zinc-100'
              : 'text-gray-600 dark:text-zinc-400 hover:bg-gray-100 dark:hover:bg-white/[0.04] hover:text-gray-900 dark:hover:text-zinc-200'
            }
          `}
          style={{ paddingLeft: `${8 + depth * 12}px` }}
        >
          {entry.isDirectory && (
            isLoadingChildren ? (
              <SpinnerGap size={12} className="flex-shrink-0 text-gray-400 dark:text-zinc-500 animate-spin" />
            ) : (
              <CaretRight
                size={12}
                className={`flex-shrink-0 text-gray-400 dark:text-zinc-600 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
              />
            )
          )}
          {!entry.isDirectory && <span className="w-3" />}
          {renderFileIcon(entry.name, entry.isDirectory, isExpanded)}
          <span className="truncate">{entry.name}</span>
        </button>

        {entry.isDirectory && isExpanded && (
          <div>
            {children.length > 0 ? (
              children.map(child => renderEntry(child, depth + 1))
            ) : !isLoadingChildren ? (
              <div
                className="text-xs text-gray-400 dark:text-zinc-600 italic"
                style={{ paddingLeft: `${20 + depth * 12}px` }}
              >
                {t('fileTree.emptyFolder')}
              </div>
            ) : null}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col bg-gray-50 dark:bg-zinc-900/50 border-r border-gray-200 dark:border-zinc-800/50">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-200 dark:border-zinc-800/50">
        <span className="text-xs font-medium text-gray-500 dark:text-zinc-500 uppercase tracking-wider">
          {t('fileTree.title')}
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setShowDotFiles(!showDotFiles)}
            className={`p-1 rounded hover:bg-gray-200 dark:hover:bg-white/[0.05] transition-colors ${
              showDotFiles ? 'text-accent' : 'text-gray-500 dark:text-zinc-500 hover:text-gray-700 dark:hover:text-zinc-300'
            }`}
            title={showDotFiles ? t('fileTree.hideHidden') : t('fileTree.showHidden')}
          >
            {showDotFiles ? <Eye size={14} /> : <EyeSlash size={14} />}
          </button>
          <button
            onClick={() => loadFiles()}
            disabled={isLoading}
            className="p-1 rounded hover:bg-gray-200 dark:hover:bg-white/[0.05] text-gray-500 dark:text-zinc-500 hover:text-gray-700 dark:hover:text-zinc-300 transition-colors disabled:opacity-50"
            title={t('fileTree.refresh')}
          >
            <ArrowClockwise size={14} className={isLoading ? 'animate-spin' : ''} />
          </button>
          <button
            onClick={() => handleNewFile(departmentPath)}
            className="p-1 rounded hover:bg-gray-200 dark:hover:bg-white/[0.05] text-gray-500 dark:text-zinc-500 hover:text-gray-700 dark:hover:text-zinc-300 transition-colors"
            title={t('fileTree.newFile')}
          >
            <FilePlus size={14} />
          </button>
          <button
            onClick={() => handleNewFolder(departmentPath)}
            className="p-1 rounded hover:bg-gray-200 dark:hover:bg-white/[0.05] text-gray-500 dark:text-zinc-500 hover:text-gray-700 dark:hover:text-zinc-300 transition-colors"
            title={t('fileTree.newFolder')}
          >
            <FolderPlus size={14} />
          </button>
        </div>
      </div>

      {/* Tree */}
      <div
        className="flex-1 overflow-auto py-2 px-1"
        onContextMenu={handleBackgroundContextMenu}
      >
        {files.length === 0 && !isLoading ? (
          <div className="px-3 py-4 text-center text-xs text-gray-400 dark:text-zinc-600">
            {t('fileTree.noFiles')}
          </div>
        ) : (
          files.map(entry => renderEntry(entry))
        )}
      </div>

      {/* Context Menu */}
      {contextMenu && (
        <ContextMenu
          items={getContextMenuItems(contextMenu.entry, contextMenu.entry?.isDirectory ? contextMenu.entry.path : contextMenu.parentPath)}
          position={contextMenu.position}
          onClose={closeContextMenu}
        />
      )}

      {/* Input Dialog */}
      <InputDialog
        isOpen={inputDialog.isOpen}
        title={inputDialog.title}
        defaultValue={inputDialog.defaultValue}
        placeholder={inputDialog.mode === 'newFile' ? 'filename.txt' : inputDialog.mode === 'newFolder' ? 'folder-name' : ''}
        onConfirm={handleInputConfirm}
        onCancel={() => setInputDialog(prev => ({ ...prev, isOpen: false }))}
      />

      {/* Confirm Dialog */}
      <ConfirmDialog
        isOpen={confirmDialog.isOpen}
        title={confirmDialog.title}
        message={confirmDialog.message}
        confirmText={t('common.delete')}
        danger
        onConfirm={handleDeleteConfirm}
        onCancel={() => setConfirmDialog(prev => ({ ...prev, isOpen: false }))}
      />
    </div>
  )
}
