// ACB foundation: linked Google Drive files as rows of 「つながっているもの」, on the task card (tasks) and the
// 案件・プロジェクト card (records) alike (records.md "Drive and PC file links").
import type { LinkedRow } from './LinkedColumn'
import { DRIVE_FILE_NEUTRAL, driveFileUrl, type LinkedDriveFile } from '../../../shared/drive-links'
import { openDriveFile } from '../ipc/drive-links'

/**
 * The rows of linked Drive files: the member's own by its name, anyone else's as 「Google Drive のファイル」,
 * opened in the browser (Drive decides who may see it), 「…」→「つながりを外す」 (`onUnlink`; none on a card that changes nothing).
 */
export function driveFileRows(files: readonly LinkedDriveFile[], busy: boolean, onUnlink?: (fileId: string, label: string) => void): LinkedRow[] {
  return files.map(f => {
    const label = f.name ?? DRIVE_FILE_NEUTRAL
    return {
      key: `drive:${f.fileId}`, name: 'ファイル', kind: 'file', label, sub: 'Google Drive',
      onOpen: () => { void openDriveFile(driveFileUrl(f.fileId)) },
      ...(onUnlink ? { menu: [{ label: 'つながりを外す', hint: 'Drive のファイルは消えません', onClick: () => { if (!busy) onUnlink(f.fileId, label) } }] } : {}),
    }
  })
}
