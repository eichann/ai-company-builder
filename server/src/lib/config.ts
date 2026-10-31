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
 *   COMPANY_CREATION_POLICY, OPERATOR_USER_IDS  who may create companies (below)
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

/** Lifetime of a broker token in minutes (clamped to 15–60 by shared/core/key-broker.ts; default 30). */
export const BROKER_TOKEN_TTL_MINUTES = Number(process.env.BROKER_TOKEN_TTL_MINUTES) || 30

/** The relay's largest request body in MB (default 100; key-broker.md). */
export const BROKER_MAX_REQUEST_MB = Number(process.env.BROKER_MAX_REQUEST_MB) || 100

/** How long the relay waits for an upstream's response headers, in seconds (default 600: long AI answers). */
export const BROKER_UPSTREAM_TIMEOUT_SECONDS = Number(process.env.BROKER_UPSTREAM_TIMEOUT_SECONDS) || 600

/**
 * Whether a key is checked once when it is registered or replaced (one free,
 * read-only request to the service's fixed host; key-broker.md). `off` for a
 * server that cannot reach the internet, and in the test suite. Default on.
 */
export const BROKER_KEY_CHECK = process.env.BROKER_KEY_CHECK?.trim().toLowerCase() !== 'off'

/** Where the relay's day (daily caps) begins, as minutes east of UTC (default 540 = Japan). */
export const BROKER_DAY_UTC_OFFSET_MINUTES = Number.isFinite(Number(process.env.BROKER_DAY_UTC_OFFSET_MINUTES)) && process.env.BROKER_DAY_UTC_OFFSET_MINUTES
  ? Number(process.env.BROKER_DAY_UTC_OFFSET_MINUTES)
  : 540

/**
 * Who may create companies: `operator` (default), later `approved` /
 * `self_serve` (services/company-creation-policy.ts). Raw value; the
 * composition root parses it and refuses to start on an unknown or
 * not-yet-implemented one.
 */
export const COMPANY_CREATION_POLICY = process.env.COMPANY_CREATION_POLICY?.trim() || null

/**
 * Server operators: the accounts (Better Auth user ids, comma-separated) that
 * may create companies once the first company exists (services/companies.ts
 * `mayCreate`). Ids, not emails: sign-up through an invitation does not verify
 * the address, so an email listed before its account exists could be claimed
 * by any invitee. Read on every call (cheap), so tests can set it at run time;
 * the server reads it again after a restart like every other setting.
 * A signed-in operator finds their id at GET /api/me.
 */
export function operatorUserIds(): ReadonlySet<string> {
  return new Set((process.env.OPERATOR_USER_IDS ?? '').split(',').map(s => s.trim()).filter(Boolean))
}

/** A company's bare repository; the id is reduced to [A-Za-z0-9_-]. */
export function companyRepoPath(companyId: string): string {
  return join(REPOS_DIR, `${companyId.replace(/[^a-zA-Z0-9_-]/g, '')}.git`)
}
