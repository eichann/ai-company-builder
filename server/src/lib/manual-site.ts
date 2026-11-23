/**
 * Reading the user manual's built site for `/manual/` (`routes/manual.ts`;
 * server.md "The user manual"). Only a file its manifest names is ever read:
 * the requested path must be one `isManualFilePath` accepts AND listed in the
 * manifest, so `..`, an encoded `%2e%2e`, a hidden file, another folder or a
 * file that only happens to sit in the folder answer nothing — and there is no
 * listing of the folder at all. The file is opened without following a link.
 */
import { constants as fsConstants } from 'fs'
import { open } from 'fs/promises'
import { createHash } from 'crypto'
import { join } from 'path'
import {
  manualContentType, manualPageFile, MANUAL_INDEX_PAGE, MANUAL_LIMITS, MANUAL_MANIFEST, parseManualManifest,
} from '../../shared/core/manual'

export interface ManualAnswer {
  bytes: Uint8Array
  contentType: string
  /** A strong ETag (the file's sha256 from the manifest, or the manifest's own). */
  etag: string
}

const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0

async function readRegularFile(path: string, maxBytes: number): Promise<Buffer | null> {
  let handle
  try {
    handle = await open(path, fsConstants.O_RDONLY | O_NOFOLLOW)
  } catch {
    return null
  }
  try {
    const st = await handle.stat()
    if (!st.isFile() || st.size > maxBytes) return null
    return await handle.readFile()
  } catch {
    return null
  } finally {
    await handle.close()
  }
}

/**
 * The file `requested` (the path after `/manual/`; empty = the index page) of
 * the site in `dir`, or null for anything not served (also when the manual was
 * not built: `pnpm manual:build`).
 */
export async function readManualFile(dir: string, requested: string): Promise<ManualAnswer | null> {
  const path = requested === '' ? manualPageFile(MANUAL_INDEX_PAGE) : requested
  const manifestBytes = await readRegularFile(join(dir, MANUAL_MANIFEST), 4 * 1024 * 1024)
  if (!manifestBytes) return null
  let manifest
  try {
    manifest = parseManualManifest(JSON.parse(manifestBytes.toString('utf8')))
  } catch {
    return null
  }
  if (!manifest) return null
  if (path === MANUAL_MANIFEST) {
    return { bytes: manifestBytes, contentType: manualContentType(path), etag: createHash('sha256').update(manifestBytes).digest('hex') }
  }
  // The manifest's paths passed `isManualFilePath` when it was parsed: only one of them is read.
  const entry = manifest.files.find(f => f.path === path)
  if (!entry) return null
  const bytes = await readRegularFile(join(dir, ...path.split('/')), MANUAL_LIMITS.fileBytes)
  if (!bytes) return null
  return { bytes, contentType: manualContentType(path), etag: entry.sha256 }
}
