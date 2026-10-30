import { useCallback, useRef, useState } from 'react'
import type { FileEntry } from '../fileTreeModel'

export type SetSelectedPaths = (update: Set<string> | ((prev: Set<string>) => Set<string>)) => void

/** The tree's multi-selection: ⌘/Ctrl+click toggles, shift+click selects a range, a plain click opens. */
export function useTreeSelection() {
  // The ref is updated synchronously so right-click snapshots are always accurate.
  const [selectedPaths, _setSelectedPaths] = useState<Set<string>>(new Set())
  const selectedPathsRef = useRef<Set<string>>(selectedPaths)
  const setSelectedPaths = useCallback<SetSelectedPaths>((update) => {
    const next = typeof update === 'function' ? update(selectedPathsRef.current) : update
    selectedPathsRef.current = next
    _setSelectedPaths(next)
  }, [])
  const [lastClickedPath, setLastClickedPath] = useState<string | null>(null)

  /** A row click; `open` runs for a plain click (folder: expand / collapse, file: open). */
  const click = (entry: FileEntry, e: React.MouseEvent, visiblePaths: string[], open: (entry: FileEntry) => void) => {
    if (e.shiftKey && lastClickedPath) {
      const startIdx = visiblePaths.indexOf(lastClickedPath)
      const endIdx = visiblePaths.indexOf(entry.path)
      if (startIdx !== -1 && endIdx !== -1) {
        const [from, to] = startIdx < endIdx ? [startIdx, endIdx] : [endIdx, startIdx]
        setSelectedPaths(new Set(visiblePaths.slice(from, to + 1)))
      }
    } else if (e.metaKey || e.ctrlKey) {
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
      setSelectedPaths(new Set())
      setLastClickedPath(entry.path)
      open(entry)
    }
  }

  return { selectedPaths, selectedPathsRef, setSelectedPaths, click }
}

export interface TreeContextMenu {
  position: { x: number; y: number }
  entry: FileEntry | null
  parentPath: string
  selectedSnapshot: Set<string>
}

/** The right-click menu's position and target, with the selection as it was at that moment. */
export function useTreeContextMenu(
  selection: Pick<ReturnType<typeof useTreeSelection>, 'selectedPaths' | 'selectedPathsRef' | 'setSelectedPaths'>,
  departmentPath: string,
) {
  const { selectedPaths, selectedPathsRef, setSelectedPaths } = selection
  const [contextMenu, setContextMenu] = useState<TreeContextMenu | null>(null)

  const openFor = useCallback((e: React.MouseEvent, entry: FileEntry | null, parentPath: string) => {
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
  }, [selectedPathsRef])

  const close = useCallback(() => {
    setContextMenu(null)
  }, [])

  /** Right-click on a row; one outside the selection while several are selected joins it. */
  const onRow = (entry: FileEntry, e: React.MouseEvent, parentPath: string) => {
    if (entry.notDownloaded) {
      openFor(e, entry, parentPath)
      return
    }
    if (selectedPathsRef.current.size > 0 && !selectedPathsRef.current.has(entry.path)) {
      setSelectedPaths(prev => new Set(prev).add(entry.path))
    }
    openFor(e, entry, parentPath)
  }

  const onBackground = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setContextMenu({
      position: { x: e.clientX, y: e.clientY },
      entry: null,
      parentPath: departmentPath,
      selectedSnapshot: new Set(selectedPaths),
    })
  }, [departmentPath, selectedPaths])

  return { contextMenu, close, onRow, onBackground }
}
