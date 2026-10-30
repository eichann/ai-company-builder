/**
 * Where the server keeps its data. The one place that reads DATA_DIR and
 * REPOS_DIR from the environment.
 *
 * Read once, when this module is first imported: src/index.ts imports
 * ./env (which loads .env) before anything else, and the tests set both
 * variables in tests/setup.ts before importing server code.
 *
 *   DATA_DIR      default <cwd>/data
 *   REPOS_DIR     the bare repositories; default <DATA_DIR>/repos
 *
 * <DATA_DIR>/workdirs held the server's working clones until department and
 * seeding commits moved into the bare repositories (lib/bare-commit.ts).
 * Nothing uses it any more; a leftover one can be deleted.
 */
import { join } from 'path'

export const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), 'data')
export const REPOS_DIR = process.env.REPOS_DIR || join(DATA_DIR, 'repos')

/** The application database (better-sqlite3, src/db). */
export const APP_DB_PATH = join(DATA_DIR, 'app.sqlite')
/** Better Auth's database (users, sessions). */
export const AUTH_DB_PATH = join(DATA_DIR, 'auth.sqlite')

/**
 * The key broker's key-encryption key (KEK): a file holding 32 random bytes
 * as base64 (`src/cli/generate-broker-kek.ts` writes one). Unset → the broker
 * is off. Keep it outside the repository and outside DATA_DIR (so a database
 * backup never contains it), owner-only (0600), mounted read-only
 * (.claude/rules/key-broker.md). Never generated automatically.
 */
export const BROKER_KEK_FILE = process.env.BROKER_KEK_FILE?.trim() || null

/** A company's bare repository; the id is reduced to [A-Za-z0-9_-]. */
export function companyRepoPath(companyId: string): string {
  return join(REPOS_DIR, `${companyId.replace(/[^a-zA-Z0-9_-]/g, '')}.git`)
}
