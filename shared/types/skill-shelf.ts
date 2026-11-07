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
 *   GET  /me/skill-shelf                              MyShelfView (what the member's app places)
 */
import type { ShelfKind } from '../core/skill-shelf'

export type { ShelfKind }

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
  action: 'publish' | 'restore' | 'unpublish'
  version: string | null
  at: string
  by: ShelfPerson
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
  /** null = the whole company. `belongs`: the member belongs to it (所属); every department listed is one they read. */
  department: { id: string; folder: string; belongs: boolean } | null
  /** The version to fetch (GET /skill-shelf/:itemId/versions/:version) and to check against shelfListing. */
  version: string
  fileCount: number
  totalBytes: number
}

export interface MyShelfView {
  items: DeliveredShelfItem[]
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
