/**
 * One company: export it to an archive directory, or restore one into this
 * server's database and repositories (adapters/company-archive.ts;
 * `.claude/rules/deployment.md` "One company: export and restore").
 *
 *   node --import tsx src/cli/company-archive.ts export <companyId> <new archive dir>
 *   node --import tsx src/cli/company-archive.ts restore <archive dir>
 *
 * Both use DATA_DIR / REPOS_DIR as the server does. Restore into an empty or
 * scratch DATA_DIR (it refuses when the company or one of its repositories
 * already exists there); start the server on it once afterwards so startup
 * configures the restored repositories and their hook.
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
    const result = await restoreCompany({ conn: db, reposDir: REPOS_DIR, archiveDir: args[0] })
    if (!result.ok) {
      console.error(`Refused, nothing was written: ${result.reason}`)
      return 1
    }
    const rows = Object.values(result.counts).reduce((a, b) => a + b, 0)
    console.log(`Restored company ${result.companyId}: ${rows} rows, ${result.repos.length} repositories into ${DATA_DIR}. Start the server once so it configures the repositories.`)
    return 0
  }
  console.error('Usage:\n  company-archive.ts export <companyId> <new archive dir>\n  company-archive.ts restore <archive dir>')
  return 2
}

main(process.argv.slice(2)).then(code => { process.exitCode = code }, (err: unknown) => {
  console.error(`Failed: ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
})
