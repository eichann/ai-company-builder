import { useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LockSimple } from '@phosphor-icons/react'
import { ContextMenu } from '../../../shared/ui/ContextMenu'
import { InputDialog } from '../../../shared/ui/InputDialog'
import { ConfirmDialog } from '../../../shared/ui/ConfirmDialog'
import { isPathWithin } from '../../../shared/lib/path'
import { useWriteAccess } from '../../../hooks/useWriteAccess'
import { useAppStore } from '../../../stores/appStore'
import { useAuthStore } from '../../../stores/authStore'
import { detectReviewStatus, hasUnseenReviews } from '../../doc-review/model'
import { reviewStatusOfListing, type FileEntry } from '../fileTreeModel'
import { treeMenuItems } from '../contextMenuItems'
import { usePrivateFolders } from '../hooks/usePrivateFolders'
import { useFileTreeModel, useVisibleRows } from '../hooks/useFileTreeModel'
import { useNotDownloadedFolders } from '../hooks/useNotDownloadedFolders'
import { useTreeContextMenu, useTreeSelection } from '../hooks/useTreeSelection'
import { useFileOperations } from '../hooks/useFileOperations'
import { useTreeDragDrop } from '../hooks/useTreeDragDrop'
import { NewFolderDialog } from './NewFolderDialog'
import { FileTreeHeader, PrivateFolderBanner } from './FileTreeHeader'
import { TreeRow, type ReviewBadge, type RowActions } from './TreeRow'

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

const parentDir = (p: string) => p.substring(0, p.lastIndexOf('/'))

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
  const departmentPath = departmentFolder ? `${rootPath}/${departmentFolder}` : rootPath

  const [notice, setNotice] = useState<string | null>(null)
  const [dropWarning, setDropWarning] = useState<string | null>(null)
  const warn = useCallback((message: string, ms: number) => {
    setDropWarning(message)
    setTimeout(() => setDropWarning(null), ms)
  }, [])
  const showNotice = useCallback((message: string) => {
    setNotice(message)
    setTimeout(() => setNotice(null), 6000)
  }, [])

  const [showDotFiles, setShowDotFiles] = useState(true)
  const { model, treeVersion, isLoading, refreshTree, showChangeIn } = useFileTreeModel(rootPath, departmentPath)
  const notDownloaded = useNotDownloadedFolders(rootPath, model, warn)
  const { rows, visiblePaths } = useVisibleRows(model, treeVersion, departmentPath, showDotFiles, notDownloaded.withPlaceholders)
  const selection = useTreeSelection()
  const menu = useTreeContextMenu(selection, departmentPath)
  const ops = useFileOperations({
    model,
    privateFolders,
    setSelectedPaths: selection.setSelectedPaths,
    showChangeIn,
    refuseNotDownloaded: notDownloaded.refuseNotDownloaded,
    closeContextMenu: menu.close,
    warn,
  })
  const dnd = useTreeDragDrop({
    model,
    privateFolders,
    selectedPathsRef: selection.selectedPathsRef,
    setSelectedPaths: selection.setSelectedPaths,
    showChangeIn,
    refusePrivateRoot: ops.refusePrivateRoot,
    refuseReserved: ops.refuseReserved,
    warn,
  })

  // The target directory for new file/folder creation, from the current selection
  const activeParentPath = (() => {
    // The active editor tab may belong to another department (tabs survive
    // department switches): new files then go to this department's folder.
    if (!selectedFilePath || !isPathWithin(selectedFilePath, departmentPath)) return departmentPath
    // A folder the tree knows (O(1)) — else a file: use its parent directory.
    if (model.isDirectory(selectedFilePath)) return selectedFilePath
    return parentDir(selectedFilePath)
  })()

  // Row behaviour behind one stable ref: rows are memoised and never need new callbacks.
  const rowActions = useRef<RowActions>(null as unknown as RowActions)
  rowActions.current = {
    click: (entry, e) => selection.click(entry, e, visiblePaths, opened => {
      if (opened.isDirectory) void model.toggle(opened.path)
      else onSelectFile(opened.path)
    }),
    doubleClick: (entry) => {
      if (!entry.isDirectory && onDoubleClickFile) onDoubleClickFile(entry.path)
    },
    contextMenu: (entry, e) => menu.onRow(entry, e, parentDir(entry.path)),
    keyDown: (entry, e) => {
      if (e.key === 'F2') {
        e.preventDefault()
        ops.rename(entry)
      } else if (e.key === 'Delete') {
        e.preventDefault()
        ops.askDelete(entry)
      }
    },
    ...dnd.row,
    download: (entry) => { void notDownloaded.downloadFolder(entry) },
    clearSelection: () => selection.setSelectedPaths(new Set()),
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

  const currentPrivate = privateFolders.privateOf(`${activeParentPath}/_`) ?? privateFolders.privateOf(`${departmentPath}/_`)
  const newFolder = ops.newFolder
  const newFolderParentRel = newFolder ? privateFolders.relativePath(newFolder.parentPath) ?? '' : ''
  const parentNotDownloaded = notDownloaded.notDownloadedOf(`${activeParentPath}/_`) !== null
  const { contextMenu } = menu

  return (
    <div className="h-full flex flex-col bg-gray-50 dark:bg-zinc-900/50 border-r border-gray-200 dark:border-zinc-800/50 relative">
      <FileTreeHeader
        readOnly={!!departmentPath && isReadOnly(departmentPath)}
        showDotFiles={showDotFiles}
        onToggleDotFiles={() => setShowDotFiles(!showDotFiles)}
        isLoading={isLoading}
        onRefresh={() => { void refreshTree() }}
        parentNotDownloaded={parentNotDownloaded}
        onNewFile={() => ops.newFile(activeParentPath)}
        onNewFolder={() => ops.newFolderIn(activeParentPath)}
      />

      {currentPrivate && <PrivateFolderBanner folder={currentPrivate} />}

      <div
        className="flex-1 overflow-auto py-2 px-1"
        onContextMenu={menu.onBackground}
        onDragOver={dnd.background.onDragOver}
        onDrop={e => dnd.background.onDrop(e, departmentPath)}
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
                isHighlighted={selection.selectedPaths.has(entry.path) || selectedFilePath === entry.path}
                isLoading={entry.isDirectory && model.isLoading(entry.path)}
                isDragOver={dnd.dragOverPath === entry.path}
                isDragSource={dnd.dragSourcePaths.has(entry.path)}
                showReadOnly={showReadOnly}
                privateRoot={entry.isDirectory && !entry.notDownloaded ? privateFolders.privateRootAt(entry.path) : null}
                review={reviewBadgeOf(entry)}
                downloading={notDownloaded.downloading.has(entry.path)}
                actions={rowActions}
              />
            )
          })
        )}
      </div>

      {contextMenu && (
        <ContextMenu
          items={treeMenuItems(
            contextMenu.entry,
            contextMenu.entry?.isDirectory ? contextMenu.entry.path : contextMenu.parentPath,
            contextMenu.selectedSnapshot,
            { ...ops, download: entry => { void notDownloaded.downloadFolder(entry) }, closeContextMenu: menu.close },
            t,
          )}
          position={contextMenu.position}
          onClose={menu.close}
        />
      )}

      <InputDialog
        isOpen={ops.inputDialog.isOpen}
        title={ops.inputDialog.title}
        defaultValue={ops.inputDialog.defaultValue}
        placeholder={ops.inputDialog.mode === 'newFile' ? 'filename.txt' : ops.inputDialog.mode === 'newFolder' ? 'folder-name' : ''}
        onConfirm={ops.confirmInput}
        onCancel={ops.cancelInput}
      />

      <ConfirmDialog
        isOpen={ops.confirmDialog.isOpen}
        title={ops.confirmDialog.title}
        message={ops.confirmDialog.message}
        confirmText={t('common.delete')}
        danger
        onConfirm={ops.confirmDelete}
        onCancel={ops.cancelDelete}
      />

      <NewFolderDialog
        isOpen={newFolder !== null}
        companyId={companyId}
        meId={meId}
        parentRel={newFolderParentRel}
        placeLabel={newFolderParentRel ? newFolderParentRel.split('/').join(' / ') : '会社のフォルダ'}
        insidePrivate={newFolder ? privateFolders.privateOf(`${newFolder.parentPath}/_`) : null}
        onCancel={() => ops.setNewFolder(null)}
        onCreatePlain={name => newFolder ? ops.createPlainFolder(newFolder.parentPath, name) : undefined}
        onCreatedPrivate={(_result, name) => {
          ops.setNewFolder(null)
          showNotice(`「${name}」を非公開フォルダとして作成しました。同期すると、あなたの手元に届きます。`)
          void privateFolders.reload()
          onPrivateFolderCreated?.()
        }}
      />

      {/* Crossing a private folder's edge */}
      <ConfirmDialog
        isOpen={dnd.moveConfirm !== null}
        title={dnd.moveConfirm?.title ?? ''}
        message={dnd.moveConfirm?.message ?? ''}
        confirmText={dnd.moveConfirm?.confirm}
        onConfirm={dnd.confirmMove}
        onCancel={dnd.cancelMove}
      />

      {notice && (
        <div role="status" className="absolute bottom-2 left-2 right-2 flex items-start gap-1.5 px-3 py-2 rounded-md bg-indigo-50 border border-indigo-200 text-xs text-indigo-900 dark:bg-indigo-400/10 dark:border-indigo-400/25 dark:text-indigo-100">
          <LockSimple size={12} weight="fill" className="mt-0.5 flex-shrink-0 text-indigo-500" />
          <span>{notice}</span>
        </div>
      )}

      {dropWarning && (
        <div className="absolute bottom-2 left-2 right-2 px-3 py-2 rounded-md bg-red-500/10 border border-red-500/30 text-xs text-red-400 whitespace-pre-wrap">
          {dropWarning}
        </div>
      )}
    </div>
  )
}
