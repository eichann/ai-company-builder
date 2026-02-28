import { useState, useRef, useCallback } from 'react'
import { useAppStore } from '../../stores/appStore'
import type { FileEntry } from '../../types'
import {
  CaretRight,
  CaretDown,
  File,
  FolderSimple,
  Robot,
  FilePlus,
  FolderPlus,
  PencilSimple,
  Trash,
  Copy,
} from '@phosphor-icons/react'
import { ContextMenu, type ContextMenuItem } from '../common/ContextMenu'
import { InputDialog } from '../common/InputDialog'
import { ConfirmDialog } from '../common/ConfirmDialog'

interface FileTreeProps {
  onRefresh?: () => void
}

export function FileTree({ onRefresh }: FileTreeProps) {
  const { fileTree, showDotFiles, currentCompany, addFileTreeEntry, removeFileTreeEntry } = useAppStore()

  // Filter dot files if needed
  const filteredTree = showDotFiles
    ? fileTree
    : fileTree.filter((entry) => !entry.name.startsWith('.'))

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

  // Handle context menu on background (for creating in root)
  const handleBackgroundContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      if (currentCompany?.rootPath) {
        setContextMenu({
          position: { x: e.clientX, y: e.clientY },
          entry: null,
          parentPath: currentCompany.rootPath,
        })
      }
    },
    [currentCompany?.rootPath]
  )

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, entry: FileEntry, parentPath: string) => {
      e.preventDefault()
      e.stopPropagation()
      setContextMenu({
        position: { x: e.clientX, y: e.clientY },
        entry,
        parentPath,
      })
    },
    []
  )

  const closeContextMenu = useCallback(() => {
    setContextMenu(null)
  }, [])

  // File operations
  const handleNewFile = useCallback((parentPath: string) => {
    setInputDialog({
      isOpen: true,
      title: '新規ファイル',
      defaultValue: '',
      mode: 'newFile',
      targetPath: '',
      parentPath,
    })
    closeContextMenu()
  }, [closeContextMenu])

  const handleNewFolder = useCallback((parentPath: string) => {
    setInputDialog({
      isOpen: true,
      title: '新規フォルダ',
      defaultValue: '',
      mode: 'newFolder',
      targetPath: '',
      parentPath,
    })
    closeContextMenu()
  }, [closeContextMenu])

  const handleRename = useCallback((entry: FileEntry) => {
    setInputDialog({
      isOpen: true,
      title: '名前を変更',
      defaultValue: entry.name,
      mode: 'rename',
      targetPath: entry.path,
      parentPath: entry.path.substring(0, entry.path.lastIndexOf('/')),
    })
    closeContextMenu()
  }, [closeContextMenu])

  const handleDelete = useCallback((entry: FileEntry) => {
    setConfirmDialog({
      isOpen: true,
      title: '削除の確認',
      message: `「${entry.name}」を削除しますか？${entry.isDirectory ? 'フォルダ内のすべてのファイルも削除されます。' : ''}この操作は取り消せません。`,
      targetPath: entry.path,
    })
    closeContextMenu()
  }, [closeContextMenu])

  const handleCopyPath = useCallback((entry: FileEntry) => {
    navigator.clipboard.writeText(entry.path)
    closeContextMenu()
  }, [closeContextMenu])

  // Dialog confirmations
  const handleInputConfirm = useCallback(
    async (value: string) => {
      const { mode, targetPath, parentPath } = inputDialog

      if (mode === 'newFile') {
        const newPath = `${parentPath}/${value}`
        const success = await window.electronAPI.writeFile(newPath, '')
        if (success) {
          addFileTreeEntry(parentPath, {
            name: value,
            path: newPath,
            isDirectory: false,
          })
          onRefresh?.()
        }
      } else if (mode === 'newFolder') {
        const newPath = `${parentPath}/${value}`
        const success = await window.electronAPI.createDirectory(newPath)
        if (success) {
          addFileTreeEntry(parentPath, {
            name: value,
            path: newPath,
            isDirectory: true,
            children: [],
          })
          onRefresh?.()
        }
      } else if (mode === 'rename') {
        const newPath = `${parentPath}/${value}`
        const result = await window.electronAPI.renameItem(targetPath, newPath)
        if (result.success) {
          onRefresh?.()
        }
      }

      setInputDialog((prev) => ({ ...prev, isOpen: false }))
    },
    [inputDialog, addFileTreeEntry, onRefresh]
  )

  const handleDeleteConfirm = useCallback(async () => {
    const { targetPath } = confirmDialog
    const result = await window.electronAPI.deleteItem(targetPath)
    if (result.success) {
      removeFileTreeEntry(targetPath)
    }
    setConfirmDialog((prev) => ({ ...prev, isOpen: false }))
  }, [confirmDialog, removeFileTreeEntry])

  // Build context menu items
  const getContextMenuItems = useCallback(
    (entry: FileEntry | null, parentPath: string): ContextMenuItem[] => {
      if (!entry) {
        // Background context menu (root level)
        return [
          {
            label: '新規ファイル',
            icon: <FilePlus size={16} />,
            onClick: () => handleNewFile(parentPath),
          },
          {
            label: '新規フォルダ',
            icon: <FolderPlus size={16} />,
            onClick: () => handleNewFolder(parentPath),
          },
        ]
      }

      const items: ContextMenuItem[] = []

      if (entry.isDirectory) {
        items.push(
          {
            label: '新規ファイル',
            icon: <FilePlus size={16} />,
            onClick: () => handleNewFile(entry.path),
          },
          {
            label: '新規フォルダ',
            icon: <FolderPlus size={16} />,
            onClick: () => handleNewFolder(entry.path),
          },
          { label: '', divider: true, onClick: () => {} }
        )
      }

      items.push(
        {
          label: '名前を変更',
          icon: <PencilSimple size={16} />,
          shortcut: 'F2',
          onClick: () => handleRename(entry),
        },
        {
          label: '削除',
          icon: <Trash size={16} />,
          shortcut: 'Del',
          danger: true,
          onClick: () => handleDelete(entry),
        },
        { label: '', divider: true, onClick: () => {} },
        {
          label: 'パスをコピー',
          icon: <Copy size={16} />,
          onClick: () => handleCopyPath(entry),
        }
      )

      return items
    },
    [handleNewFile, handleNewFolder, handleRename, handleDelete, handleCopyPath]
  )

  return (
    <div className="text-sm" onContextMenu={handleBackgroundContextMenu}>
      {filteredTree.length === 0 ? (
        <div className="px-4 py-8 text-center text-text-secondary text-xs">
          フォルダが空です
        </div>
      ) : (
        filteredTree.map((entry) => (
          <FileTreeItem
            key={entry.path}
            entry={entry}
            depth={0}
            showDotFiles={showDotFiles}
            onContextMenu={handleContextMenu}
            onRename={handleRename}
            onDelete={handleDelete}
            parentPath={currentCompany?.rootPath || ''}
          />
        ))
      )}

      {contextMenu && (
        <ContextMenu
          items={getContextMenuItems(contextMenu.entry, contextMenu.entry?.isDirectory ? contextMenu.entry.path : contextMenu.parentPath)}
          position={contextMenu.position}
          onClose={closeContextMenu}
        />
      )}

      <InputDialog
        isOpen={inputDialog.isOpen}
        title={inputDialog.title}
        defaultValue={inputDialog.defaultValue}
        placeholder={inputDialog.mode === 'newFile' ? 'filename.txt' : inputDialog.mode === 'newFolder' ? 'folder-name' : ''}
        onConfirm={handleInputConfirm}
        onCancel={() => setInputDialog((prev) => ({ ...prev, isOpen: false }))}
      />

      <ConfirmDialog
        isOpen={confirmDialog.isOpen}
        title={confirmDialog.title}
        message={confirmDialog.message}
        confirmText="削除"
        danger
        onConfirm={handleDeleteConfirm}
        onCancel={() => setConfirmDialog((prev) => ({ ...prev, isOpen: false }))}
      />
    </div>
  )
}

interface FileTreeItemProps {
  entry: FileEntry
  depth: number
  showDotFiles: boolean
  onContextMenu: (e: React.MouseEvent, entry: FileEntry, parentPath: string) => void
  onRename: (entry: FileEntry) => void
  onDelete: (entry: FileEntry) => void
  parentPath: string
}

function FileTreeItem({
  entry,
  depth,
  showDotFiles,
  onContextMenu,
  onRename,
  onDelete,
  parentPath,
}: FileTreeItemProps) {
  const { expandedPaths, toggleExpanded, openFile, selectedFile, setSelectedFile } =
    useAppStore()
  const isExpanded = expandedPaths.has(entry.path)
  const isSelected = selectedFile?.path === entry.path
  const isAgentFile = entry.name === 'AGENT.md' || entry.name === '.agent'
  const itemRef = useRef<HTMLDivElement>(null)

  // Filter children for dot files
  const filteredChildren = entry.children
    ? showDotFiles
      ? entry.children
      : entry.children.filter((child) => !child.name.startsWith('.'))
    : []

  function handleClick() {
    setSelectedFile(entry)
    if (entry.isDirectory) {
      toggleExpanded(entry.path)
    } else {
      openFile(entry)
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'F2') {
      e.preventDefault()
      onRename(entry)
    } else if (e.key === 'Delete') {
      e.preventDefault()
      onDelete(entry)
    }
  }

  return (
    <div>
      <div
        ref={itemRef}
        className={`flex items-center gap-1 px-2 py-0.5 cursor-pointer hover:bg-white/5 outline-none focus:bg-white/10 ${
          isSelected ? 'bg-white/10' : ''
        }`}
        style={{ paddingLeft: depth * 12 + 8 }}
        onClick={handleClick}
        onContextMenu={(e) => onContextMenu(e, entry, parentPath)}
        onKeyDown={handleKeyDown}
        tabIndex={0}
      >
        {entry.isDirectory ? (
          <>
            {isExpanded ? (
              <CaretDown size={12} className="text-text-secondary" />
            ) : (
              <CaretRight size={12} className="text-text-secondary" />
            )}
            <FolderSimple
              size={16}
              weight="fill"
              className={isAgentFile ? 'text-purple-400' : 'text-yellow-500'}
            />
          </>
        ) : (
          <>
            <span className="w-3" />
            {isAgentFile ? (
              <Robot size={16} className="text-purple-400" />
            ) : (
              <File size={16} className="text-text-secondary" />
            )}
          </>
        )}
        <span className={`truncate ${isAgentFile ? 'text-purple-400' : ''}`}>
          {entry.name}
        </span>
      </div>

      {entry.isDirectory && isExpanded && filteredChildren.length > 0 && (
        <div>
          {filteredChildren.map((child) => (
            <FileTreeItem
              key={child.path}
              entry={child}
              depth={depth + 1}
              showDotFiles={showDotFiles}
              onContextMenu={onContextMenu}
              onRename={onRename}
              onDelete={onDelete}
              parentPath={entry.path}
            />
          ))}
        </div>
      )}
    </div>
  )
}
