// Keep a file's current version, byte for byte, before the app replaces or
// removes it on the member's behalf: the editor overwriting a file changed
// elsewhere, a backup restored over it, 「元に戻す」 in the sync preview.
// .backups/<ts>_<reason>/ — or .git/acb-private-backups/ for a file in a
// private folder or a nested repository (never in that folder's working tree).
// Plan and rules: shared/editor-disk-state.ts.

import fs from 'fs'
import path from 'path'
import { editorOverwriteBackupPlan, type EditorOverwriteBackupMetadata, type KeepCurrentReason } from '../../../shared/editor-disk-state'
import { privateBackupsDir, readPrivateScopesCache } from '../../sync/private-folders'
import type { PathGuard } from '../ports'

export type KeepCurrentResult =
  | { success: true; backupPath?: string; skipped?: 'missing' | 'outside-company' | 'internal' }
  | { success: false; error: string }

/** `root` is validated; `filePath` is inside it by name (its final link may not be followed yet). */
export async function keepCurrentVersion(
  paths: PathGuard,
  root: string,
  filePath: string,
  reason: KeepCurrentReason,
  now = new Date(),
): Promise<KeepCurrentResult> {
  try {
    let bytes: Buffer
    try {
      // A link is kept by what it points to, and only when that is inside the company.
      if ((await fs.promises.lstat(filePath)).isSymbolicLink()) paths.validate(filePath)
      if (!(await fs.promises.stat(filePath)).isFile()) return { success: true, skipped: 'missing' }
      bytes = await fs.promises.readFile(filePath)
    } catch {
      return { success: true, skipped: 'missing' }
    }
    let insideNestedRepo = false
    for (let dir = path.dirname(filePath); dir.startsWith(root + path.sep); dir = path.dirname(dir)) {
      if (fs.existsSync(path.join(dir, '.git'))) { insideNestedRepo = true; break }
    }
    const cache = readPrivateScopesCache(root)
    const plan = editorOverwriteBackupPlan({
      rootPath: root,
      filePath,
      privateFolders: cache ? [...cache.scopes, ...(cache.pendingPublic ?? [])].map(s => s.path) : [],
      insideNestedRepo,
      now,
      reason,
    })
    if ('skip' in plan) return { success: true, skipped: plan.skip }
    const base = plan.privateFolder ? privateBackupsDir(root) : path.join(root, '.backups')
    // Two keeps in the same millisecond get their own folders (each has one _metadata.json).
    let backupDir = path.join(base, plan.folder)
    for (let n = 2; fs.existsSync(backupDir); n++) backupDir = path.join(base, `${plan.folder}_${n}`)
    // Inside the company by its real location too (.backups could be a link).
    const target = paths.validate(path.join(backupDir, ...plan.rel.split('/')))
    await fs.promises.mkdir(path.dirname(target), { recursive: true })
    await fs.promises.writeFile(target, bytes)
    const metadata: EditorOverwriteBackupMetadata = {
      timestamp: now.toISOString(),
      reason,
      files: [plan.rel],
      privateFolder: plan.privateFolder,
    }
    await fs.promises.writeFile(path.join(backupDir, '_metadata.json'), JSON.stringify(metadata, null, 2))
    return { success: true, backupPath: backupDir }
  } catch (error) {
    console.error(`[backups] keeping the current version (${reason}) failed:`, error)
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}
