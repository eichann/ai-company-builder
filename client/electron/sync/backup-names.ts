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

/** `_metadata.json`, `_metadata (member).json`, `_metadata (member) (member).json`, … */
const METADATA_FAMILY = /^_metadata((?: \(member\))*)\.json$/

/**
 * Where a member's file goes inside a backup folder. `prefix` is the folder
 * the copies sit under (a private folder's path), empty for the backup root.
 * At the root, a first segment of the `_metadata…json` family gets one more
 * ` (member)`: `_metadata.json` → `_metadata (member).json`, and a member's
 * own `_metadata (member).json` → `_metadata (member) (member).json`, so no
 * two of the member's paths share a copy and none meets the metadata.
 */
export function backupCopyName(file: string, prefix = ''): string {
  if (prefix) return file
  const slash = file.indexOf('/')
  const first = slash === -1 ? file : file.slice(0, slash)
  const m = METADATA_FAMILY.exec(first)
  if (!m) return file
  return `_metadata${m[1]} (member).json${slash === -1 ? '' : file.slice(slash)}`
}
