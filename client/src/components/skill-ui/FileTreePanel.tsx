import { useState, useEffect, useCallback, useRef, useMemo, useSyncExternalStore, memo } from 'react'
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
  CloudArrowDown,
  FolderSimpleDashed,
  LockSimple,
} from '@phosphor-icons/react'
import { ContextMenu, type ContextMenuItem } from '../common/ContextMenu'
import { normalizePathSeparators } from '../../utils/path'
import { isPathWithin } from '../../lib/editorTabs'
import { InputDialog } from '../common/InputDialog'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { FolderIcon } from '../../shared/ui/FileIcons'
import { getFileIcon } from '../../shared/ui/fileIcon'
import { isPerfCutEnabled, perfMark } from '../../lib/perfDiagnostics'
import { detectReviewStatus, hasUnseenReviews, isReviewSidecarFile } from '../../features/doc-review/model'
import { ReadOnlyBadge } from './ReadOnlyBadge'
import { useWriteAccess } from '../../hooks/useWriteAccess'
import { useSparseCheckout } from '../../hooks/useSparseCheckout'
import { notDownloadedUserMessage, pathKey } from '../../../shared/sparse-paths'
import { NewFolderDialog } from './NewFolderDialog'
import { createDirectory, createEmptyFile, deleteItem, getStats, moveFromExternal, moveItem, readDirectory, readDirectoryTree, renameItem, reservedPathRefusal, startDrag } from '../../features/files/api'
import { usePrivateFolders } from '../../hooks/usePrivateFolders'
import { useAppStore } from '../../stores/appStore'
import { useAuthStore } from '../../stores/authStore'
import { boundaryCrossing, crossingMessage, lastSegment, viewersLabel, type MyPrivateFolder } from '../../../shared/private-folder-ui'
import {
  applyEventsToFileTreeModels,
  getFileTreeModel,
  retainFileTreeModels,
  reviewStatusOfListing,
  viewOfListing,
  type FileEntry,
  type FileTreeIO,
  type RawDirEntry,
} from '../../lib/fileTreeModel'
import { subscribeFileChanges } from '../../lib/fileEvents'

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
  /** A private folder was created on the server: sync so it reaches this computer. */
  onPrivateFolderCreated?: () => void
}

// Sort entries: directories first, then files, alphabetically
const sortEntries = (entries: FileEntry[]): FileEntry[] =>
  entries.sort((a, b) => {
    if (a.isDirectory && !b.isDirectory) return -1
    if (!a.isDirectory && b.isDirectory) return 1
    return a.name.localeCompare(b.name)
  })

const parentDir = (p: string) => p.substring(0, p.lastIndexOf('/'))

const treeIO: FileTreeIO = {
  readDirectory: dir => readDirectory(dir),
  readDirectoryTree: (dir, depth) => readDirectoryTree(dir, depth) as Promise<RawDirEntry[]>,
}

// Every tree model (shown or not) learns about watcher events, so a
// department visited earlier is up to date when it is shown again. One
// subscription for the app's lifetime.
let modelEventsInstalled = false
function installModelEvents(): void {
  if (modelEventsInstalled) return
  modelEventsInstalled = true
  subscribeFileChanges((changes) => {
    perfMark('file_tree_panel.fs_change')
    applyEventsToFileTreeModels(changes)
  })
}

type ReviewBadge = 'request' | 'unseen' | 'seen' | null

/** Everything a row does, behind one stable ref so memoised rows never re-render for new callbacks. */
interface RowActions {
  click: (entry: FileEntry, e: React.MouseEvent) => void
  doubleClick: (entry: FileEntry) => void
  contextMenu: (entry: FileEntry, e: React.MouseEvent) => void
  keyDown: (entry: FileEntry, e: React.KeyboardEvent) => void
  dragStart: (entry: FileEntry, e: React.DragEvent) => void
  dragEnd: () => void
  dragOver: (entry: FileEntry, e: React.DragEvent) => void
  dragLeave: (entry: FileEntry, e: React.DragEvent) => void
  drop: (entry: FileEntry, e: React.DragEvent) => void
  download: (entry: FileEntry) => void
  clearSelection: () => void
}

interface TreeRowProps {
  entry: FileEntry
  depth: number
  isExpanded: boolean
  isHighlighted: boolean
  isLoading: boolean
  isDragOver: boolean
  isDragSource: boolean
  showReadOnly: boolean
  privateRoot: MyPrivateFolder | null
  review: ReviewBadge
  downloading: boolean
  actions: React.MutableRefObject<RowActions>
}

const TreeRow = memo(function TreeRow({
  entry, depth, isExpanded, isHighlighted, isLoading, isDragOver, isDragSource,
  showReadOnly, privateRoot, review, downloading, actions,
}: TreeRowProps) {
  // A folder this computer does not download: muted, not expandable, not a
  // drop target; one click downloads it.
  if (entry.notDownloaded) {
    return (
      <div
        role="button"
        tabIndex={0}
        aria-label={`${entry.name}（未ダウンロード）`}
        title="このフォルダはこのPCにダウンロードしていません。サーバーにはあります。"
        onClick={() => actions.current.clearSelection()}
        onKeyDown={e => { if ((e.key === 'Enter' || e.key === ' ') && !downloading) { e.preventDefault(); actions.current.download(entry) } }}
        onContextMenu={e => actions.current.contextMenu(entry, e)}
        className="group w-full flex items-center gap-1.5 px-2 py-1 text-left text-sm rounded-md outline-none transition-colors focus:ring-1 focus:ring-accent/50 text-gray-400 dark:text-zinc-500 hover:bg-gray-100 dark:hover:bg-white/[0.04]"
        style={{ paddingLeft: `${8 + depth * 12}px` }}
      >
        <span className="flex-shrink-0 w-3 h-4" />
        <span className="flex-shrink-0 w-4 h-4 flex items-center justify-center">
          <FolderSimpleDashed size={14} className="text-gray-400 dark:text-zinc-500" />
        </span>
        <span className="truncate" title={entry.name}>{entry.name}</span>
        <span className="ml-auto flex flex-shrink-0 items-center gap-1 pl-2">
          {downloading ? (
            <span className="flex items-center gap-1 text-[11px] text-gray-500 dark:text-zinc-400">
              <SpinnerGap size={11} className="animate-spin" />ダウンロード中…
            </span>
          ) : (
            <>
              <span className="text-[11px] text-gray-400 dark:text-zinc-500 group-hover:hidden group-focus-within:hidden">未ダウンロード</span>
              <button
                type="button"
                tabIndex={-1}
                onClick={e => { e.stopPropagation(); actions.current.download(entry) }}
                className="hidden items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-accent hover:bg-accent/10 group-hover:flex group-focus-within:flex"
              >
                <CloudArrowDown size={12} />ダウンロード
              </button>
            </>
          )}
        </span>
      </div>
    )
  }

  const FileIc = entry.isDirectory ? null : getFileIcon(entry.name, false)
  return (
    <div
      role="button"
      tabIndex={0}
      draggable
      onDragStart={e => actions.current.dragStart(entry, e)}
      onDragEnd={() => actions.current.dragEnd()}
      onDragOver={e => actions.current.dragOver(entry, e)}
      onDragLeave={e => { if (isDragOver) actions.current.dragLeave(entry, e) }}
      onDrop={e => actions.current.drop(entry, e)}
      onClick={e => actions.current.click(entry, e)}
      onDoubleClick={() => actions.current.doubleClick(entry)}
      onContextMenu={e => actions.current.contextMenu(entry, e)}
      onKeyDown={e => actions.current.keyDown(entry, e)}
      className={`
        w-full flex items-center gap-1.5 px-2 py-1 text-left text-sm cursor-pointer
        rounded-md transition-colors outline-none focus:ring-1 focus:ring-accent/50
        ${isHighlighted
          ? 'bg-accent/20 text-gray-900 dark:text-zinc-100'
          : 'text-gray-600 dark:text-zinc-400 hover:bg-gray-100 dark:hover:bg-white/[0.04] hover:text-gray-900 dark:hover:text-zinc-200'
        }
        ${isDragOver && entry.isDirectory ? 'ring-2 ring-accent bg-accent/10' : ''}
        ${isDragSource ? 'opacity-50' : ''}
      `}
      style={{ paddingLeft: `${8 + depth * 12}px` }}
    >
      <span className="flex-shrink-0 w-3 h-4 flex items-center justify-center">
        {entry.isDirectory && (
          isLoading ? (
            <SpinnerGap size={10} className="text-gray-400 dark:text-zinc-500 animate-spin" />
          ) : (
            <CaretRight
              size={10}
              className={`text-gray-400 dark:text-zinc-600 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
            />
          )
        )}
      </span>
      <span className="flex-shrink-0 w-4 h-4 flex items-center justify-center">
        {FileIc ? <FileIc size={14} /> : <FolderIcon size={14} isOpen={isExpanded} />}
      </span>
      <span className="truncate" title={entry.name}>{entry.name}</span>
      {privateRoot && (
        <span
          className="flex-shrink-0 text-indigo-500 dark:text-indigo-400"
          title={viewersLabel(privateRoot)}
          aria-label={`非公開（${privateRoot.viewerCount}人だけが見られます）`}
          data-private-folder
        >
          <LockSimple size={12} weight="fill" />
        </span>
      )}
      {showReadOnly && <ReadOnlyBadge compact />}
      {/* 依頼バッジ: UIからの依頼ボタンは非表示にしたが、
          Slack通知連携で review-request を再利用予定のため残してある */}
      {review === 'request' && (
        <span className="flex-shrink-0 ml-auto text-[9px] px-1 rounded bg-amber-500/20 text-amber-400" title="レビュー依頼あり">依頼</span>
      )}
      {review === 'unseen' && (
        <span className="flex-shrink-0 ml-auto w-2 h-2 rounded-full bg-amber-400 animate-pulse" title="新しいレビューあり" />
      )}
      {review === 'seen' && (
        <span className="flex-shrink-0 ml-auto w-1.5 h-1.5 rounded-full bg-blue-400" title="レビューあり" />
      )}
    </div>
  )
})

type TreeRowItem =
  | { kind: 'entry'; entry: FileEntry; depth: number }
  | { kind: 'empty'; key: string; depth: number }

export function FileTreePanel({
  rootPath,
  departmentFolder,
  selectedFilePath,
  onSelectFile,
  onDoubleClickFile,
  onPrivateFolderCreated,
}: FileTreePanelProps) {
  const { t } = useTranslation()
  const { isReadOnly } = useWriteAccess()
  // Private folders this member can read: lock icons, the banner, move confirmations.
  const privateFolders = usePrivateFolders()
  const companyId = useAppStore(s => s.currentCompany?.id)
  const meId = useAuthStore(s => s.user?.id)
  const [newFolder, setNewFolder] = useState<{ parentPath: string } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [moveConfirm, setMoveConfirm] = useState<{ title: string; message: string; confirm: string; run: () => Promise<void> } | null>(null)
  // Folders not downloaded on this computer: shown as greyed placeholders
  // (so nobody thinks they do not exist and recreates them), never written to.
  const sparse = useSparseCheckout({ rootPath })
  const [downloading, setDownloading] = useState<Set<string>>(new Set())
  const repoRel = useCallback((abs: string): string | null => {
    const root = normalizePathSeparators(rootPath).replace(/\/+$/, '')
    const p = normalizePathSeparators(abs)
    if (p === root) return ''
    return p.startsWith(`${root}/`) ? p.slice(root.length + 1) : null
  }, [rootPath])
  /** The not-downloaded folder an absolute path lies in, or null. */
  const notDownloadedOf = useCallback((abs: string): string | null => {
    const rel = repoRel(abs)
    return rel === null ? null : sparse.notDownloadedFolderOf(rel)
  }, [repoRel, sparse])
  /** Entries of `dirPath` with placeholders for the not-downloaded folders in it. */
  const withPlaceholders = useCallback((dirPath: string, entries: FileEntry[]): FileEntry[] => {
    const rel = repoRel(dirPath)
    if (rel === null || sparse.excludedPaths.length === 0) return entries
    if (rel !== '' && sparse.notDownloadedFolderOf(rel)) return []
    const prefix = rel === '' ? '' : `${pathKey(rel)}/`
    const extra = new Map<string, boolean>() // child name → is itself excluded
    for (const ex of sparse.excludedPaths) {
      const key = pathKey(ex)
      if (!key.startsWith(prefix)) continue
      const rest = ex.split('/').slice(rel === '' ? 0 : rel.split('/').length)
      if (rest.length === 0) continue
      extra.set(rest[0], (extra.get(rest[0]) ?? false) || rest.length === 1)
    }
    if (extra.size === 0) return entries
    const out = entries.map(e => {
      for (const [name, excluded] of extra) {
        if (excluded && e.isDirectory && pathKey(e.name) === pathKey(name)) return { ...e, notDownloaded: true }
      }
      return e
    })
    for (const [name, excluded] of extra) {
      if (out.some(e => pathKey(e.name) === pathKey(name))) continue
      out.push({ name: name.normalize('NFC'), path: `${dirPath}/${name}`, isDirectory: true, notDownloaded: excluded })
    }
    return sortEntries(out)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoRel, sparse.excludedPaths, sparse.notDownloadedFolderOf])

  const departmentPath = departmentFolder ? `${rootPath}/${departmentFolder}` : rootPath

  // The tree's data lives in a model per folder (src/lib/fileTreeModel.ts):
  // cached across department switches, fed by the company's watcher, loaded
  // lazily (a folder is read when expanded; an event re-reads only its parent).
  installModelEvents()
  const model = useMemo(() => getFileTreeModel(departmentPath, treeIO), [departmentPath])
  const treeVersion = useSyncExternalStore(model.subscribe, model.getVersion)
  useEffect(() => {
    if (rootPath) retainFileTreeModels(rootPath)
  }, [rootPath])
  useEffect(() => {
    if (!departmentPath) return
    perfMark('file_tree_panel.activate')
    void model.activate()
    return () => model.deactivate()
  }, [model, departmentPath])

  const [showDotFiles, setShowDotFiles] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const isLoading = model.initialLoading || refreshing

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

  // Determine the target directory for new file/folder creation based on current selection
  const activeParentPath = (() => {
    // The active editor tab may belong to another department (tabs survive
    // department switches): new files then go to this department's folder.
    if (!selectedFilePath || !isPathWithin(selectedFilePath, departmentPath)) return departmentPath
    // A folder the tree knows (O(1)) — else a file: use its parent directory.
    if (model.isDirectory(selectedFilePath)) return selectedFilePath
    return parentDir(selectedFilePath)
  })()

  /** Re-read the root and every open folder (the refresh button). */
  const refreshTree = useCallback(async () => {
    setRefreshing(true)
    try {
      await model.revalidateVisible()
    } finally {
      setRefreshing(false)
    }
  }, [model])

  /** Show an app-made change in `dir` (and open it so the new item is visible). */
  const showChangeIn = useCallback(async (dir: string, open = false) => {
    if (open && dir !== departmentPath && !model.isExpanded(dir)) await model.expand(dir)
    await model.invalidate(dir)
  }, [model, departmentPath])

  const downloadFolder = useCallback(async (entry: FileEntry) => {
    const folder = notDownloadedOf(entry.path)
    if (!folder) return
    setDownloading(prev => new Set(prev).add(entry.path))
    try {
      const result = await sparse.apply(sparse.excludedPaths.filter(e => pathKey(e) !== pathKey(folder)))
      if (!result.success) {
        setDropWarning(result.offline ? 'インターネットにつながっているときにダウンロードできます' : `ダウンロードできませんでした：${result.error ?? ''}`)
        setTimeout(() => setDropWarning(null), 5000)
      } else {
        void model.invalidate(parentDir(entry.path))
      }
    } finally {
      setDownloading(prev => { const n = new Set(prev); n.delete(entry.path); return n })
    }
  }, [notDownloadedOf, sparse, model])

  /** Refuse an action that would write into a folder that is not downloaded (the main process refuses too). */
  const refuseNotDownloaded = useCallback((absTarget: string): boolean => {
    const folder = notDownloadedOf(absTarget)
    if (!folder) return false
    setDropWarning(notDownloadedUserMessage(folder.normalize('NFC')))
    setTimeout(() => setDropWarning(null), 6000)
    return true
  }, [notDownloadedOf])

  /**
   * Refuse a folder name that a private folder the member cannot read already
   * uses (known to the main process only as a salted hash). The sentence names
   * only what the member typed. The main process refuses the write too.
   */
  const refuseReserved = useCallback(async (absTarget: string): Promise<boolean> => {
    let message: string | null = null
    try { message = await reservedPathRefusal(absTarget) } catch { /* older preload / preview: allow */ }
    if (!message) return false
    setDropWarning(message)
    setTimeout(() => setDropWarning(null), 6000)
    return true
  }, [])

  // Resolve a unique destination path (appends " (1)", " (2)" etc. if name already exists)
  const resolveUniquePath = useCallback(async (destDir: string, fileName: string): Promise<string> => {
    const destPath = `${destDir}/${fileName}`
    try {
      await getStats(destPath)
      const dotIdx = fileName.lastIndexOf('.')
      const base = dotIdx > 0 ? fileName.substring(0, dotIdx) : fileName
      const ext = dotIdx > 0 ? fileName.substring(dotIdx) : ''
      for (let i = 1; i < 100; i++) {
        const candidate = `${destDir}/${base} (${i})${ext}`
        try {
          await getStats(candidate)
        } catch {
          return candidate
        }
      }
    } catch {
      // Doesn't exist — use as-is
    }
    return destPath
  }, [])

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
      const destPath = await resolveUniquePath(destDir, file.name)

      const result = await moveFromExternal(file.path, destPath)
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
      void showChangeIn(destDir)
    }
  }, [resolveUniquePath, showChangeIn])

  // Without the company watcher (perf diagnostics), changes show on refresh only.
  useEffect(() => {
    if (isPerfCutEnabled('disableWatchers')) perfMark('file_tree_panel.watch.disabled')
  }, [])

  // The visible rows, depth-first: entries of expanded folders follow their folder.
  const rows = useMemo(() => {
    const out: TreeRowItem[] = []
    const walk = (dirPath: string, depth: number) => {
      const raw = model.listing(dirPath)
      const entries = withPlaceholders(dirPath, raw ? viewOfListing(raw, showDotFiles, isReviewSidecarFile) : [])
      for (const entry of entries) {
        out.push({ kind: 'entry', entry, depth })
        if (!entry.isDirectory || entry.notDownloaded || !model.isExpanded(entry.path)) continue
        const before = out.length
        walk(entry.path, depth + 1)
        if (out.length === before && !model.isLoading(entry.path)) {
          out.push({ kind: 'empty', key: `${entry.path}\0empty`, depth })
        }
      }
    }
    if (departmentPath) walk(departmentPath, 0)
    return out
    // treeVersion: the model changed (listings, expanded folders, loading).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, treeVersion, departmentPath, showDotFiles, withPlaceholders])

  // Flatten visible entries for shift+click range selection
  const visiblePaths = useMemo(
    () => rows.flatMap(r => (r.kind === 'entry' && !r.entry.notDownloaded ? [r.entry.path] : [])),
    [rows],
  )

  // Toggle directory expansion (reads it when never read or out of date)
  const toggleDir = useCallback((path: string) => {
    void model.toggle(path)
  }, [model])

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
    if (refuseNotDownloaded(`${parentPath}/_`)) { closeContextMenu(); return }
    setInputDialog({
      isOpen: true,
      title: t('fileTree.newFile'),
      defaultValue: '',
      mode: 'newFile',
      targetPath: '',
      parentPath,
    })
    closeContextMenu()
  }, [closeContextMenu, t, refuseNotDownloaded])

  const handleNewFolder = useCallback((parentPath: string) => {
    if (refuseNotDownloaded(`${parentPath}/_`)) { closeContextMenu(); return }
    setNewFolder({ parentPath })
    closeContextMenu()
  }, [closeContextMenu, refuseNotDownloaded])

  const showNotice = useCallback((message: string) => {
    setNotice(message)
    setTimeout(() => setNotice(null), 6000)
  }, [])

  /** A private folder itself cannot be moved or renamed here (it is its own repository on the server). */
  const refusePrivateRoot = useCallback((absPath: string, action: '移動' | '名前の変更'): boolean => {
    const root = privateFolders.privateRootAt(absPath)
    if (!root) return false
    setDropWarning(`非公開フォルダ「${lastSegment(root.path)}」そのものは、${action}ができません。必要なときは管理者に相談してください。`)
    setTimeout(() => setDropWarning(null), 6000)
    return true
  }, [privateFolders])

  const handleRename = useCallback((entry: FileEntry) => {
    if (refusePrivateRoot(entry.path, '名前の変更')) { closeContextMenu(); return }
    setInputDialog({
      isOpen: true,
      title: t('fileTree.rename'),
      defaultValue: entry.name,
      mode: 'rename',
      targetPath: entry.path,
      parentPath: parentDir(entry.path),
    })
    closeContextMenu()
  }, [closeContextMenu, t, refusePrivateRoot])

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

    // A name with a '/' could still lead into a folder that is not downloaded.
    if (refuseNotDownloaded(`${parentPath}/${value}`) || await refuseReserved(`${parentPath}/${value}`)) {
      setInputDialog(prev => ({ ...prev, isOpen: false }))
      return
    }

    if (mode === 'newFile') {
      const newPath = `${parentPath}/${value}`
      await createEmptyFile(newPath)
    } else if (mode === 'newFolder') {
      const newPath = `${parentPath}/${value}`
      await createDirectory(newPath)
    } else if (mode === 'rename') {
      const newPath = `${parentPath}/${value}`
      await renameItem(targetPath, newPath)
    }

    // Show it at once (the watcher reports it too) and open the parent so the new item is visible.
    await showChangeIn(parentPath, true)

    setInputDialog(prev => ({ ...prev, isOpen: false }))
  }, [inputDialog, showChangeIn, refuseNotDownloaded, refuseReserved])

  /** 公開 (or inside a private folder) from 「新しいフォルダ…」: on disk, as before. */
  const createPlainFolder = useCallback(async (parentPath: string, name: string) => {
    if (refuseNotDownloaded(`${parentPath}/${name}`) || await refuseReserved(`${parentPath}/${name}`)) { setNewFolder(null); return }
    await createDirectory(`${parentPath}/${name}`)
    await showChangeIn(parentPath, true)
    setNewFolder(null)
  }, [showChangeIn, refuseNotDownloaded, refuseReserved])

  // Internal drag & drop: confirm when files cross a private folder's edge
  // (public → private: their past versions stay in everyone's history;
  // private → public: everyone gets them). A private folder itself never moves.
  const requestMove = useCallback(async (sourcePaths: string[], destDir: string) => {
    const sources = sourcePaths.filter(src => destDir !== src && !destDir.startsWith(src + '/'))
    if (sources.some(src => refusePrivateRoot(src, '移動'))) return
    const run = async () => {
      for (const sourcePath of sources) {
        const fileName = sourcePath.split('/').pop()
        if (!fileName) continue
        const destPath = await resolveUniquePath(destDir, fileName)
        if (sourcePath === destPath) continue
        if (await refuseReserved(destPath)) break
        await moveItem(sourcePath, destPath)
      }
      setSelectedPaths(new Set())
      await Promise.all([destDir, ...sources.map(parentDir)].map(dir => model.invalidate(dir)))
    }
    const destRel = privateFolders.relativePath(`${destDir}/_`)
    const crossing = destRel === null ? null : sources
      .map(src => {
        const srcRel = privateFolders.relativePath(src)
        return srcRel === null ? null : boundaryCrossing(srcRel, destRel, privateFolders.folders)
      })
      .find(c => c !== null) ?? null
    if (!crossing) { await run(); return }
    const msg = crossingMessage(crossing, sources.length, '移動')
    setMoveConfirm({ ...msg, run })
  }, [privateFolders, refusePrivateRoot, resolveUniquePath, setSelectedPaths, refuseReserved, model])

  const handleDeleteConfirm = useCallback(async () => {
    const paths = confirmDialog.targetPaths || [confirmDialog.targetPath]
    const affectedParents = new Set<string>()

    for (const p of paths) {
      await deleteItem(p)
      affectedParents.add(parentDir(p))
    }

    setSelectedPaths(new Set())
    await Promise.all([...affectedParents].map(dir => model.invalidate(dir)))
    setConfirmDialog(prev => ({ ...prev, isOpen: false }))
  }, [confirmDialog, model, setSelectedPaths])

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
            const hasFolders = paths.some(p => model.isDirectory(p))
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

    if (entry?.notDownloaded) {
      return [
        {
          label: 'ダウンロード',
          icon: <CloudArrowDown size={16} />,
          onClick: () => { closeContextMenu(); void downloadFolder(entry) },
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
  }, [handleNewFile, handleNewFolder, handleRename, handleDelete, handleCopyPath, closeContextMenu, t, downloadFolder, model, setSelectedPaths])

  // Row behaviour behind one stable ref: rows are memoised and never need new callbacks.
  const rowActions = useRef<RowActions>(null as unknown as RowActions)
  rowActions.current = {
    click: (entry, e) => {
      if (e.shiftKey && lastClickedPath) {
        // Shift+click: range selection
        const startIdx = visiblePaths.indexOf(lastClickedPath)
        const endIdx = visiblePaths.indexOf(entry.path)
        if (startIdx !== -1 && endIdx !== -1) {
          const [from, to] = startIdx < endIdx ? [startIdx, endIdx] : [endIdx, startIdx]
          setSelectedPaths(new Set(visiblePaths.slice(from, to + 1)))
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
    },
    doubleClick: (entry) => {
      if (!entry.isDirectory && onDoubleClickFile) onDoubleClickFile(entry.path)
    },
    contextMenu: (entry, e) => {
      if (entry.notDownloaded) {
        handleContextMenu(e, entry, parentDir(entry.path))
        return
      }
      // If right-clicking on an unselected item while multi-selecting, add it to selection
      if (selectedPathsRef.current.size > 0 && !selectedPathsRef.current.has(entry.path)) {
        setSelectedPaths(prev => new Set(prev).add(entry.path))
      }
      handleContextMenu(e, entry, parentDir(entry.path))
    },
    keyDown: (entry, e) => {
      if (e.key === 'F2') {
        e.preventDefault()
        handleRename(entry)
      } else if (e.key === 'Delete') {
        e.preventDefault()
        handleDelete(entry)
      }
    },
    dragStart: (entry, e) => {
      // Alt/Option + drag: native drag to external apps (browser, Finder, Slack, etc.)
      if (e.altKey && !entry.isDirectory) {
        e.preventDefault()
        startDrag(entry.path)
        return
      }
      // Normal drag: internal tree move
      const selected = selectedPathsRef.current
      const paths = selected.has(entry.path) && selected.size > 1 ? [...selected] : [entry.path]
      setDragSourcePaths(new Set(paths))
      e.dataTransfer.setData('application/x-file-paths', JSON.stringify(paths))
      e.dataTransfer.effectAllowed = 'move'
    },
    dragEnd: () => {
      setDragSourcePaths(new Set())
      setDragOverPath(null)
    },
    dragOver: (entry, e) => {
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
    },
    dragLeave: (_entry, e) => {
      const rect = e.currentTarget.getBoundingClientRect()
      const { clientX, clientY } = e
      if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
        setDragOverPath(null)
      }
    },
    drop: (entry, e) => {
      e.preventDefault()
      e.stopPropagation()
      setDragOverPath(null)
      if (!entry.isDirectory) return
      // External file drop (from Finder etc.)
      if (e.dataTransfer.files.length > 0 && !e.dataTransfer.getData('application/x-file-paths')) {
        void handleExternalFileDrop(e.dataTransfer.files, entry.path)
        return
      }
      // Internal move
      const raw = e.dataTransfer.getData('application/x-file-paths')
      if (!raw) return
      const sourcePaths: string[] = JSON.parse(raw)
      void requestMove(sourcePaths, entry.path)
    },
    download: (entry) => { void downloadFolder(entry) },
    clearSelection: () => setSelectedPaths(new Set()),
  }

  /** The review badge of a file row (from its folder's names; sidecars are hidden). */
  const reviewBadgeOf = (entry: FileEntry): ReviewBadge => {
    if (entry.isDirectory) return null
    const raw = model.listing(parentDir(entry.path))
    const fileStatus = raw ? reviewStatusOfListing(raw, detectReviewStatus).get(entry.name) : undefined
    if (!fileStatus) return null
    if (fileStatus.hasRequest) return 'request'
    if (fileStatus.hasReview) return hasUnseenReviews(entry.path, fileStatus.reviewFileNames) ? 'unseen' : 'seen'
    return null
  }

  // 「🔒 非公開：N人だけが見られます」 while the selection (or the department) is inside a private folder.
  const currentPrivate = privateFolders.privateOf(`${activeParentPath}/_`) ?? privateFolders.privateOf(`${departmentPath}/_`)
  const newFolderParentRel = newFolder ? privateFolders.relativePath(newFolder.parentPath) ?? '' : ''
  // New file / folder from the header goes into the selection's folder: not into a placeholder.
  const parentNotDownloaded = notDownloadedOf(`${activeParentPath}/_`) !== null

  return (
    <div className="h-full flex flex-col bg-gray-50 dark:bg-zinc-900/50 border-r border-gray-200 dark:border-zinc-800/50 relative">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-200 dark:border-zinc-800/50">
        <span className="flex items-center gap-1.5 min-w-0">
          <span className="text-xs font-medium text-gray-500 dark:text-zinc-500 uppercase tracking-wider">
            {t('fileTree.title')}
          </span>
          {departmentPath && isReadOnly(departmentPath) && <ReadOnlyBadge compact />}
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
            onClick={() => { void refreshTree() }}
            disabled={isLoading}
            className="p-1 rounded hover:bg-gray-200 dark:hover:bg-white/[0.05] text-gray-500 dark:text-zinc-500 hover:text-gray-700 dark:hover:text-zinc-300 transition-colors disabled:opacity-50"
            title={t('fileTree.refresh')}
          >
            <ArrowClockwise size={14} className={isLoading ? 'animate-spin' : ''} />
          </button>
          <button
            onClick={() => handleNewFile(activeParentPath)}
            className="p-1 rounded hover:bg-gray-200 dark:hover:bg-white/[0.05] text-gray-500 dark:text-zinc-500 hover:text-gray-700 dark:hover:text-zinc-300 transition-colors disabled:opacity-40 disabled:pointer-events-none"
            disabled={parentNotDownloaded}
            title={parentNotDownloaded ? 'ダウンロードしていないフォルダには作成できません' : t('fileTree.newFile')}
          >
            <FilePlus size={14} />
          </button>
          <button
            onClick={() => handleNewFolder(activeParentPath)}
            className="p-1 rounded hover:bg-gray-200 dark:hover:bg-white/[0.05] text-gray-500 dark:text-zinc-500 hover:text-gray-700 dark:hover:text-zinc-300 transition-colors disabled:opacity-40 disabled:pointer-events-none"
            disabled={parentNotDownloaded}
            title={parentNotDownloaded ? 'ダウンロードしていないフォルダには作成できません' : t('fileTree.newFolder')}
          >
            <FolderPlus size={14} />
          </button>
        </div>
      </div>

      {currentPrivate && (
        <div
          role="note"
          title={viewersLabel(currentPrivate)}
          className="flex items-center gap-1.5 border-b border-indigo-100 bg-indigo-50 px-3 py-1.5 text-[11px] text-indigo-900 dark:border-indigo-400/15 dark:bg-indigo-400/[0.08] dark:text-indigo-100"
        >
          <LockSimple size={12} weight="fill" className="flex-shrink-0 text-indigo-500 dark:text-indigo-400" />
          <span className="truncate">
            <span className="font-medium">非公開：{currentPrivate.viewerCount}人だけが見られます</span>
            <span className="text-indigo-900/60 dark:text-indigo-200/60">（{lastSegment(currentPrivate.path)}）</span>
          </span>
        </div>
      )}

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
          await requestMove(sourcePaths, departmentPath)
        }}
      >
        {rows.length === 0 && !isLoading ? (
          <div className="px-3 py-4 text-center text-xs text-gray-400 dark:text-zinc-600">
            {t('fileTree.noFiles')}
          </div>
        ) : (
          rows.map(row => {
            if (row.kind === 'empty') {
              return (
                <div
                  key={row.key}
                  className="text-xs text-gray-400 dark:text-zinc-600 italic"
                  style={{ paddingLeft: `${20 + row.depth * 12}px` }}
                >
                  {t('fileTree.emptyFolder')}
                </div>
              )
            }
            const { entry, depth } = row
            // 閲覧のみ: badge where read-only starts (a top-level entry, or the parent is writable).
            const showReadOnly = entry.isDirectory && !entry.notDownloaded && isReadOnly(entry.path)
              && (depth === 0 || !isReadOnly(parentDir(entry.path)))
            return (
              <TreeRow
                key={entry.path}
                entry={entry}
                depth={depth}
                isExpanded={entry.isDirectory && model.isExpanded(entry.path)}
                isHighlighted={selectedPaths.has(entry.path) || selectedFilePath === entry.path}
                isLoading={entry.isDirectory && model.isLoading(entry.path)}
                isDragOver={dragOverPath === entry.path}
                isDragSource={dragSourcePaths.has(entry.path)}
                showReadOnly={showReadOnly}
                privateRoot={entry.isDirectory && !entry.notDownloaded ? privateFolders.privateRootAt(entry.path) : null}
                review={reviewBadgeOf(entry)}
                downloading={downloading.has(entry.path)}
                actions={rowActions}
              />
            )
          })
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

      <NewFolderDialog
        isOpen={newFolder !== null}
        companyId={companyId}
        meId={meId}
        parentRel={newFolderParentRel}
        placeLabel={newFolderParentRel ? newFolderParentRel.split('/').join(' / ') : '会社のフォルダ'}
        insidePrivate={newFolder ? privateFolders.privateOf(`${newFolder.parentPath}/_`) : null}
        onCancel={() => setNewFolder(null)}
        onCreatePlain={name => newFolder ? createPlainFolder(newFolder.parentPath, name) : undefined}
        onCreatedPrivate={(_result, name) => {
          setNewFolder(null)
          showNotice(`「${name}」を非公開フォルダとして作成しました。同期すると、あなたの手元に届きます。`)
          void privateFolders.reload()
          onPrivateFolderCreated?.()
        }}
      />

      {/* Crossing a private folder's edge */}
      <ConfirmDialog
        isOpen={moveConfirm !== null}
        title={moveConfirm?.title ?? ''}
        message={moveConfirm?.message ?? ''}
        confirmText={moveConfirm?.confirm}
        onConfirm={() => {
          const pending = moveConfirm
          setMoveConfirm(null)
          void pending?.run()
        }}
        onCancel={() => setMoveConfirm(null)}
      />

      {notice && (
        <div role="status" className="absolute bottom-2 left-2 right-2 flex items-start gap-1.5 px-3 py-2 rounded-md bg-indigo-50 border border-indigo-200 text-xs text-indigo-900 dark:bg-indigo-400/10 dark:border-indigo-400/25 dark:text-indigo-100">
          <LockSimple size={12} weight="fill" className="mt-0.5 flex-shrink-0 text-indigo-500" />
          <span>{notice}</span>
        </div>
      )}

      {/* Drop warning toast */}
      {dropWarning && (
        <div className="absolute bottom-2 left-2 right-2 px-3 py-2 rounded-md bg-red-500/10 border border-red-500/30 text-xs text-red-400 whitespace-pre-wrap">
          {dropWarning}
        </div>
      )}
    </div>
  )
}
