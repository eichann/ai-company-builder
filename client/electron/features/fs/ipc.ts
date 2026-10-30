// The company folder on disk, for the file tree and the editor. Every path
// from the renderer goes through the allowed-roots check (paths.validate);
// writes are refused inside a folder not downloaded on this computer and at
// a folder name the member may not use (a private folder they cannot read),
// and a new file, rename, move or copy never replaces what is already there.
//   dialog:selectDirectory, fs:* (fs:startDrag is a send), fs:watch /
//   fs:unwatch (sends fs:changes), editor:backupBeforeOverwrite

import fs from 'fs'
import path from 'path'
import type { DirectoryTreeNode, FileOpResult } from '../../../shared/ipc-contract'
import type { FileChange } from '../../company-watcher'
import type { IpcRegistrar } from '../../ipc/registrar'
import { keepCurrentVersion } from '../backups/keep-current'
import type { DesktopShell, PathGuard, WindowPort } from '../ports'
import { NAME_TAKEN_MESSAGE } from '../../../shared/file-names'
import { isAtomicSaveRename, nameTaken, notDownloadedRefusal } from './file-guards'
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

const TAKEN: FileOpResult = { success: false, error: NAME_TAKEN_MESSAGE, code: 'name_taken' }

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

  // Saving (the editor, the review sidecars): replaces the file on purpose.
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

  // A new file (the file tree's 新規ファイル, a new skill's SKILL.md): never
  // replaces one that exists — writeFile did, and silently emptied it.
  ipc.handle('fs:createFile', async (_, filePath: string, content: string) => {
    try {
      const safePath = paths.validate(filePath)
      const refused = notDownloadedRefusal(safePath) ?? await reservedRefusal(safePath)
      if (refused) return { success: false, error: refused }
      await fs.promises.writeFile(safePath, typeof content === 'string' ? content : '', { encoding: 'utf-8', flag: 'wx' })
      return { success: true }
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') return TAKEN
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  // Before the editor overwrites a file someone else changed since the tab
  // loaded it (the member confirmed): keep the disk version (features/backups/keep-current.ts).
  ipc.handle('editor:backupBeforeOverwrite', async (_, rootPath: string, filePath: string) => {
    try {
      const root = paths.validate(rootPath)
      const safePath = paths.validate(filePath)
      return await keepCurrentVersion(paths, root, safePath, 'editor_overwrite')
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
      if (!isAtomicSaveRename(safeOld, safeNew) && await nameTaken(safeNew, safeOld)) return TAKEN
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
      if (await nameTaken(safeDest, safeSrc)) return TAKEN
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
      if (await nameTaken(safeDest)) return TAKEN

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
      if (await nameTaken(safeDest)) return TAKEN
      const stat = await fs.promises.stat(safeSrc)
      if (stat.isDirectory()) {
        await fs.promises.cp(safeSrc, safeDest, { recursive: true, force: false, errorOnExist: true })
      } else {
        await fs.promises.copyFile(safeSrc, safeDest, fs.constants.COPYFILE_EXCL)
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
