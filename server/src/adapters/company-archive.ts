/**
 * One company, out and back in: its rows (through the company handle,
 * ./sqlite/company-archive.ts) and its repositories (the company repository and
 * its private folders' scope repositories, as git bundles) in one archive
 * directory with a manifest. The operator command is src/cli/company-archive.ts;
 * usage and limits in `.claude/rules/deployment.md` "One company: export and
 * restore".
 *
 * Archive layout (directories 0700, files 0600 — it holds the company's data):
 *   manifest.json            format, version, company, created at, schema
 *                            (columns per table), counts per table, repositories,
 *                            sha256 of every file, notes (sealed keys, redactions)
 *   rows/<table>.json        the rows, blobs as { $base64 }
 *   repos/company.bundle     `git bundle --all` of <REPOS_DIR>/<company>.git
 *   repos/scopes/<repo>.bundle   each private folder's scope repository
 *
 * Secrets: the key broker's keys stay sealed (ciphertext + wrapped data key);
 * opening them needs the KEK they were sealed with (listed by id in the
 * manifest), so keys work after a restore only on a server with that KEK.
 * Relay tokens are left out; invitation link tokens are replaced
 * (ARCHIVE_REDACTED_COLUMNS). Better Auth accounts (auth.sqlite) are not part of
 * a company and are not moved: memberships keep the user ids.
 *
 * All git here is async (gitAsync). Nothing runs inside a request.
 */
import { createHash } from 'crypto'
import { existsSync } from 'fs'
import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from 'fs/promises'
import { join, relative } from 'path'
import type Database from 'better-sqlite3'
import { gitAsync } from '../lib/git-exec'
import { scopeRepoPath, scopeReposDir } from '../lib/git-server/scope-repo'
import type { ArchivedRows } from '../ports/company-data'
import { ARCHIVE_EXCLUDED_TABLES, ARCHIVE_REDACTED_COLUMNS, restoreCompanyRows } from './sqlite/company-archive'
import { sqliteCompanyData } from './sqlite/company-data'

export const ARCHIVE_FORMAT = 'acb-company-archive'
export const ARCHIVE_VERSION = 1

export interface ArchivedRepo {
  kind: 'company' | 'private-folder'
  /** scope_repos.id for a private folder. */
  repoId?: string
  /** Bundle path inside the archive; null when the repository had no commits or did not exist. */
  file: string | null
  state: 'bundled' | 'empty' | 'missing'
}

export interface CompanyArchiveManifest {
  format: typeof ARCHIVE_FORMAT
  version: typeof ARCHIVE_VERSION
  companyId: string
  createdAt: string
  /** Columns of every archived table, as this server's schema has them. */
  schema: Record<string, string[]>
  counts: Record<string, number>
  repos: ArchivedRepo[]
  /** Archives of deleted / made-public private folders kept on the server (listed, not copied). */
  privateFolderArchives: string[]
  /** sha256 of every file in the archive (path relative to the archive). */
  files: Record<string, string>
  notes: {
    brokerKeys: string
    kekIds: string[]
    excludedTables: Record<string, string>
    redacted: Record<string, { column: string; reason: string }>
    accounts: string
  }
}

const companyRepoPathIn = (reposDir: string, companyId: string) => join(reposDir, `${companyId.replace(/[^a-zA-Z0-9_-]/g, '')}.git`)

async function writePrivate(path: string, data: string | Buffer): Promise<void> {
  await writeFile(path, data, { mode: 0o600 })
  await chmod(path, 0o600)
}

async function sha256(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

/** Bundle a bare repository into `file`; 'empty' when it has no refs, 'missing' when it does not exist. */
async function bundle(repo: string, file: string): Promise<ArchivedRepo['state']> {
  if (!existsSync(repo)) return 'missing'
  const refs = (await gitAsync(['-C', repo, 'for-each-ref', '--count=1', '--format=%(refname)'])).trim()
  if (!refs) return 'empty'
  await gitAsync(['-C', repo, 'bundle', 'create', file, '--all'])
  await chmod(file, 0o600)
  return 'bundled'
}

export interface ExportOptions {
  conn: Database.Database
  reposDir: string
  companyId: string
  /** A directory that does not exist yet. */
  outDir: string
  /** <PRIVATE_FOLDER_ARCHIVE_DIR>, to list this company's kept private-folder archives. */
  privateFolderArchiveDir?: string
  now?: () => Date
}

export async function exportCompany(opts: ExportOptions): Promise<CompanyArchiveManifest> {
  const { conn, reposDir, companyId, outDir } = opts
  if (existsSync(outDir)) throw new Error('the archive directory already exists; choose a new one')
  const rows: ArchivedRows = sqliteCompanyData(conn).forCompany(companyId).archive.exportRows()
  if ((rows.companies ?? []).length !== 1) throw new Error('no such company')

  await mkdir(join(outDir, 'rows'), { recursive: true, mode: 0o700 })
  await mkdir(join(outDir, 'repos', 'scopes'), { recursive: true, mode: 0o700 })
  for (const dir of [outDir, join(outDir, 'rows'), join(outDir, 'repos'), join(outDir, 'repos', 'scopes')]) await chmod(dir, 0o700)

  const counts: Record<string, number> = {}
  const schema: Record<string, string[]> = {}
  for (const [table, list] of Object.entries(rows)) {
    counts[table] = list.length
    schema[table] = (conn.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map(c => c.name)
    await writePrivate(join(outDir, 'rows', `${table}.json`), JSON.stringify(list))
  }

  const repos: ArchivedRepo[] = []
  const companyFile = join('repos', 'company.bundle')
  const companyState = await bundle(companyRepoPathIn(reposDir, companyId), join(outDir, companyFile))
  repos.push({ kind: 'company', file: companyState === 'bundled' ? companyFile : null, state: companyState })
  for (const r of (rows.scope_repos ?? []) as Array<{ id: string }>) {
    const file = join('repos', 'scopes', `${r.id}.bundle`)
    const state = await bundle(scopeRepoPath(reposDir, companyId, r.id), join(outDir, file))
    repos.push({ kind: 'private-folder', repoId: r.id, file: state === 'bundled' ? file : null, state })
  }

  let privateFolderArchives: string[] = []
  if (opts.privateFolderArchiveDir) {
    const dir = join(opts.privateFolderArchiveDir, companyId)
    if (existsSync(dir)) privateFolderArchives = (await readdir(dir)).sort().map(f => join(dir, f))
  }

  const files: Record<string, string> = {}
  for (const sub of ['rows', join('repos'), join('repos', 'scopes')]) {
    for (const name of await readdir(join(outDir, sub))) {
      const path = join(outDir, sub, name)
      if ((await stat(path)).isFile()) files[relative(outDir, path)] = await sha256(path)
    }
  }

  const kekIds = [...new Set(((rows.broker_keys ?? []) as Array<{ kek_id?: unknown }>).map(k => String(k.kek_id)))].sort()
  const manifest: CompanyArchiveManifest = {
    format: ARCHIVE_FORMAT,
    version: ARCHIVE_VERSION,
    companyId,
    createdAt: (opts.now?.() ?? new Date()).toISOString(),
    schema,
    counts,
    repos,
    privateFolderArchives,
    files,
    notes: {
      brokerKeys: 'sealed as stored (envelope encryption); usable only on a server with the same KEK (kekIds)',
      kekIds,
      excludedTables: ARCHIVE_EXCLUDED_TABLES,
      redacted: ARCHIVE_REDACTED_COLUMNS,
      accounts: 'Better Auth accounts (auth.sqlite) are shared across companies and not included; memberships keep the user ids',
    },
  }
  await writePrivate(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  return manifest
}

export interface RestoreOptions {
  conn: Database.Database
  reposDir: string
  archiveDir: string
}

export type RestoreResult =
  | { ok: true; companyId: string; counts: Record<string, number>; repos: ArchivedRepo[] }
  | { ok: false; reason: string }

/**
 * Restore an archive into this database and REPOS_DIR. Refuses (nothing
 * written) when the archive is not intact, the company or one of its
 * repositories already exists, or the rows do not fit this schema. Rows go in
 * one transaction; if they fail, the repositories just created are removed.
 * Start the server once afterwards: startup configures every repository and
 * its hook.
 */
export async function restoreCompany(opts: RestoreOptions): Promise<RestoreResult> {
  const { conn, reposDir, archiveDir } = opts
  const manifest = JSON.parse(await readFile(join(archiveDir, 'manifest.json'), 'utf8')) as CompanyArchiveManifest
  if (manifest.format !== ARCHIVE_FORMAT || manifest.version !== ARCHIVE_VERSION) {
    return { ok: false, reason: `not a company archive of version ${ARCHIVE_VERSION}` }
  }
  for (const [file, digest] of Object.entries(manifest.files)) {
    if (!existsSync(join(archiveDir, file)) || await sha256(join(archiveDir, file)) !== digest) {
      return { ok: false, reason: `the archive is damaged or changed (${file})` }
    }
  }
  const { companyId } = manifest
  if (conn.prepare(`SELECT 1 FROM companies WHERE id = ?`).get(companyId)) {
    return { ok: false, reason: 'this company already exists in this database' }
  }

  const rows: ArchivedRows = {}
  for (const table of Object.keys(manifest.counts)) {
    rows[table] = JSON.parse(await readFile(join(archiveDir, 'rows', `${table}.json`), 'utf8'))
    if (rows[table].length !== manifest.counts[table]) return { ok: false, reason: `the row count of ${table} does not match the manifest` }
  }

  const targets = manifest.repos.map(r => ({
    repo: r,
    dest: r.kind === 'company' ? companyRepoPathIn(reposDir, companyId) : scopeRepoPath(reposDir, companyId, r.repoId!),
  }))
  const taken = targets.find(t => existsSync(t.dest))
  if (taken) return { ok: false, reason: 'a repository of this company already exists in REPOS_DIR' }

  const created: string[] = []
  try {
    for (const { repo, dest } of targets) {
      if (repo.state === 'missing') continue
      created.push(dest)
      if (repo.state === 'empty') {
        await gitAsync(['init', '--bare', '--quiet', dest])
      } else {
        await gitAsync(['clone', '--bare', '--quiet', join(archiveDir, repo.file!), dest])
        await gitAsync(['-C', dest, 'remote', 'remove', 'origin'])
      }
    }
    const result = restoreCompanyRows(conn, companyId, rows)
    if (!result.ok) {
      await removeAll(created, reposDir, companyId)
      return result
    }
    return { ok: true, companyId, counts: result.counts, repos: manifest.repos }
  } catch (err) {
    await removeAll(created, reposDir, companyId)
    throw err
  }
}

async function removeAll(paths: string[], reposDir: string, companyId: string): Promise<void> {
  for (const p of paths) await rm(p, { recursive: true, force: true })
  const scopes = scopeReposDir(reposDir, companyId)
  if (existsSync(scopes) && (await readdir(scopes)).length === 0) await rm(scopes, { recursive: true, force: true })
}
