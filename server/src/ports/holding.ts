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
  /** The distinct contents stored now, in bytes (what counts against the ticket's and the company's room). */
  totalBytes: number
  createdAt: string
  finishedAt: string | null
  blobsDeletedAt: string | null
}

/**
 * Why an entry sent with content is not held: `too-large` (a file, item or ticket cap — kept as a
 * name), `secret` (never kept — a name), `company-full` (the company's room is full now: the app
 * keeps its copy and tries again later).
 */
export type HoldingDropped = 'too-large' | 'secret' | 'company-full'

export interface HoldingFile {
  idx: number
  path: string
  kind: HoldingFileKind
  size: number
  sha256: string | null
  label: string | null
  stored: boolean
  dropped: HoldingDropped | null
}

export interface NewHoldingItem {
  id: string
  ticketId: string
  userId: string
  deviceKey: string
  scopeId: string
  folderPath: string
  baseCommit: string | null
  at: string
}

/** One company's holding items and their files, from its handle (`CompanyData.holdingItems`). */
export interface HoldingItemRepository {
  get(itemId: string): HoldingItem | null
  forDevice(ticketId: string, deviceKey: string): HoldingItem | null
  countForTicket(ticketId: string): number
  /** Bytes stored by the company's items that still hold contents (receiving, waiting, taking), but `exceptItemId`. */
  storedBytes(exceptItemId?: string): number
  /** The same, for one ticket's items (its member's PCs). */
  ticketStoredBytes(ticketId: string, exceptItemId?: string): number
  create(item: NewHoldingItem, files: HoldingFile[]): void
  /** A receiving item's manifest replaced (`stored` flags as given). False when it is not receiving. */
  replaceFiles(itemId: string, files: HoldingFile[], at: string): boolean
  files(itemId: string): HoldingFile[]
  /**
   * The not-dropped content entries with this sha256 of a receiving item are stored. False when it
   * is not receiving or no such entry is left (the manifest changed meanwhile).
   */
  markStored(itemId: string, sha256: string, at: string): boolean
  /** This content is not held: its entries are dropped for `reason` (`secret` / `too-large` also make them names only; sha256 kept). */
  dropContent(itemId: string, sha256: string, reason: 'secret' | 'too-large' | 'company-full', at: string): void
  /** Its file is not on the disk (a restore from an older copy): the entries with this sha256 are not stored any more. */
  unmarkStored(itemId: string, sha256: string, at: string): void
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

/** A content received into a temporary file of its item's directory, not yet under its name. */
export interface ReceivedBlob {
  temp: string
  bytes: number
  sha256: string
}

/**
 * Where held contents are kept: `<root>/<companyId>/<itemId>/<sha256>` (adapters/holding-blobs.ts).
 * A content arrives into a temporary file of its own (one per request), is hashed as it streams,
 * and only then gets its name; a request that loses only ever removes its own temporary file.
 */
export interface HoldingBlobStore {
  /** Stream into a new temporary file (0600; directories 0700). Null when more than `maxBytes` came (nothing kept). */
  receive(companyId: string, itemId: string, chunks: AsyncIterable<Uint8Array>, maxBytes: number): Promise<ReceivedBlob | null>
  /** The temporary file gets the content's name (a rename; the same content already there is replaced by itself). */
  commit(companyId: string, itemId: string, temp: string, sha256: string): Promise<void>
  /** Remove a temporary file this request made. */
  discard(companyId: string, itemId: string, temp: string): Promise<void>
  has(companyId: string, itemId: string, sha256: string): Promise<boolean>
  remove(companyId: string, itemId: string, sha256: string): Promise<void>
  /** The files of an item's directory: contents by sha256 and temporary files, with their age. */
  entries(companyId: string, itemId: string): Promise<Array<{ name: string; temp: boolean; mtimeMs: number }>>
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
