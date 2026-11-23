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
  /** Entries per item: the ones after it are kept as names only. */
  files: number
  /** Items per ticket (one per PC). */
  devices: number
}

export const HOLDING_LIMITS: HoldingLimits = Object.freeze({
  fileBytes: 50 * 1024 * 1024,
  itemBytes: 500 * 1024 * 1024,
  files: 5000,
  devices: 3,
})

/** Waiting items of one company, together (above it: names only). Server-side; not in the answer. */
export const HOLDING_COMPANY_BYTES = 2 * 1024 * 1024 * 1024

/** The refusal codes the app reads (fixed strings). */
export const HOLDING_CODES = Object.freeze({
  /** 410: the ticket's 30 days are over — the app removes the folder (nothing can be handed over). */
  expired: 'EXPIRED',
  /** 410: the member reads the folder again — the app puts it back. Told only to the ticket's own member. */
  cancelled: 'CANCELLED',
  /** 409: this item was received already (finished) — the app may remove its copy. */
  alreadyReceived: 'ALREADY_RECEIVED',
  /** 409: `finish` before every content arrived; `missing` lists the sha256 still wanted. */
  missingFiles: 'MISSING_FILES',
  /** 409: the ticket has its items from `devices` PCs already. */
  tooManyDevices: 'TOO_MANY_DEVICES',
  /** 413: a blob body above `fileBytes`. */
  tooLarge: 'TOO_LARGE',
  /** 400: the body's sha256 or size is not the one in the URL / manifest. */
  hashMismatch: 'HASH_MISMATCH',
  /** 400: the request is not valid. */
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
 * manifest replaces the old one). `missing`: sha256 of contents to PUT. `namesOnly`: indexes of
 * manifest entries kept as their name only (too large, over a cap, a secret's file name).
 */
export interface HoldingItemResponse {
  itemId: string
  missing: string[]
  namesOnly: number[]
}

// ----------------------------------------------------------------------------
// PUT /api/me/holding/items/:itemId/blobs/:sha256   raw body (≤ fileBytes) → 204
// POST /api/me/holding/items/:itemId/finish          → 200 HoldingFinishResponse
// ----------------------------------------------------------------------------

/**
 * The item is received and waits for the folder's managers. A repeat answers the same while it
 * waits; once they decided (or it expired), 409 `ALREADY_RECEIVED`.
 */
export interface HoldingFinishResponse {
  state: 'waiting'
}
