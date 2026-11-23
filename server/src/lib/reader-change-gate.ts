/**
 * The gate every change of who reads a private folder passes through
 * (private-folders.md "Access removed: holding tickets").
 *
 * A member who stops reading a private folder may still hold work for it on
 * their PC that never reached the server. The server writes a holding ticket
 * for them in the same transaction as the change (services/holding-tickets.ts
 * `track`), so their app can hand that work over before it removes the
 * folder. A change made without `track` would leave them without a ticket —
 * silently. So the storage methods that can take read access away (rules on a
 * private folder, a member's rules, a membership or its role, a private
 * folder's rows) ask this gate first and throw when no tracked change of that
 * company is running: a new path that forgets `track` fails loudly in its
 * first test instead of losing a member's work in production.
 *
 * Synchronous only: a tracked change runs inside one synchronous transaction
 * (ports/transactions.ts), so nothing else can run between enter and leave.
 * No database, no state outside the instance the composition root makes.
 */
import type { ReaderChangeGate } from '../ports/holding'

export class UntrackedReaderChangeError extends Error {
  constructor(what: string) {
    super(`${what} changes who reads private folders and must run inside holdingTickets.track (private-folders.md "Access removed: holding tickets")`)
    this.name = 'UntrackedReaderChangeError'
  }
}

export function createReaderChangeGate(): ReaderChangeGate {
  const depth = new Map<string, number>()
  return {
    within(companyId, fn) {
      depth.set(companyId, (depth.get(companyId) ?? 0) + 1)
      try {
        return fn()
      } finally {
        const left = (depth.get(companyId) ?? 1) - 1
        if (left === 0) depth.delete(companyId)
        else depth.set(companyId, left)
      }
    },
    assertWithin(companyId, what) {
      if (!depth.has(companyId)) throw new UntrackedReaderChangeError(what)
    },
  }
}
