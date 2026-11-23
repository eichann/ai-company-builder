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
}
