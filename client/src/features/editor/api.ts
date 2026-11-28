// The editor's access to the main process, as small ports over the IPC
// contract (src/shared/ipc/electron-api.ts), one per capability. Every function
// takes its port as the last parameter, defaulting to window.electronAPI.
import type { ElectronPort } from '../../shared/ipc/electron-api'
import type { EditorEditsReason } from '../../../shared/editor-disk-state'

/** Reading an open file on this computer: its text, its bytes (PDF), whether it still exists. */
export type EditorReads = ElectronPort<'readFile' | 'readFileBinary' | 'exists'>
/**
 * Saving on this computer: the file, its folder when it was deleted, the
 * disk version kept in the backups before overwriting a change made elsewhere,
 * and the tab's edits kept there before taking the version that arrived.
 */
export type EditorWrites = ElectronPort<'writeFile' | 'createDirectory' | 'backupBeforeOverwrite' | 'backupEdits'>
/**
 * An image pasted or dropped into a document edited in place, kept beside it: the renderer hands the
 * bytes and the document; main names and places the file (`images/`) and answers its address.
 */
export type EditorImageWrites = ElectronPort<'saveDocumentImage'>

export function saveDocumentImage(documentPath: string, bytes: ArrayBuffer, writes: EditorImageWrites = window.electronAPI) {
  return writes.saveDocumentImage(documentPath, bytes)
}

/** Why a save was refused, in a sentence for the member (a skill file they may not change, …). */
export type EditorRefusals = ElectronPort<'reservedPathRefusal'>

/**
 * The HTML viewer's document views (doc-frame.md): main shows an `.html`
 * file in a view of its own (its own session, no network) and hands back only
 * the view's id; the viewer places it over the tab (null hides it), zooms and
 * reloads it; closing it revokes the document's grant. Main tells the window
 * about a link the member pressed in it, or a view that went by itself. While the document is reviewed,
 * main reports the text the member selects in it and draws the comments' marks (quoted text only).
 * Its Google Drive videos play in ACB's own player, which main places over the document (by view and
 * index only: main keeps the ids; doc-frame.md "ACB's player over Drive embeds (plan 4)").
 */
export type DocViewControls = ElectronPort<'openDocView' | 'closeDocView' | 'setDocViewBounds' | 'setDocViewZoom' | 'reloadDocView' | 'onDocViewEvent' | 'setDocViewReview' | 'findDocViewQuote' | 'openDocViewDriveVideo' | 'playDocViewDriveVideo' | 'playDocViewLinkedVideo'>

/** 「ほかのアプリで開く」: a video the editor cannot play, handed to this computer's own app for it. */
export type VideoOutbound = ElectronPort<'openVideo'>

export function openVideoInOtherApp(filePath: string, outbound: VideoOutbound = window.electronAPI) {
  return outbound.openVideo(filePath)
}

/** Opening a link of a document in the member's browser, after they said yes. */
export type DocLinkOutbound = ElectronPort<'openExternal'>

/**
 * The user manual (files-and-editor.md "The user manual"): a page opened in a document view (main
 * fetches the server's manual and shows its copy; only the view's id comes back), and written to a
 * new folder the member picks in main's save dialog (the renderer never names a path).
 */
export type ManualControls = ElectronPort<'openManual' | 'exportManual'>

export function manualPorts(): ManualControls {
  return window.electronAPI
}

/** The app's own ports for the viewer (a preview page fakes `window.electronAPI`). */
export function docViewPorts(): { views: DocViewControls; links: DocLinkOutbound } {
  return { views: window.electronAPI, links: window.electronAPI }
}

/** The file's text, or null when it is gone. */
export function readFile(filePath: string, reads: EditorReads = window.electronAPI) {
  return reads.readFile(filePath)
}

/** Whether a tab remembered from the last session can be reopened. */
export function fileExists(filePath: string, reads: EditorReads = window.electronAPI) {
  return reads.exists(filePath)
}

export function readFileBinary(filePath: string, reads: EditorReads = window.electronAPI) {
  return reads.readFileBinary(filePath)
}

/** True when written. */
export function writeFile(filePath: string, content: string, writes: EditorWrites = window.electronAPI) {
  return writes.writeFile(filePath, content)
}

/** The sentence for a save that failed; null when it failed for another reason, or the question could not be asked. */
export async function saveRefusal(filePath: string, refusals: EditorRefusals = window.electronAPI): Promise<string | null> {
  try {
    return await refusals.reservedPathRefusal(filePath)
  } catch {
    return null
  }
}

export function createDirectory(dirPath: string, writes: EditorWrites = window.electronAPI) {
  return writes.createDirectory(dirPath)
}

/** Keeps the disk version (.backups/<ts>_editor_overwrite/, or the private backups). */
export function backupBeforeOverwrite(rootPath: string, filePath: string, writes: EditorWrites = window.electronAPI) {
  return writes.backupBeforeOverwrite(rootPath, filePath)
}

/**
 * Keeps the tab's unsaved edits (.backups/<ts>_<reason>/, or the private backups):
 * before ［届いた版を採用］ (`editor_edits`) or ［保存せずに進む］ (`editor_left_unsaved`).
 */
export function backupEdits(rootPath: string, filePath: string, content: string, reason: EditorEditsReason, writes: EditorWrites = window.electronAPI) {
  return writes.backupEdits(rootPath, filePath, content, reason)
}

/** Whether a record a tidied tab points to can still be read (「片づけたタブ」 marks it 「見つかりません」). */
export type TidiedRecordReads = ElectronPort<'getRecordCard'>

/** false only when the server says the record is gone or not readable; unknown (offline) → true. */
export async function recordStillThere(companyId: string, recordId: string, reads: TidiedRecordReads = window.electronAPI): Promise<boolean> {
  const r = await reads.getRecordCard(companyId, recordId).catch(() => null)
  return !(r && !r.success && r.notFound)
}
