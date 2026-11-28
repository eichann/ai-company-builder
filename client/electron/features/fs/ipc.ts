// The company folder on disk, for the file tree and the editor. Every path
// from the renderer goes through the allowed-roots check (paths.validate);
// writes are refused inside a folder not downloaded on this computer, at a
// folder name the member may not use (a private folder they cannot read) and
// on a skill file they may not change, and a new file, rename, move or copy never replaces what is already there.
//   dialog:selectDirectory, fs:* (fs:startDrag is a send; fs:openVideo hands a video to the OS's app), fs:watch /
//   fs:unwatch (sends fs:changes), editor:backupBeforeOverwrite, editor:backupEdits, editor:saveImage

import fs from 'fs'
import path from 'path'
import type { DirectoryTreeNode, FileOpResult } from '../../../shared/ipc-contract'
import type { FileChange } from '../../company-watcher'
import type { IpcRegistrar } from '../../ipc/registrar'
import { keepCurrentVersion, keepGivenVersion } from '../backups/keep-current'
import { EDITOR_EDITS_REASON, EDITOR_EDITS_REASONS } from '../../../shared/editor-disk-state'
import type { DesktopShell, PathGuard, WindowPort } from '../ports'
import { NAME_TAKEN_MESSAGE } from '../../../shared/file-names'
import { isAtomicSaveRename, nameTaken, notDownloadedRefusal } from '../../file-guards'
import { createCompanyWatchers } from './watchers'
import { isVideoFileName } from '../../../shared/video-files'
import { DROP_WORDS, dropRefusal } from '../../../shared/file-drop'
import { LINK_ESCAPE_MESSAGE, OUTSIDE_ROOTS_MESSAGE } from '../../allowed-roots'
import { DOCUMENT_IMAGE_FOLDER, DOCUMENT_IMAGE_WORDS, documentImageAddress, documentImageKind, documentImageName, documentImageRefusal } from '../../../shared/document-images'

export interface FsDeps {
  paths: PathGuard
  shell: Pick<DesktopShell, 'selectDirectory' | 'startDrag' | 'openPath'>
  window: WindowPort
  /**
   * The sentence when changing `absPath` is refused: a folder name the member
   * may not use (a private folder they cannot read), a skill file they may not
   * change; null to allow.
   */
  writeRefusal: (absPath: string) => Promise<string | null>
  /** The folder-name half alone: creating an empty folder. */
  reservedRefusal: (absPath: string) => Promise<string | null>
  /** Watcher batches, before they reach the window (the skills cache drops stale scans). */
  onFileChanges?: (changes: FileChange[]) => void
  /** The clock a pasted image's name comes from (tests fix it). */
  now?: () => Date
}

export interface FsFeature {
  /** Close every company watcher (app quit). */
  closeWatchers(): void
}

const TAKEN: FileOpResult = { success: false, error: NAME_TAKEN_MESSAGE, code: 'name_taken' }

const TREE_SKIP_DIRS = new Set(['node_modules', '.git', '.backups', '.workspace', '__pycache__', '.next', '.nuxt', 'dist', '.venv', 'venv'])

export function registerFsIpc(ipc: IpcRegistrar, deps: FsDeps): FsFeature {
  const { paths, shell, writeRefusal, reservedRefusal } = deps
  const now = deps.now ?? (() => new Date())
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

  // A video the editor cannot play, opened in the OS's app for it. openPath launches whatever it
  // is given (an .app, a script): only a .mp4 / .mov name, a regular file and no link.
  ipc.handle('fs:openVideo', async (_, filePath: string) => {
    try {
      const safePath = paths.validate(filePath)
      if (!isVideoFileName(path.basename(safePath))) return { success: false, error: 'Not a video' }
      if (!(await fs.promises.lstat(safePath)).isFile()) return { success: false, error: 'Not a video' }
      const problem = await shell.openPath(safePath)
      return problem ? { success: false, error: problem } : { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  // Saving (the editor, the review sidecars): replaces the file on purpose.
  ipc.handle('fs:writeFile', async (_, filePath: string, content: string) => {
    try {
      const safePath = paths.validate(filePath)
      if (notDownloadedRefusal(safePath) || await writeRefusal(safePath)) return false
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
      const refused = notDownloadedRefusal(safePath) ?? await writeRefusal(safePath)
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

  // Before the editor drops a tab's unsaved edits — for the version that arrived
  // (［届いた版を採用］) or on leaving (［保存せずに進む］): keep the edits, which were never on
  // disk, as a version of the file.
  ipc.handle('editor:backupEdits', async (_, rootPath: string, filePath: string, content: string, reason?: unknown) => {
    try {
      const root = paths.validate(rootPath)
      const safePath = paths.validate(filePath)
      if (typeof content !== 'string') return { success: false, error: 'No text to keep' }
      const why = reason === undefined ? EDITOR_EDITS_REASON : EDITOR_EDITS_REASONS.find(r => r === reason)
      if (!why) return { success: false, error: 'Unknown reason' }
      return await keepGivenVersion(paths, root, safePath, Buffer.from(content, 'utf-8'), why)
    } catch (error) {
      console.error('[editor] backup of the edits failed:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  // An image pasted or dropped into a document edited in place (files-and-editor.md "Images in a
  // document"): the renderer hands the bytes and which document; main makes the place and the name
  // (`images/` beside it, the date and time, `wx`) and answers only the address to write.
  ipc.handle('editor:saveImage', async (_, documentPath: string, bytes: unknown) => {
    try {
      const doc = paths.validate(documentPath)
      if (!/\.(md|markdown)$/i.test(doc) || !(await fs.promises.lstat(doc)).isFile()) return { success: false, error: DOCUMENT_IMAGE_WORDS.failed }
      const data = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : ArrayBuffer.isView(bytes) ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : null
      if (!data) return { success: false, error: DOCUMENT_IMAGE_WORDS.type }
      const kind = documentImageKind(data)
      const notAnImage = documentImageRefusal(data)
      if (notAnImage || !kind) return { success: false, error: notAnImage ?? DOCUMENT_IMAGE_WORDS.type }
      const root = paths.rootOf(doc)
      if (root && await fs.promises.realpath(root) === await fs.promises.realpath(path.dirname(doc))) return { success: false, error: DOCUMENT_IMAGE_WORDS.topLevel }
      const folder = paths.validate(path.join(path.dirname(doc), DOCUMENT_IMAGE_FOLDER))
      const at = now()
      const first = path.join(folder, documentImageName(at, kind))
      const refused = notDownloadedRefusal(first) ?? await writeRefusal(first)
      if (refused) return { success: false, error: refused }
      await fs.promises.mkdir(folder).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'EEXIST') throw e })
      // The folder itself, never a link (even one pointing inside) or a file named `images`.
      if (!(await fs.promises.lstat(folder)).isDirectory()) return { success: false, error: DOCUMENT_IMAGE_WORDS.folder }
      for (let attempt = 0; attempt < 100; attempt++) {
        const name = documentImageName(at, kind, attempt)
        const target = paths.validate(path.join(folder, name))
        try {
          await fs.promises.writeFile(target, data, { flag: 'wx' })
          return { success: true, address: documentImageAddress(name) }
        } catch (error) {
          if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error
        }
      }
      return { success: false, error: NAME_TAKEN_MESSAGE }
    } catch (error) {
      // The allowed roots' refusals as they are; a disk error (EACCES, ENOSPC) in a plain sentence, not Node's text.
      const message = error instanceof Error ? error.message : ''
      return { success: false, error: message === LINK_ESCAPE_MESSAGE || message === OUTSIDE_ROOTS_MESSAGE ? message : DOCUMENT_IMAGE_WORDS.failed }
    }
  })

  ipc.handle('fs:createDirectory', async (_, dirPath: string) => {
    try {
      const safePath = paths.validate(dirPath)
      // An empty folder is never shared, so the skill rule has nothing to say here.
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
      const refused = await writeRefusal(safePath)
      if (refused) return { success: false, error: refused, code: 'refused' as const }
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
      const refused = notDownloadedRefusal(safeNew) ?? await writeRefusal(safeOld) ?? await writeRefusal(safeNew)
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
      const refused = notDownloadedRefusal(safeDest) ?? await writeRefusal(safeSrc) ?? await writeRefusal(safeDest)
      if (refused) return { success: false, error: refused }
      if (await nameTaken(safeDest, safeSrc)) return TAKEN
      await fs.promises.rename(safeSrc, safeDest)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  // A Finder drop, copied in: the original (a camera's card, the Desktop) is never moved or
  // deleted (owner, 2026-11-26). The source lies outside by design and is only read; the
  // destination is checked like any write, and main decides the drop rule (type, size).
  ipc.handle('fs:copyFromExternal', async (_, sourcePath: string, destinationPath: string) => {
    let made: 'file' | 'folder' | null = null
    let safeDest = ''
    try {
      safeDest = paths.validate(destinationPath)
      const resolved = path.resolve(sourcePath)
      const refused = notDownloadedRefusal(safeDest) ?? await writeRefusal(safeDest)
      if (refused) return { success: false, error: refused }
      if (await nameTaken(safeDest)) return TAKEN
      const source = await fs.promises.stat(resolved)
      if (!source.isFile() && !source.isDirectory()) return { success: false, error: DROP_WORDS.type }
      const tooMuch = dropRefusal(path.basename(safeDest), { isDirectory: source.isDirectory(), size: source.size })
      if (tooMuch) return { success: false, error: tooMuch }
      if (source.isDirectory()) {
        // Made first and alone (no replace), then filled; removed again if the copy fails.
        await fs.promises.mkdir(safeDest)
        made = 'folder'
        await fs.promises.cp(resolved, safeDest, { recursive: true, force: false, errorOnExist: true })
      } else {
        made = 'file'
        await fs.promises.copyFile(resolved, safeDest, fs.constants.COPYFILE_EXCL)
      }
      return { success: true }
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : null
      // What this call made is removed (a half copy: a full disk, the card pulled out); never
      // a name someone else took meanwhile (EEXIST: copyFile / mkdir made nothing).
      if (made && code !== 'EEXIST') await fs.promises.rm(safeDest, { recursive: made === 'folder', force: true }).catch(() => {})
      if (code === 'EEXIST') return TAKEN
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  // Copy file or folder
  ipc.handle('fs:copy', async (_, sourcePath: string, destinationPath: string) => {
    try {
      const safeSrc = paths.validate(sourcePath)
      const safeDest = paths.validate(destinationPath)
      const refused = notDownloadedRefusal(safeDest) ?? await writeRefusal(safeDest)
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
