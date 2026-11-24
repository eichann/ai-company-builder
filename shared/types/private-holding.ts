/**
 * The holding place of private folders — the member's side (owner decision 2026-11-23 「B」,
 * `.claude/rules/private-folders.md` "Holding: the member's upload"). The contract between the
 * server (`server/src/routes/private-holding.ts`) and the desktop app's sync, which released apps
 * will call: change it only together with a compatible app path (`protocol`).
 *
 * Someone who stopped reading a private folder holds a ticket for it (one per member × folder,
 * 30 days). With it, their app hands over what never reached the server — one item per PC — and
 * then removes the folder from the PC. Nothing here ever carries the folder's path or name: a
 * ticket is known by its ids only, and entry paths are relative to the folder.
 *
 * Every answer is `{ success: true, data }`; a refusal is `{ error, code? }` with the status below.
 * A ticket or item that is not the caller's, unknown, or another company's is always the same
 * 404 `{ error: 'Not found' }`.
 */

/** The version of this contract the server speaks (in the tickets answer). */
export const HOLDING_PROTOCOL = 1

/** What one entry of a manifest is. */
export const HOLDING_ENTRY_KINDS = ['changed', 'deleted', 'backup', 'personal', 'names-only'] as const
/**
 * - `changed`: added or modified against the folder's last shared version (the file as on disk now)
 * - `deleted`: removed against it (no content)
 * - `backup`: a copy from the member's backups of that folder (`label` = reason and time)
 * - `personal`: a note under `.personal/` (never taken into the folder; downloaded or discarded only)
 * - `names-only`: its name and size only (a secret, too large, unreadable); content is never accepted
 */
export type HoldingEntryKind = typeof HOLDING_ENTRY_KINDS[number]
/** The kinds whose content is uploaded (by sha256). */
export const HOLDING_CONTENT_KINDS: readonly HoldingEntryKind[] = ['changed', 'backup', 'personal']

/** The caps (owner decision 2026-11-23, question 4). Over a cap an entry is kept as its name only. */
export interface HoldingLimits {
  /** One file's bytes (a blob body above it: 413). */
  fileBytes: number
  /** One item's bytes (distinct contents). */
  itemBytes: number
  /**
   * One ticket's bytes, all its PCs' items together (one member cannot fill the company's room).
   * Not a cap that loses work: beyond it an entry is `companyFull` (keep and try again).
   */
  ticketBytes: number
  /** Entries per item: the ones after it are kept as names only. */
  files: number
  /** Items per ticket (one per PC). */
  devices: number
}

export const HOLDING_LIMITS: HoldingLimits = Object.freeze({
  fileBytes: 50 * 1024 * 1024,
  itemBytes: 500 * 1024 * 1024,
  ticketBytes: 1024 * 1024 * 1024,
  files: 5000,
  devices: 3,
})

/**
 * The contents one company holds at once (stored bytes of its items still holding contents).
 * Server-side; not in the answer. Above it an entry is `company-full`: see `HoldingItemResponse`.
 */
export const HOLDING_COMPANY_BYTES = 2 * 1024 * 1024 * 1024

/** The refusal codes the app reads (fixed strings). */
export const HOLDING_CODES = Object.freeze({
  /** 410: the ticket's 30 days are over — the app removes the folder (nothing can be handed over). */
  expired: 'EXPIRED',
  /** 410: the member reads the folder again — the app puts it back. Told only to the ticket's own member. */
  cancelled: 'CANCELLED',
  /** 409: this item was received already (finished) — the app may remove its copy. */
  alreadyReceived: 'ALREADY_RECEIVED',
  /**
   * 410: the server's operator erased this item (contents and names) — it is **not** received: the app
   * must not take this as `ALREADY_RECEIVED` (keep the local copy; owner decision L4, 2026-11-24). Told
   * only to the item's own member. An item still receiving is never erased.
   */
  erased: 'ERASED',
  /** 409: `finish` before every content arrived; `missing` lists the sha256 still wanted. */
  missingFiles: 'MISSING_FILES',
  /**
   * 409: no room right now — the company's holding place, or this ticket's share (all the
   * member's PCs together), is full (blob PUT, finish). **The app keeps its
   * local copy and tries again later** — it must not finish, nor remove anything (owner principle:
   * a member's work is never lost). A later `POST …/items` with the same `deviceKey` judges again.
   */
  companyFull: 'COMPANY_FULL',
  /** 409: the ticket has its items from `devices` PCs already. */
  tooManyDevices: 'TOO_MANY_DEVICES',
  /** 413: a blob body above `fileBytes`. */
  tooLarge: 'TOO_LARGE',
  /** 400: the body's sha256 or size is not the one in the URL / manifest. */
  hashMismatch: 'HASH_MISMATCH',
  /** 429: this member (or the server) has enough uploads running; wait `Retry-After` seconds. */
  busy: 'BUSY',
  /** 400: the request is not valid (also a blob PUT without `Content-Length`). */
  invalid: 'INVALID',
  /** 429: too many requests of this member; wait `Retry-After` seconds. */
  rateLimited: 'RATE_LIMITED',
})

// ----------------------------------------------------------------------------
// GET /api/me/holding/tickets
// ----------------------------------------------------------------------------

export interface HoldingTicketView {
  ticketId: string
  companyId: string
  /** The folder's scope id, as `/me/scopes` named it while the member read it. */
  scopeId: string
  /** `expired` also for an open ticket past its expiry the server clock has not closed yet. */
  state: 'open' | 'expired' | 'cancelled'
  expiresAt: string
  limits: HoldingLimits
}

/** Open tickets, and those that expired or were cancelled in the last 90 days. */
export interface HoldingTicketsResponse {
  protocol: typeof HOLDING_PROTOCOL
  tickets: HoldingTicketView[]
}

// ----------------------------------------------------------------------------
// POST /api/me/holding/tickets/:ticketId/items
// ----------------------------------------------------------------------------

export interface HoldingManifestEntry {
  /** Relative to the folder ('/'-separated; NFC on the server). */
  path: string
  kind: HoldingEntryKind
  size: number
  /** Lowercase hex sha256 of the content: required for the content kinds, null otherwise. */
  sha256: string | null
  /** A backup's reason and time. */
  label?: string
}

export interface HoldingItemRequest {
  /** A random id the app keeps once per PC: one item per ticket and PC (8–128 of A–Z a–z 0–9 _ -). */
  deviceKey: string
  /** The folder's last shared commit the changes are against (hex), or null. */
  baseCommit: string | null
  manifest: HoldingManifestEntry[]
}

/**
 * The item for this ticket and PC (the same one on a repeat; while it is still receiving, a new
 * manifest replaces the old one and the server judges every entry again). `missing`: sha256 of
 * contents to PUT. `namesOnly`: indexes of manifest entries kept as their name only (too large,
 * over a cap, a secret's file name) — the app may remove those.
 *
 * `companyFull`: indexes of entries there is no room for **now** (the company's holding place, or
 * this ticket's share — it frees up when the folder's managers decide the member's other items). While any
 * is listed, the app must not finish the item and must keep its whole local copy; it tries again
 * later with the same `deviceKey` (the contents already stored stay).
 */
export interface HoldingItemResponse {
  itemId: string
  missing: string[]
  namesOnly: number[]
  companyFull: number[]
}

// ----------------------------------------------------------------------------
// PUT /api/me/holding/items/:itemId/blobs/:sha256   raw body with Content-Length = the entry's size
//   (≤ fileBytes; above it 413 before the body is read) → 204. At most 2 uploads at once per member.
// POST /api/me/holding/items/:itemId/finish          → 200 HoldingFinishResponse
// ----------------------------------------------------------------------------

/**
 * The item is received and waits for the folder's managers. A repeat answers the same while it
 * waits; once they decided (or it expired), 409 `ALREADY_RECEIVED`.
 */
export interface HoldingFinishResponse {
  state: 'waiting'
}

// ============================================================================
// The review (stage S3, private-folders.md "Holding: review"): the folder's managers
// look at what was handed over and take it into the folder or discard it.
// Under /api/companies/:companyId (a member of the company). Not called by released
// apps: the admin console's 「預かり」 tab (A1) is its first caller.
//
// Who sees an item (I5): someone who reads the folder now and is an owner / admin or a
// 部署の管理役 of the department it is in; an item of a folder that is no longer private
// (deleted, made public): owners / admins only. Anyone else: the same 404 `{ error: 'Not found' }`
// as an item that does not exist (never a hint that the folder or the item exists).
// ============================================================================

/** Why the member stopped reading the folder (the ticket's cause). */
export type HoldingCause = 'readers' | 'left-company' | 'folder-deleted' | 'role' | 'rules'

/** The review's refusal codes (fixed strings). */
export const HOLDING_REVIEW_CODES = Object.freeze({
  /** 409: someone decided it first (taken, being taken, or discarded) — 「ほかの人が先に決めました」. */
  alreadyDecided: 'ALREADY_DECIDED',
  /** 410: 30 days passed since it arrived; it is (being) discarded by the clock. */
  expired: 'EXPIRED',
  /** 409: the folder is no longer a private folder (deleted or made public): download or discard only. */
  folderGone: 'FOLDER_GONE',
  /** 400: a chosen entry cannot go into the folder (本人のメモ, a name only, a content not held). */
  notTakeable: 'NOT_TAKEABLE',
  /** 409: the push checker refused the take-in as the reviewer's own push; `refused` says why. Nothing changed. */
  takeRefused: 'TAKE_REFUSED',
  /** 503: the folder is busy (being deleted / made public, members pushing); try again. Nothing changed. */
  busy: 'BUSY',
  /** 400: the request is not valid. */
  invalid: 'INVALID',
})

/** GET /holding: one item. */
export interface HoldingReviewItem {
  itemId: string
  scopeId: string
  /** The folder's path (the caller reads it; for a folder no longer private, owners / admins only). */
  folderPath: string
  /** The folder was deleted or made public: download or discard only (owner decision, question 7). */
  folderGone: boolean
  userId: string
  userName: string | null
  cause: HoldingCause
  state: 'waiting' | 'taking'
  /** When it arrived. */
  receivedAt: string
  /** When the clock discards it (30 days after it arrived). */
  expiresAt: string
  /** Entries by kind (`namesOnly`: names only — secrets, too large, unreadable). */
  counts: { changed: number; deleted: number; backup: number; personal: number; namesOnly: number }
  bytes: number
}

export interface HoldingReviewList {
  items: HoldingReviewItem[]
}

/**
 * How a file of the item stands against the folder today, judged on its newest version:
 * - `unchanged`: the folder still has the version the member started from (or still lacks the file)
 * - `changed`: someone changed it (or added / removed it) since — taken in alongside unless overwritten
 * - `unknown`: the version the member started from is not known (no base) — treated as `changed`
 */
export type HoldingFileStanding = 'unchanged' | 'changed' | 'unknown'

export interface HoldingReviewFile {
  /** The entry's index (what `take` and the content endpoint name). */
  idx: number
  /** Relative to the folder. */
  path: string
  kind: HoldingEntryKind
  size: number
  label: string | null
  /** Its content is held (downloadable). */
  held: boolean
  /** Why a name only: `too-large`, `secret`. */
  dropped: 'too-large' | 'secret' | null
  /** May be chosen for `take` (changed / deleted / backup with content held; never personal or names only). */
  takeable: boolean
  standing: HoldingFileStanding
  /** The folder has a file at this path now. */
  inFolderNow: boolean
}

/** GET /holding/:itemId */
export interface HoldingReviewDetail extends HoldingReviewItem {
  files: HoldingReviewFile[]
}

/**
 * POST /holding/:itemId/take `{ files: idx[], whenChanged }`: the chosen entries go into the folder
 * as ONE commit, pushed through the push checker as the reviewer. The rest of the item is discarded
 * with it (the item is decided once).
 * - `alongside` (default): a file someone changed since is not overwritten; the member's version is
 *   put next to it as 「<name>（〇〇さんの版 MM-DD）.<ext>」. A deletion is applied only to a file
 *   unchanged since.
 * - `overwrite`: the member's version replaces it.
 */
export interface HoldingTakeRequest {
  files: number[]
  whenChanged?: 'alongside' | 'overwrite'
}

export interface HoldingTakeResult {
  state: 'taken'
  /** The folder's commit (null: nothing needed changing). */
  commit: string | null
  /** Where each chosen entry went: `placed` at its path, `alongside` under another name, `overwritten`, `deleted`, `same` (already so). */
  placed: Array<{ idx: number; path: string; how: 'placed' | 'alongside' | 'overwritten' | 'deleted' | 'same' }>
  /** Chosen entries left out: a deletion of a file changed since (`changed`) or already gone (`absent`), or a path a folder / file is in the way of (`path-taken`). */
  skipped: Array<{ idx: number; reason: 'changed' | 'absent' | 'path-taken' }>
}

/** POST /holding/:itemId/discard → `{ state: 'discarded' }`. */
export interface HoldingDiscardResult {
  state: 'discarded'
}
