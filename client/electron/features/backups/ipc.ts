// Backups sync (and the editor) made of the member's versions: list them,
// put a file back, show a backup folder. Two places: .backups/ in the
// working tree, and the private folders' backups inside .git
// (sync/private-folders.ts privateBackupsDir), listed with ids `private:…`.
//   backup:list, backup:restore, backup:openFolder

import fs from 'fs'
import path from 'path'
import { privateBackupsDir } from '../../sync/private-folders'
import type { IpcRegistrar } from '../../ipc/registrar'
import type { DesktopShell, PathGuard } from '../ports'

/** backup:list ids of private folders' backups (kept in .git, privateBackupsDir). */
export const PRIVATE_BACKUP_ID_PREFIX = 'private:'

export interface BackupsDeps {
  paths: PathGuard
  shell: Pick<DesktopShell, 'openPath'>
}

export function registerBackupsIpc(ipc: IpcRegistrar, { paths, shell }: BackupsDeps): void {
  // Get backup history
  ipc.handle('backup:list', async (_, unsafeRepoPath: string) => {
    try {
      const repoPath = paths.validate(unsafeRepoPath)
      // .backups/ in the working tree, and the private folders' backups kept
      // inside .git (sync/private-folders.ts privateBackupsDir — never in the
      // working tree, so they can never be staged into the company repository).
      // The latter are listed with ids prefixed `private:`.
      const backups: Array<{
        id: string
        timestamp: string
        reason: string
        files: string[]
        path: string
      }> = []

      for (const { dir: backupsDir, idPrefix } of [
        { dir: path.join(repoPath, '.backups'), idPrefix: '' },
        { dir: privateBackupsDir(repoPath), idPrefix: PRIVATE_BACKUP_ID_PREFIX },
      ]) {
        if (!fs.existsSync(backupsDir)) continue
        for (const entry of fs.readdirSync(backupsDir, { withFileTypes: true })) {
          if (entry.isDirectory() && !entry.name.startsWith('.')) {
            const backupPath = path.join(backupsDir, entry.name)
            const metadataPath = path.join(backupPath, '_metadata.json')

            let metadata: { timestamp?: string; reason?: string; conflictFiles?: string[] } = {}
            if (fs.existsSync(metadataPath)) {
              try {
                metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'))
              } catch {
                // Ignore parse errors
              }
            }

            // List files in backup (excluding _metadata.json)
            const files: string[] = []
            const listFiles = (dir: string, prefix = '') => {
              const items = fs.readdirSync(dir, { withFileTypes: true })
              for (const item of items) {
                if (item.name === '_metadata.json') continue
                const relativePath = prefix ? `${prefix}/${item.name}` : item.name
                if (item.isDirectory()) {
                  listFiles(path.join(dir, item.name), relativePath)
                } else {
                  files.push(relativePath)
                }
              }
            }
            listFiles(backupPath)

            backups.push({
              id: `${idPrefix}${entry.name}`,
              timestamp: metadata.timestamp || entry.name,
              reason: metadata.reason || 'unknown',
              files: metadata.conflictFiles || files,
              path: backupPath
            })
          }
        }
      }

      // Sort by timestamp (newest first)
      backups.sort((a, b) => b.timestamp.localeCompare(a.timestamp))

      return { success: true, backups }
    } catch (error) {
      console.error('Backup list error:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error', backups: [] }
    }
  })

  // Restore a file from backup
  ipc.handle('backup:restore', async (_, repoPath: string, backupId: string, filePath: string) => {
    try {
      const safeRepoPath = paths.validate(repoPath)
      const isPrivate = backupId.startsWith(PRIVATE_BACKUP_ID_PREFIX)
      const backupsDir = isPrivate ? privateBackupsDir(safeRepoPath) : path.join(safeRepoPath, '.backups')
      const backupPath = path.join(backupsDir, isPrivate ? backupId.slice(PRIVATE_BACKUP_ID_PREFIX.length) : backupId)
      if (!backupPath.startsWith(backupsDir + path.sep)) return { success: false, error: 'Invalid backup path' }
      const srcPath = path.resolve(backupPath, filePath)
      const destPath = path.resolve(safeRepoPath, filePath)

      // Prevent path traversal via ../
      if (!srcPath.startsWith(backupPath + path.sep)) {
        return { success: false, error: 'Invalid backup path' }
      }
      if (!destPath.startsWith(safeRepoPath + path.sep)) {
        return { success: false, error: 'Invalid destination path' }
      }

      if (!fs.existsSync(srcPath)) {
        return { success: false, error: 'Backup file not found' }
      }
      // Links resolved, both stay inside the company folder.
      paths.validate(srcPath)
      paths.validate(destPath)

      // Ensure destination directory exists
      fs.mkdirSync(path.dirname(destPath), { recursive: true })

      // Copy file
      fs.copyFileSync(srcPath, destPath)

      return { success: true, message: `Restored: ${filePath}` }
    } catch (error) {
      console.error('Backup restore error:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  // Open backup folder in Finder/Explorer
  ipc.handle('backup:openFolder', async (_, backupPath: string) => {
    try {
      // Only a backup folder (what backup:list returns) inside a company:
      // openPath on anything else could launch it (an .app, a script).
      const safe = paths.validate(backupPath)
      const parent = path.basename(path.dirname(safe))
      if ((parent !== '.backups' && parent !== 'acb-private-backups') || !fs.statSync(safe).isDirectory()) {
        return { success: false, error: 'Not a backup folder' }
      }
      await shell.openPath(safe)
      return { success: true }
    } catch (error) {
      console.error('Open folder error:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })
}
