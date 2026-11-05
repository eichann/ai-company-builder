/**
 * Better Auth 1.7 checks auth.sqlite against its own schema and refuses all auth when
 * something is missing (server.md "Sign-in (Better Auth)"). Production's auth.sqlite has a
 * slightly different shape from a fresh one (account has a legacy expiresAt, and account /
 * verification have nullable timestamps): it must be accepted, or deploying blocks sign-in.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3'

const PRODUCTION_SHAPE = `
  CREATE TABLE user (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, emailVerified INTEGER NOT NULL, image TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
  CREATE TABLE session (id TEXT PRIMARY KEY, token TEXT NOT NULL, expiresAt TEXT NOT NULL, ipAddress TEXT, userAgent TEXT, userId TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
  CREATE TABLE account (id TEXT PRIMARY KEY, accountId TEXT NOT NULL, providerId TEXT NOT NULL, userId TEXT NOT NULL, accessToken TEXT, refreshToken TEXT, idToken TEXT, expiresAt TEXT, password TEXT, accessTokenExpiresAt TEXT, refreshTokenExpiresAt TEXT, scope TEXT, createdAt TEXT, updatedAt TEXT);
  CREATE TABLE verification (id TEXT PRIMARY KEY, identifier TEXT NOT NULL, value TEXT NOT NULL, expiresAt TEXT NOT NULL, createdAt TEXT, updatedAt TEXT);
`

const dirs: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function handlerWith(sql: string) {
  const dir = mkdtempSync(join(tmpdir(), 'acb-auth-schema-'))
  dirs.push(dir)
  mkdirSync(join(dir, 'repos'))
  const db = new Database(join(dir, 'auth.sqlite'))
  db.exec(sql)
  db.close()
  vi.resetModules()
  vi.stubEnv('DATA_DIR', dir)
  vi.stubEnv('AUTH_SECRET', 'test-secret-for-auth-schema-0123456789abcdef')
  const { auth } = await import('../../src/lib/auth')
  return () =>
    auth.handler(
      new Request('http://127.0.0.1:3001/api/auth/sign-out', {
        method: 'POST',
        headers: { origin: 'app://', cookie: 'better-auth.session_token=none', 'content-type': 'application/json' },
        body: '{}',
      }),
    )
}

describe('auth.sqlite schema validation', () => {
  it("accepts production's auth.sqlite shape", async () => {
    const call = await handlerWith(PRODUCTION_SHAPE)
    await expect(call()).resolves.toBeInstanceOf(Response)
  })

  it('refuses all auth when a table is missing (the check is really running)', async () => {
    const call = await handlerWith(PRODUCTION_SHAPE.replace(/CREATE TABLE verification[^;]*;/, ''))
    await expect(call()).rejects.toThrow(/schema mismatch/i)
  })
})
