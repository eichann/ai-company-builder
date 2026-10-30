import { useCallback, useState } from 'react'
import { normalizePathSeparators } from '../../../utils/path'
import { useSparseCheckout } from '../../../hooks/useSparseCheckout'
import { notDownloadedUserMessage, pathKey } from '../../../../shared/sparse-paths'
import type { FileEntry, FileTreeModel } from '../fileTreeModel'

// Sort entries: directories first, then files, alphabetically
const sortEntries = (entries: FileEntry[]): FileEntry[] =>
  entries.sort((a, b) => {
    if (a.isDirectory && !b.isDirectory) return -1
    if (!a.isDirectory && b.isDirectory) return 1
    return a.name.localeCompare(b.name)
  })

const parentDir = (p: string) => p.substring(0, p.lastIndexOf('/'))

/**
 * Folders not downloaded on this computer: shown as greyed placeholders (so
 * nobody thinks they do not exist and recreates them), never written to, and
 * downloaded with one click (download-choices.md).
 */
export function useNotDownloadedFolders(
  rootPath: string,
  model: FileTreeModel,
  warn: (message: string, ms: number) => void,
) {
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

  const downloadFolder = useCallback(async (entry: FileEntry) => {
    const folder = notDownloadedOf(entry.path)
    if (!folder) return
    setDownloading(prev => new Set(prev).add(entry.path))
    try {
      const result = await sparse.apply(sparse.excludedPaths.filter(e => pathKey(e) !== pathKey(folder)))
      if (!result.success) {
        warn(result.offline ? 'インターネットにつながっているときにダウンロードできます' : `ダウンロードできませんでした：${result.error ?? ''}`, 5000)
      } else {
        void model.invalidate(parentDir(entry.path))
      }
    } finally {
      setDownloading(prev => { const n = new Set(prev); n.delete(entry.path); return n })
    }
  }, [notDownloadedOf, sparse, model, warn])

  /** Refuse an action that would write into a folder that is not downloaded (the main process refuses too). */
  const refuseNotDownloaded = useCallback((absTarget: string): boolean => {
    const folder = notDownloadedOf(absTarget)
    if (!folder) return false
    warn(notDownloadedUserMessage(folder.normalize('NFC')), 6000)
    return true
  }, [notDownloadedOf, warn])

  return { downloading, notDownloadedOf, withPlaceholders, downloadFolder, refuseNotDownloaded }
}
