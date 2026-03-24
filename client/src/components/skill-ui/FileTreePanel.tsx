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

// Allowed file extensions for external drop
const ALLOWED_DROP_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg',
  'md', 'txt', 'csv', 'pdf', 'docx', 'xlsx', 'pptx',
  'json', 'yaml', 'yml',
])
const MAX_DROP_FILE_SIZE = 20 * 1024 * 1024 // 20MB

interface FileTreePanelProps {
  rootPath: string
  departmentFolder: string
  selectedFilePath: string | null
  onSelectFile: (path: string) => void
  onDoubleClickFile?: (path: string) => void
  onCreateFile?: () => void
}

export function FileTreePanel({
  rootPath,
  departmentFolder,
  selectedFilePath,
  onSelectFile,
  onDoubleClickFile,
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

  // Per-department tree cache to avoid re-reading on tab switch
  const departmentTreeCache = useRef<Map<string, {
    files: FileEntry[]
    children: Map<string, FileEntry[]>
    expandedDirs: Set<string>
    loadedDirs: Set<string>
  }>>(new Map())

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{
    position: { x: number; y: number }
    entry: FileEntry | null
    parentPath: string
    selectedSnapshot: Set<string>
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
    targetPaths?: string[]
  }>({
    isOpen: false,
    title: '',
    message: '',
    targetPath: '',
  })

  // Multi-select state — ref is updated synchronously so right-click snapshots are always accurate
  const [selectedPaths, _setSelectedPaths] = useState<Set<string>>(new Set())
  const selectedPathsRef = useRef<Set<string>>(selectedPaths)
  const setSelectedPaths = useCallback((update: Set<string> | ((prev: Set<string>) => Set<string>)) => {
    const next = typeof update === 'function' ? update(selectedPathsRef.current) : update
    selectedPathsRef.current = next
    _setSelectedPaths(next)
  }, [])
  const [lastClickedPath, setLastClickedPath] = useState<string | null>(null)

  // Drag & drop state
  const [dragOverPath, setDragOverPath] = useState<string | null>(null)
  const [dragSourcePaths, setDragSourcePaths] = useState<Set<string>>(new Set())
  const [dropWarning, setDropWarning] = useState<string | null>(null)

  const departmentPath = `${rootPath}/${departmentFolder}`

  // Determine the target directory for new file/folder creation based on current selection
  const activeParentPath = (() => {
    if (!selectedFilePath) return departmentPath
    // Find if the selected path is a directory (check in expanded dirs or files)
    const isDir = expandedDirs.has(selectedFilePath) ||
      files.some(f => f.path === selectedFilePath && f.isDirectory) ||
      Array.from(childrenCache.current.values()).flat().some(f => f.path === selectedFilePath && f.isDirectory)
    if (isDir) return selectedFilePath
    // It's a file — use its parent directory
    return selectedFilePath.substring(0, selectedFilePath.lastIndexOf('/'))
  })()

  // Sort entries: directories first, then files, alphabetically
  const sortEntries = (entries: FileEntry[]): FileEntry[] =>
    entries.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1
      if (!a.isDirectory && b.isDirectory) return 1
      return a.name.localeCompare(b.name)
    })

  // Filter and convert raw tree data from IPC into FileEntry[], populating childrenCache
  // Only populates cache (loadedDirs) — does NOT set expandedDirs (that's UI state)
  const processTree = useCallback((
    rawEntries: Array<{ name: string; isDirectory: boolean; path: string; children?: Array<unknown> }>,
    includeDotFiles: boolean,
  ): { topLevel: FileEntry[]; firstLevelDirs: Set<string>; loadedDirs: Set<string> } => {
    const newLoaded = new Set<string>()
    const firstLevelDirs = new Set<string>()

    const process = (entries: Array<{ name: string; isDirectory: boolean; path: string; children?: Array<unknown> }>, depth: number): FileEntry[] => {
      const result: FileEntry[] = []
      for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name === '.DS_Store') continue
        if (entry.name.startsWith('.') && !includeDotFiles) continue

        const fileEntry: FileEntry = {
          name: entry.name,
          path: entry.path,
          isDirectory: entry.isDirectory,
        }
        result.push(fileEntry)

        if (entry.isDirectory) {
          if (depth === 0) firstLevelDirs.add(entry.path)
          // Cache children data if available, but don't auto-expand
          if (entry.children) {
            const children = sortEntries(process(entry.children as Array<{ name: string; isDirectory: boolean; path: string; children?: Array<unknown> }>, depth + 1))
            childrenCache.current.set(entry.path, children)
            newLoaded.add(entry.path)
          }
        }
      }
      return result
    }

    const topLevel = sortEntries(process(rawEntries, 0))
    return { topLevel, firstLevelDirs, loadedDirs: newLoaded }
  }, [])

  // Load single directory (for lazy-loading deeper levels and refresh)
  const loadSingleDirectory = useCallback(async (dirPath: string, includeDotFiles: boolean): Promise<FileEntry[]> => {
    try {
      const entries = await window.electronAPI.readDirectory(dirPath)
      const result: FileEntry[] = []
      for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name === '.DS_Store') continue
        if (entry.name.startsWith('.') && !includeDotFiles) continue
        result.push({ name: entry.name, path: entry.path, isDirectory: entry.isDirectory })
      }
      return sortEntries(result)
    } catch {
      return []
    }
  }, [])

  // Load children for a specific directory (lazy loading for depth > 2)
  const loadChildren = useCallback(async (dirPath: string): Promise<FileEntry[]> => {
    const cached = childrenCache.current.get(dirPath)
    if (cached && loadedDirs.has(dirPath)) return cached

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

  // Save cache when department changes (before new load)
  const prevDepartmentRef = useRef(departmentPath)
  if (prevDepartmentRef.current !== departmentPath) {
    departmentTreeCache.current.set(prevDepartmentRef.current, {
      files,
      children: new Map(childrenCache.current),
      expandedDirs: new Set(expandedDirsRef.current),
      loadedDirs: new Set(loadedDirs),
    })
    prevDepartmentRef.current = departmentPath
  }

  // Load entire tree with single IPC call
  const loadFiles = useCallback(async (preserveExpandedState = false) => {
    perfMark('file_tree_panel.load_files.start')
    const startedAt = performance.now()

    // Check department cache for instant restore on tab switch
    if (!preserveExpandedState) {
      const cached = departmentTreeCache.current.get(departmentPath)
      if (cached) {
        setFiles(cached.files)
        childrenCache.current = new Map(cached.children)
        setExpandedDirs(cached.expandedDirs)
        setLoadedDirs(cached.loadedDirs)
        perfMeasure('file_tree_panel.load_files.ms', performance.now() - startedAt)
        // Background refresh with single IPC call (don't touch expandedDirs — preserve user's state)
        window.electronAPI.readDirectoryTree(departmentPath, 10).then(rawEntries => {
          const { topLevel, loadedDirs: newLoaded } = processTree(rawEntries, showDotFiles)
          setFiles(topLevel)
          // Only update loadedDirs (which dirs have cached children), NOT expandedDirs
          setLoadedDirs(prev => {
            const merged = new Set(prev)
            for (const d of newLoaded) merged.add(d)
            return merged
          })
        })
        return
      }
    }

    if (!preserveExpandedState) {
      // Only clear cache on full reload (tab switch), not on refresh
      setIsLoading(true)
      childrenCache.current.clear()
      setLoadedDirs(new Set())
    }

    try {
      // Single IPC call fetches 2 levels of directory tree
      const rawEntries = await window.electronAPI.readDirectoryTree(departmentPath, 10)
      const { topLevel, firstLevelDirs, loadedDirs: newLoaded } = processTree(rawEntries, showDotFiles)
      setFiles(topLevel)

      if (preserveExpandedState) {
        // Don't change expandedDirs — preserve user's state as-is
      } else {
        // Initial load: auto-expand only first-level directories
        setExpandedDirs(firstLevelDirs)
      }
      setLoadedDirs(newLoaded)
    } finally {
      perfMeasure('file_tree_panel.load_files.ms', performance.now() - startedAt)
      if (!preserveExpandedState) {
        setIsLoading(false)
      }
    }
  }, [departmentPath, showDotFiles, processTree])

  // Handle external file drop (from Finder etc.)
  const handleExternalFileDrop = useCallback(async (fileList: FileList, destDir: string) => {
    const warnings: string[] = []
    let moved = 0

    for (const file of Array.from(fileList)) {
      if (!file.path) continue

      // Extension and size validation (skip for entries without extension — likely folders)
      const ext = file.name.includes('.') ? file.name.split('.').pop()?.toLowerCase() : ''
      if (ext) {
        if (!ALLOWED_DROP_EXTENSIONS.has(ext)) {
          warnings.push(`${file.name}: 非対応の形式`)
          continue
        }
        if (file.size > MAX_DROP_FILE_SIZE) {
          warnings.push(`${file.name}: 20MBを超えています`)
          continue
        }
      }

      // Unique destination path
      let destPath = `${destDir}/${file.name}`
      try {
        await window.electronAPI.getStats(destPath)
        // Already exists — find unique name
        const dotIdx = file.name.lastIndexOf('.')
        const base = dotIdx > 0 ? file.name.substring(0, dotIdx) : file.name
        const ext = dotIdx > 0 ? file.name.substring(dotIdx) : ''
        for (let i = 1; i < 100; i++) {
          const candidate = `${destDir}/${base} (${i})${ext}`
          try {
            await window.electronAPI.getStats(candidate)
          } catch {
            destPath = candidate
            break
          }
        }
      } catch {
        // Doesn't exist — use as-is
      }

      const result = await window.electronAPI.moveFromExternal(file.path, destPath)
      if (result.success) {
        moved++
      } else {
        warnings.push(`${file.name}: ${result.error || '移動に失敗'}`)
      }
    }

    if (warnings.length > 0) {
      setDropWarning(warnings.join('\n'))
      setTimeout(() => setDropWarning(null), 5000)
    }

    if (moved > 0) {
      loadFiles(true)
    }
  }, [loadFiles])

  const deferCountRef = useRef(0)
  const MAX_DEFER_COUNT = 4 // max ~1 second of deferral (4 × 250ms)

  const requestDeferredReload = useCallback(() => {
    pendingReloadRef.current = true
    if (deferredReloadTimerRef.current != null) return
    deferCountRef.current = 0

    const run = () => {
      if (!pendingReloadRef.current) {
        deferredReloadTimerRef.current = null
        return
      }

      if (isChatInputRecentlyActive() && deferCountRef.current < MAX_DEFER_COUNT) {
        deferCountRef.current++
        perfMark('file_tree_panel.load_files.deferred_for_chat_input')
        deferredReloadTimerRef.current = window.setTimeout(run, 250)
        return
      }

      pendingReloadRef.current = false
      deferredReloadTimerRef.current = null
      deferCountRef.current = 0
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

  // Flatten visible entries for shift+click range selection
  const flattenVisibleEntries = useCallback((entries: FileEntry[]): string[] => {
    const result: string[] = []
    for (const entry of entries) {
      result.push(entry.path)
      if (entry.isDirectory && expandedDirs.has(entry.path)) {
        const children = childrenCache.current.get(entry.path) || []
        result.push(...flattenVisibleEntries(children))
      }
    }
    return result
  }, [expandedDirs])

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
      // Expand - use cache if available, otherwise load
      if (!childrenCache.current.has(path) && !loadedDirs.has(path)) {
        await loadChildren(path)
      }
      setExpandedDirs(prev => new Set(prev).add(path))
    }
  }, [expandedDirs, loadedDirs, loadChildren])

  const renderFileIcon = (name: string, isDirectory: boolean, isExpanded: boolean) => {
    const icon = isDirectory
      ? <FolderIcon size={14} isOpen={isExpanded} />
      : (() => { const IC = getFileIcon(name, false); return <IC size={14} /> })()
    return (
      <span className="flex-shrink-0 w-4 h-4 flex items-center justify-center">
        {icon}
      </span>
    )
  }

  // Context menu handlers
  const handleContextMenu = useCallback((e: React.MouseEvent, entry: FileEntry | null, parentPath: string) => {
    e.preventDefault()
    e.stopPropagation()
    // Use ref to always get the latest selectedPaths (state may be stale in closure)
    const snapshot = new Set(selectedPathsRef.current)
    if (entry) snapshot.add(entry.path)
    setContextMenu({
      position: { x: e.clientX, y: e.clientY },
      entry,
      parentPath,
      selectedSnapshot: snapshot,
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
      selectedSnapshot: new Set(selectedPaths),
    })
  }, [departmentPath, selectedPaths])

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

    // Ensure the parent directory is expanded so the new item is visible
    if (parentPath !== departmentPath && !expandedDirs.has(parentPath)) {
      setExpandedDirs(prev => new Set(prev).add(parentPath))
    }

    if (parentPath === departmentPath) {
      loadFiles(true)
    } else {
      await loadChildren(parentPath)
    }

    setInputDialog(prev => ({ ...prev, isOpen: false }))
  }, [inputDialog, departmentPath, expandedDirs, loadFiles, loadChildren])

  const handleDeleteConfirm = useCallback(async () => {
    const paths = confirmDialog.targetPaths || [confirmDialog.targetPath]
    const affectedParents = new Set<string>()

    for (const p of paths) {
      await window.electronAPI.deleteItem(p)
      affectedParents.add(p.substring(0, p.lastIndexOf('/')))
    }

    // Invalidate cache for all affected parent directories
    for (const parentPath of affectedParents) {
      childrenCache.current.delete(parentPath)
      setLoadedDirs(prev => {
        const next = new Set(prev)
        next.delete(parentPath)
        return next
      })
    }

    setSelectedPaths(new Set())
    loadFiles(true)
    setConfirmDialog(prev => ({ ...prev, isOpen: false }))
  }, [confirmDialog, loadFiles])

  // Build context menu items
  const getContextMenuItems = useCallback((entry: FileEntry | null, parentPath: string, snapshot?: Set<string>): ContextMenuItem[] => {
    // Multi-select context menu using snapshot from right-click moment
    const effectiveSelection = snapshot || new Set<string>()
    if (effectiveSelection.size > 1) {
      return [
        {
          label: `${effectiveSelection.size}件を削除`,
          icon: <Trash size={16} />,
          danger: true,
          onClick: () => {
            // Ensure selection includes the right-clicked item
            setSelectedPaths(effectiveSelection)
            const paths = [...effectiveSelection]
            const count = paths.length
            const hasFolders = paths.some(p =>
              files.some(f => f.path === p && f.isDirectory) ||
              Array.from(childrenCache.current.values()).flat().some(f => f.path === p && f.isDirectory)
            )
            const message = `${count}件のアイテムを削除しますか？` +
              (hasFolders ? ' フォルダを含む場合、中身もすべて削除されます。' : '') +
              ' この操作は取り消せません。'
            setConfirmDialog({
              isOpen: true,
              title: `${count}件を削除`,
              message,
              targetPath: '',
              targetPaths: paths,
            })
            closeContextMenu()
          },
        },
      ]
    }

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
  }, [handleNewFile, handleNewFolder, handleRename, handleDelete, handleCopyPath, closeContextMenu, files, t])

  const renderEntry = (entry: FileEntry, depth: number = 0) => {
    const isExpanded = expandedDirs.has(entry.path)
    const isFileActive = selectedFilePath === entry.path
    const isMultiSelected = selectedPaths.has(entry.path)
    const isHighlighted = isMultiSelected || isFileActive
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
        <div
          role="button"
          tabIndex={0}
          draggable
          onDragStart={(e) => {
            // If dragging a selected item, drag all selected; otherwise drag just this one
            const paths = isMultiSelected && selectedPaths.size > 1
              ? [...selectedPaths]
              : [entry.path]
            setDragSourcePaths(new Set(paths))
            e.dataTransfer.setData('application/x-file-paths', JSON.stringify(paths))
            e.dataTransfer.effectAllowed = 'move'
          }}
          onDragEnd={() => {
            setDragSourcePaths(new Set())
            setDragOverPath(null)
          }}
          onDragOver={(e) => {
            if (!entry.isDirectory) return
            // Internal D&D checks
            if (dragSourcePaths.size > 0) {
              if (dragSourcePaths.has(entry.path)) return
              for (const src of dragSourcePaths) {
                if (entry.path.startsWith(src + '/')) return
              }
            }
            e.preventDefault()
            e.stopPropagation()
            e.dataTransfer.dropEffect = 'move'
            setDragOverPath(entry.path)
          }}
          onDragLeave={(e) => {
            if (dragOverPath === entry.path) {
              const rect = e.currentTarget.getBoundingClientRect()
              const { clientX, clientY } = e
              if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
                setDragOverPath(null)
              }
            }
          }}
          onDrop={async (e) => {
            e.preventDefault()
            e.stopPropagation()
            setDragOverPath(null)

            if (!entry.isDirectory) return

            // External file drop (from Finder etc.)
            if (e.dataTransfer.files.length > 0 && !e.dataTransfer.getData('application/x-file-paths')) {
              await handleExternalFileDrop(e.dataTransfer.files, entry.path)
              return
            }

            // Internal move
            const raw = e.dataTransfer.getData('application/x-file-paths')
            if (!raw) return
            const sourcePaths: string[] = JSON.parse(raw)

            for (const sourcePath of sourcePaths) {
              if (entry.path === sourcePath || entry.path.startsWith(sourcePath + '/')) continue
              const fileName = sourcePath.split('/').pop()
              if (!fileName) continue
              const destPath = `${entry.path}/${fileName}`
              if (sourcePath === destPath) continue
              await window.electronAPI.moveItem(sourcePath, destPath)
            }
            setSelectedPaths(new Set())
            loadFiles(true)
          }}
          onClick={(e) => {
            if (e.shiftKey && lastClickedPath) {
              // Shift+click: range selection
              const flat = flattenVisibleEntries(files)
              const startIdx = flat.indexOf(lastClickedPath)
              const endIdx = flat.indexOf(entry.path)
              if (startIdx !== -1 && endIdx !== -1) {
                const [from, to] = startIdx < endIdx ? [startIdx, endIdx] : [endIdx, startIdx]
                const rangePaths = flat.slice(from, to + 1)
                setSelectedPaths(new Set(rangePaths))
              }
            } else if (e.metaKey || e.ctrlKey) {
              // Cmd/Ctrl+click: toggle individual selection
              setSelectedPaths(prev => {
                const next = new Set(prev)
                if (next.has(entry.path)) {
                  next.delete(entry.path)
                } else {
                  next.add(entry.path)
                }
                return next
              })
              setLastClickedPath(entry.path)
            } else {
              // Normal click: reset selection
              setSelectedPaths(new Set())
              setLastClickedPath(entry.path)
              if (entry.isDirectory) {
                toggleDir(entry.path)
              } else {
                onSelectFile(entry.path)
              }
            }
          }}
          onDoubleClick={() => {
            if (!entry.isDirectory && onDoubleClickFile) {
              onDoubleClickFile(entry.path)
            }
          }}
          onContextMenu={(e) => {
            // If right-clicking on an unselected item while multi-selecting, add it to selection
            if (selectedPaths.size > 0 && !selectedPaths.has(entry.path)) {
              setSelectedPaths(prev => new Set(prev).add(entry.path))
            }
            handleContextMenu(e, entry, entry.path.substring(0, entry.path.lastIndexOf('/')))
          }}
          onKeyDown={handleKeyDown}
          className={`
            w-full flex items-center gap-1.5 px-2 py-1 text-left text-sm cursor-pointer
            rounded-md transition-colors outline-none focus:ring-1 focus:ring-accent/50
            ${isHighlighted
              ? 'bg-accent/20 text-gray-900 dark:text-zinc-100'
              : 'text-gray-600 dark:text-zinc-400 hover:bg-gray-100 dark:hover:bg-white/[0.04] hover:text-gray-900 dark:hover:text-zinc-200'
            }
            ${dragOverPath === entry.path && entry.isDirectory ? 'ring-2 ring-accent bg-accent/10' : ''}
            ${dragSourcePaths.has(entry.path) ? 'opacity-50' : ''}
          `}
          style={{ paddingLeft: `${8 + depth * 12}px` }}
        >
          <span className="flex-shrink-0 w-3 h-4 flex items-center justify-center">
            {entry.isDirectory && (
              isLoadingChildren ? (
                <SpinnerGap size={10} className="text-gray-400 dark:text-zinc-500 animate-spin" />
              ) : (
                <CaretRight
                  size={10}
                  className={`text-gray-400 dark:text-zinc-600 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
                />
              )
            )}
          </span>
          {renderFileIcon(entry.name, entry.isDirectory, isExpanded)}
          <span className="truncate" title={entry.name}>{entry.name}</span>
        </div>

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
    <div className="h-full flex flex-col bg-gray-50 dark:bg-zinc-900/50 border-r border-gray-200 dark:border-zinc-800/50 relative">
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
            onClick={() => handleNewFile(activeParentPath)}
            className="p-1 rounded hover:bg-gray-200 dark:hover:bg-white/[0.05] text-gray-500 dark:text-zinc-500 hover:text-gray-700 dark:hover:text-zinc-300 transition-colors"
            title={t('fileTree.newFile')}
          >
            <FilePlus size={14} />
          </button>
          <button
            onClick={() => handleNewFolder(activeParentPath)}
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
        onDragOver={(e) => {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
        }}
        onDrop={async (e) => {
          e.preventDefault()
          setDragOverPath(null)

          // External file drop (from Finder etc.)
          if (e.dataTransfer.files.length > 0 && !e.dataTransfer.getData('application/x-file-paths')) {
            await handleExternalFileDrop(e.dataTransfer.files, departmentPath)
            return
          }

          // Internal move
          const raw = e.dataTransfer.getData('application/x-file-paths')
          if (!raw) return
          const sourcePaths: string[] = JSON.parse(raw)
          for (const sourcePath of sourcePaths) {
            const fileName = sourcePath.split('/').pop()
            if (!fileName) continue
            const destPath = `${departmentPath}/${fileName}`
            if (sourcePath === destPath) continue
            await window.electronAPI.moveItem(sourcePath, destPath)
          }
          setSelectedPaths(new Set())
          loadFiles(true)
        }}
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
          items={getContextMenuItems(contextMenu.entry, contextMenu.entry?.isDirectory ? contextMenu.entry.path : contextMenu.parentPath, contextMenu.selectedSnapshot)}
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

      {/* Drop warning toast */}
      {dropWarning && (
        <div className="absolute bottom-2 left-2 right-2 px-3 py-2 rounded-md bg-red-500/10 border border-red-500/30 text-xs text-red-400 whitespace-pre-wrap">
          {dropWarning}
        </div>
      )}
    </div>
  )
}
