import { useCallback, useState } from 'react'
import { boundaryCrossing, crossingMessage } from '../../../../shared/private-folder-ui'
import { droppedFilePath, getStats, moveFromExternal, moveItem, startDrag } from '../api'
import type { FileEntry, FileTreeModel } from '../fileTreeModel'
import { FILE_PATHS_DRAG_TYPE, FILE_TREE_EFFECT_ALLOWED } from '../../../shared/lib/dragTypes'
import type { SetSelectedPaths } from './useTreeSelection'
import type { usePrivateFolders } from './usePrivateFolders'

// What a Finder drop may bring in. The only list: main's fs:moveFromExternal
// checks the destination, not the type. HTML is shown in the sandboxed
// document view (doc-frame.md), so it is allowed like any other document.
const ALLOWED_DROP_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg',
  'md', 'txt', 'csv', 'pdf', 'docx', 'xlsx', 'pptx', 'html', 'htm',
  'json', 'yaml', 'yml',
])
const MAX_DROP_FILE_SIZE = 20 * 1024 * 1024 // 20MB
const INTERNAL_PATHS = FILE_PATHS_DRAG_TYPE

const parentDir = (p: string) => p.substring(0, p.lastIndexOf('/'))
/** Where a drop on this row goes: a folder takes it, a file hands it to its own folder. */
const dropDirOf = (entry: FileEntry) => (entry.isDirectory ? entry.path : parentDir(entry.path))

// Resolve a unique destination path (appends " (1)", " (2)" etc. if name already exists)
async function resolveUniquePath(destDir: string, fileName: string): Promise<string> {
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
}

export interface MoveConfirm { title: string; message: string; confirm: string; run: () => Promise<void> }

interface Deps {
  model: FileTreeModel
  privateFolders: ReturnType<typeof usePrivateFolders>
  selectedPathsRef: React.MutableRefObject<Set<string>>
  setSelectedPaths: SetSelectedPaths
  showChangeIn: (dir: string, open?: boolean) => Promise<void>
  refusePrivateRoot: (absPath: string, action: '移動' | '名前の変更') => boolean
  refuseReserved: (absTarget: string) => Promise<boolean>
  warn: (message: string, ms: number) => void
}

/**
 * Drag & drop: moves inside the tree (confirmed when they cross a private
 * folder's edge), files dropped from Finder, and Alt-drag out to other apps.
 */
export function useTreeDragDrop({ model, privateFolders, selectedPathsRef, setSelectedPaths, showChangeIn, refusePrivateRoot, refuseReserved, warn }: Deps) {
  const [dragOverPath, setDragOverPath] = useState<string | null>(null)
  const [dragSourcePaths, setDragSourcePaths] = useState<Set<string>>(new Set())
  const [moveConfirm, setMoveConfirm] = useState<MoveConfirm | null>(null)

  const dropFromOutside = useCallback(async (fileList: FileList, destDir: string) => {
    const warnings: string[] = []
    let moved = 0

    for (const file of Array.from(fileList)) {
      const sourcePath = droppedFilePath(file)
      if (!sourcePath) continue

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

      const destPath = await resolveUniquePath(destDir, file.name)
      const result = await moveFromExternal(sourcePath, destPath)
      if (result.success) {
        moved++
      } else {
        warnings.push(`${file.name}: ${result.error || '移動に失敗'}`)
      }
    }

    if (warnings.length > 0) warn(warnings.join('\n'), 5000)
    if (moved > 0) void showChangeIn(destDir)
  }, [showChangeIn, warn])

  // Public → private: their past versions stay in everyone's history;
  // private → public: everyone gets them. A private folder itself never moves.
  const requestMove = useCallback(async (sourcePaths: string[], destDir: string) => {
    // Not into itself or below it, and not where it already is (a drop on a
    // sibling file would otherwise move it to 「name (1)」 beside itself).
    const sources = sourcePaths.filter(src => destDir !== src && !destDir.startsWith(src + '/') && parentDir(src) !== destDir)
    if (sources.length === 0) return
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
  }, [privateFolders, refusePrivateRoot, setSelectedPaths, refuseReserved, model])

  /** A drop onto `destDir`: files from Finder, or rows dragged inside the tree. */
  const dropInto = (e: React.DragEvent, destDir: string) => {
    if (e.dataTransfer.files.length > 0 && !e.dataTransfer.getData(INTERNAL_PATHS)) {
      return dropFromOutside(e.dataTransfer.files, destDir)
    }
    const raw = e.dataTransfer.getData(INTERNAL_PATHS)
    if (!raw) return
    const sourcePaths: string[] = JSON.parse(raw)
    return requestMove(sourcePaths, destDir)
  }

  const row = {
    dragStart: (entry: FileEntry, e: React.DragEvent) => {
      // Alt/Option + drag: native drag to external apps (browser, Finder, Slack, etc.)
      if (e.altKey && !entry.isDirectory) {
        e.preventDefault()
        startDrag(entry.path)
        return
      }
      const selected = selectedPathsRef.current
      const paths = selected.has(entry.path) && selected.size > 1 ? [...selected] : [entry.path]
      setDragSourcePaths(new Set(paths))
      e.dataTransfer.setData(INTERNAL_PATHS, JSON.stringify(paths))
      e.dataTransfer.effectAllowed = FILE_TREE_EFFECT_ALLOWED
    },
    dragEnd: () => {
      setDragSourcePaths(new Set())
      setDragOverPath(null)
    },
    dragOver: (entry: FileEntry, e: React.DragEvent) => {
      const destDir = dropDirOf(entry)
      if (dragSourcePaths.size > 0) {
        if (dragSourcePaths.has(destDir)) return
        for (const src of dragSourcePaths) {
          if (destDir.startsWith(src + '/')) return
        }
        // Already there (a sibling file or its own folder): nothing would move.
        if ([...dragSourcePaths].every(src => parentDir(src) === destDir)) return
      }
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = 'move'
      // Over a file, its folder's row lights up (none for the department's own files).
      setDragOverPath(destDir)
    },
    dragLeave: (_entry: FileEntry, e: React.DragEvent) => {
      const rect = e.currentTarget.getBoundingClientRect()
      const { clientX, clientY } = e
      if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
        setDragOverPath(null)
      }
    },
    drop: (entry: FileEntry, e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setDragOverPath(null)
      void dropInto(e, dropDirOf(entry))
    },
  }

  /** The tree's empty space: a drop there goes to the department folder. */
  const background = {
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
    },
    onDrop: async (e: React.DragEvent, departmentPath: string) => {
      e.preventDefault()
      setDragOverPath(null)
      await dropInto(e, departmentPath)
    },
  }

  const confirmMove = () => {
    const pending = moveConfirm
    setMoveConfirm(null)
    void pending?.run()
  }
  const cancelMove = () => setMoveConfirm(null)

  return { dragOverPath, dragSourcePaths, moveConfirm, confirmMove, cancelMove, row, background }
}
