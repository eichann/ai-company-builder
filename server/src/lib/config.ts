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
 *   WORKDIR_DIR   the server's working clones (department and company-seed
 *                 mutations); <DATA_DIR>/workdirs
 */
import { join } from 'path'

export const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), 'data')
export const REPOS_DIR = process.env.REPOS_DIR || join(DATA_DIR, 'repos')
export const WORKDIR_DIR = join(DATA_DIR, 'workdirs')

/** The application database (better-sqlite3, src/db). */
export const APP_DB_PATH = join(DATA_DIR, 'app.sqlite')
/** Better Auth's database (users, sessions). */
export const AUTH_DB_PATH = join(DATA_DIR, 'auth.sqlite')

/** A company's bare repository; the id is reduced to [A-Za-z0-9_-]. */
export function companyRepoPath(companyId: string): string {
  return join(REPOS_DIR, `${companyId.replace(/[^a-zA-Z0-9_-]/g, '')}.git`)
}
