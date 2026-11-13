/**
 * The company map of the light ontology (stage 4-2, `.claude/rules/records.md`):
 * the feature switch, type definitions (every version), the record index,
 * links, server-sourced state, and the indexer's bookkeeping. Reached only
 * through a company handle (ports/company-data.ts): no method takes a
 * company, and every statement is limited to the handle's company.
 */

import type { LedgerEntry } from '../../shared/core/record-ledger'

/** A repository the index reads: the company repository, or one private folder's (by scope id). */
export type RecordRepoKey = 'company' | `scope:${string}`

export interface RecordSettingsRow {
  enabled: boolean
  updatedAt: string | null
  updatedBy: string | null
}

export interface RecordTypeRow {
  name: string
  version: number
  /** JSON of shared/core TypeDefinition. */
  definition: string
  source: 'file' | 'core' | 'plugin'
  commitSha: string | null
  createdAt: string
}

export interface RecordRow {
  id: string
  type: string
  typeVersion: number | null
  /** The private folder (scope id) holding the file; null = company repository or server only. */
  scopeId: string | null
  /** Company path of the record's file; null = the record lives on the server only. */
  path: string | null
  /** Server-only record: the folder whose readers may see it (null = everyone in the company). */
  folder: string | null
  /**
   * Owner-only record (「持ち主だけ」, records.md "Owner-only records"): the one member who
   * may see it — nobody else, owners and admins included. null = visibility by `folder`.
   * Written on insert and by `setPlace` only (an upsert of an existing row keeps it).
   */
  personalOwner: string | null
  /**
   * Members-only record (「この人たちだけ」, records.md "Members-only records"): the members who
   * may see it — nobody else, owners and admins included (an empty list: nobody). null = not
   * members-only. `upsert` marks a new row members-only (an existing row keeps its place; a list
   * asked for an existing row that is not members-only throws) and the caller lists its readers
   * with `addMembers` in the same transaction; `setPlace` ends it. Never set together with `personalOwner`.
   */
  members: readonly string[] | null
  /**
   * The groups and departments on a members-only list (records.md "Members-only records"), with
   * who is in each now (read with the row, never stored). Absent or empty = people only. Only a
   * members-only row has any; added with `addMemberSets`.
   */
  memberSets?: readonly RecordMemberSet[]
  title: string
  summary: string
  createdAt: string
  updatedAt: string
  removedAt: string | null
}

export interface RecordStateRow {
  recordId: string
  state: string | null
  /** JSON object of server-sourced field values. */
  fields: string
  version: number
  updatedAt: string
}

export interface RecordLinkRow {
  sourceId: string
  name: string
  position: number
  targetId: string | null
  targetPath: string | null
  /**
   * Who made a file link (the member; their AI counts as them), kept so a link into a
   * `.personal/` folder is shown to that member alone (records.md "Links into .personal/").
   * Absent / null: not known (a record file's link, a link from before it was kept).
   */
  createdBy?: string | null
  /** A `drive:` link's facts as they were when it was linked (absent for every other link). */
  drive?: DriveLinkMeta | null
}

/**
 * What ACB kept of a Google Drive file when a member linked it (records.md "Drive and PC file links"): the revision it was at, its name as picked (shown to the linker only), the sha256
 * of the content ACB read then (null when ACB could not read it), its MIME type and when.
 */
export interface DriveLinkMeta {
  revisionId: string | null
  name: string
  sha256: string | null
  mimeType: string | null
  linkedAt: string
}

export interface RecordProblemRow {
  repo: RecordRepoKey
  path: string
  kind: string
  detail: string
  foundAt: string
}

/** SQL-level narrowing of a map query (the viewer's read access is applied by the service afterwards). */
export interface RecordCandidateFilter {
  types?: string[]
  states?: string[]
  /** Server field (validated name) → accepted values (JSON scalars). */
  fields?: Array<{ name: string; values: Array<string | number | boolean | null> }>
  /** Tags field (kind `tags`, validated name) → a tag the stored list must hold (already normalized). */
  contains?: Array<{ name: string; tag: string }>
  /** Matched against title and summary (substring, A–Z case-insensitive). */
  text?: string
  ids?: string[]
  /** Server field (validated name; date / datetime / number) → `gte` ≤ value < `lt` (compared as stored). */
  ranges?: Array<{ name: string; gte?: string | number; lt?: string | number }>
  /** Order by a server field (validated name), empty values last, then most recently changed. Default: most recently changed. */
  sort?: { field: string; order: 'asc' | 'desc' }
  /** In one of these (type, state) pairs, entered (a ledger entry into it from another state) at or after `since`. */
  finishedSince?: { since: string; finals: Array<{ type: string; state: string }> }
  /** An outgoing record link `name` holds `id`. */
  link?: { name: string; id: string }
}

/** The columns read access is decided from. */
export interface RecordAccessRow {
  id: string
  type: string
  scopeId: string | null
  path: string | null
  folder: string | null
  personalOwner: string | null
  /** Members-only (records.md "Members-only records"): the members who read it; null = not members-only. */
  members: readonly string[] | null
  /** …and the groups and departments on that list, with who is in each now (absent = none). */
  memberSets?: readonly RecordMemberSet[]
}

/** A group or a department on a members-only list (records.md "Members-only records"). */
export interface RecordSetSubject {
  type: 'group' | 'department'
  id: string
}

/** …as read with the row: who is in it now (`memberIds`, never stored). */
export interface RecordMemberSet extends RecordSetSubject {
  memberIds: readonly string[]
}

/** The AI's credential for the company map (only the digest of its value). */
export interface RecordAiTokenRow {
  id: string
  userId: string
  tokenHash: string
  scope: 'read' | 'act'
  agent: string
  conversationId: string
  createdAt: string
  expiresAt: string
  revokedAt: string | null
  /** The execution run the token is bound to and its claim generation (S10b); absent / null for a consultation's token. */
  runId?: string | null
  runGeneration?: number | null
}

/** The first time a turn's holder (or their delegate) opened a record in the app. */
export interface RecordTurnOpenRow {
  recordId: string
  /** The ledger version that began the turn. */
  turnVersion: number
  holderId: string
  openedBy: string
  openedAt: string
}

/** One calendar event as the minutes' discovery knows it (`meeting_events`). */
export interface MeetingEventRow {
  eventKey: string
  recordId: string | null
  /** Someone's calendar marks it private: never recorded. */
  private: boolean
  /** Looks that found no minutes yet, and when to look again. */
  tries: number
  nextAt: string | null
}

export interface RecordRepository {
  settings(): RecordSettingsRow
  setEnabled(enabled: boolean, by: string, at: string): void
  /** The company's minutes folder (milestone 4, minutes.md): a department folder, or null when not chosen. */
  minutesFolder(): string | null
  setMinutesFolder(folder: string | null, by: string, at: string): void
  /** Which meetings the intake reads (minutes.md "Which meetings"): the stored value, null = the default. */
  meetingIntake(): string | null
  setMeetingIntake(value: string, by: string, at: string): void
  /** Days 「どのまとまりの会議ですか？」 asks after a meeting is read (minutes.md): the stored value, null = the default. */
  meetingBundleDays(): number | null
  setMeetingBundleDays(days: number, by: string, at: string): void

  /** Every stored version of every type, oldest first per name. */
  typeVersions(): RecordTypeRow[]
  insertTypeVersion(row: RecordTypeRow): void

  find(id: string): RecordRow | null
  /** The live (not removed) record whose file is at `path`. */
  findByPath(path: string): RecordRow | null
  /** Live records whose file is in one repository (`scopeId` null = the company repository). */
  fileRecordsIn(scopeId: string | null): RecordRow[]
  upsert(row: RecordRow): void
  markRemoved(id: string, at: string): void
  /**
   * Who may see a server-only record: an owner-only or members-only record shared to a folder
   * (records.md "Owner-only records", "Members-only records"). Ends members-only (its list is dropped).
   */
  setPlace(id: string, place: { folder: string | null; personalOwner: string | null }, at: string): void
  /**
   * Add readers to a members-only record (「招待する」, records.md "Members-only records"); a member
   * already listed is kept as is. Returns the ids newly added. Throws for a record that is not
   * members-only (call it inside the transaction that wrote the record or its version).
   */
  addMembers(id: string, userIds: readonly string[], by: string, at: string): string[]
  /**
   * Add groups / departments to a members-only record's list (each of this company: the database
   * refuses another's). Returns those newly added; throws for a record that is not members-only.
   */
  addMemberSets(id: string, sets: readonly RecordSetSubject[], by: string, at: string): RecordSetSubject[]
  /**
   * Take people, groups and departments off a members-only record's list (「見る人を減らす」).
   * Returns what was on it and is now gone; throws for a record that is not members-only.
   */
  removeMembers(id: string, userIds: readonly string[], sets: readonly RecordSetSubject[]): { users: string[]; sets: RecordSetSubject[] }
  /** A member left the company: they are on no members-only record's list any more (re-joining starts from nothing). */
  forgetMember(userId: string): void
  /** The recurring series (digests) a member set to 「自動で読む」 (minutes.md "Meetings for their attendees"). */
  meetingAutoSeries(userId: string): string[]
  setMeetingAutoSeries(userId: string, seriesKey: string, auto: boolean, at: string): void
  /** What discovery knows of one calendar event (minutes.md): its record, a private mark, the back-off. */
  meetingEvent(eventKey: string): MeetingEventRow | null
  setMeetingEvent(eventKey: string, change: Partial<Omit<MeetingEventRow, 'eventKey'>>, at: string): void
  /** Live records of `type` whose members-only list names the member. */
  listedRecordIds(userId: string, type: string): string[]

  linksFrom(ids: string[]): RecordLinkRow[]
  /**
   * Whether a ledger entry fixed this Drive file as a decision's material or an attachment (`{ kind: 'drive', fileId }`,
   * with its revision): such a file is never overwritten (google-drive.md "Overwriting").
   */
  driveFileFixed(fileId: string): boolean
  /**
   * The records on which this member made a live link to this Drive file (`drive:<fileId>`, made by them — their AI's put
   * link counts — with the facts kept when linked; a link brought back by an undo has none): while they can still read
   * one of them, the file stays theirs to read (google-drive.md "How long a pick lasts").
   */
  driveLinkSources(userId: string, fileId: string): string[]
  /** Links whose target is a file at exactly one of `paths` (company paths). */
  fileLinksTo(paths: string[]): RecordLinkRow[]
  /** Point these links (source, name, position) at another file path. */
  retargetFileLinks(links: Array<{ sourceId: string; name: string; position: number; targetPath: string }>): void
  /**
   * A department folder renamed by the server (services/departments.ts): records whose readers'
   * folder is at or under `from`, links to files at or under it, and the minutes folder move to `to`.
   */
  moveFolder(from: string, to: string): void
  /**
   * Live records whose readers' folder is `folder` or under it (ids only): 「非公開にする」 takes a
   * まとまり only into a private folder no record is in yet (records.md "Making a 案件・プロジェクト private").
   */
  placedIn(folder: string): string[]
  /** Links naming any of `ids` as their target. */
  linksTo(ids: string[]): RecordLinkRow[]
  replaceLinks(sourceId: string, links: RecordLinkRow[]): void

  states(ids: string[]): RecordStateRow[]
  /**
   * Write a record's server state if its version is still `expectedVersion`
   * (0 = no state yet). false = someone changed it first (nothing written).
   */
  writeState(row: RecordStateRow, expectedVersion: number): boolean

  /** The record's ledger, oldest first. */
  ledger(recordId: string): LedgerEntry[]
  appendLedger(entry: LedgerEntry): void

  /**
   * 「番の人が最初に開いた」 (records.md "Whose turn it was"): keep the first
   * opening of the record's turn that began at `turnVersion`; false when that
   * turn already has one (nothing changes).
   */
  noteTurnOpened(row: RecordTurnOpenRow): boolean
  /** The record's first openings, one per turn, oldest turn first. */
  turnOpens(recordId: string): RecordTurnOpenRow[]

  /** Live records matching the filter, with only the access columns (bounded by `limit`). */
  candidates(filter: RecordCandidateFilter, limit: number): RecordAccessRow[]
  /** Full rows of live records, any order. */
  byIds(ids: string[]): RecordRow[]

  head(repo: RecordRepoKey): string | null
  setHead(repo: RecordRepoKey, commitSha: string, at: string): void
  /** Forget every head: the next index run reads every repository in full. */
  clearHeads(): void

  insertAiToken(row: RecordAiTokenRow): void
  /** The token of this company with this digest (another company's never matches). */
  aiTokenByHash(tokenHash: string): RecordAiTokenRow | null
  /** End one of the member's tokens; false when it is not theirs (or already ended). */
  revokeAiToken(userId: string, tokenId: string, at: string): boolean
  liveAiTokens(userId: string, now: string): number
  /** Forget tokens that expired before `before`. */
  pruneAiTokens(before: string): void

  problems(limit: number): RecordProblemRow[]
  /** Replace the problems of these paths in one repository (all of its problems when `paths` is null). */
  replaceProblems(repo: RecordRepoKey, paths: string[] | null, problems: RecordProblemRow[]): void
}
