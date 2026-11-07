/**
 * API contract of the company map (light ontology, stage 4-2;
 * `.claude/rules/records.md`). Mounted at /api/companies/:companyId.
 *
 *   GET  /records/settings   owner/admin   → RecordSettings
 *   PUT  /records/settings   owner/admin   { enabled: boolean } → RecordSettings
 *   GET  /records/problems   owner/admin   → { problems: RecordIndexProblem[] }
 *   POST /records/reindex    owner/admin   { full: true } → { scheduled: true }   (index rebuilt from the files)
 *   GET  /records/types      any member    → { types: RecordTypeView[] }
 *   POST /records/query      any member    RecordQuery → RecordQueryResult (records of an old connection only with includeOldConnection)
 *   GET  /records/item/:recordId  any member  → RecordDetail
 *   GET  /records/my-turn    any member    → RecordQueryResult (「あなたの番」, 4-4)
 *   POST /records/item       any member    CreateRecordRequest → 201 { record, entry, similar? } (server-only record;
 *                                          `similar` { id, title }: made from a meeting, a live item of it the
 *                                          caller reads has a close title — 「似ているやることがあります」, a hint only)
 *   POST /records/item/:recordId/actions/:action   ActionRequest → { record, entry }
 *   POST /records/item/:recordId/undo              UndoRequest → { record, entry }
 *   POST /records/item/:recordId/file-links        FileLinkRequest → FileLinkResult (link a file later)
 *   POST /records/item/:recordId/file-links/remove FileLinkRequest → FileLinkResult (remove that link)
 *   POST /records/item/:recordId/record-links        RecordLinkRequest → RecordLinkResult (link a record later)
 *   POST /records/item/:recordId/record-links/remove RecordLinkRequest → RecordLinkResult (remove that link;
 *                                                  取り消す = POST …/undo { version: entry.version, expectedVersion })
 *   POST /records/item/:recordId/share             ShareRecordRequest → { record, entry, similar? } (owner-only / members-only → a folder; session only)
 *   POST /records/item/:recordId/members           InviteRecordMembersRequest → { record, entry, added } (members-only; session only)
 *   GET  /records/item/:recordId/history           → { entries: LedgerEntry[] }
 *   GET  /records/item/:recordId/versions/:version → ReplayedState
 *
 * The state engine's refusals carry a `code`: VERSION_CONFLICT (409, with the
 * current `version`), ACTION_NOT_ALLOWED_IN_STATE (409), NOT_ALLOWED (403),
 * NOTE_REQUIRED / ARG_REQUIRED / BAD_VALUE / BAD_ATTACHMENT / BAD_MATERIAL
 * (400), ATTACHMENT_NOT_SYNCED (409: push the file first), CHANGED_SINCE (409, undo),
 * FILE_NOT_LINKABLE (400: a file the caller cannot read, or one the record may
 * not reach — never says which or where), LINK_NOT_FOUND (404, removing), LINK_IS_ORIGIN
 * (400: an origin link — where the record came from — is never linked or removed by hand).
 *
 * While the feature is off for the company, every route but the settings
 * answers 404 `RECORDS_DISABLED`. Answers, counts and link lists hold only
 * records the caller may read: a record in a private folder they cannot read,
 * and another member's owner-only record (owners and admins included), is
 * exactly a record that does not exist.
 */
import type { TypeDefinition } from '../core/record-types'
import type { DecisionMaterial, LedgerEntry } from '../core/record-ledger'

export interface RecordSettings {
  enabled: boolean
  updatedAt: string | null
}

export interface RecordIndexProblem {
  /** 'company' or 'scope:<scope id>'. */
  repo: string
  path: string
  /** duplicate_id, invalid_record, invalid_type, type_version, breaking_type_change, type_file_removed, unknown_type, ignored_keys, blocked_link, moved_across_folders, server_only_type */
  kind: string
  detail: string
  foundAt: string
}

export interface RecordTypeView {
  /** The version in force. */
  definition: TypeDefinition
  source: 'file' | 'core' | 'plugin'
  /** Every stored version, oldest first. */
  versions: number[]
}

export type RecordFieldValue = string | number | boolean | null

export interface RecordQuery {
  type?: string
  /** Records of every type implementing this interface (e.g. `request`). */
  implements?: string
  state?: string[]
  /**
   * Server-sourced field → one value or several (`{ in: [...] }`); a field of
   * kind `tags` → `{ contains: tag }` (records whose tags hold it, normalized
   * as stored; only types where that field holds tags are searched); a field
   * of kind date / datetime / number → `{ gte?, lt? }` (gte ≤ value < lt,
   * compared as stored: `{ lt: '2026-11-06' }` = due by the end of 11/5, with
   * or without a time; only types where that field has such a kind).
   */
  fields?: Record<string, RecordFieldValue | { in: RecordFieldValue[] } | { contains: string } | { gte?: string | number; lt?: string | number }>
  /** Order by a date / datetime / number server field (empty values last); default most recently changed first. */
  sort?: { field: string; order?: 'asc' | 'desc' }
  /** Only records now in a final state of their type that they entered at or after this time (「今日終わったこと」). */
  finishedSince?: string
  /** Only records whose outgoing link `name` points at `id` (a bundle's tasks); `id` must be readable (else 404). */
  link?: { name: string; id: string }
  /** Records linked to this one (either direction), up to `hops` (1 or 2, default 1). */
  linkedTo?: { id: string; hops?: 1 | 2 }
  /**
   * Records with a file link to exactly this company path (「つながっているもの」 of
   * a file). Empty when the caller cannot read the file; a record outside a
   * private folder never counts for a path inside one. Not with `linkedTo`.
   */
  linkedToFile?: string
  /** Substring of the title or summary (0.23-1: not the full text). */
  text?: string
  /** 1–200, default 50. */
  limit?: number
  /** 0–10000. */
  offset?: number
  /** Only `total`. */
  countOnly?: boolean
  /**
   * Also records imported through an earlier connection of an outside system
   * (`fromOldConnection`); left out by default (and never in 「あなたの番」).
   */
  includeOldConnection?: boolean
}

/** What a record imported through an earlier connection is called on screen and for the AI. */
export const OLD_CONNECTION_LABEL = '前のつなぎ先から取り込んだもの（いまは使われていません）'

/**
 * A 「決めたこと」 marked 例外（この件だけ） (its `exception` field): a judgement
 * for its linked thing only, never a precedent for another case. Carried as
 * `exceptionNotice` so the AI reading past decisions sees it in words.
 */
export const DECISION_EXCEPTION_NOTICE = '例外（この件だけ）：つながった件だけの判断です。ほかの件の前例にしないでください。'

/**
 * A 「決めたこと」 not confirmed yet (state `unconfirmed`, decision version 6, owner decision
 * 2026-11-07 「決めたことを人が確かめる」): an AI's 「決めたことの案」, not a decision until the person
 * who decides says so. Carried as `proposalNotice` wherever the AI reads it (`recordSummaries`), so it
 * is never used as a precedent.
 */
export const DECISION_PROPOSAL_NOTICE = 'まだ確かめていない案：決める立場の人が「そうです」と確かめるまでは決めたことではありません。前例や根拠として使わないでください。'

/** The decision actions a screen asks about (`RecordDetail.decisionChecks`). */
export const DECISION_CHECK_ACTIONS = ['confirm', 'reject', 'retract'] as const

/**
 * Who may say 「そうです」/「違う」 on a decision, as the server answers it for the caller
 * (`GET /records/item/:id`, decision version 6): `may` — the engine's own answer per action, so a
 * screen shows only buttons that work. `responsible` — the 責任者 of its まとまり who read it (they
 * decide); `cannotRead` — a 責任者 who cannot read it (a meeting for its attendees they did not
 * attend): never widened, the meeting's readers decide instead and the screen says
 * 「〇〇さんはこの会議を見られません」. Both are member ids, given only when the caller reads that まとまり.
 */
export interface DecisionCheck {
  may: { confirm: boolean; reject: boolean; retract: boolean }
  responsible: string[]
  cannotRead: string[]
}

export interface RecordSummary {
  id: string
  type: string
  typeVersion: number | null
  title: string
  summary: string
  /** Company path of the record's file; null = it lives on the server only. */
  path: string | null
  state: string | null
  /**
   * Server-sourced field values. A field of kind `tags` holds the JSON text
   * of its list (`["急ぎ","見積"]`, null = none): `parseTagsValue` in
   * `shared/core/record-types.ts` reads it.
   */
  fields: Record<string, RecordFieldValue>
  /** Changes made through the state engine (0 = none yet). */
  version: number
  updatedAt: string
  /**
   * Imported through an earlier connection of an outside system (an owner /
   * admin started a new one with 「新しいつなぎ先として始める」): kept as it
   * was, but no longer brought up to date and no operation runs on it.
   * Absent for every other record.
   */
  fromOldConnection?: true
  /** With `fromOldConnection`: `OLD_CONNECTION_LABEL`, to show as is. */
  notice?: string
  /**
   * A decision marked 例外（この件だけ） (`fields.exception: true`):
   * `DECISION_EXCEPTION_NOTICE`. Absent for every other record.
   */
  exceptionNotice?: string
  /**
   * A decision not confirmed yet (`state: unconfirmed`): `DECISION_PROPOSAL_NOTICE` (「まだ確かめていない
   * 案」). Absent for every other record.
   */
  proposalNotice?: string
  /**
   * Owner-only (「持ち主だけ」, records.md "Owner-only records"): only the member
   * reading it sees it — it reaches nobody else, owners and admins included.
   * Absent for every other record.
   */
  personal?: true
  /**
   * Members-only (「この人たちだけ」, records.md "Members-only records"): only the members on its
   * list see it — owners and admins included only when listed. No names here (who is on it is
   * the 見られる人 label's). Absent for every other record.
   */
  membersOnly?: true
  /**
   * 「あなたの番」 and 「AI の番」 only: the absent member this item waits for,
   * when it is in the caller's list as their delegate (代わりの人,
   * records.md "Absence and the delegate"). Absent otherwise.
   */
  actingFor?: string
  /**
   * 「AI の番」 only: the server clock's 「見込みの日時が過ぎた」 put it in this state
   * (`enteredByWaitOver`, shared/core/core-types.ts) — what the PC's wait-over step runs.
   * Absent otherwise.
   */
  waitOver?: true
  /**
   * 「あなたの番」 only: the server clock gave it back because its 見込み (`wait_until`) passed and
   * it is still the person's (`waitCameBack`, shared/core/core-types.ts; task version 12) — when
   * the wait began (`waitedSince`, ISO; null when not known) and when it came back. Absent
   * otherwise (an older server never sends it).
   */
  waitCameBack?: { waitedSince: string | null; overAt: string }
}

export interface RecordQueryResult {
  /** Every match the caller may read (not only this page). */
  total: number
  records: RecordSummary[]
}

/**
 * One record 探す found (`POST /records/find`, records.md "探す"): the summary plus what the
 * left tab narrows and labels by, all decided on the server from what the caller reads.
 */
export interface RecordFindHit {
  record: RecordSummary
  /** The department folder it lives in (its path's or folder's first part); null = the whole company. */
  department: string | null
  /** The caller is in it: its owner (owner-only), a person field of its type, or a meeting's attendee. */
  mine: boolean
  /** Its 案件・プロジェクト (outgoing `bundle` link), when the caller reads it. */
  bundle?: { id: string; title: string }
}

/** A 相手 / 案件 at a glance (探す's summary card, 「進行中の案件」): counts of what the caller reads. */
export interface RecordFindHub {
  id: string
  counts: { bundles: number; openTasks: number; meetings: number; decisions: number; files: number }
  /** The first meeting on or after `today` (its `meeting_at`), else null. */
  nextMeetingAt: string | null
  /** The newest change among it and what is linked to it. */
  lastMovedAt: string
  /** Readable やること and 案件 linked to it: the app matches this PC's consultations about them. */
  memberIds: string[]
}

/** `POST /records/find { text, today }`. */
export interface RecordFindResult {
  /** Every readable match (hits holds the newest 200). */
  total: number
  hits: RecordFindHit[]
  /** Hits that are a 相手 or a 案件 whose name holds the words (at most 5). */
  hubs: RecordFindHub[]
}

/** `POST /records/find-home { today, from, to }`: 探す with nothing typed. */
export interface RecordFindHome {
  /** The caller's unfinished 案件・プロジェクト, newest first (at most 5). */
  bundles: Array<RecordFindHit & { hub: RecordFindHub }>
  /** The caller's meetings with `meeting_at` in [from, to), earliest first (at most 5). */
  meetings: RecordFindHit[]
}

export interface RecordLinkView {
  name: string
  /** out = written in this record; in = another record names this one. */
  direction: 'out' | 'in'
  record?: RecordSummary
  /** A file of the company folder (outgoing file links). */
  path?: string
  /**
   * With `path`: true when no file or folder is at that path now (deleted, or
   * moved where the link could not follow) — 「つながりが切れています」. Absent
   * when the server could not tell.
   */
  broken?: boolean
  /**
   * With `path`: a folder (not a file) is at that path on the shared branch now —
   * the app shows a folder row that opens it in the file tree. Absent for a
   * file, a broken link, or when the server could not tell.
   */
  folder?: true
  /**
   * A file of the member's own PC (a company without the shared folder: records.md "File links
   * without the shared folder"): `path` inside their working folder. Only ever in an answer to the
   * member who linked it — nobody else gets the row, its path or a count of it. Remove it with
   * `file-links/remove { target: { kind: 'local', path } }`.
   */
  local?: { path: string }
  /**
   * A Google Drive file linked to the record (a company without the shared folder). Every reader of
   * the record gets the row (`fileId`, opened in Drive, which decides who may see it); only the member
   * who linked it (`mine`) gets what ACB read then: the name as picked, the revision, the sha256 of
   * the content ACB read (null when it could not read it), the type and when.
   */
  drive?: DriveLinkView
  /**
   * The link cannot be removed by hand (no 「…」→「つながりを外す」): it says where the record came
   * from (an `origin` link: もとの会議・もとの連絡・AI が用意したもの), or the record's links change only
   * through its service or its file. Absent = it can be removed (`record-links/remove`,
   * `file-links/remove`).
   */
  fixed?: true
}

/** A Drive link as `RecordLinkView.drive` answers it. */
export interface DriveLinkView {
  fileId: string
  /** The caller linked it (only then the facts below). */
  mine: boolean
  name?: string
  revisionId?: string | null
  sha256?: string | null
  mimeType?: string | null
  linkedAt?: string
}

/**
 * A kind of 束ねるもの as the screen names it (records.md "Bundle kinds"): the type to create
 * (`POST /records/item { type }`) and its name — a business plugin's kind keeps its own label
 * (案件・番組), the core's `project` takes the company's name (初期値「プロジェクト」). Never 「まとまり」.
 */
export interface BundleKind {
  type: string
  name: string
  source: 'core' | 'plugin'
}

/** GET /records/bundle-kinds. */
export interface BundleKindsResult {
  /** The core's ordinary kind, under the company's name. */
  core: BundleKind
  /** What each department makes: its business plugin's kind if one lives there, else `core`. */
  departments: Array<{ departmentId: string; folder: string; kind: BundleKind }>
  /** Every kind in use in the company (where kinds mix: 「案件・プロジェクトごと」, searching across departments). */
  kinds: BundleKind[]
  /**
   * 「使う機能」 プロジェクト is off (records.md "Features on and off"): the core's kind is still named
   * (existing ones are 「見るだけ」) but nothing new of it is made — a department whose `kind` is the
   * core's has nothing to make or choose. Absent = on (and from older servers; an older app ignores it,
   * and its 「新しいプロジェクトにする」 gets the server's FEATURE_OFF words).
   */
  coreOff?: true
}

export interface RecordDetail {
  record: RecordSummary
  links: RecordLinkView[]
  /**
   * A 非公開 案件・プロジェクト (records.md "Private 案件・プロジェクト"): the private folder that is its
   * 見える範囲 (its participants are that folder's readers). Only on a まとまり placed exactly there;
   * whoever reads the record reads the folder. Absent otherwise and from older servers.
   */
  privateFolder?: { scopeId: string; path: string }
  /**
   * Decision version 6: for the record itself when it is a decision, and for every decision among
   * `links`, keyed by its id — who may confirm (`DecisionCheck`). Absent from older servers.
   */
  decisionChecks?: Record<string, DecisionCheck>
}

/**
 * The agents whose record tokens may act (create / run actions); any other
 * agent gets a `read` token whatever it asks for (owner decision 0.3-3:
 * Codex reads only). Server-side defence in depth: the agent name is the
 * app's word, and the app restricts the same way (its registry's
 * `recordActions`, pinned to this list by client/tests/records-tools.test.ts).
 */
export const RECORD_ACTION_AGENTS: readonly string[] = ['claude-code']

/** Who acts: the member by hand (default) or the member's AI. */
export interface RecordActor {
  kind: 'human' | 'ai'
  /** For an AI: which one (e.g. `claude`). */
  source?: string
}

export interface CreateRecordRequest {
  type: string
  title: string
  summary?: string
  /** The folder whose readers may see it (none = everyone in the company); not inside a private folder. */
  folder?: string
  /**
   * Owner-only (「持ち主だけ」: 自分用のやること): only the creator sees it — not owners or admins
   * either. Never with `folder` (400 PERSONAL_WITH_FOLDER); an assignee other than the creator
   * cannot read it (400 ASSIGNEE_CANNOT_READ). Shown to a folder later with ShareRecordRequest.
   */
  personal?: boolean
  /**
   * Members-only (「この人たちだけ」): only these members see it (the creator is added; at most
   * 200) — not owners or admins unless listed. Not with `personal` / `folder` (400
   * MEMBERS_WITH_PLACE), not for a business plugin's type (400 MEMBERS_NOT_FOR_TYPE); a
   * non-member → 400 BAD_MEMBER; every person field must name a listed member (400
   * ASSIGNEE_CANNOT_READ). A record linked to a members-only meeting (`links.meeting`) is
   * members-only by itself: the meeting's list plus the people its fields name.
   */
  members?: string[]
  /** Server-field values (requested_by defaults to the creator for request types). */
  fields?: Record<string, RecordFieldValue>
  links?: Record<string, string | string[]>
  /** The state to start in instead of the type's `initial`: one of its `create_states` (task: `preparing`). */
  state?: string
  actor?: RecordActor
}

export interface ActionRequest {
  /** The record version the caller saw (optimistic concurrency). */
  expectedVersion: number
  note?: string
  /** The action's arguments: each sets the server field of the same name. */
  args?: Record<string, RecordFieldValue>
  /** Record links the action sets (its definition's `links`): ids, null / [] = none; a link left out stays. */
  links?: Record<string, string | string[] | null>
  /** Files (of the action's `attach` links) handed over, at the commit that was pushed. */
  attachments?: Array<{ link: string; path: string; commit: string }>
  /**
   * Provenance, informational only (never authorizes; the server records what
   * the app says): `ai` when the member confirms an action their AI suggested
   * in a consultation, and that consultation's id. Ignored on the AI's routes.
   */
  proposedBy?: 'ai'
  conversationId?: string
  /** Only for actions marked `decision`: what the decision rests on (references, never copies). */
  decision?: { materials?: DecisionMaterial[]; policyVersion?: string; precedents?: string[]; supersedes?: string }
  actor?: RecordActor
}

export interface UndoRequest {
  /** The ledger entry (record version) to reverse. */
  version: number
  expectedVersion: number
  note?: string
  actor?: RecordActor
}

/**
 * Link a file to a record after it was made, or remove that link (any type
 * with a `file` link; records.md "Linking files later").
 */
export interface FileLinkRequest {
  /** Company path of the file or folder (as in the company folder, e.g. `営業部/提案書/見積.md`). */
  path?: string
  /**
   * Instead of `path`, in a company without the shared folder (records.md "File links without the
   * shared folder"; session only): a file of the member's own working folder (`local`, shown to
   * them alone) or a Google Drive file they picked (`drive`; the server checks the pick with Google).
   */
  target?: { kind: 'local'; path: string } | { kind: 'drive'; fileId: string }
  /** The link's name; may be left out when the type has one file link (task: `files`). */
  link?: string
  expectedVersion: number
  note?: string
  proposedBy?: 'ai'
  conversationId?: string
}

/**
 * 「部署に出す／案件につなぐ」: the owner makes their owner-only record visible to
 * the readers of `folder` (a folder they read, not a private one; for a deal,
 * the deal's folder). Ledger action `share` (`place.personal_owner`,
 * `place.folder`), never undone. Not personal any more → 409 NOT_PERSONAL;
 * anyone but the owner cannot find the record (404 RECORD_NOT_FOUND).
 */
export interface ShareRecordRequest {
  /**
   * The folder whose readers will see it. A private folder only when it is the folder of the
   * 案件・プロジェクト the task links to (records.md "A task and its 案件・プロジェクト").
   */
  folder?: string
  /**
   * ［プロジェクトの人に見せる］: the place of the 案件・プロジェクト the task links to (its folder, or the
   * whole company) instead of `folder`. None linked → 400 NO_BUNDLE; one shown to a list or its
   * owner only → 409 BUNDLE_NOT_PLACED.
   */
  toBundle?: true
  expectedVersion: number
  note?: string
  proposedBy?: 'ai'
  conversationId?: string
}

/**
 * 「招待する」 (records.md "Members-only records"): a listed member adds members to a
 * members-only record (at most 200 at once; each must be a member of the company, else 400
 * BAD_MEMBER). Ledger action `invite` (`place.members` before / after), never undone. Not
 * members-only → 409 NOT_MEMBERS_ONLY; anyone not listed cannot find the record (404
 * RECORD_NOT_FOUND). Session only (no AI route).
 */
export interface InviteRecordMembersRequest {
  /**
   * People (a member id, as older apps send) and, in a place rule's subject form, groups and
   * departments (2026-11-08). A group or department only by the record's 責任者, a 部署の管理役 or an
   * owner / admin (403 LIST_WIDENING_NOT_ALLOWED); unknown → 400 BAD_GROUP / BAD_DEPARTMENT.
   * Answer: `{ record, entry, added, addedSets }`.
   */
  add: Array<string | RecordListSubject>
  expectedVersion: number
  note?: string
}

/** One entry of a members-only list, written like a place rule's subject. */
export interface RecordListSubject {
  subjectType: 'user' | 'group' | 'department'
  subjectId: string
}

/**
 * 「見る人を減らす」 (`POST /records/item/:recordId/members/remove`): any reader takes people, groups
 * or departments off a members-only list. 400 NOT_ON_LIST (none of them is on it),
 * NAMED_PERSON_CANNOT_READ (someone the record names would lose it), LIST_WOULD_BE_EMPTY. Answer
 * `{ record (null when the caller took themself off), entry, removed, removedSets }`.
 */
export interface RemoveRecordMembersRequest {
  remove: Array<string | RecordListSubject>
  expectedVersion: number
  note?: string
}

/** `GET /records/item/:recordId/members/choices`: what the caller may add besides people, and the list's groups / departments. */
export interface RecordMemberChoices {
  /** May the caller add groups / departments (the record's 責任者, a 部署の管理役, an owner / admin)? */
  maySets: boolean
  /** Empty unless `maySets`. */
  groups: Array<{ id: string; name: string }>
  departments: Array<{ id: string; name: string }>
  /** The groups and departments on the list now. */
  listed: Array<{ type: 'group' | 'department'; id: string; name: string }>
}

/**
 * Linking a record to another later, or removing that link (records.md "Linking records later"):
 * `link` is a record link of the source's type that is not an origin one (task: bundle,
 * counterpart, related); `target` the other record's id. A `one` link (bundle) is replaced.
 */
export interface RecordLinkRequest {
  link: string
  target: string
  expectedVersion: number
  /**
   * A task linked to a 案件・プロジェクト is never seen by more people than it (records.md "A task and
   * its 案件・プロジェクト"): a wider task is refused (400 WIDER_THAN_BUNDLE) unless the person asks
   * to narrow it to the 案件's place with `narrow: true` — in the same entry (`place.*` changes: never
   * undone). Someone the task names who could not read it then → 400 NAMED_PERSON_CANNOT_READ.
   */
  narrow?: true
  note?: string
  proposedBy?: 'ai'
  conversationId?: string
}

/** The answer: the record after the change and its ledger entry (`link_record` / `unlink_record`; null when nothing changed). */
export interface RecordLinkResult {
  record: RecordSummary
  entry: LedgerEntry | null
  changed: boolean
}

export interface FileLinkResult {
  record: RecordSummary
  /** The ledger entry (`link_file` / `unlink_file`); null when nothing changed (already linked). */
  entry: LedgerEntry | null
  changed: boolean
}
