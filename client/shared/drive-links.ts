// Google Drive files linked to a record, as every card shows them (the task card and the 案件・プロジェクト
// card; records.md "Drive and PC file links", owner decisions 2026-11-08 / 2026-11-13): pure, no I/O.
import { driveAiReadable } from '../../shared/core/google-drive'

/**
 * A Google Drive file linked to a record: every reader gets the row; `name` only for the member who
 * linked it (`mine`) — anyone else sees 「Google Drive のファイル」 and Drive decides who may open it.
 * For the linker only (owner FB 2026-11-14): `content` — `unreadable` (a type the AI cannot read, linked only:
 * 「AI では中身を読めません」) or `unchecked` (a readable type whose content ACB could not read when it was linked:
 * 「中身を確かめられていません」, with 「中身を確かめ直す」); absent when ACB read it (or for anyone else).
 */
export interface LinkedDriveFile { fileId: string; mine: boolean; name: string | null; content?: 'unreadable' | 'unchecked' }

/** What a Drive file's row says when its name is not the member's to see. */
export const DRIVE_FILE_NEUTRAL = 'Google Drive のファイル'

/** Drive's own page for a file (opened in the member's browser; Drive decides who may see it). */
export function driveFileUrl(fileId: string): string {
  return `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view`
}

/** A record link's Drive part as the server answered it (`RecordLinkView.drive`), or null: the name only when it is the member's. */
export function linkedDriveFileOf(l: { direction?: string; drive?: { fileId?: unknown; mine?: unknown; name?: unknown; sha256?: unknown; mimeType?: unknown } | null }): LinkedDriveFile | null {
  if (l.direction !== 'out' || !l.drive || typeof l.drive.fileId !== 'string') return null
  const mine = l.drive.mine === true
  // What ACB read is the linker's to know (the server answers it to them only); a link without kept facts (an undo) says nothing.
  const kept = mine && typeof l.drive.mimeType === 'string'
  const content = !kept || typeof l.drive.sha256 === 'string' ? undefined : driveAiReadable(l.drive.mimeType) ? 'unchecked' as const : 'unreadable' as const
  return { fileId: l.drive.fileId, mine, name: mine && typeof l.drive.name === 'string' ? l.drive.name : null, ...(content ? { content } : {}) }
}

/** A linked file's line for its linker: the AI cannot read its type (Word, Excel, an image…), it was linked only. */
export const DRIVE_CONTENT_UNREADABLE = 'AI では中身を読めません'
/** A linked file's line for its linker: ACB could not read its content when it was linked (not material until checked). */
export const DRIVE_CONTENT_UNCHECKED = '中身を確かめられていません'

/**
 * Under 「ファイル」 on a 案件・プロジェクト's card (`word`: its kind's name): who sees what (owner FB 2026-11-14: linking
 * does not share — the link is seen, opening it needs the file shared in Drive).
 */
export const driveFilesNote = (word: string) => `Google Drive のファイルは、この${word}を見られる人みんなにリンクが見えます（名前は、つないだ人だけ）。開けるのは Drive で共有されている人だけで、つないでも共有はされません`

/** A paste or a drop that holds no Drive file address. */
export const NOT_A_DRIVE_LINK = 'Google Drive のファイルのリンクではないため、つなげません。'
/** A paste or a drop of a Drive folder's address: folders cannot be linked yet (owner FB 2026-11-14). */
export const DRIVE_FOLDER_NOT_YET = 'Google Drive のフォルダは、まだつなげません。フォルダの中のファイルを選んでつないでください。'
/** While Google's chooser is open in the member's browser (owner FB 2026-11-14, #33): where to look, and ［やめる］. */
export const DRIVE_PICKING_TEXT = 'ブラウザで Google Drive の画面を開いています。そこで選んでください（10分まで待ちます）。'
/** Google's chooser ended without a choice because time ran out (not the member's own 「キャンセル」). */
export const DRIVE_PICK_TIMED_OUT = '選ばれないまま時間が過ぎました。もう一度押すと選び直せます。'
/** After the chooser opened on a pasted / dropped link ended with nothing chosen: why it may have been empty. */
export const DRIVE_LINK_EMPTY_HINT = '選ぶ画面にファイルが出てこないときは、そのリンクのファイルをあなたが Google Drive で見られるか（共有されているか）を確かめてください。'

/** A drag that may carry an address (a link from the browser); the text is read only on the drop. */
export function mayCarryLink(data: Pick<DataTransfer, 'types'> | null): boolean {
  return !!data && Array.from(data.types).includes('text/uri-list')
}

/** The text a drop carries: the address list and the plain text (either may hold the link). */
export function droppedText(data: Pick<DataTransfer, 'getData'>): string {
  return `${data.getData('text/uri-list')}\n${data.getData('text/plain')}`
}
