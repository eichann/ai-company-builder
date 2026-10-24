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
