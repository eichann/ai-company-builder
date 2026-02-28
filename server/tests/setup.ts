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

// Create repos directory (some routes check this at import time)
mkdirSync(join(testDataDir, 'repos'), { recursive: true })

// Create auth.sqlite with required tables (git-http.ts opens this at import time)
const authDb = new Database(join(testDataDir, 'auth.sqlite'))
authDb.exec(`
  CREATE TABLE IF NOT EXISTS user (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    name TEXT,
    image TEXT,
    emailVerified INTEGER DEFAULT 0,
    createdAt TEXT,
    updatedAt TEXT
  );
  CREATE TABLE IF NOT EXISTS session (
    id TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    expiresAt TEXT NOT NULL,
    ipAddress TEXT,
    userAgent TEXT,
    createdAt TEXT,
    updatedAt TEXT
  );
`)
authDb.close()
