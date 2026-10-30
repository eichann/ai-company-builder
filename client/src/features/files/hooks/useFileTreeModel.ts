import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { isPerfCutEnabled, perfMark } from '../../../lib/perfDiagnostics'
import { subscribeFileChanges } from '../../../lib/fileEvents'
import { isReviewSidecarFile } from '../../doc-review/model'
import { readDirectory, readDirectoryTree } from '../api'
import {
  applyEventsToFileTreeModels,
  getFileTreeModel,
  retainFileTreeModels,
  viewOfListing,
  type FileEntry,
  type FileTreeIO,
  type FileTreeModel,
  type RawDirEntry,
} from '../fileTreeModel'
import type { TreeRowItem } from '../components/TreeRow'

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

/**
 * The tree's data: a model per folder (../fileTreeModel.ts), cached across
 * department switches, fed by the company's watcher, loaded lazily (a folder
 * is read when expanded; an event re-reads only its parent).
 */
export function useFileTreeModel(rootPath: string, departmentPath: string) {
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

  const [refreshing, setRefreshing] = useState(false)
  const isLoading = model.initialLoading || refreshing

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

  // Without the company watcher (perf diagnostics), changes show on refresh only.
  useEffect(() => {
    if (isPerfCutEnabled('disableWatchers')) perfMark('file_tree_panel.watch.disabled')
  }, [])

  return { model, treeVersion, isLoading, refreshTree, showChangeIn }
}

/** The visible rows, depth-first: entries of expanded folders follow their folder. */
export function useVisibleRows(
  model: FileTreeModel,
  treeVersion: number,
  departmentPath: string,
  showDotFiles: boolean,
  withPlaceholders: (dirPath: string, entries: FileEntry[]) => FileEntry[],
) {
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
  return { rows, visiblePaths }
}
