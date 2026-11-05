/**
 * Vitest global setup: create isolated temp DATA_DIR for integration tests.
 * Runs before each test file.
 */
import { mkdtempSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3'

const testDataDir = mkdtempSync(join(tmpdir(), 'acb-test-'))

// Set env vars BEFORE any route/db module is imported
process.env.DATA_DIR = testDataDir
process.env.REPOS_DIR = join(testDataDir, 'repos')
// The key broker never checks a key against a real provider in tests; the check's own
// tests pass a fake upstream (tests/integration/broker-key-check.test.ts).
process.env.BROKER_KEY_CHECK = 'off'

// Create repos directory (some routes check this at import time)
mkdirSync(join(testDataDir, 'repos'), { recursive: true })

// Create auth.sqlite with required tables (git-http.ts opens this at import time)
const authDb = new Database(join(testDataDir, 'auth.sqlite'))
authDb.exec(`
  CREATE TABLE IF NOT EXISTS user (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    emailVerified INTEGER NOT NULL DEFAULT 0,
    image TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS session (
    id TEXT PRIMARY KEY,
    token TEXT NOT NULL UNIQUE,
    expiresAt TEXT NOT NULL,
    ipAddress TEXT,
    userAgent TEXT,
    userId TEXT NOT NULL,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
  );
  -- The shape of production's auth.sqlite (Better Auth 1.7 validates the schema
  -- and refuses all auth when a table or column is missing): account carries a
  -- legacy expiresAt, and account / verification have nullable timestamps.
  CREATE TABLE IF NOT EXISTS account (
    id TEXT PRIMARY KEY,
    accountId TEXT NOT NULL,
    providerId TEXT NOT NULL,
    userId TEXT NOT NULL,
    accessToken TEXT,
    refreshToken TEXT,
    idToken TEXT,
    expiresAt TEXT,
    password TEXT,
    accessTokenExpiresAt TEXT,
    refreshTokenExpiresAt TEXT,
    scope TEXT,
    createdAt TEXT,
    updatedAt TEXT
  );
  CREATE TABLE IF NOT EXISTS verification (
    id TEXT PRIMARY KEY,
    identifier TEXT NOT NULL,
    value TEXT NOT NULL,
    expiresAt TEXT NOT NULL,
    createdAt TEXT,
    updatedAt TEXT
  );
`)
authDb.close()
