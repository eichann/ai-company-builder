/**
 * Ports: what the server's services need from the outside world, as
 * interfaces. Services (src/services) depend only on these and on
 * shared/core; adapters (src/adapters) implement them — SQLite repositories,
 * the git repository store, the clock — and src/composition.ts wires them.
 *
 * Nothing in this folder imports Node, a database driver, Hono or git —
 * only other ports and shared/core types (tests/unit/layering.test.ts).
 *
 * The repositories are synchronous on purpose: better-sqlite3 is, and the
 * API's correctness leans on it — a check followed by a write inside one
 * handler cannot interleave with another request, and a transaction is a
 * plain function call. Moving to a client/server database turns these
 * signatures (and `Transactions.run`) into Promises at this one seam.
 */
export type * from './clock'
export type * from './transactions'
export type * from './accounts'
export type * from './companies'
export type * from './memberships'
export type * from './invitations'
export type * from './departments'
export type * from './scopes'
export type * from './private-folders'
export type * from './client-activity'
export type * from './push-rejections'
export type * from './agent-events'
export type * from './orphaned-scopes'
export type * from './repo-store'
export type * from './secret-cipher'
