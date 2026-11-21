/**
 * The cross-build check of the rollback floor (jobs.md "Event jobs on the PC" "Rolling back", deployment.md "Rolling back
 * production"): one SQLite file goes from this build (1-make) to the floor build (2-floor, copied into a worktree of the
 * pinned floor commit) and back (3-return). Imported **first** by each step (before `src/db`), so the step opens that file:
 * it is copied over the test's own fresh `DATA_DIR/app.sqlite` (tests/setup.ts made it). Without `ACB_CROSS_BUILD_DB`
 * (every ordinary test run) nothing happens and the steps skip. Kept to Node built-ins: the floor build runs it as is.
 */
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'

export const CROSS_DB = process.env.ACB_CROSS_BUILD_DB ?? null
const here = () => join(process.env.DATA_DIR as string, 'app.sqlite')

if (CROSS_DB && existsSync(CROSS_DB)) {
  for (const suffix of ['', '-wal', '-shm']) rmSync(here() + suffix, { force: true })
  copyFileSync(CROSS_DB, here())
}

/** Write the step's database back to the shared file (WAL folded in first), and what the step wants the next to know. */
export function saveDb(db: { pragma(source: string): unknown }, manifest?: unknown): void {
  if (!CROSS_DB) return
  db.pragma('wal_checkpoint(TRUNCATE)')
  copyFileSync(here(), CROSS_DB)
  if (manifest !== undefined) writeFileSync(`${CROSS_DB}.json`, JSON.stringify(manifest, null, 1))
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function manifest(): any {
  return CROSS_DB ? JSON.parse(readFileSync(`${CROSS_DB}.json`, 'utf8')) : null
}
