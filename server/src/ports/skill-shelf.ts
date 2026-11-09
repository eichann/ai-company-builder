/**
 * The Skill shelf (plugins.md "The Skill shelf"), behind the company handle: every method is
 * limited to the handle's company. Check-then-write stays inside one call (better-sqlite3 is
 * synchronous): `put` and `setCurrent` compare the current version and write in one transaction.
 */
import type { ShelfKind, ShelfRequestState } from '../../shared/core/skill-shelf'

export interface ShelfItemRow {
  id: string
  kind: ShelfKind
  departmentId: string | null
  name: string
  currentVersion: string | null
  createdAt: string
  createdBy: string
  changedAt: string
  changedBy: string
  /** Of the current version (0 when taken off). */
  fileCount: number
  totalBytes: number
}

export interface ShelfVersionRow {
  version: string
  fileCount: number
  totalBytes: number
  autorun: boolean
  publishedAt: string
  publishedBy: string
}

export interface ShelfStoredFile {
  path: string
  base64: string
}

export interface ShelfHistoryRow {
  action: 'publish' | 'restore' | 'unpublish' | 'remove-version'
  version: string | null
  at: string
  byUser: string
  /** A version published from a request: who asked for it (`byUser` approved it). */
  requestedBy: string | null
}

export interface ShelfPut {
  /** A new item's id (used only when no item is at this place yet). */
  newItemId: string
  kind: ShelfKind
  departmentId: string | null
  name: string
  /** The current version the caller saw (null: none). */
  expected: string | null
  version: string
  files: ShelfStoredFile[]
  fileCount: number
  totalBytes: number
  autorun: boolean
  /** Bytes every stored version of the company may take together; a new version past it is refused. */
  companyLimitBytes: number
  at: string
  by: string
  /** Published from a request: who asked (kept in the history beside `by`, who approved). */
  requestedBy?: string
}

export type ShelfWrite =
  | { ok: true; itemId: string; changed: boolean }
  | { ok: false; reason: 'conflict'; currentVersion: string | null }
  | { ok: false; reason: 'not-found' | 'full' }

/** A request to publish a Skill (「会社に出してほしいと頼む」); always a Skill. */
export interface ShelfRequestRow {
  id: string
  departmentId: string | null
  name: string
  requestedBy: string
  requestedAt: string
  version: string
  fileCount: number
  totalBytes: number
  autorun: boolean
  state: ShelfRequestState
  decidedBy: string | null
  decidedAt: string | null
  reason: string | null
  publishedVersion: string | null
}

export interface ShelfRequestPut {
  /** The new row's id when the member has none at this place yet. */
  newId: string
  departmentId: string | null
  name: string
  by: string
  at: string
  version: string
  files: ShelfStoredFile[]
  fileCount: number
  totalBytes: number
  autorun: boolean
  limits: { pendingPerMember: number; pendingPerCompany: number; pendingCompanyBytes: number }
}

export type ShelfRequestWrite =
  | { ok: true; id: string }
  | { ok: false; reason: 'member-limit' | 'company-limit' }

export interface SkillShelfRepository {
  items(): ShelfItemRow[]
  item(itemId: string): ShelfItemRow | null
  /** The item at a place (department null = the whole company), or null. */
  itemAt(kind: ShelfKind, departmentId: string | null, name: string): ShelfItemRow | null
  /** How many items (handed out or taken off) a department holds. */
  countInDepartment(departmentId: string): number
  /** Newest first. */
  versions(itemId: string): ShelfVersionRow[]
  version(itemId: string, version: string): ShelfVersionRow | null
  versionFiles(itemId: string, version: string): ShelfStoredFile[] | null
  /** Newest first. */
  history(itemId: string): ShelfHistoryRow[]
  /**
   * Publish content at a place: creates the item when none is there, stores the version once,
   * makes it current, appends history. `expected` must equal the current version (a new item:
   * null), else nothing is written. Content equal to the current version: nothing is written.
   * A version not stored yet that would take the company past `companyLimitBytes`: 'full'.
   * All checked and written in one transaction.
   */
  put(input: ShelfPut): ShelfWrite
  /** Restore one of its stored versions (`version`: the caller read it) or take the item off (null), compare-and-set on `expected`. */
  setCurrent(itemId: string, expected: string | null, version: string | null, at: string, by: string): ShelfWrite
  /** Remove one stored version that is not the current one, and note it in the history. */
  removeVersion(itemId: string, version: string, at: string, by: string): 'removed' | 'not-found' | 'current'
  /** Remove an item that is taken off (no current version), with its versions and history. */
  removeItem(itemId: string): 'removed' | 'not-found' | 'published'

  /** Every request: the pending ones, and the newest `decidedLimit` decided ones (newest first). */
  requests(decidedLimit: number): ShelfRequestRow[]
  /** One member's requests (every state), newest first. */
  requestsBy(userId: string): ShelfRequestRow[]
  request(requestId: string): ShelfRequestRow | null
  /** A pending request's files; null when there is none or it is decided (its files are gone). */
  requestFiles(requestId: string): ShelfStoredFile[] | null
  /**
   * A member's request at a place: replaces their earlier one there (pending or decided) with a
   * pending one. The limits count pending requests other than the one replaced; checked and
   * written in one transaction.
   */
  putRequest(input: ShelfRequestPut): ShelfRequestWrite
  /** Decide a pending request (its files go); false when it is not pending any more. */
  decideRequest(requestId: string, decision: { state: 'published' | 'declined'; by: string; at: string; reason: string | null; publishedVersion: string | null }): boolean
}
