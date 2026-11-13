// Google Drive files linked to a record, as every card shows them (the task card and the 案件・プロジェクト
// card; records.md "Drive and PC file links", owner decisions 2026-11-08 / 2026-11-13): pure, no I/O.

/**
 * A Google Drive file linked to a record: every reader gets the row; `name` only for the member who
 * linked it (`mine`) — anyone else sees 「Google Drive のファイル」 and Drive decides who may open it.
 */
export interface LinkedDriveFile { fileId: string; mine: boolean; name: string | null }

/** What a Drive file's row says when its name is not the member's to see. */
export const DRIVE_FILE_NEUTRAL = 'Google Drive のファイル'

/** Drive's own page for a file (opened in the member's browser; Drive decides who may see it). */
export function driveFileUrl(fileId: string): string {
  return `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view`
}

/** A record link's Drive part as the server answered it (`RecordLinkView.drive`), or null: the name only when it is the member's. */
export function linkedDriveFileOf(l: { direction?: string; drive?: { fileId?: unknown; mine?: unknown; name?: unknown } | null }): LinkedDriveFile | null {
  if (l.direction !== 'out' || !l.drive || typeof l.drive.fileId !== 'string') return null
  const mine = l.drive.mine === true
  return { fileId: l.drive.fileId, mine, name: mine && typeof l.drive.name === 'string' ? l.drive.name : null }
}

/** Under 「ファイル」 on a 案件・プロジェクト's card (`word`: its kind's name): who sees what. */
export const driveFilesNote = (word: string) => `Google Drive のファイルは、この${word}を見られる人みんなに見えます（名前は、つないだ人だけ）`

/** A paste or a drop that holds no Drive file address. */
export const NOT_A_DRIVE_LINK = 'Google Drive のファイルのリンクではないため、つなげません。'
/** After the chooser opened on a pasted / dropped link ended with nothing chosen: why it may have been empty. */
export const DRIVE_LINK_EMPTY_HINT = '選ぶ画面にファイルが出てこないときは、そのリンクのファイルをあなたが見られるか、読める種類（Google ドキュメント・スプレッドシート・スライド・PDF・テキスト）かを確かめてください。'

/** A drag that may carry an address (a link from the browser); the text is read only on the drop. */
export function mayCarryLink(data: Pick<DataTransfer, 'types'> | null): boolean {
  return !!data && Array.from(data.types).includes('text/uri-list')
}

/** The text a drop carries: the address list and the plain text (either may hold the link). */
export function droppedText(data: Pick<DataTransfer, 'getData'>): string {
  return `${data.getData('text/uri-list')}\n${data.getData('text/plain')}`
}
