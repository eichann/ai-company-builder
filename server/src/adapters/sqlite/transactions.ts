import type Database from 'better-sqlite3'
import type { Transactions } from '../../ports/transactions'

/** better-sqlite3 transactions: BEGIN … COMMIT (a savepoint when nested), ROLLBACK on throw. */
export function sqliteTransactions(conn: Database.Database): Transactions {
  return {
    run: fn => conn.transaction(fn)(),
  }
}
