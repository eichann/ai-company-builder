/**
 * Runs `fn` atomically: every repository write inside it commits together or
 * not at all. Nested calls join the outer transaction (savepoints in SQLite).
 * `fn` must be synchronous — nothing else may run between its statements.
 */
export interface Transactions {
  run<T>(fn: () => T): T
}
