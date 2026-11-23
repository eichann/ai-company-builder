/**
 * Holding tickets (private-folders.md "Access removed: holding tickets"): one company's
 * record of who stopped reading which private folder, from its handle (`CompanyData.holding`,
 * adapters/sqlite/holding.ts). Every method is limited to that company.
 */

/** Why the member stopped reading the folder. */
export type HoldingTicketCause = 'readers' | 'left-company' | 'folder-deleted' | 'role' | 'rules'

export type HoldingTicketState = 'open' | 'used' | 'cancelled' | 'expired'

export interface HoldingTicket {
  id: string
  userId: string
  scopeId: string
  repoId: string | null
  /** The folder's path when access ended (server-only: never answered to the ticket's member). */
  folderPath: string
  cause: HoldingTicketCause
  state: HoldingTicketState
  createdAt: string
  updatedAt: string
  expiresAt: string
  byUser: string
  closedAt: string | null
}

export interface NewHoldingTicket {
  id: string
  userId: string
  scopeId: string
  repoId: string | null
  folderPath: string
  cause: HoldingTicketCause
  at: string
  expiresAt: string
  byUser: string
}

export interface HoldingTicketRepository {
  /**
   * Open a ticket for the member and folder, or — when one is open already — give it the new
   * cause, path and expiry (one open ticket per member and folder). Returns its id.
   */
  open(ticket: NewHoldingTicket): { ticketId: string; extended: boolean }
  /** The member reads the folder again: their open ticket for it is cancelled. Returns how many. */
  cancelOpen(userId: string, scopeId: string, at: string): number
  /** Open tickets whose expiry has passed become `expired`. Returns how many. */
  expireDue(now: string): number
  /** Every ticket of the company, newest first. */
  list(): HoldingTicket[]
  /** One ticket of this company, or null (another company's id is not found). */
  get(ticketId: string): HoldingTicket | null
  /** The member's tickets in this company, newest first. */
  ofUser(userId: string): HoldingTicket[]
}

/**
 * The control plane of the holding place (private-folders.md "Holding: the member's upload"): a
 * person who left the company has no membership to find it by, so their tickets are found by
 * their own user id across companies. Everything after goes through that company's handle.
 */
export interface HoldingTicketLookup {
  ofUser(userId: string): Array<{ ticketId: string; companyId: string }>
}

export type HoldingItemState = 'receiving' | 'waiting' | 'taking' | 'taken' | 'discarded' | 'expired'
export type HoldingFileKind = 'changed' | 'deleted' | 'backup' | 'personal' | 'names-only'

/** What one PC handed over for one ticket. */
export interface HoldingItem {
  id: string
  ticketId: string
  userId: string
  deviceKey: string
  scopeId: string
  /** Copied from the ticket (server-only). */
  folderPath: string
  baseCommit: string | null
  state: HoldingItemState
  /** The accepted distinct contents' bytes (reserved against the caps). */
  totalBytes: number
  createdAt: string
  finishedAt: string | null
  blobsDeletedAt: string | null
}

export interface HoldingFile {
  idx: number
  path: string
  kind: HoldingFileKind
  size: number
  sha256: string | null
  label: string | null
  stored: boolean
  dropped: 'too-large' | 'secret' | null
}

export interface NewHoldingItem {
  id: string
  ticketId: string
  userId: string
  deviceKey: string
  scopeId: string
  folderPath: string
  baseCommit: string | null
  totalBytes: number
  at: string
}

/** One company's holding items and their files, from its handle (`CompanyData.holdingItems`). */
export interface HoldingItemRepository {
  get(itemId: string): HoldingItem | null
  forDevice(ticketId: string, deviceKey: string): HoldingItem | null
  countForTicket(ticketId: string): number
  /** Bytes reserved by the items that still hold contents (receiving, waiting, taking), but `exceptItemId`. */
  heldBytes(exceptItemId?: string): number
  create(item: NewHoldingItem, files: HoldingFile[]): void
  /** A receiving item's manifest replaced (`stored` flags as given). False when it is not receiving. */
  replaceFiles(itemId: string, files: HoldingFile[], totalBytes: number, at: string): boolean
  files(itemId: string): HoldingFile[]
  /** The content entries with this sha256 of a receiving item are stored. False when it is not receiving. */
  markStored(itemId: string, sha256: string, at: string): boolean
  /** A secret found in this content: its entries become names only (`secret`, sha256 kept, never the bytes), with the new total. */
  dropContent(itemId: string, sha256: string, totalBytes: number, at: string): void
  /** receiving → waiting (compare-and-set). */
  finish(itemId: string, at: string): boolean
  /** waiting items finished at or before `before` → expired (compare-and-set); their ids. */
  expireWaiting(before: string, at: string): string[]
  /** receiving items created at or before `before` are deleted with their files (a later upload starts again); their ids. */
  removeAbandoned(before: string): string[]
  /** Ids of the items whose contents are kept (receiving, waiting, taking). */
  holdingContents(): string[]
  /** Items done with their contents (taken, discarded, expired) whose blobs are not marked deleted yet. */
  blobsToDelete(): string[]
  markBlobsDeleted(itemId: string, at: string): void
  /** The operator's erasure: the file rows go, the item is discarded. False when unknown. */
  erase(itemId: string, at: string): boolean
}

/** Where held contents are kept: `<root>/<companyId>/<itemId>/<sha256>` (adapters/holding-blobs.ts). */
export interface HoldingBlobStore {
  /** Write a content (temp file then rename; directories 0700, files 0600). */
  put(companyId: string, itemId: string, sha256: string, bytes: Uint8Array): Promise<void>
  remove(companyId: string, itemId: string, sha256: string): Promise<void>
  /** The item's directory and everything in it. */
  removeItem(companyId: string, itemId: string): Promise<void>
  /** Item directories present for the company. */
  itemIds(companyId: string): Promise<string[]>
  /** Where the company's item directories are (the company archive lists them). */
  companyDir(companyId: string): string
}

/**
 * The gate the storage steps that can take a private folder away from someone ask
 * (lib/reader-change-gate.ts implements it; services/holding-tickets.ts `track` opens it).
 */
export interface ReaderChangeGate {
  /** Run `fn` (synchronous) as a tracked change of who reads the company's private folders. */
  within<T>(companyId: string, fn: () => T): T
  /** Throws unless a tracked change of this company is running. `what` names the storage step. */
  assertWithin(companyId: string, what: string): void
  /** Is a tracked change of this company running (a nested `track` joins it)? */
  isWithin(companyId: string): boolean
}
