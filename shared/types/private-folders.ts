/**
 * Private folders (permission plan stage 3) — the contract between the
 * server (stage 3a), the desktop app's sync (3b) and the UIs (3c).
 *
 * A private folder is created private from the start: the server creates a
 * separate bare repository for it (a "scope repository") and a permission
 * scope at its path inside the company tree. Only members who may READ that
 * scope receive the repository; everyone else never sees its contents, and —
 * by the owner's decision (2026-10-22, option B) — not even its NAME. Inside
 * the company (parent) repository the path is *reserved*: no push may add or
 * change anything at or under it ([RESERVED_PATH]).
 *
 * Paths are company-relative, '/'-separated, Unicode NFC, without leading or
 * trailing slashes ('人事/評価').
 */

// ----------------------------------------------------------------------------
// GET /api/companies/:companyId/me/scopes
// ----------------------------------------------------------------------------

/** A private folder the caller may read: clone it at `path` inside the company folder. */
export interface MyPrivateScope {
  scopeId: string
  /** Where the folder lives in the company tree (NFC). */
  path: string
  /** Absolute git URL (PUBLIC_URL, else the URL the request reached). */
  cloneUrl: string
  /** Server-relative form of cloneUrl: `/api/git-http/<companyId>/scopes/<scopeId>.git`. */
  clonePath: string
  /** False = read only (pushes changing files are rejected with [WRITE_DENIED]). */
  canWrite: boolean
}

/**
 * Every private folder of the company — readable or not — as salted hashes,
 * so the app can tell "this path is at or under a private folder" without
 * learning names it may not see. See reservedPathKeyInput for the algorithm.
 */
export interface ReservedPathHashes {
  algorithm: typeof RESERVED_PATH_ALGORITHM
  /** Per company, stable (not rotated). */
  salt: string
  /** Lowercase hex SHA-256 keys, sorted. Includes the folders in `scopes` too. */
  hashes: string[]
}

export interface MyScopesResponse {
  /** Changes whenever anything below changes; also sent as the ETag (If-None-Match → 304). */
  version: string
  scopes: MyPrivateScope[]
  reserved: ReservedPathHashes
}

// ----------------------------------------------------------------------------
// Reserved-path hashing (the client MUST implement exactly this)
// ----------------------------------------------------------------------------

export const RESERVED_PATH_ALGORITHM = 'sha256-salt-nfc-asciilower-v1' as const

/**
 * The normalised form a path is hashed in: split on '/' (and '\\'), empty
 * segments dropped, each segment Unicode NFC with ASCII A–Z lowered to a–z
 * (nothing else is case-folded: not full-width Ａ, not É — exactly the
 * comparison the server's push check uses), joined with '/'.
 */
export function normalizeReservedPath(path: string): string {
  return path
    .normalize('NFC')
    .split(/[/\\]/)
    .filter(s => s.length > 0)
    .map(s => s.replace(/[A-Z]+/g, m => m.toLowerCase()))
    .join('/')
}

/**
 * The string whose SHA-256 (of its UTF-8 bytes, lowercase hex) is a key:
 *
 *     key(path) = hex(sha256(utf8(salt + "\u0000" + normalizeReservedPath(path))))
 */
export function reservedPathKeyInput(salt: string, path: string): string {
  return `${salt}\u0000${normalizeReservedPath(path)}`
}

/**
 * The prefixes of `path` to hash, shortest first ('a/b/c' → 'a', 'a/b',
 * 'a/b/c'). A path is reserved when the key of ANY of them is in
 * `reserved.hashes`; the matching prefix — in the member's own spelling — is
 * the folder name to show:
 * 「『<prefix>』というフォルダ名は使えません。別の名前にしてください。」
 */
export function reservedPathCandidates(path: string): string[] {
  const segments = path.normalize('NFC').split(/[/\\]/).filter(s => s.length > 0)
  return segments.map((_, i) => segments.slice(0, i + 1).join('/'))
}

/** The message for a reserved path — never more (no "private", no viewers). */
export function reservedPathMessage(folder: string): string {
  return `『${folder}』というフォルダ名は使えません。別の名前にしてください。`
}

// ----------------------------------------------------------------------------
// Admin / app management API (/api/companies/:companyId/private-folders)
// ----------------------------------------------------------------------------

/** POST /private-folders */
export interface CreatePrivateFolderInput {
  /** Existing folder of the company repository; '' = the company root (owner/admin only). */
  parentPath: string
  /** One folder name (department folder-name rules). */
  name: string
  /**
   * User ids who may read. Omitted = the creator + the managers of the
   * department the folder is in. The creator is always added; owners/admins
   * always have access and are ignored here.
   */
  viewers?: string[]
  /** Subset of viewers who may also edit. Omitted = every viewer. */
  editors?: string[]
  /** Owner/admin only: create although some member's app is not ready (409 OUTDATED_CLIENTS). */
  force?: boolean
}

/** PUT /private-folders/:scopeId/members */
export interface UpdatePrivateFolderMembersInput {
  viewers: string[]
  editors?: string[]
}

export interface PrivateFolderSummary {
  scopeId: string
  path: string
  /** Department whose folder contains it, or null (company root). */
  departmentId: string | null
  /** Members who can read it (owners/admins included). */
  viewerCount: number
  /** Members who can edit it (owners/admins included). */
  editorCount: number
  createdAt: string
  createdBy: string | null
  createdByName: string | null
}

export interface PrivateFolderMember {
  userId: string
  name: string | null
  email: string | null
  role: string
  canWrite: boolean
  /** 'role' = owner/admin (always), 'rule' = named on the folder. */
  via: 'role' | 'rule'
}

/** GET /private-folders/:scopeId, POST /private-folders (201), PUT …/members */
export interface PrivateFolderDetail extends PrivateFolderSummary {
  members: PrivateFolderMember[]
}

/** POST /private-folders/:scopeId/make-public (owner/admin) */
export interface MakePublicResult {
  path: string
  /** The company-repository commit that put the contents back at `path`. */
  commit: string
}

/** Error codes of these endpoints (body: { error, code, ... }). */
export type PrivateFolderErrorCode =
  /** 409: the path is taken (a folder/file in the company repository or a private folder). `error` is reservedPathMessage(path). */
  | 'FOLDER_NAME_UNAVAILABLE'
  /** 400: parentPath does not exist (or is not visible to the caller). */
  | 'PARENT_NOT_FOUND'
  /** 400: parentPath is inside a private folder the caller can read — folders there are private already. */
  | 'ALREADY_PRIVATE'
  /** 409: some member's app cannot handle private folders yet (first private folder only); body.members, body.canForce. */
  | 'OUTDATED_CLIENTS'
  /** 403: force sent by a manager. */
  | 'FORCE_NOT_ALLOWED'
  /** 400: an editor who is not a viewer, a non-member, … */
  | 'INVALID_MEMBERS'
