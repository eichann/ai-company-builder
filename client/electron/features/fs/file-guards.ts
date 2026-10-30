// Refusals shared by the handlers that create or replace something in the
// company folder (fs:*, backup:restore): a folder not downloaded on this
// computer, and a name that is already taken. The renderer checks the same
// first for a better message; these are the backstop (files-and-editor.md).

import fs from 'fs'
import path from 'path'
import { notDownloadedUserMessage } from '../../../shared/sparse-paths'
import { isTempSaveFile } from '../../../shared/temp-save-file'
import { notDownloadedFolderFor } from '../../sync/not-downloaded'

/**
 * Refuse an app file operation that would create or change something inside
 * a folder not downloaded on this computer (sparse exclusions): the member
 * cannot see the teammates' files there, and sync would hold the file back
 * instead of sharing it. Returns the message, or null to allow.
 */
export function notDownloadedRefusal(absPath: string): string | null {
  const folder = notDownloadedFolderFor(absPath)
  if (folder !== null) {
    console.warn(`[fs] Refused a write into a folder that is not downloaded: ${absPath}`)
    return notDownloadedUserMessage(folder.normalize('NFC'))
  }
  return null
}

/**
 * Whether `target` already holds something a rename / move / copy onto it
 * would silently replace (fs.rename replaces a file without asking). Not
 * taken: nothing there, or the very entry being renamed (another spelling of
 * it on a case- or normalization-insensitive disk, e.g. a.md → A.md).
 */
export async function nameTaken(target: string, source?: string): Promise<boolean> {
  let at: fs.Stats
  try {
    at = await fs.promises.lstat(target)
  } catch {
    return false
  }
  if (source !== undefined) {
    try {
      const from = await fs.promises.lstat(source)
      if (from.dev === at.dev && from.ino === at.ino) return false
    } catch { /* the source is gone: the operation fails on its own */ }
  }
  return true
}

/**
 * The one rename that replaces on purpose: the app's temporary save file
 * (`.<name>.acb-tmp-<random>`, client/shared/temp-save-file.ts) renamed over
 * `<name>` next to it, which is how the document review saves atomically.
 */
export function isAtomicSaveRename(source: string, target: string): boolean {
  return isTempSaveFile(source)
    && path.dirname(source) === path.dirname(target)
    && path.basename(source).startsWith(`.${path.basename(target)}.acb-tmp-`)
}
