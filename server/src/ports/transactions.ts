/**
 * A transaction's body must not be a Promise: whatever ran after its first `await` would run outside the
 * transaction (after COMMIT), so a check inside and a write after the await could interleave with another
 * request (SERVERCORE-1, server.md "Layers": transactions are synchronous). `() => void` alone would not stop
 * it — a function returning a Promise is assignable to one — so the return type itself is refused here.
 */
export type NotPromise<T> = T extends PromiseLike<unknown> ? never : T

/**
 * Runs `fn` atomically: every repository write inside it commits together or
 * not at all. Nested calls join the outer transaction (savepoints in SQLite).
 * `fn` must be synchronous — nothing else may run between its statements: an async
 * function (or one returning a Promise) is a type error, and a thenable returned
 * anyway (through `any`) is refused at run time, the transaction rolled back.
 */
export interface Transactions {
  run<T>(fn: () => NotPromise<T>): T
}

/**
 * Per-company serialization of repository work (lib/company-lock.ts): a run
 * registers before awaiting the previous one, so two queued requests never
 * run together.
 */
export interface CompanyLock {
  run<T>(companyId: string, fn: () => Promise<T>): Promise<T>
}
