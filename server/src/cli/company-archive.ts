/**
 * One company: export it to an archive directory, or restore one into this
 * server's database and repositories (adapters/company-archive.ts;
 * `.claude/rules/deployment.md` "One company: export and restore").
 *
 *   node --import tsx src/cli/company-archive.ts export <companyId> <new archive dir>
 *   node --import tsx src/cli/company-archive.ts restore <archive dir>
 *   node --import tsx src/cli/company-archive.ts pause-after-restore <companyId> | --all
 *
 * All use DATA_DIR / REPOS_DIR as the server does. Restore into an empty or
 * scratch DATA_DIR (it refuses when the company or one of its repositories
 * already exists there); start the server on it once afterwards so startup
 * configures the restored repositories and their hook.
 *
 * A restored company's automatic work stays stopped (services/restore-pause.ts,
 * deployment.md "After a restore"): `restore` stops its scheduled jobs and its
 * AI and tells its owners / admins. After restoring the whole server from a
 * backup, run `pause-after-restore --all` (the api stopped) before starting it.
 *
 * Deleting a company is designed but deliberately NOT a command (owner gate
 * "1社だけ渡して消す"; it needs the customer agreement on retention first):
 *   1. export the company (the archive is what is handed over / kept for the
 *      promised period);
 *   2. stop it: refuse its sign-ins to the company, its git and its relay
 *      tokens (company-wide emergency stop + revoke tokens);
 *   3. one transaction: DELETE FROM companies WHERE id = ? — every company
 *      table cascades (company_id REFERENCES companies ON DELETE CASCADE),
 *      except private_folder_archives (no foreign key: delete its rows by
 *      company_id explicitly);
 *   4. remove <REPOS_DIR>/<id>.git, <REPOS_DIR>/<id>.scopes/ and
 *      <PRIVATE_FOLDER_ARCHIVE_DIR>/<id>/;
 *   5. leave Better Auth accounts alone (they may belong to other companies);
 *   6. backups still hold the company until they expire — the retention
 *      promised to the customer; per-company keys (later) let it be made
 *      unreadable at once by destroying that company's key.
 */
import { exportCompany, restoreCompany } from '../adapters/company-archive'
import type { RestorePause } from '../services/restore-pause'

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv
  const { DATA_DIR, REPOS_DIR } = await import('../lib/config')
  const { privateFolderArchiveDir } = await import('../lib/private-folders')
  if (command === 'export' && args.length === 2) {
    const { db } = await import('../db')
    const manifest = await exportCompany({
      conn: db, reposDir: REPOS_DIR, companyId: args[0], outDir: args[1], privateFolderArchiveDir: privateFolderArchiveDir(),
    })
    const rows = Object.values(manifest.counts).reduce((a, b) => a + b, 0)
    console.log(`Exported company ${manifest.companyId}: ${rows} rows in ${Object.keys(manifest.counts).length} tables, ${manifest.repos.length} repositories → ${args[1]}`)
    if (manifest.notes.kekIds.length > 0) console.log(`Its API keys are sealed with KEK ${manifest.notes.kekIds.join(', ')}: they open only on a server with that KEK.`)
    return 0
  }
  if (command === 'restore' && args.length === 1) {
    const { db, initDatabase } = await import('../db')
    initDatabase(db)
    // The services that stop the company's work afterwards are built first: a server setting they need (AUTH_SECRET …)
    // that is missing stops the command here, before anything is written — never a restored company left running.
    const pause = await restorePauseFor(db)
    const result = await restoreCompany({ conn: db, reposDir: REPOS_DIR, archiveDir: args[0] })
    if (!result.ok) {
      console.error(`Refused, nothing was written: ${result.reason}`)
      return 1
    }
    const rows = Object.values(result.counts).reduce((a, b) => a + b, 0)
    console.log(`Restored company ${result.companyId}: ${rows} rows, ${result.repos.length} repositories into ${DATA_DIR}.`)
    pauseAfterRestore(pause, [result.companyId])
    console.log('Start the server once so it configures the repositories.')
    return 0
  }
  if (command === 'pause-after-restore' && args.length === 1) {
    const { db, initDatabase } = await import('../db')
    initDatabase(db)
    const pause = await restorePauseFor(db)
    const { sqliteCompanyRepository } = await import('../adapters/sqlite/companies')
    const all = sqliteCompanyRepository(db).allIds()
    const ids = args[0] === '--all' ? all : all.filter(id => id === args[0])
    if (ids.length === 0) { console.error(args[0] === '--all' ? 'No company in this database.' : 'No such company in this database.'); return 1 }
    pauseAfterRestore(pause, ids)
    return 0
  }
  console.error('Usage:\n  company-archive.ts export <companyId> <new archive dir>\n  company-archive.ts restore <archive dir>\n  company-archive.ts pause-after-restore <companyId> | --all')
  return 2
}

/** The server's own restore pause (services/restore-pause.ts), built over this database. */
async function restorePauseFor(db: import('better-sqlite3').Database): Promise<RestorePause> {
  const { createServices } = await import('../composition')
  return createServices(db).restorePause
}

/** Scheduled jobs and the AI stopped for each company, its owners / admins told. */
function pauseAfterRestore(restorePause: RestorePause, companyIds: string[]): void {
  for (const companyId of companyIds) {
    const r = restorePause.pauseAfterRestore(companyId)
    console.log(`Company ${companyId}: scheduled jobs stopped, the AI ${r.aiStopAdded ? 'stopped' : 'was already stopped'}, ${r.told} owner(s) / admin(s) told. Check outside results before resuming.`)
  }
}

main(process.argv.slice(2)).then(code => { process.exitCode = code }, (err: unknown) => {
  console.error(`Failed: ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
})
