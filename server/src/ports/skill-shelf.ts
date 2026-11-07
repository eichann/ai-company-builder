/**
 * The Skill shelf (plugins.md "The Skill shelf"), behind the company handle: every method is
 * limited to the handle's company. Check-then-write stays inside one call (better-sqlite3 is
 * synchronous): `put` and `setCurrent` compare the current version and write in one transaction.
 */
import type { ShelfKind } from '../../shared/core/skill-shelf'

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
}

export type ShelfWrite =
  | { ok: true; itemId: string; changed: boolean }
  | { ok: false; reason: 'conflict'; currentVersion: string | null }
  | { ok: false; reason: 'not-found' | 'full' }

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
}
