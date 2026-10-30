// auth.sqlite is opened once per process, in WAL mode (src/lib/auth.ts): every
// request's session lookup reads it, and in the default rollback journal a
// sign-in's write made those readers wait (or fail with SQLITE_BUSY); the
// public /api/config and the sign-up check opened a new connection per request.
import { describe, it, expect, beforeAll } from 'vitest'

beforeAll(() => {
  process.env.AUTH_SECRET ??= 'test-secret-for-auth-db-unit-test-0123456789'
})

describe('auth database connection', () => {
  it('runs in WAL mode with a busy timeout, so readers do not wait behind a writer', async () => {
    const { authDb } = await import('../../src/lib/auth')
    expect(authDb.pragma('journal_mode', { simple: true })).toBe('wal')
    expect(authDb.pragma('busy_timeout', { simple: true })).toBeGreaterThanOrEqual(1000)
  })
})
