/** The current time, as the database stores it (ISO 8601, UTC). */
export interface Clock {
  /** `new Date().toISOString()` in production. */
  now(): string
  /** The current instant in milliseconds (expiry arithmetic and comparisons). */
  nowMs(): number
}

/** New primary keys and secret tokens. */
export interface IdGenerator {
  /** A random UUID in production. */
  newId(): string
  /** An unguessable token for a link (256 random bits, hex). */
  newToken(): string
}

/**
 * A clock no setting of the system's time moves (agent-browser.md "Plans, executions, permits and
 * locks", the clock fix): the milliseconds since this server process began, and a random id of this
 * start. A reading compares only with one of the same `bootId`; after a restart `monoMs()` itself is
 * the time since the start.
 */
export interface MonotonicClock {
  /** This process start's id (random, made once at start). */
  readonly bootId: string
  /** Milliseconds since this process started; never goes back, never jumps with the wall clock. */
  monoMs(): number
}

/**
 * Waiting on a monotonic clock (google-drive.md "A Google document's own changes": the observation's quiet period and
 * the gap between its reads). Production: `performance.now()` and a timer; a test may run it on a virtual clock whose
 * every wait moves it on at once, so what is read when does not depend on how busy the machine is.
 */
export interface MonotonicWait {
  /** Milliseconds on a clock no setting of the system's time moves. */
  monoMs(): number
  /** Resolves once `monoMs()` has reached `atMs` (at once when it already has). */
  sleepUntil(atMs: number): Promise<void>
}
