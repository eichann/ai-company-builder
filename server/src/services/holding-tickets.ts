/**
 * Holding tickets (private-folders.md "Access removed: holding tickets"; owner decision
 * 2026-11-23 「B」, design memo docs/private-folder-holding-design.md).
 *
 * When someone stops reading a private folder — taken off its readers, removed from the
 * company, the folder deleted, demoted from owner/admin, a rule on it changed in the permission
 * editor — their PC may still hold work for it that never reached the server. The app removes
 * the folder (owner decision Q1: nothing private stays on a PC that can no longer read it); a
 * ticket is what lets it first hand that work to the server's holding place (later PRs), for
 * the folder's managers to take in or discard.
 *
 * `track` is the one way such a change is made (joining included: coming back can give folders
 * back): it runs the change in a transaction, compares
 * who reads which private folder before and after, and in the same transaction
 *   - opens a ticket (30 days) for each lost reader — or renews the open one — and records it
 *     in permission_history (`holding-ticket`);
 *   - cancels the open ticket of each reader who reads the folder again
 *     (`holding-ticket-cancel`).
 * A folder made public is not a loss: whoever reads it now has their open ticket cancelled. A
 * `track` inside another of the same company joins it. The storage steps that can take
 * access away refuse to run outside `track` (lib/reader-change-gate.ts), so a new path that
 * forgets it fails loudly instead of leaving a member without a ticket.
 */
import { canReadPrivateScope, resolveAccess, type PermissionRepository } from '../../shared/core/permissions'
import type { CompanyDataSource } from '../ports/company-data'
import type { Clock, IdGenerator } from '../ports/clock'
import type { HoldingTicketCause, ReaderChangeGate } from '../ports/holding'
import type { MembershipRepository } from '../ports/memberships'
import type { NotPromise, Transactions } from '../ports/transactions'

/** How long a member's app may hand over what it never sent (owner decision 2026-11-23, question 3). */
export const HOLDING_TICKET_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000

export interface HoldingTicketServiceDeps {
  companyData: CompanyDataSource
  memberships: MembershipRepository
  transactions: Transactions
  clock: Clock
  ids: IdGenerator
  readerChanges: ReaderChangeGate
}

/** What a tracked change is. `cause` is the change's own; a folder that is gone afterwards is always `folder-deleted`. */
export interface ReaderChange {
  cause: HoldingTicketCause
  byUser: string
}

/** Run a change of who may read private folders (synchronous), with its holding tickets. */
export type TrackReaderChange = <T>(companyId: string, change: ReaderChange, mutate: () => NotPromise<T>) => T

interface FolderReaders { path: string; repoId: string; users: Set<string> }

export function createHoldingTicketService(deps: HoldingTicketServiceDeps) {
  const { companyData, memberships, transactions, clock, ids, readerChanges } = deps

  /** Who reads each private folder of the company now (owners / admins read every one). */
  function readersNow(companyId: string): Map<string, FolderReaders> {
    const members = memberships.listByCompany(companyId)
    const out = new Map<string, FolderReaders>()
    for (const scope of companyData.forCompany(companyId).scopes.listWithRules()) {
      if (scope.repoId === null) continue
      const users = new Set(members.filter(m => canReadPrivateScope(scope, m.user_id, m.role)).map(m => m.user_id))
      out.set(scope.id, { path: scope.path, repoId: scope.repoId, users })
    }
    return out
  }

  function settle(companyId: string, before: Map<string, FolderReaders>, after: Map<string, FolderReaders>, change: ReaderChange): void {
    const handle = companyData.forCompany(companyId)
    const at = clock.now()
    const expiresAt = new Date(clock.nowMs() + HOLDING_TICKET_DAYS * DAY_MS).toISOString()
    for (const [scopeId, was] of before) {
      const now = after.get(scopeId)
      let lost: string[]
      let cause = change.cause
      if (now) {
        lost = [...was.users].filter(u => !now.users.has(u))
      } else if (handle.scopes.getById(scopeId) === null) {
        // The folder is gone: everyone who read it lost it.
        lost = [...was.users]
        cause = 'folder-deleted'
      } else {
        // Still a scope but no longer private: made public. Nobody lost it; whoever reads it now
        // gets it back, so their open ticket for it is cancelled.
        lost = []
        cancelFor(companyId, scopeId, was.path, readersOfPublic(companyId, was.path), change.byUser, at)
      }
      for (const userId of lost) {
        const { ticketId, extended } = handle.holding.open({
          id: ids.newId(), userId, scopeId, repoId: was.repoId, folderPath: was.path, cause, at, expiresAt, byUser: change.byUser,
        })
        handle.permissionHistory.append({
          action: 'holding-ticket',
          detail: { ticketId, scopeId, path: was.path, userId, cause, expiresAt, ...(extended ? { extended: true } : {}) },
          at,
          byUser: change.byUser,
        })
      }
    }
    for (const [scopeId, is] of after) {
      const was = before.get(scopeId)
      cancelFor(companyId, scopeId, is.path, [...is.users].filter(u => !was?.users.has(u)), change.byUser, at)
    }
  }

  /** The members who read `path` now (an ordinary folder: the company's rules). */
  function readersOfPublic(companyId: string, path: string): string[] {
    const members = memberships.listByCompany(companyId)
    const roles = new Map(members.map(m => [m.user_id, m.role]))
    const scopes = companyData.forCompany(companyId).scopes.listWithRules()
    const repo: PermissionRepository = { getMemberRole: (_c, u) => roles.get(u) ?? null, listScopes: () => scopes }
    return members.filter(m => resolveAccess(companyId, m.user_id, path, repo).read).map(m => m.user_id)
  }

  /** They read the folder (again): each one's open ticket for it is cancelled, with permission_history. */
  function cancelFor(companyId: string, scopeId: string, path: string, userIds: string[], byUser: string, at: string): void {
    const handle = companyData.forCompany(companyId)
    for (const userId of userIds) {
      if (handle.holding.cancelOpen(userId, scopeId, at) > 0) {
        handle.permissionHistory.append({ action: 'holding-ticket-cancel', detail: { scopeId, path, userId }, at, byUser })
      }
    }
  }

  const track: TrackReaderChange = (companyId, change, mutate) =>
    // Inside a tracked change of the same company already: join it. The outer one compares before
    // and after the whole change, so a second comparison here would only write every ticket twice.
    readerChanges.isWithin(companyId) ? mutate() : transactions.run(() => readerChanges.within(companyId, () => {
      const before = readersNow(companyId)
      const result = mutate()
      settle(companyId, before, readersNow(companyId), change)
      return result
    }))

  return {
    track,
    /** The server clock: open tickets past their expiry become `expired`. Returns how many. */
    expire(companyId: string): number {
      return companyData.forCompany(companyId).holding.expireDue(clock.now())
    },
  }
}

export type HoldingTicketService = ReturnType<typeof createHoldingTicketService>
