// ACB foundation: linked Google Drive files as rows of 「つながっているもの」, on the task card (tasks) and the
// 案件・プロジェクト card (records) alike (records.md "Drive and PC file links").
import type { LinkedRow } from './LinkedColumn'
import { DRIVE_CONTENT_UNCHECKED, DRIVE_CONTENT_UNREADABLE, DRIVE_FILE_NEUTRAL, driveFileUrl, type LinkedDriveFile } from '../../../shared/drive-links'
import { openDriveFile } from '../ipc/drive-links'

/**
 * The rows of linked Drive files: the member's own by its name, anyone else's as 「Google Drive のファイル」,
 * opened in the browser (Drive decides who may see it), 「…」→「つながりを外す」 (`onUnlink`; none on a card that changes nothing).
 * For the linker: 「AI では中身を読めません」 (a type linked only) or 「中身を確かめられていません」 with 「中身を確かめ直す」
 * (`onRecheck`: linked again, which reads it again — owner FB 2026-11-14).
 */
export function driveFileRows(files: readonly LinkedDriveFile[], busy: boolean, onUnlink?: (fileId: string, label: string) => void, onRecheck?: (fileId: string) => void): LinkedRow[] {
  return files.map(f => {
    const label = f.name ?? DRIVE_FILE_NEUTRAL
    const state = f.content === 'unreadable' ? DRIVE_CONTENT_UNREADABLE : f.content === 'unchecked' ? DRIVE_CONTENT_UNCHECKED : null
    const menu = [
      ...(onRecheck && f.content === 'unchecked' ? [{ label: '中身を確かめ直す', hint: '読めると、決めたことの根拠にも使えます', onClick: () => { if (!busy) onRecheck(f.fileId) } }] : []),
      ...(onUnlink ? [{ label: 'つながりを外す', hint: 'Drive のファイルは消えません', onClick: () => { if (!busy) onUnlink(f.fileId, label) } }] : []),
    ]
    return {
      key: `drive:${f.fileId}`, name: 'ファイル', kind: 'file', label, sub: state ? `Google Drive・${state}` : 'Google Drive',
      onOpen: () => { void openDriveFile(driveFileUrl(f.fileId)) },
      ...(menu.length > 0 ? { menu } : {}),
    }
  })
}
