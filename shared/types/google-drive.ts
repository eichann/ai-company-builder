/**
 * Google Drive through the Google connection — API contract
 * (`.claude/rules/google-drive.md`). Only `DrivePickerSession` carries a
 * token: the Picker's own, `drive.file` only, answered to the member's app
 * session (never to a record token, the AI or a log).
 */
import type { DrivePickMode, DrivePutAs } from '../core/google-drive'
import type { SkillUse } from '../core/skill-uses'

export type { DrivePickMode } from '../core/google-drive'

/** POST /api/companies/:id/me/google/drive/picker { mode } (session) — for the app's Picker window only. */
export interface DrivePickerSession {
  /** Google access token with exactly `drive.file`; Google's lifetime (≤ 1 hour). Never stored or logged. */
  accessToken: string
  expiresAt: string
  /** The Picker's API key (developer key) and app id (Cloud project number) the admin registered. */
  apiKey: string
  appId: string
  /** Where the Picker's script comes from: Google's, or the practice Google's origin on staging. */
  scriptOrigin: string
  mode: DrivePickMode
}

/** What a person picked (the server checked each one with Google before keeping it). */
export interface DrivePick {
  id: string
  kind: 'folder' | 'file'
  name: string
  mimeType: string
  pickedAt: string
  expiresAt: string
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
}

/** A file one of the member's own puts made (the latest put of it): `drive_put` may update it as a new revision. */
export interface DriveUpdatableFile {
  fileId: string
  /** The name as put (the member's own). */
  name: string
  mimeType: string
  folderId: string
  link: string | null
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
   * linked to it now (records.md "File links without the shared folder"). Absent: nothing was linked
   * (no record named, a replay, a check refused it, or an older server).
   */
  linkedTo?: { recordId: string }
}

/** POST /api/records-ai/google/drive/put body. */
export interface DrivePutRequest {
  folderId: string
  name: string
  /** What the local file is. */
  kind: 'pdf' | 'html' | 'markdown'
  /** `google_doc`: HTML or Markdown converted into a Google document; absent / `file`: the file as is (PDF or HTML). */
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
