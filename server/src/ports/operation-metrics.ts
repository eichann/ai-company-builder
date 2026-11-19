/**
 * Where a request's time goes (server.md "Request log"): the I/O boundaries
 * (the SQLite connection, git processes, the way out to other services)
 * report each operation's start and end here, under a fixed category and
 * nothing else — no SQL, no command line, no host, no path.
 *
 * The implementation (lib/request-log.ts) adds the time to the request the
 * operation started in and to the server's per-minute totals.
 */

/** db: inside better-sqlite3; git: a git process running; ext: waiting for another service's answer. */
export type OperationCategory = 'db' | 'git' | 'ext'

export interface OperationMetrics {
  /** One operation began; call the returned function when it ends (a second call does nothing). */
  start(category: OperationCategory): () => void
}
