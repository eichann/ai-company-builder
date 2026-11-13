/**
 * Google Drive's storage behind the company handle (google-drive.md): what a
 * person picked with Google Picker, and the receipts of puts (操作の控え).
 * Every method is limited to the handle's company and takes the member.
 */
import type { SkillUse } from '../../shared/core/skill-uses'
import type { DrivePutAs, DrivePutKind } from '../../shared/core/google-drive'

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
 * Who sees where a waiting put goes, as the member's card shows it (google-drive.md "Asking before a put"): never the
 * addresses, only the domains outside and how many inside.
 */
export interface DriveConfirmAudience {
  anyone: boolean
  outsideDomains: string[]
  insideOthers: 'domain' | number
  /** The file is in a private folder on the member's PC (the app said so). */
  privateSource: boolean
}

/**
 * A put that waits for the member's press (google-drive.md "Continuing a document people edited", "Asking before a
 * put"): the request as the AI made it (content included, fixed by its sha256); for an edited document what it was when
 * the AI read it and the comments seen then (`fingerprint` … `commentsSeen`, else null); for a place others see who sees
 * it (`audience`, `audienceSig`, else null). `open` until pressed, declined or expired; the content is removed once decided.
 */
export interface DriveOverwriteConfirmationRow {
  id: string
  userId: string
  conversationId: string
  requestKey: string
  folderId: string
  /** An update's file; null for a new file. */
  fileId: string | null
  name: string
  kind: DrivePutKind
  as: DrivePutAs
  sha256: string
  content: Uint8Array | null
  recordId: string | null
  fingerprint: string | null
  revision: string | null
  revisionAt: string | null
  /** sha256 of the document's comments as seen then (ids, times, deleted): one more comment afterwards asks again. */
  commentsSeen: string | null
  editors: string[]
  commented: boolean
  audience: DriveConfirmAudience | null
  /** sha256 of exactly who sees it (outside and inside): the press writes only while it is the same. */
  audienceSig: string | null
  /** 「このフォルダはもう聞かない」 may be offered (people outside only: no link for anyone, not a private folder's file). */
  trustOffered: boolean
  /** `writing`: a press is being written now (claimed atomically; neither a decline nor a newer request takes it). */
  state: 'open' | 'writing' | 'written' | 'declined'
  createdAt: string
  expiresAt: string
}

/** 「このフォルダはもう聞かない」 (google-drive.md "Asking before a put"): for exactly the people outside who saw it then. */
export interface DriveFolderTrust {
  userId: string
  folderId: string
  folderName: string
  audienceSig: string
  outsideDomains: string[]
  createdAt: string
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
  /** Files mode: `read` (for the AI: readable types only) or `link` (linked to a record by the person: every type). */
  purpose: 'read' | 'link'
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
  /**
   * The member's own open, unexpired confirmation for this Drive file (an update: at most one waits per file) or for this
   * request (a new file: at most one per request key), or null.
   */
  openOverwriteConfirmation(userId: string, target: { fileId: string } | { requestKey: string }, now: string): DriveOverwriteConfirmationRow | null
  /**
   * Moves a confirmation from one of `from` to `to` atomically (false when it was in none of them); its content is removed
   * when `to` is `written` or `declined`.
   */
  moveOverwriteConfirmation(id: string, from: DriveOverwriteConfirmationRow['state'][], to: DriveOverwriteConfirmationRow['state']): boolean
  /** Declines every open confirmation for this Drive file (any put of it went through: what they were asked about is gone). */
  declineOpenOverwriteConfirmations(fileId: string): void
  /** The member's 「このフォルダはもう聞かない」 for this folder, or null. */
  folderTrust(userId: string, folderId: string): DriveFolderTrust | null
  /** Keeps (or replaces) the member's trust of a folder. */
  trustFolder(row: DriveFolderTrust): void
  /** Takes the member's trust of a folder away (false when there was none). */
  untrustFolder(userId: string, folderId: string): boolean
  /** The member's trusted folders, newest first. */
  trustedFolders(userId: string): DriveFolderTrust[]
  /** A member left the company: their waiting confirmations (with their content), their reads and trusted folders are removed. */
  forgetMember(userId: string): void
  /** Removes the content of every confirmation expired at `now`, and the rows that expired before `deleteBefore` (every member). */
  pruneOverwriteConfirmations(now: string, deleteBefore: string): void

  /** Writes a new put in `sending` (the AI's copies its consultation's Skills, answered as `skills`; `row.skills` is ignored); when the member already has one with this request key, returns it instead. */
  claimPut(row: DrivePutRow): { claimed: true; skills: SkillUse[] | null } | { claimed: false; existing: DrivePutRow }
  put(userId: string, id: string): DrivePutRow | null
  /** The member's own put that made this Drive file (state done), or null. */
  putOfFile(userId: string, fileId: string): DrivePutRow | null
  /**
   * The files the member's own puts made (state done): **one row per Drive file** — its latest done put — newest first,
   * so re-putting one file many times never pushes another out of the list. `folderId`: only files whose latest put is
   * in that folder; `before`: only those after this one in that order (the next page: its time and id, so ties are never skipped).
   */
  donePutFiles(userId: string, opts: { limit: number; folderId?: string; before?: { createdAt: string; id: string } }): DrivePutRow[]
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
