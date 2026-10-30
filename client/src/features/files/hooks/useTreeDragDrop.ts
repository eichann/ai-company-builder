import { useCallback, useState } from 'react'
import { boundaryCrossing, crossingMessage } from '../../../../shared/private-folder-ui'
import { getStats, moveFromExternal, moveItem, startDrag } from '../api'
import type { FileEntry, FileTreeModel } from '../fileTreeModel'
import type { SetSelectedPaths } from './useTreeSelection'
import type { usePrivateFolders } from './usePrivateFolders'

// Allowed file extensions for external drop
const ALLOWED_DROP_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg',
  'md', 'txt', 'csv', 'pdf', 'docx', 'xlsx', 'pptx',
  'json', 'yaml', 'yml',
])
const MAX_DROP_FILE_SIZE = 20 * 1024 * 1024 // 20MB
const INTERNAL_PATHS = 'application/x-file-paths'

const parentDir = (p: string) => p.substring(0, p.lastIndexOf('/'))

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

      const destPath = await resolveUniquePath(destDir, file.name)
      const result = await moveFromExternal(file.path, destPath)
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
      e.dataTransfer.effectAllowed = 'move'
    },
    dragEnd: () => {
      setDragSourcePaths(new Set())
      setDragOverPath(null)
    },
    dragOver: (entry: FileEntry, e: React.DragEvent) => {
      if (!entry.isDirectory) return
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
      if (!entry.isDirectory) return
      void dropInto(e, entry.path)
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
