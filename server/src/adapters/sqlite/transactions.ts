import type Database from 'better-sqlite3'
import type { Transactions } from '../../ports/transactions'

/**
 * better-sqlite3 transactions: BEGIN … COMMIT (a savepoint when nested), ROLLBACK on throw. A body that returns a
 * thenable (an async function slipped past the port's type through `any`) throws inside the transaction, so it rolls
 * back — checked here rather than left to the driver (better-sqlite3 12 refuses one too; another driver may not).
 */
export function sqliteTransactions(conn: Database.Database): Transactions {
  return {
    run: fn => conn.transaction(() => {
      const result: unknown = fn()
      if (isThenable(result)) {
        // Its rejection, if any, is not this transaction's to report: keep it from becoming an unhandled one.
        result.then(undefined, () => {})
        throw new TypeError('Transactions.run: the body returned a Promise; a transaction body must be synchronous')
      }
      return result as ReturnType<typeof fn>
    })(),
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (typeof value === 'object' || typeof value === 'function') && value !== null
    && typeof (value as { then?: unknown }).then === 'function'
}
