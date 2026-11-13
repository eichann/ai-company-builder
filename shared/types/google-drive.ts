/**
 * Google Drive through the Google connection — API contract
 * (`.claude/rules/google-drive.md`). Only `DrivePickerPageConfig` carries a
 * token: the Picker's own, `drive.file` only, handed once to the Picker page
 * that holds the member's one-time pick ticket (never to a record token, the AI
 * or a log).
 */
import type { DriveFolderSharing, DrivePickMode, DrivePickPurpose, DrivePickRefusedWhy, DrivePutAs } from '../core/google-drive'
import type { SkillUse } from '../core/skill-uses'

export type { DriveFolderSharing, DrivePickMode, DrivePickPurpose, DrivePickRefusedWhy } from '../core/google-drive'

/**
 * POST /api/companies/:id/me/google/drive/pick-tickets { mode, fileIds? } (session): a one-time pick
 * ticket for the Picker page in the member's browser. `ticket` is answered only here, once; the server
 * keeps its sha256. `ticketId` is what the app polls and cancels with its session.
 */
export interface DrivePickTicketStarted {
  ticketId: string
  ticket: string
  expiresAt: string
}

/**
 * GET …/me/google/drive/pick-tickets/:ticketId (session): `waiting` while the person chooses (`opened`:
 * the page took its config); a final state is answered once and the ticket is closed.
 */
export type DrivePickTicketState =
  | { state: 'waiting'; opened: boolean; saving?: boolean }
  /** `refusedWhy`: why the refused ones were not kept, by reason (absent from an older server). */
  | { state: 'picked'; picks: DrivePick[]; refused: number; refusedWhy?: DrivePickRefusedWhy }
  | { state: 'cancelled' }
  | { state: 'expired' }
  | { state: 'failed'; error: string }

/** POST /api/google-picker/config { ticket } (public, once per ticket): what the Picker page needs. */
export interface DrivePickerPageConfig {
  /** Google access token with exactly `drive.file`; Google's lifetime (≤ 1 hour). Never stored or logged. */
  accessToken: string
  /** The Picker's API key (developer key) and app id (Cloud project number) the admin registered. */
  apiKey: string
  appId: string
  /** Where the Picker's script comes from: Google's, or the practice Google's origin on staging. */
  scriptOrigin: string
  mode: DrivePickMode
  /** Files mode: `read` (for the AI: the readable types only) or `link` (to link to a record: every file type). */
  purpose?: DrivePickPurpose
  /** The types the Picker shows; empty = every type (a `link` pick). */
  mimeTypes: readonly string[]
  maxItems: number
  /** Files mode only: the files the Picker shows (a pasted Drive link), already checked as Drive ids. */
  fileIds?: string[]
  /** The Google account of the member's grant (its `accountEmail`): the Picker opens on it when it can. */
  account?: string
}

/** What a person picked (the server checked each one with Google before keeping it). */
export interface DrivePick {
  id: string
  kind: 'folder' | 'file'
  name: string
  mimeType: string
  pickedAt: string
  expiresAt: string
  /**
   * A folder picked through a pick ticket: who sees what is put into it (said right after the pick; the AI and a
   * scheduled job cannot put into an `outside` / `unknown` one). Absent: a file, or an older server.
   */
  sharing?: DriveFolderSharing
}

/** POST …/me/google/drive/picks { mode, ids } → the picks kept. */
export interface DrivePicksResult {
  picks: DrivePick[]
  /** Ids Google did not let ACB open (not picked through the Picker, gone, wrong kind). */
  refused: number
}

/** GET /api/records-ai/google/drive (any token): whether the Drive tools work for this member now. */
export interface DriveAiStatus {
  /** The company's Google is on and the admin registered the Picker. */
  available: boolean
  /** The member allowed `drive.file` (else the first pick asks for it). */
  granted: boolean
  /** The member's live picks (newest first). A scheduled job's run sees only its own folder. */
  picks: DrivePick[]
  /**
   * Files the member's puts made that `drive_put` may update (`updateFileId`), newest first: their own
   * receipts only (a scheduled job's run: only those in its folder). Absent from an older server.
   */
  puts?: DriveUpdatableFile[]
  /**
   * More files the member's puts made than `puts` lists (one entry per file, newest first): `GET /status?putsBefore=<putsNext>`
   * reads the next page. Absent: `puts` is all of them (or an older server).
   */
  putsNext?: string
  /** Why `available` is false when the company's Google is on but the admin has not registered the Picker. */
  reason?: 'picker-not-configured'
}

/** A file one of the member's own puts made (the latest put of it): `drive_put` may update it as a new revision. */
export interface DriveUpdatableFile {
  fileId: string
  /** The name as put (the member's own). */
  name: string
  mimeType: string
  folderId: string
  link: string | null
  /** The revision of its latest put (an update names it in its request key: a later update is another operation). */
  revisionId?: string | null
  at: string
}

/** POST /api/records-ai/google/drive/read { fileId } (read token): a picked file. */
export interface DriveReadAnswer {
  file: { id: string; name: string; mimeType: string; modifiedTime: string | null }
  /** Text (Docs / Slides / Sheets exported, or a text file), between the header and footer: outside text. */
  header: string
  text: string | null
  footer: string
  truncated: boolean
  /** A PDF: its bytes as base64 (the app saves it under `.personal/` for the AI to read). */
  pdfBase64: string | null
  instructionLike: Array<{ label: string; words: string }>
}

/** done: in Drive; unknown: sent, the answer was lost and ACB could not find it yet (never re-sent). */
export type DrivePutState = 'sending' | 'done' | 'unknown'

/** The receipt of one put (操作の控え): never content, never a local path. */
export interface DrivePutView {
  id: string
  state: DrivePutState
  name: string
  mimeType: string
  bytes: number
  sha256: string
  folderId: string
  folderName: string
  /** Drive's ids once known: the file and its revision (the approval design pins Drive revisions). */
  fileId: string | null
  revisionId: string | null
  link: string | null
  createdAt: string
  finishedAt: string | null
  /** found-by-correlation: the answer was lost and ACB found its own file by the put's id. */
  reason: string | null
  /** The company Skills the AI's consultation had used when the put was asked (records.md "Which Skill"); null when none or a person's put. */
  skills: SkillUse[] | null
  /**
   * This put updated a file an earlier put of the member made (a new revision of the same Drive file:
   * `fileId` is then that file). null: it made a new file. Absent from an older server.
   */
  updatedFileId?: string | null
}

/** POST /api/records-ai/google/drive/put (act token) and GET …/puts/:putId. */
export interface DrivePutAnswer {
  drivePut: DrivePutView
  /** The same request (same requestKey) was put before: this is that put, nothing was sent again. */
  existing: boolean
  /**
   * The request named a record (`recordId`, the consultation's やること) and this put's new file was
   * linked to it now (records.md "Drive and PC file links"). Absent: nothing was linked
   * (no record named, a replay, a check refused it, or an older server).
   */
  linkedTo?: { recordId: string }
  /**
   * A Google document was overwritten while it had comments: a full replace may take a comment off the words it was
   * on (google-drive.md "Continuing a document people edited"). Absent: none, or not a document's update.
   */
  commentsMayMove?: boolean
  /**
   * The document had changed in Drive since ACB's last put and the AI's text (written after reading it) replaced it:
   * `own` — every change was the member's own; `confirmed` — someone else's, after the member pressed 「上書きする」.
   */
  continued?: 'own' | 'confirmed'
  /**
   * The put is done in Drive but its file could not be linked to the named record (a record check refused it, or it
   * failed): said plainly so the AI tells the member (they can link it from the card). `code`: the refusal's code.
   */
  notLinked?: { recordId: string; code: string }
}

/**
 * The 409 `DRIVE_OVERWRITE_NEEDS_CONFIRMATION` of a put (google-drive.md "Continuing a document people edited"): someone
 * else edited or commented on the Google document since ACB's last put. Nothing was written; the content waits on the
 * server until the member presses 「上書きする」 on the app's card (or `expiresAt`).
 */
export interface DriveOverwriteConfirmation {
  id: string
  /** The document's name as ACB put it (the member's own). */
  fileName: string
  /** Google's display names of the others whose edits or comments came since (at most 5; empty: unnamed). */
  editors: string[]
  /** Someone else commented (or replied) since. */
  commented: boolean
  expiresAt: string
}

/** POST /api/companies/:id/me/google/drive/overwrite-confirmations/:id { action } (session): the member's press. */
export type DriveOverwriteDecision =
  | { state: 'written'; drivePut: DrivePutView; commentsMayMove: boolean }
  /** Sent, but Google's answer was lost and the file is not found yet: never sent again (looked up by the put's id). */
  | { state: 'unknown'; drivePut: DrivePutView }
  | { state: 'declined' }

/** POST /api/records-ai/google/drive/put body. */
export interface DrivePutRequest {
  folderId: string
  name: string
  /** What the local file is. */
  kind: 'pdf' | 'html' | 'markdown' | 'text' | 'json'
  /** `google_doc`: HTML or Markdown converted into a Google document; absent / `file`: the file as is (PDF, HTML, Markdown `.md`, text `.txt`, JSON `.json`). */
  as?: DrivePutAs
  sha256: string
  contentBase64: string
  /**
   * A file an earlier put of this member made, in this same folder: it gets the content as a new revision
   * (the same file id and link) instead of a new file being made. Absent: a new file.
   */
  updateFileId?: string
  /**
   * The app's key for this put (same content, folder, name, form and target → same key): a byte-identical
   * repeat is never put twice; edited content without `updateFileId` is a new file.
   */
  requestKey: string
  /**
   * The consultation's やること (its topic), set by the app, never by the AI: once the file is in
   * Drive the server links it to that record when every record check passes. A refusal there never
   * fails the put.
   */
  recordId?: string
  /**
   * The app shows the card that asks the member before a Google document someone else (may have) edited is replaced
   * (google-drive.md "Continuing a document people edited"). Absent (an app released before it): such an update is refused
   * as before and nothing waits on the server.
   */
  askPerson?: boolean
}

/** One of the member's own Drive files ACB may open: a live pick of a file, or a file their put made. */
export interface DriveOwnFile {
  id: string
  /** The name as picked or put (the member's own; never answered to anyone else). */
  name: string
  mimeType: string
  source: 'picked' | 'put'
  /** When it was picked or put. */
  at: string
}

/** GET /api/companies/:id/me/google/drive/files (session): the member's own, newest first (empty while Drive is not available). */
export interface DriveOwnFiles {
  files: DriveOwnFile[]
}
