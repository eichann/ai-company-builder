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

  /** Writes a new put in `sending` (the AI's copies its consultation's Skills, answered as `skills`; `row.skills` is ignored); when the member already has one with this request key, returns it instead. */
  claimPut(row: DrivePutRow): { claimed: true; skills: SkillUse[] | null } | { claimed: false; existing: DrivePutRow }
  put(userId: string, id: string): DrivePutRow | null
  /** The member's own put that made this Drive file (state done), or null. */
  putOfFile(userId: string, fileId: string): DrivePutRow | null
  /** The member's own puts that made a file (state done), newest first. */
  donePuts(userId: string, limit: number): DrivePutRow[]
  /** The member's own done puts made within this execution run (a scheduled job's deliverables), oldest first. */
  runPuts(userId: string, runId: string, limit: number): DrivePutRow[]
  /** Settles a put still in `sending` / `unknown` (true when a row changed). */
  settlePut(id: string, fields: Pick<DrivePutRow, 'state' | 'fileId' | 'revisionId' | 'link' | 'reason' | 'finishedAt'>): boolean
  /** Removes a put still in `sending` (refused: nothing was made; its key is free again). */
  dropPut(id: string): void
}
