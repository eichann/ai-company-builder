import { useEffect, useState, useCallback, useRef } from 'react'
import { useAppStore } from '../../stores/appStore'
import { FileTree } from './FileTree'
import { isPerfCutEnabled, perfMark, perfMeasure } from '../../lib/perfDiagnostics'
import { isChatInputRecentlyActive } from '../../lib/chatInputActivity'
import {
  FolderSimple,
  MagnifyingGlass,
  Robot,
  ArrowClockwise,
  CloudArrowUp,
  CheckCircle,
  Warning,
  Eye,
  EyeSlash,
} from '@phosphor-icons/react'
import type { FileEntry } from '../../types'

export function Sidebar() {
  // Use individual selectors to prevent unnecessary re-renders
  const currentCompany = useAppStore((s) => s.currentCompany)
  const setFileTree = useAppStore((s) => s.setFileTree)
  const showDotFiles = useAppStore((s) => s.showDotFiles)
  const setShowDotFiles = useAppStore((s) => s.setShowDotFiles)
  const fileTreeRefreshTrigger = useAppStore((s) => s.fileTreeRefreshTrigger)
  const removeFileTreeEntry = useAppStore((s) => s.removeFileTreeEntry)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [isSyncing, setIsSyncing] = useState(false)
  const [syncStatus, setSyncStatus] = useState<'idle' | 'success' | 'error'>('idle')
  const [syncMessage, setSyncMessage] = useState('')
  const pendingTreeRefreshRef = useRef(false)
  const deferredRefreshTimerRef = useRef<number | null>(null)

  const loadDirectoryRecursive = useCallback(
    async (dirPath: string, depth: number): Promise<FileEntry[] | undefined> => {
      if (depth <= 0) return undefined
      const entries = await window.electronAPI.readDirectory(dirPath)
      return Promise.all(
        entries.map(async (entry): Promise<FileEntry> => {
          if (entry.isDirectory) {
            const children = await loadDirectoryRecursive(entry.path, depth - 1)
            return { ...entry, children }
          }
          return entry
        })
      )
    },
    []
  )

  const loadFileTree = useCallback(
    async (rootPath: string): Promise<void> => {
      perfMark('sidebar.load_file_tree.start')
      const startedAt = performance.now()
      try {
        const entries = await window.electronAPI.readDirectory(rootPath)
        const tree = await Promise.all(
          entries.map(async (entry): Promise<FileEntry> => {
            if (entry.isDirectory) {
              const children = await loadDirectoryRecursive(entry.path, 5) // Increased depth
              return { ...entry, children }
            }
            return entry
          })
        )
        setFileTree(tree)
      } finally {
        perfMeasure('sidebar.load_file_tree.ms', performance.now() - startedAt)
      }
    },
    [loadDirectoryRecursive, setFileTree]
  )

  const requestDeferredTreeRefresh = useCallback(() => {
    pendingTreeRefreshRef.current = true
    if (deferredRefreshTimerRef.current != null) return

    const run = () => {
      if (!pendingTreeRefreshRef.current || !currentCompany?.rootPath) {
        deferredRefreshTimerRef.current = null
        return
      }

      if (isChatInputRecentlyActive()) {
        perfMark('sidebar.load_file_tree.deferred_for_chat_input')
        deferredRefreshTimerRef.current = window.setTimeout(run, 250)
        return
      }

      pendingTreeRefreshRef.current = false
      deferredRefreshTimerRef.current = null
      void loadFileTree(currentCompany.rootPath)
    }

    deferredRefreshTimerRef.current = window.setTimeout(run, 120)
  }, [currentCompany?.rootPath, loadFileTree])

  useEffect(() => {
    return () => {
      if (deferredRefreshTimerRef.current != null) {
        window.clearTimeout(deferredRefreshTimerRef.current)
      }
    }
  }, [])

  // Load file tree when company changes
  useEffect(() => {
    if (currentCompany?.rootPath) {
      loadFileTree(currentCompany.rootPath)
    }
  }, [currentCompany?.rootPath, loadFileTree])

  // Reload when refresh trigger changes
  useEffect(() => {
    if (currentCompany?.rootPath && fileTreeRefreshTrigger > 0) {
      loadFileTree(currentCompany.rootPath)
    }
  }, [fileTreeRefreshTrigger, currentCompany?.rootPath, loadFileTree])

  // Setup file watching
  useEffect(() => {
    if (!currentCompany?.rootPath) return

    if (isPerfCutEnabled('disableWatchers')) {
      perfMark('sidebar.watch.disabled')
      return
    }

    // Start watching
    perfMark('sidebar.watch.start')
    window.electronAPI.watchDirectory(currentCompany.rootPath)

    // Handle file change events
    const unsubscribe = window.electronAPI.onFileChange((data) => {
      perfMark('sidebar.fs_change')
      perfMark(`sidebar.fs_change.${data.type}`)
      if (isPerfCutEnabled('fsEvents')) {
        perfMark('sidebar.fs_change.skipped')
        return
      }
      if (!data.path.startsWith(currentCompany.rootPath)) {
        return
      }

      switch (data.type) {
        case 'unlink':
        case 'unlinkDir':
          // Remove from tree
          removeFileTreeEntry(data.path)
          break
        case 'add':
        case 'addDir':
        case 'change':
          // Coalesce frequent fs updates and defer while chat input is active.
          requestDeferredTreeRefresh()
          break
      }
    })

    return () => {
      unsubscribe()
      window.electronAPI.unwatchDirectory(currentCompany.rootPath)
      perfMark('sidebar.watch.stop')
    }
  }, [currentCompany?.rootPath, removeFileTreeEntry, requestDeferredTreeRefresh])

  // Listen for refresh events from other components
  useEffect(() => {
    const handleRefreshEvent = () => {
      perfMark('sidebar.refresh_file_tree_event')
      if (isPerfCutEnabled('fsEvents')) {
        perfMark('sidebar.refresh_file_tree_event.skipped')
        return
      }
      if (currentCompany?.rootPath) {
        requestDeferredTreeRefresh()
      }
    }
    window.addEventListener('refresh-file-tree', handleRefreshEvent)
    return () => window.removeEventListener('refresh-file-tree', handleRefreshEvent)
  }, [currentCompany?.rootPath, requestDeferredTreeRefresh])

  const handleRefresh = useCallback(async () => {
    if (!currentCompany?.rootPath || isRefreshing) return
    setIsRefreshing(true)
    try {
      await loadFileTree(currentCompany.rootPath)
    } finally {
      setIsRefreshing(false)
    }
  }, [currentCompany?.rootPath, isRefreshing, loadFileTree])

  const handleSyncToServer = useCallback(async () => {
    if (!currentCompany?.rootPath || !currentCompany?.id || isSyncing) return

    setIsSyncing(true)
    setSyncStatus('idle')
    setSyncMessage('サーバーに同期中...')

    try {
      // Step 1: Create repo on server (if doesn't exist)
      const createResult = await window.electronAPI.serverCreateRepo(currentCompany.id)
      if (!createResult.success) {
        throw new Error(createResult.error || 'Failed to create server repo')
      }

      // Step 2: Setup local Git repo with remote
      const setupResult = await window.electronAPI.gitSetupCompanyRemote(
        currentCompany.rootPath,
        currentCompany.id
      )
      if (!setupResult.success) {
        throw new Error(setupResult.error || 'Failed to setup Git')
      }

      // Step 3: Push to server
      const pushResult = await window.electronAPI.gitPushToServer(currentCompany.rootPath)
      if (!pushResult.success) {
        throw new Error(pushResult.error || 'Failed to push to server')
      }

      setSyncStatus('success')
      setSyncMessage('同期完了!')

      // Reset status after 3 seconds
      setTimeout(() => {
        setSyncStatus('idle')
        setSyncMessage('')
      }, 3000)
    } catch (error) {
      console.error('Sync error:', error)
      setSyncStatus('error')
      setSyncMessage(error instanceof Error ? error.message : 'Sync failed')
    } finally {
      setIsSyncing(false)
    }
  }, [currentCompany?.rootPath, currentCompany?.id, isSyncing])

  const toggleDotFiles = useCallback(() => {
    setShowDotFiles(!showDotFiles)
  }, [showDotFiles, setShowDotFiles])

  return (
    <div className="h-full flex flex-col">
      {/* Sidebar Header */}
      <div className="h-9 flex items-center justify-between px-4 text-xs uppercase text-text-secondary tracking-wider border-b border-border">
        <span>Explorer</span>
        <div className="flex gap-1">
          <button
            onClick={toggleDotFiles}
            className={`p-1 hover:bg-white/5 rounded ${showDotFiles ? 'text-accent' : ''}`}
            title={showDotFiles ? '隠しファイルを非表示' : '隠しファイルを表示'}
          >
            {showDotFiles ? <Eye size={14} /> : <EyeSlash size={14} />}
          </button>
          <button
            onClick={handleRefresh}
            disabled={isRefreshing}
            className="p-1 hover:bg-white/5 rounded disabled:opacity-50"
            title="ファイルツリーを更新"
          >
            <ArrowClockwise size={14} className={isRefreshing ? 'animate-spin' : ''} />
          </button>
          <button className="p-1 hover:bg-white/5 rounded" title="検索">
            <MagnifyingGlass size={14} />
          </button>
        </div>
      </div>

      {/* Company Section */}
      <div className="px-2 py-2 border-b border-border">
        <div className="flex items-center gap-2 px-2 py-1.5 text-sm">
          <FolderSimple size={16} className="text-accent" weight="fill" />
          <span className="truncate">{currentCompany?.name}</span>
        </div>
      </div>

      {/* File Tree */}
      <div className="flex-1 overflow-auto py-1">
        <FileTree onRefresh={handleRefresh} />
      </div>

      {/* Sync to Server */}
      <div className="p-2 border-t border-border">
        <button
          onClick={handleSyncToServer}
          disabled={isSyncing || !currentCompany}
          className={`w-full flex items-center justify-center gap-2 px-3 py-2 rounded text-xs font-medium transition-colors ${
            syncStatus === 'success'
              ? 'bg-green-500/20 text-green-400'
              : syncStatus === 'error'
              ? 'bg-red-500/20 text-red-400'
              : 'bg-accent/10 text-accent hover:bg-accent/20'
          } disabled:opacity-50`}
        >
          {isSyncing ? (
            <>
              <ArrowClockwise size={14} className="animate-spin" />
              <span>同期中...</span>
            </>
          ) : syncStatus === 'success' ? (
            <>
              <CheckCircle size={14} weight="fill" />
              <span>{syncMessage}</span>
            </>
          ) : syncStatus === 'error' ? (
            <>
              <Warning size={14} weight="fill" />
              <span className="truncate">{syncMessage}</span>
            </>
          ) : (
            <>
              <CloudArrowUp size={14} weight="fill" />
              <span>サーバーに同期</span>
            </>
          )}
        </button>
      </div>

      {/* Agent Status */}
      <div className="p-2 border-t border-border">
        <div className="flex items-center gap-2 px-2 py-2 rounded bg-accent/10 text-accent text-xs">
          <Robot size={16} weight="fill" />
          <span>AI Agent Ready</span>
        </div>
      </div>
    </div>
  )
}
