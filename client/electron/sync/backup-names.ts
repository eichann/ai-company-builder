// Names inside a backup folder (.backups/<ts>…/ or the private backups):
// each folder has one `_metadata.json` of its own at its root, so a member's
// own root `_metadata.json` is kept under another name beside it. Used by
// every writer that copies the member's files into a backup folder and by
// 復元, so a copy and its metadata never meet.

export const BACKUP_METADATA_FILE = '_metadata.json'
export const MEMBER_METADATA_COPY = '_metadata (member).json'

/**
 * Where a member's file goes inside a backup folder. `prefix` is the folder
 * the copies sit under (a private folder's path), empty for the backup root.
 */
export function backupCopyName(file: string, prefix = ''): string {
  return !prefix && file === BACKUP_METADATA_FILE ? MEMBER_METADATA_COPY : file
}
