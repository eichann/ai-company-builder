// Names inside a backup folder (.backups/<ts>…/ or the private backups):
// each folder has one `_metadata.json` of its own at its root, so a member's
// own `_metadata.json` at that level (file or folder) is kept under another
// name beside it. Used by every writer that copies the member's files into a
// backup folder and by 復元, so a copy and the metadata never meet.

export const BACKUP_METADATA_FILE = '_metadata.json'

/**
 * A backup's metadata `copies`: the member's path → where its copy is in the
 * backup folder, for every copy not kept at its own path. The backup list
 * shows the member's path and 復元 reads the copy from here; nothing is
 * guessed from file names, so older backups keep their meaning.
 */
export type BackupCopies = Record<string, string>

/** The `copies` entries of files copied with `backupCopyName` (shown as `prefix + file`). */
export function renamedCopies(files: string[], prefix = ''): BackupCopies {
  const copies: BackupCopies = {}
  for (const file of files) {
    const copy = backupCopyName(file, prefix)
    if (copy !== file) copies[`${prefix}${file}`] = `${prefix}${copy}`
  }
  return copies
}

/** `copies` of a parsed metadata object; anything malformed counts as none. */
export function backupCopies(metadata: unknown): BackupCopies {
  const raw = (metadata as { copies?: unknown } | null)?.copies
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  return Object.fromEntries(Object.entries(raw).filter(([k, v]) => typeof k === 'string' && typeof v === 'string')) as BackupCopies
}

/**
 * `_metadata.json`, `_metadata (member).json`, `_metadata (member) (member).json`, …
 * in any A–Z case: on a Mac `_Metadata.JSON` is the backup's own file too.
 */
const METADATA_FAMILY = /^_metadata(?: \(member\))*\.json$/i

/**
 * Where a member's file goes inside a backup folder. `prefix` is the folder
 * the copies sit under (a private folder's path), empty for the backup root.
 * At the root, a first segment of the `_metadata…json` family (any case)
 * gets one more ` (member)` before its `.json`, its own spelling kept:
 * `_metadata.json` → `_metadata (member).json`, `_metadata (MEMBER).json` →
 * `_metadata (MEMBER) (member).json`. Names outside the family stay as they
 * are, so no two of the member's paths share a copy, even where case does
 * not count, and none meets the metadata.
 */
export function backupCopyName(file: string, prefix = ''): string {
  if (prefix) return file
  const slash = file.indexOf('/')
  const first = slash === -1 ? file : file.slice(0, slash)
  if (!METADATA_FAMILY.test(first)) return file
  const ext = first.slice(-'.json'.length)
  return `${first.slice(0, -ext.length)} (member)${ext}${slash === -1 ? '' : file.slice(slash)}`
}
