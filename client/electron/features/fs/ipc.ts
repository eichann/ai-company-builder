// The company folder on disk, for the file tree and the editor. Every path
// from the renderer goes through the allowed-roots check (paths.validate);
// writes are refused inside a folder not downloaded on this computer and at
// a folder name the member may not use (a private folder they cannot read).
//   dialog:selectDirectory, fs:* (fs:startDrag is a send), fs:watch /
//   fs:unwatch (sends fs:changes), editor:backupBeforeOverwrite

import fs from 'fs'
import path from 'path'
import { notDownloadedUserMessage } from '../../../shared/sparse-paths'
import { editorOverwriteBackupPlan, type EditorOverwriteBackupMetadata } from '../../../shared/editor-disk-state'
import type { DirectoryTreeNode } from '../../../shared/ipc-contract'
import type { FileChange } from '../../company-watcher'
import type { IpcRegistrar } from '../../ipc/registrar'
import { notDownloadedFolderFor } from '../../sync/not-downloaded'
import { privateBackupsDir, readPrivateScopesCache } from '../../sync/private-folders'
import type { DesktopShell, PathGuard, WindowPort } from '../ports'
import { createCompanyWatchers } from './watchers'

export interface FsDeps {
  paths: PathGuard
  shell: Pick<DesktopShell, 'selectDirectory' | 'startDrag'>
  window: WindowPort
  /**
   * The server's sentence when creating `absPath` would use a folder name the
   * member may not use (a private folder they cannot read); null to allow.
   */
  reservedRefusal: (absPath: string) => Promise<string | null>
  /** Watcher batches, before they reach the window (the skills cache drops stale scans). */
  onFileChanges?: (changes: FileChange[]) => void
}

export interface FsFeature {
  /** Close every company watcher (app quit). */
  closeWatchers(): void
}

/**
 * Refuse an app file operation that would create or change something inside
 * a folder not downloaded on this computer (sparse exclusions): the member
 * cannot see the teammates' files there, and sync would hold the file back
 * instead of sharing it. The renderer disables these actions with the same
 * explanation; this is the backstop. Returns the message, or null to allow.
 */
function notDownloadedRefusal(absPath: string): string | null {
  const folder = notDownloadedFolderFor(absPath)
  if (folder !== null) {
    console.warn(`[fs] Refused a write into a folder that is not downloaded: ${absPath}`)
    return notDownloadedUserMessage(folder.normalize('NFC'))
  }
  return null
}

const TREE_SKIP_DIRS = new Set(['node_modules', '.git', '.backups', '.workspace', '__pycache__', '.next', '.nuxt', 'dist', '.venv', 'venv'])

export function registerFsIpc(ipc: IpcRegistrar, deps: FsDeps): FsFeature {
  const { paths, shell, reservedRefusal } = deps
  const watchers = createCompanyWatchers(changes => {
    deps.onFileChanges?.(changes)
    deps.window.send('fs:changes', changes)
  })

  // IPC Handlers for file system operations
  ipc.handle('dialog:selectDirectory', async () => {
    const selected = await shell.selectDirectory()
    if (selected) {
      paths.add(selected)
    }
    return selected
  })

  // Register a directory as allowed for file system access (called when company folder is set)
  ipc.handle('fs:registerAllowedRoot', async (_, dirPath: string) => {
    if (dirPath && typeof dirPath === 'string') {
      paths.add(dirPath)
    }
    return { success: true }
  })

  ipc.handle('fs:readDirectory', async (_, dirPath: string) => {
    try {
      const safePath = paths.validate(dirPath)
      const entries = await fs.promises.readdir(safePath, { withFileTypes: true })
      return entries.map(entry => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
        path: path.join(safePath, entry.name),
      }))
    } catch {
      return []
    }
  })



  ipc.handle('fs:readDirectoryTree', async (_, dirPath: string, maxDepth: number = 2) => {
    try {
      const safePath = paths.validate(dirPath)
      const readLevel = async (dir: string, depth: number): Promise<DirectoryTreeNode[]> => {
        const entries = await fs.promises.readdir(dir, { withFileTypes: true })
        const results = await Promise.all(entries.map(async (entry) => {
          const entryPath = path.join(dir, entry.name)
          const isDir = entry.isDirectory()
          const node: DirectoryTreeNode = {
            name: entry.name,
            isDirectory: isDir,
            path: entryPath,
          }
          if (isDir && depth < maxDepth && !TREE_SKIP_DIRS.has(entry.name)) {
            try {
              node.children = await readLevel(entryPath, depth + 1)
            } catch {
              node.children = []
            }
          }
          return node
        }))
        return results
      }
      return await readLevel(safePath, 0)
    } catch {
      return []
    }
  })

  ipc.handle('fs:readFile', async (_, filePath: string) => {
    try {
      const safePath = paths.validate(filePath)
      return await fs.promises.readFile(safePath, 'utf-8')
    } catch {
      return null
    }
  })

  ipc.handle('fs:readFileBinary', async (_, filePath: string) => {
    try {
      const safePath = paths.validate(filePath)
      const buffer = await fs.promises.readFile(safePath)
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
    } catch {
      return null
    }
  })

  ipc.handle('fs:writeFile', async (_, filePath: string, content: string) => {
    try {
      const safePath = paths.validate(filePath)
      if (notDownloadedRefusal(safePath) || await reservedRefusal(safePath)) return false
      await fs.promises.writeFile(safePath, content, 'utf-8')
      return true
    } catch {
      return false
    }
  })

  // Before the editor overwrites a file someone else changed since the tab
  // loaded it (the member confirmed): keep the disk version, byte for byte, in
  // .backups/<ts>_editor_overwrite/ — or .git/acb-private-backups/ for a file in
  // a private folder (never in that folder's working tree). Plan and rules:
  // shared/editor-disk-state.ts.
  ipc.handle('editor:backupBeforeOverwrite', async (_, rootPath: string, filePath: string) => {
    try {
      const root = paths.validate(rootPath)
      const safePath = paths.validate(filePath)
      let bytes: Buffer
      try {
        bytes = await fs.promises.readFile(safePath)
      } catch {
        return { success: true, skipped: 'missing' as const }
      }
      let insideNestedRepo = false
      for (let dir = path.dirname(safePath); dir.startsWith(root + path.sep); dir = path.dirname(dir)) {
        if (fs.existsSync(path.join(dir, '.git'))) { insideNestedRepo = true; break }
      }
      const cache = readPrivateScopesCache(root)
      const plan = editorOverwriteBackupPlan({
        rootPath: root,
        filePath: safePath,
        privateFolders: cache ? [...cache.scopes, ...(cache.pendingPublic ?? [])].map(s => s.path) : [],
        insideNestedRepo,
        now: new Date(),
      })
      if ('skip' in plan) return { success: true, skipped: plan.skip }
      const backupDir = path.join(plan.privateFolder ? privateBackupsDir(root) : path.join(root, '.backups'), plan.folder)
      // Inside the company by its real location too (.backups could be a link).
      const target = paths.validate(path.join(backupDir, ...plan.rel.split('/')))
      await fs.promises.mkdir(path.dirname(target), { recursive: true })
      await fs.promises.writeFile(target, bytes)
      const metadata: EditorOverwriteBackupMetadata = {
        timestamp: new Date().toISOString(),
        reason: 'editor_overwrite',
        files: [plan.rel],
        privateFolder: plan.privateFolder,
      }
      await fs.promises.writeFile(path.join(backupDir, '_metadata.json'), JSON.stringify(metadata, null, 2))
      return { success: true, backupPath: backupDir }
    } catch (error) {
      console.error('[editor] backup before overwrite failed:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  ipc.handle('fs:createDirectory', async (_, dirPath: string) => {
    try {
      const safePath = paths.validate(dirPath)
      if (notDownloadedRefusal(safePath) || await reservedRefusal(safePath)) return false
      await fs.promises.mkdir(safePath, { recursive: true })
      return true
    } catch {
      return false
    }
  })

  ipc.handle('fs:exists', async (_, targetPath: string) => {
    try {
      const safePath = paths.validate(targetPath)
      await fs.promises.access(safePath)
      return true
    } catch {
      return false
    }
  })

  // Delete file or folder
  ipc.handle('fs:delete', async (_, targetPath: string) => {
    try {
      // The entry itself: deleting a link removes the link, never its target.
      const safePath = paths.validate(targetPath, { followFinal: false })
      const stat = await fs.promises.lstat(safePath)
      if (stat.isDirectory()) {
        await fs.promises.rm(safePath, { recursive: true })
      } else {
        await fs.promises.unlink(safePath)
      }
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  // Rename file or folder
  ipc.handle('fs:rename', async (_, oldPath: string, newPath: string) => {
    try {
      const safeOld = paths.validate(oldPath, { followFinal: false })
      const safeNew = paths.validate(newPath)
      const refused = notDownloadedRefusal(safeNew) ?? await reservedRefusal(safeNew)
      if (refused) return { success: false, error: refused }
      await fs.promises.rename(safeOld, safeNew)
      return { success: true, newPath: safeNew }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  // Move file or folder
  ipc.handle('fs:move', async (_, sourcePath: string, destinationPath: string) => {
    try {
      const safeSrc = paths.validate(sourcePath, { followFinal: false })
      const safeDest = paths.validate(destinationPath)
      const refused = notDownloadedRefusal(safeDest) ?? await reservedRefusal(safeDest)
      if (refused) return { success: false, error: refused }
      await fs.promises.rename(safeSrc, safeDest)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  // Move file from external location (e.g. Finder drop)
  // Source path is NOT validated (external), only destination is validated
  ipc.handle('fs:moveFromExternal', async (_, sourcePath: string, destinationPath: string) => {
    try {
      const safeDest = paths.validate(destinationPath)
      const resolved = path.resolve(sourcePath)
      const refused = notDownloadedRefusal(safeDest) ?? await reservedRefusal(safeDest)
      if (refused) return { success: false, error: refused }

      try {
        await fs.promises.rename(resolved, safeDest)
      } catch (err: unknown) {
        if (err && typeof err === 'object' && 'code' in err && err.code === 'EXDEV') {
          // Cross-volume: copy then delete original
          const stat = await fs.promises.stat(resolved)
          if (stat.isDirectory()) {
            await fs.promises.cp(resolved, safeDest, { recursive: true })
            await fs.promises.rm(resolved, { recursive: true, force: true })
          } else {
            await fs.promises.copyFile(resolved, safeDest)
            await fs.promises.unlink(resolved)
          }
        } else {
          throw err
        }
      }
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  // Copy file or folder
  ipc.handle('fs:copy', async (_, sourcePath: string, destinationPath: string) => {
    try {
      const safeSrc = paths.validate(sourcePath)
      const safeDest = paths.validate(destinationPath)
      const refused = notDownloadedRefusal(safeDest) ?? await reservedRefusal(safeDest)
      if (refused) return { success: false, error: refused }
      const stat = await fs.promises.stat(safeSrc)
      if (stat.isDirectory()) {
        await fs.promises.cp(safeSrc, safeDest, { recursive: true })
      } else {
        await fs.promises.copyFile(safeSrc, safeDest)
      }
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  // Get file/folder stats
  ipc.handle('fs:stat', async (_, targetPath: string) => {
    try {
      const safePath = paths.validate(targetPath)
      const stat = await fs.promises.stat(safePath)
      return {
        success: true,
        data: {
          isDirectory: stat.isDirectory(),
          isFile: stat.isFile(),
          size: stat.size,
          mtime: stat.mtime.toISOString(),
          ctime: stat.ctime.toISOString(),
        }
      }
    } catch {
      return { success: false }
    }
  })

  // Native drag to external apps (browser, Finder, Slack, etc.)
  ipc.on('fs:startDrag', (event, filePath: string) => {
    const safePath = paths.validate(filePath)
    shell.startDrag(event.sender, safePath)
  })

  // Watch a company folder: one recursive watcher for the whole company, kept
  // open across department switches. Idempotent; a folder inside an already
  // watched one is covered by it.
  ipc.handle('fs:watch', async (_, rootPath: string) => {
    try {
      watchers.watch(paths.validate(rootPath))
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  // Stop watching a company folder (the company was closed or switched).
  ipc.handle('fs:unwatch', async (_, rootPath: string) => {
    try {
      watchers.unwatch(paths.validate(rootPath))
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  return { closeWatchers: () => watchers.closeAll() }
}
