// The working folders of companies without the shared company folder (`none`,
// client/shared/company-folder.ts): plain folders on this PC where the AI works. Nothing in
// them is ever synced, so no git runs there — not sync, history, download choices, backups,
// skill sharing, nor a read-only `git status`.
//
// A folder is registered only by companySetup:openWorkingFolder, after the server said the
// company is exactly `none` and the folder holds no `.git` of its own. Folders are matched
// exactly (never "inside"): a git company's folder is always a repository root with its own
// `.git`, so it can never be one of these, and git companies behave as before.
//
// `withoutWorkingFolders` is the backstop around the app's one git factory (services/app-git.ts):
// a git for a working folder throws, so an entry point missed above fails with a plain
// sentence instead of running git there (or in a repository above it on disk).

import fs from 'node:fs'
import path from 'node:path'
import type { AppGit } from './app-git'

export const NO_GIT_IN_WORKING_FOLDER = 'この会社は全社フォルダを使わない設定のため、この操作はできません。'

export interface WorkingFolders {
  add(folder: string): void
  /** Whether `folder` is exactly a registered working folder (by name or by its real location). */
  has(folder: string): boolean
}

function keysOf(folder: string): string[] {
  const resolved = path.resolve(folder).replace(/[\\/]+$/, '')
  const keys = [resolved.normalize('NFC')]
  try { keys.push(fs.realpathSync.native(resolved).normalize('NFC')) } catch { /* not on disk (yet) */ }
  return keys
}

export function createWorkingFolders(): WorkingFolders {
  const keys = new Set<string>()
  return {
    add(folder) {
      for (const key of keysOf(folder)) keys.add(key)
    },
    has(folder) {
      if (typeof folder !== 'string' || folder === '') return false
      return keysOf(folder).some(key => keys.has(key))
    },
  }
}

/** The app's git, refusing every working folder (see above). */
export function withoutWorkingFolders(appGit: AppGit, folders: Pick<WorkingFolders, 'has'>): AppGit {
  return {
    ...appGit,
    create(repoPath, extraEnv) {
      if (folders.has(repoPath)) throw new Error(NO_GIT_IN_WORKING_FOLDER)
      return appGit.create(repoPath, extraEnv)
    },
  }
}
