/**
 * The Skill shelf (「会社の Skill」, `.claude/rules/plugins.md` "The Skill shelf"): the API
 * contract under /api/companies/:companyId for a company without the shared company folder.
 * Rules: shared/core/skill-shelf.ts. A company with the folder gets 409 SKILL_SHELF_NOT_HERE
 * from every endpoint.
 *
 *   GET  /skill-shelf                                 ShelfListView (what the caller may read)
 *   POST /skill-shelf                                 ShelfPublishRequest → ShelfPublishResult
 *   GET  /skill-shelf/:itemId/versions                ShelfVersionsView
 *   GET  /skill-shelf/:itemId/versions/:version       ShelfVersionContent (the files)
 *   POST /skill-shelf/:itemId/restore                 { version, expectedVersion } → ShelfPublishResult
 *   POST /skill-shelf/:itemId/unpublish               { expectedVersion } → ShelfPublishResult
 *   DELETE /skill-shelf/:itemId/versions/:version     owner/admin: remove an old version → ShelfVersionsView
 *   DELETE /skill-shelf/:itemId                       owner/admin: remove an item taken off → { removed: true }
 *   GET  /me/skill-shelf                              MyShelfView (what the member's app places)
 *   GET  /skill-shelf-requests                        ShelfRequestsView (their own, and those they may decide)
 *   POST /skill-shelf-requests                        ShelfRequestCreate → ShelfRequestView (someone who may not publish there)
 *   GET  /skill-shelf-requests/:requestId/files       ShelfRequestContent (a pending one's files)
 *   POST /skill-shelf-requests/:requestId/publish     { expectedVersion } → ShelfRequestDecided (who may publish there)
 *   POST /skill-shelf-requests/:requestId/decline     { reason? } → ShelfRequestDecided (who may publish there)
 */
import type { ShelfKind, ShelfRequestState } from '../core/skill-shelf'

export type { ShelfKind, ShelfRequestState }

export interface ShelfFileUpload {
  /** Path inside the Skill folder ('SKILL.md', 'tools/run.py'). */
  path: string
  base64: string
}

export interface ShelfPublishRequest {
  kind: ShelfKind
  /** null = the whole company; else a department of the company. */
  departmentId: string | null
  /** A Skill's or rule file's name; the instruction text's is 'instructions' (may be left out). */
  name?: string
  /** A Skill: its folder's files (SKILL.md at the top). */
  files?: ShelfFileUpload[]
  /** An instruction text or a rule file: its Markdown text. */
  text?: string
  /** The version the caller saw as current; null = they saw none (a new item, or one taken off). */
  expectedVersion: string | null
}

export interface ShelfPerson {
  id: string
  name: string | null
}

export interface ShelfItemView {
  id: string
  kind: ShelfKind
  name: string
  /** null = the whole company. */
  department: { id: string; name: string; folder: string } | null
  /** The version handed out now; null = taken off the shelf (earlier versions are kept). */
  version: string | null
  fileCount: number
  totalBytes: number
  /** The last change (publish, restore, unpublish): when and by whom. */
  changedAt: string
  changedBy: ShelfPerson
  /** May the caller publish, restore or unpublish it (the same checks as publishing)? */
  canChange: boolean
}

export interface ShelfListView {
  items: ShelfItemView[]
}

export interface ShelfVersionView {
  version: string
  fileCount: number
  totalBytes: number
  /** When it was first published, by whom. */
  publishedAt: string
  publishedBy: ShelfPerson
  current: boolean
  /** Has auto-run parts (owner/admin only may put it back). */
  autorun: boolean
}

export interface ShelfHistoryEntry {
  action: 'publish' | 'restore' | 'unpublish' | 'remove-version'
  version: string | null
  at: string
  by: ShelfPerson
  /** Published from a request: who asked for it (`by` approved it). Absent otherwise. */
  requestedBy?: ShelfPerson
}

export interface ShelfVersionsView {
  item: ShelfItemView
  /** Newest first. */
  versions: ShelfVersionView[]
  /** Newest first. */
  history: ShelfHistoryEntry[]
}

export interface ShelfPublishResult {
  item: ShelfItemView
  /** false: the content was already the current version (nothing written). */
  changed: boolean
}

export interface ShelfVersionContent {
  id: string
  kind: ShelfKind
  name: string
  version: string
  files: ShelfFileUpload[]
}

export interface DeliveredShelfItem {
  id: string
  kind: ShelfKind
  name: string
  /** null = the whole company; else a department the member reads (its people, a group or a person named on it; owners/admins: every one). */
  department: { id: string; folder: string } | null
  /** The version to fetch (GET /skill-shelf/:itemId/versions/:version) and to check against shelfListing. */
  version: string
  fileCount: number
  totalBytes: number
  /** When this version became the one handed out (「会社の版が新しくなっています」 shows it). */
  changedAt: string
}

/** One of the member's own requests, as their app shows it (only at places they read). */
export interface MyShelfRequest {
  id: string
  name: string
  /** null = the whole company. */
  department: { id: string; folder: string } | null
  state: ShelfRequestState
  requestedAt: string
  decidedAt: string | null
  /** 見送る's reason, when one was given. */
  reason: string | null
}

export interface MyShelfView {
  items: DeliveredShelfItem[]
  /** The member's own requests (「会社に出してほしいと頼む」); absent from an older server. */
  requests?: MyShelfRequest[]
  /**
   * Where the member may publish a Skill (the publish check without the files: auto-run parts are
   * judged when they are sent): the whole company, and the folders (NFC) of departments they read
   * and may publish to. The app offers 「会社に公開」 only there; the server still decides.
   */
  skillPublishing: { company: boolean; departmentFolders: string[] }
}

/** 409 SHELF_VERSION_CHANGED: someone changed it first. */
export interface ShelfVersionChangedBody {
  error: string
  code: 'SHELF_VERSION_CHANGED'
  currentVersion: string | null
}

/** 403 SHELF_NOT_ALLOWED: which files this member may not publish, and why. */
export interface ShelfNotAllowedBody {
  error: string
  code: 'SHELF_NOT_ALLOWED'
  files: Array<{ path: string; reason: 'owner-admin-only' | 'not-allowed' | 'autorun' | 'no-write'; findings?: string[] }>
}

/** POST /skill-shelf-requests: a Skill folder, sent by someone who may not publish it there. */
export interface ShelfRequestCreate {
  /** null = the whole company. */
  departmentId: string | null
  name: string
  files: ShelfFileUpload[]
}

export interface ShelfRequestView {
  /** A request sent again gets a new id (its earlier one is gone). */
  id: string
  name: string
  /** The version of its files: sent back as `requestVersion` by 公開する / 見送る. */
  version: string
  /** null = the whole company. */
  department: { id: string; name: string; folder: string } | null
  requestedBy: ShelfPerson
  requestedAt: string
  state: ShelfRequestState
  fileCount: number
  totalBytes: number
  /** Has auto-run parts (never accepted: a request with them is refused when sent). */
  autorun: boolean
  decidedBy: ShelfPerson | null
  decidedAt: string | null
  reason: string | null
  /** Published: the version it became. */
  publishedVersion: string | null
  /** The caller sent it. */
  mine: boolean
  /** The caller may publish there, so may 公開する / 見送る while it is pending. */
  canDecide: boolean
  /** The item at that place now (to send as expectedVersion), or null when there is none or it is taken off. */
  currentVersion: string | null
}

export interface ShelfRequestsView {
  /** Pending first (newest first), then recently decided ones. */
  requests: ShelfRequestView[]
}

export interface ShelfRequestContent {
  id: string
  name: string
  version: string
  files: ShelfFileUpload[]
}

export interface ShelfRequestDecided {
  request: ShelfRequestView
  /** 公開する: the shelf item as it is now. */
  item?: ShelfItemView
}
