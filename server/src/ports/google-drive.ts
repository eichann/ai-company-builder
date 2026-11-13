/**
 * Google Drive's storage behind the company handle (google-drive.md): what a
 * person picked with Google Picker, and the receipts of puts (操作の控え).
 * Every method is limited to the handle's company and takes the member.
 */
import type { SkillUse } from '../../shared/core/skill-uses'

export interface DrivePickRow {
  userId: string
  fileId: string
  kind: 'folder' | 'file'
  name: string
  mimeType: string
  pickedAt: string
  expiresAt: string
}

export interface DrivePutRow {
  id: string
  userId: string
  requestKey: string
  actorKind: 'ai' | 'person'
  conversationId: string | null
  runId: string | null
  folderId: string
  folderName: string
  name: string
  mimeType: string
  bytes: number
  sha256: string
  state: 'sending' | 'done' | 'unknown'
  fileId: string | null
  revisionId: string | null
  link: string | null
  reason: string | null
  createdAt: string
  finishedAt: string | null
  /** The company Skills the AI's consultation had used, copied when the receipt is written (records.md "Which Skill"); null otherwise. */
  skills: SkillUse[] | null
  /** The Drive file this put gave a new revision (a file an earlier put of the member made); null: it made a new file. */
  updatedFileId: string | null
  /**
   * A Google document only: what it was right after this put made or updated it, proven to be ACB's own (google-drive.md
   * "A Google document's own changes") — what an overwrite compares with, since a document's `version` moves without an
   * edit. Null: not a document, a put found after a lost answer, or the baseline could not be proven.
   */
  docBaseline: DriveDocBaseline | null
}

/** A Google document as ACB left it: its text, its newest revision and when (the upload's `modifiedTime`). */
export interface DriveDocBaseline {
  /** sha256 of its `text/plain` export (BOM / CRLF cleaned). */
  fingerprint: string
  /** The id of its newest revision (`revisions.list`): any change of content, formatting or images makes a new one. */
  revision: string
  /**
   * That revision's `modifiedTime`: Docs merges edits made close together by the same account into one revision (ACB
   * writes with the member's own token), so a change merged into ACB's revision keeps its id but moves this.
   */
  revisionAt: string
  /** The upload's `modifiedTime`: comments made or changed after it are someone's. */
  at: string
}

/**
 * The AI read a Google document in a consultation (google-drive.md "Continuing a document people edited"): what it read —
 * the sha256 of the text export it was given and the newest revision then. An overwrite of a document people changed
 * needs the newest read of this consultation to be what the document is now.
 */
export interface DriveDocRead {
  userId: string
  conversationId: string
  fileId: string
  fingerprint: string
  revision: string
  revisionAt: string
  /** sha256 of the document's comments as handed to the AI with the text (ids, times, deleted): a comment since → read again. */
  commentsSeen: string
  readAt: string
}

/**
 * A put that waits for the member's 「上書きする」 (google-drive.md "Continuing a document people edited"): the request as
 * the AI made it (content included, fixed by its sha256), what the document was when the AI read it, and the comments
 * seen then. `open` until pressed, declined or expired; the content is removed once it is decided.
 */
export interface DriveOverwriteConfirmationRow {
  id: string
  userId: string
  conversationId: string
  requestKey: string
  folderId: string
  fileId: string
  name: string
  kind: 'html' | 'markdown'
  sha256: string
  content: Uint8Array | null
  recordId: string | null
  fingerprint: string
  revision: string
  revisionAt: string
  /** sha256 of the document's comments as seen then (ids, times, deleted): one more comment afterwards asks again. */
  commentsSeen: string
  editors: string[]
  commented: boolean
  /** `writing`: a press is being written now (claimed atomically; neither a decline nor a newer request takes it). */
  state: 'open' | 'writing' | 'written' | 'declined'
  createdAt: string
  expiresAt: string
}

/**
 * A one-time pick ticket for Google Picker in the member's browser (google-drive.md "Picker and its
 * token"): only the ticket's sha256 is stored. `result` is the JSON of the picks the server kept (the
 * service writes and reads it), `error` a fixed sentence when the picking failed.
 */
export interface DrivePickTicketRow {
  id: string
  userId: string
  ticketHash: string
  mode: 'folder' | 'files'
  maxItems: number
  fileIds: string[]
  state: 'open' | 'saving' | 'picked' | 'cancelled' | 'failed'
  configHandedAt: string | null
  result: string | null
  createdAt: string
  expiresAt: string
  finishedAt: string | null
}

/**
 * The control plane's one lookup of a pick ticket (like a key-broker token by hash): which company's row
 * holds this sha256. Everything after it reads that company's handle.
 */
export interface PickTicketDirectory {
  companyOf(ticketHash: string): string | null
}

export interface GoogleDriveRepository {
  /** Insert or renew picks (a re-pick renews the name, type and expiry). */
  savePicks(rows: DrivePickRow[]): void
  /** The member's live pick of this file / folder at `now`, or null. */
  pick(userId: string, fileId: string, now: string): DrivePickRow | null
  /** The member's live picks, newest first. */
  picks(userId: string, now: string, limit: number): DrivePickRow[]
  /** The member's live picks of one kind, newest first. */
  picksOfKind(userId: string, kind: DrivePickRow['kind'], now: string, limit: number): DrivePickRow[]
  /** Removes expired picks (every member). */
  prunePicks(now: string): void
  /**
   * Renews the member's own **live** pick of this kind to `expiresAt` (never shortens it; an expired or unknown pick
   * stays as it is): a pick lasts since it was last used (google-drive.md "How long a pick lasts").
   */
  renewPick(userId: string, fileId: string, kind: DrivePickRow['kind'], expiresAt: string, now: string): void
  /** The member's pick of this file / folder whether or not it is still live (an expired one until pruned), or null. */
  anyPick(userId: string, fileId: string): DrivePickRow | null

  /** Keeps what the AI read of a document in a consultation (the newest read replaces the one before). */
  keepDocRead(row: DriveDocRead): void
  /** The newest read of this document in this consultation by the member's AI, or null. */
  docRead(userId: string, conversationId: string, fileId: string): DriveDocRead | null
  /** Removes reads kept before `before` (every member). */
  pruneDocReads(before: string): void

  createOverwriteConfirmation(row: DriveOverwriteConfirmationRow): void
  /** The member's own confirmation by id (any state), or null. */
  overwriteConfirmation(userId: string, id: string): DriveOverwriteConfirmationRow | null
  /** The member's own open, unexpired confirmation for this Drive file (at most one waits per file), or null. */
  openOverwriteConfirmation(userId: string, fileId: string, now: string): DriveOverwriteConfirmationRow | null
  /**
   * Moves a confirmation from one of `from` to `to` atomically (false when it was in none of them); its content is removed
   * when `to` is `written` or `declined`.
   */
  moveOverwriteConfirmation(id: string, from: DriveOverwriteConfirmationRow['state'][], to: DriveOverwriteConfirmationRow['state']): boolean
  /** Declines every open confirmation for this Drive file (any put of it went through: what they were asked about is gone). */
  declineOpenOverwriteConfirmations(fileId: string): void
  /** A member left the company: their waiting confirmations (with their content) and their reads are removed. */
  forgetMember(userId: string): void
  /** Removes the content of every confirmation expired at `now`, and the rows that expired before `deleteBefore` (every member). */
  pruneOverwriteConfirmations(now: string, deleteBefore: string): void

  /** Writes a new put in `sending` (the AI's copies its consultation's Skills, answered as `skills`; `row.skills` is ignored); when the member already has one with this request key, returns it instead. */
  claimPut(row: DrivePutRow): { claimed: true; skills: SkillUse[] | null } | { claimed: false; existing: DrivePutRow }
  put(userId: string, id: string): DrivePutRow | null
  /** The member's own put that made this Drive file (state done), or null. */
  putOfFile(userId: string, fileId: string): DrivePutRow | null
  /** The member's own puts that made a file (state done), newest first. */
  donePuts(userId: string, limit: number): DrivePutRow[]
  /** The member's own puts that made a file in this folder (state done), newest first. */
  donePutsInFolder(userId: string, folderId: string, limit: number): DrivePutRow[]
  /** The member's own done puts made within this execution run (a scheduled job's deliverables), oldest first. */
  runPuts(userId: string, runId: string, limit: number): DrivePutRow[]
  /** Settles a put still in `sending` / `unknown` (true when a row changed). */
  settlePut(id: string, fields: Pick<DrivePutRow, 'state' | 'fileId' | 'revisionId' | 'link' | 'reason' | 'finishedAt'>): boolean
  /** Removes a put still in `sending` (refused: nothing was made; its key is free again). */
  dropPut(id: string): void
  /** Keeps a done put's document baseline (read right after the put). */
  setDocBaseline(id: string, baseline: DriveDocBaseline): void

  createPickTicket(row: DrivePickTicketRow): void
  /** A ticket by the sha256 of its value (the Picker page's own request; no member known yet). */
  pickTicketByHash(ticketHash: string): DrivePickTicketRow | null
  /** The member's own ticket by its id (the app's session). */
  pickTicket(userId: string, id: string): DrivePickTicketRow | null
  /** Marks the config handed out, only once and only while the ticket is open and not expired at `now`. */
  claimPickTicketConfig(id: string, now: string): boolean
  /** Moves a ticket from one of `from` to `to` (with its result / error), atomically; false when it was in no state of `from`. */
  movePickTicket(id: string, from: DrivePickTicketRow['state'][], to: DrivePickTicketRow['state'], fields: { result?: string | null; finishedAt?: string | null }): boolean
  /** Removes the member's own ticket (closed after its result, or cancelled by the app). */
  dropPickTicket(userId: string, id: string): void
  /** How many of the member's tickets are open or saving and not expired at `now`. */
  openPickTickets(userId: string, now: string): number
  /** Removes tickets that expired before `before` (every member). */
  prunePickTickets(before: string): void
}
