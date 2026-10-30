import type { TFunction } from 'i18next'
import { Copy, CloudArrowDown, FilePlus, FolderPlus, PencilSimple, Trash } from '@phosphor-icons/react'
import type { ContextMenuItem } from '../../shared/ui/ContextMenu'
import type { FileEntry } from './fileTreeModel'

export interface TreeMenuActions {
  newFile: (parentPath: string) => void
  newFolderIn: (parentPath: string) => void
  rename: (entry: FileEntry) => void
  askDelete: (entry: FileEntry) => void
  askDeleteMany: (paths: string[]) => void
  copyPath: (entry: FileEntry) => void
  download: (entry: FileEntry) => void
  closeContextMenu: () => void
}

/**
 * The right-click menu: several selected → delete them; a not-downloaded
 * folder → download; empty space → new file / folder; a row → its actions.
 */
export function treeMenuItems(
  entry: FileEntry | null,
  parentPath: string,
  snapshot: Set<string> | undefined,
  actions: TreeMenuActions,
  t: TFunction,
): ContextMenuItem[] {
  // Multi-select context menu using snapshot from right-click moment
  const effectiveSelection = snapshot || new Set<string>()
  if (effectiveSelection.size > 1) {
    return [
      {
        label: `${effectiveSelection.size}件を削除`,
        icon: <Trash size={16} />,
        danger: true,
        onClick: () => actions.askDeleteMany([...effectiveSelection]),
      },
    ]
  }

  if (entry?.notDownloaded) {
    return [
      {
        label: 'ダウンロード',
        icon: <CloudArrowDown size={16} />,
        onClick: () => { actions.closeContextMenu(); actions.download(entry) },
      },
    ]
  }

  if (!entry) {
    return [
      { label: t('fileTree.newFile'), icon: <FilePlus size={16} />, onClick: () => actions.newFile(parentPath) },
      { label: t('fileTree.newFolder'), icon: <FolderPlus size={16} />, onClick: () => actions.newFolderIn(parentPath) },
    ]
  }

  const items: ContextMenuItem[] = []
  if (entry.isDirectory) {
    items.push(
      { label: t('fileTree.newFile'), icon: <FilePlus size={16} />, onClick: () => actions.newFile(entry.path) },
      { label: t('fileTree.newFolder'), icon: <FolderPlus size={16} />, onClick: () => actions.newFolderIn(entry.path) },
      { label: '', divider: true, onClick: () => {} },
    )
  }
  items.push(
    { label: t('fileTree.rename'), icon: <PencilSimple size={16} />, shortcut: 'F2', onClick: () => actions.rename(entry) },
    { label: t('common.delete'), icon: <Trash size={16} />, shortcut: 'Del', danger: true, onClick: () => actions.askDelete(entry) },
    { label: '', divider: true, onClick: () => {} },
    { label: t('fileTree.copyPath'), icon: <Copy size={16} />, onClick: () => actions.copyPath(entry) },
  )
  return items
}
