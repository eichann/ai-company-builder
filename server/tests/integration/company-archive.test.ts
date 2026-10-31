/**
 * One company out and back in (adapters/company-archive.ts, the operator
 * command src/cli/company-archive.ts): from a server with two companies, the
 * archive of company A holds every row of A and its repositories, nothing of
 * company B, no key or link in plain text; restored into an empty database and
 * repository folder it gives the same rows and refs; a damaged archive, an
 * archive smuggling another company's row, or a company that already exists
 * is refused with nothing written.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { createHash, randomBytes } from 'crypto'
import { tmpdir } from 'os'
import { join } from 'path'
import { execFileSync } from 'child_process'
import Database from 'better-sqlite3'

// Accounts are not part of an archive; the services only need a directory to exist.
vi.mock('../../src/lib/auth', async () => {
  const Database = (await import('better-sqlite3')).default
  const { join: joinPath } = await import('path')
  return {
    authDb: new Database(joinPath(process.env.DATA_DIR!, 'auth.sqlite')),
    getUserFromRequest: vi.fn().mockResolvedValue(null),
    getUsersByIds: vi.fn().mockImplementation((ids: string[]) => new Map(ids.map(id => [id, { email: `${id}@example.com`, name: id }]))),
    auth: { handler: vi.fn(), api: { getSession: vi.fn().mockResolvedValue(null) } },
  }
})

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })

const SECRET_A = 'fake-test-key-NOT-REAL-archive-a-0123456789'
const SECRET_B = 'fake-test-key-NOT-REAL-archive-b-0123456789'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
let work: string
let db: Database.Database
let reposDir: string
let archive: typeof import('../../src/adapters/company-archive')
let initDatabase: (conn: Database.Database) => void
const co: Record<'A' | 'B', string> = { A: '', B: '' }
const invitationToken: Record<'A' | 'B', string> = { A: '', B: '' }

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' })
const refs = (dir: string) => git(dir, 'for-each-ref', '--format=%(refname) %(objectname)').trim()

/** Every table with company_id, plus the registry row. */
function companyRows(conn: Database.Database, companyId: string): Record<string, Array<Record<string, unknown>>> {
  const tables = (conn.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as Array<{ name: string }>).map(t => t.name)
    .filter(t => (conn.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).some(c => c.name === 'company_id'))
  const out: Record<string, Array<Record<string, unknown>>> = { companies: conn.prepare('SELECT * FROM companies WHERE id = ?').all(companyId) as Array<Record<string, unknown>> }
  for (const t of tables) {
    out[t] = (conn.prepare(`SELECT * FROM ${t} WHERE company_id = ? ORDER BY rowid`).all(companyId) as Array<Record<string, unknown>>)
      .map(r => { const copy = { ...r }; delete copy.seq; return copy }) // agent_events.seq is renumbered on restore
  }
  return out
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap(n => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? filesUnder(p) : [p]
  })
}

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'acb-archive-'))
  writeFileSync(join(work, 'kek'), randomBytes(32).toString('base64'))
  chmodSync(join(work, 'kek'), 0o600)
  process.env.BROKER_KEK_FILE = join(work, 'kek')
  vi.spyOn(console, 'log').mockImplementation(() => {})

  const dbModule = await import('../../src/db')
  db = dbModule.db
  initDatabase = dbModule.initDatabase
  initDatabase(db)
  const { services } = await import('../../src/composition')
  const { REPOS_DIR } = await import('../../src/lib/config')
  const { createPrivateFolder } = await import('../../src/adapters/private-folders')
  const store = await import('../../src/adapters/sqlite/permission-store')
  archive = await import('../../src/adapters/company-archive')
  reposDir = REPOS_DIR

  const ts = new Date().toISOString()
  for (const name of ['B', 'A'] as const) {
    const owner = `ar-owner-${name}`
    const member = `ar-member-${name}`
    const created = await services.companies.create(owner, `Archive ${name}`, `archive-${name.toLowerCase()}`)
    const id = created.id
    co[name] = id
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${member}`, member, id, 'member', ts, ts)
    const sales = (db.prepare('SELECT id FROM departments WHERE company_id = ? AND folder = ?').get(id, '営業部') as { id: string }).id
    store.replaceDepartmentManagers(db, id, sales, [member], owner)
    store.upsertScopeRule(db, id, '営業部', { subjectType: 'user', subjectId: member, canRead: true, canWrite: true }, owner)
    await createPrivateFolder(db, { companyId: id, path: '営業部/秘密', rules: { viewers: [member], editors: [] }, createdBy: owner })
    const ownerMember = { companyId: id, userId: owner, role: 'owner' }
    invitationToken[name] = services.invitations.create(ownerMember, 'member', 7).token
    const key = await services.keyBroker.create(ownerMember, {
      service: 'gemini', displayName: `Key ${name}`, secret: name === 'A' ? SECRET_A : SECRET_B,
      audience: { allDepartments: true, departmentIds: [], everyone: true, addUserIds: [], removeUserIds: [] },
    })
    if (!key.ok) throw new Error(JSON.stringify(key))
    db.prepare(`INSERT INTO agent_stops (id, company_id, user_id, tool, reason, stopped_at, stopped_by) VALUES (?, ?, NULL, NULL, '', ?, ?)`).run(`stop-${name}`, id, ts, owner)
    db.prepare(`INSERT INTO broker_tokens (id, company_id, user_id, token_hash, services, conversation_id, created_at, expires_at) VALUES (?, ?, ?, ?, '[]', 'c', ?, ?)`)
      .run(`tok-${name}`, id, member, createHash('sha256').update(`tok-${name}`).digest('hex'), ts, ts)
    for (let i = 0; i < 3; i++) {
      db.prepare(`INSERT INTO agent_events (company_id, id, user_id, received_at, at, client_at, version, call_id, agent, tool, category, target_kind, target, decision)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?, 'claude', 'Read', 'read', 'file', ?, 'allowed')`).run(id, `ev-${name}-${i}`, member, ts, ts, ts, `call-${i}`, `営業部/${name}-${i}.md`)
    }
  }
})

afterAll(() => {
  rmSync(work, { recursive: true, force: true })
  delete process.env.BROKER_KEK_FILE
})

describe('per-company export and restore', () => {
  let out: string
  let manifest: Any

  it('exports every row of the company and its repositories, with counts per table', async () => {
    out = join(work, 'archive-a')
    manifest = await archive.exportCompany({ conn: db, reposDir, companyId: co.A, outDir: out })
    const source = companyRows(db, co.A)
    for (const [table, rows] of Object.entries(source)) {
      if (table === 'broker_tokens') continue
      expect(manifest.counts[table], table).toBe(rows.length)
    }
    expect(manifest.counts.scope_rules).toBeGreaterThan(0)
    expect(manifest.counts.department_managers).toBe(1)
    expect(manifest.counts.agent_events).toBe(3)
    expect(manifest.counts.broker_tokens).toBeUndefined()
    expect(manifest.repos.map((r: Any) => [r.kind, r.state])).toEqual([['company', 'bundled'], ['private-folder', 'bundled']])
    expect(manifest.notes.kekIds).toHaveLength(1)
    expect(statSync(out).mode & 0o777).toBe(0o700)
    expect(statSync(join(out, 'manifest.json')).mode & 0o777).toBe(0o600)
  })

  it('holds nothing of the other company, no key and no invitation link in plain text', () => {
    const otherIds = [co.B, ...(db.prepare('SELECT id FROM departments WHERE company_id = ?').all(co.B) as Array<{ id: string }>).map(d => d.id)]
    for (const file of filesUnder(out)) {
      const bytes = readFileSync(file)
      for (const needle of [...otherIds, SECRET_A, SECRET_B, invitationToken.A, invitationToken.B]) {
        expect(bytes.includes(Buffer.from(needle)), `${file} contains ${needle.slice(0, 12)}…`).toBe(false)
      }
    }
  })

  it('restores into an empty database and repository folder: same rows, same refs, one company only', async () => {
    const conn = new Database(join(work, 'restored.sqlite'))
    initDatabase(conn)
    const reposTo = join(work, 'repos-restored')
    const result = await archive.restoreCompany({ conn, reposDir: reposTo, archiveDir: out })
    expect(result.ok).toBe(true)

    const before = companyRows(db, co.A)
    const after = companyRows(conn, co.A)
    delete before.broker_tokens
    delete after.broker_tokens
    before.invitations = before.invitations.map(r => ({ ...r, token: `redacted:${String(r.id)}` }))
    expect(after).toEqual(before)

    // Cross-company check on the restored database: only company A, every child on its parent's company.
    const tables = Object.keys(after).filter(t => t !== 'companies')
    const owners = new Set(tables.flatMap(t => (conn.prepare(`SELECT DISTINCT company_id FROM ${t}`).all() as Array<{ company_id: string }>).map(r => r.company_id)))
    expect([...owners]).toEqual([co.A])
    expect(conn.prepare(`SELECT COUNT(*) AS n FROM scope_rules r JOIN scopes s ON s.id = r.scope_id WHERE r.company_id IS NOT s.company_id`).get()).toEqual({ n: 0 })
    expect(conn.prepare('PRAGMA foreign_key_check').all()).toEqual([])

    expect(refs(join(reposTo, `${co.A}.git`))).toBe(refs(join(reposDir, `${co.A}.git`)))
    const repoId = (db.prepare('SELECT id FROM scope_repos WHERE company_id = ?').get(co.A) as { id: string }).id
    expect(refs(join(reposTo, `${co.A}.scopes`, `${repoId}.git`))).toBe(refs(join(reposDir, `${co.A}.scopes`, `${repoId}.git`)))
    expect(git(join(reposTo, `${co.A}.git`), 'remote').trim()).toBe('')

    // A second company restored next to it: its events are numbered after A's, nothing collides.
    const outB = join(work, 'archive-b')
    await archive.exportCompany({ conn: db, reposDir, companyId: co.B, outDir: outB })
    expect((await archive.restoreCompany({ conn, reposDir: reposTo, archiveDir: outB })).ok).toBe(true)
    expect(conn.prepare('SELECT company_id, COUNT(*) AS n FROM agent_events GROUP BY company_id ORDER BY company_id').all())
      .toEqual([co.A, co.B].sort().map(id => ({ company_id: id, n: 3 })))
    const again = companyRows(conn, co.A)
    delete again.broker_tokens
    expect(again).toEqual(after)

    // The same company again: refused.
    expect(await archive.restoreCompany({ conn, reposDir: join(work, 'repos-other'), archiveDir: out }))
      .toEqual({ ok: false, reason: 'this company already exists in this database' })
    conn.close()
  })

  it('refuses a damaged archive and one that smuggles another company\'s row; nothing is written', async () => {
    const conn = new Database(join(work, 'refusals.sqlite'))
    initDatabase(conn)
    const reposTo = join(work, 'repos-refusals')
    const companiesBefore = conn.prepare('SELECT COUNT(*) AS n FROM companies').get()

    const damaged = join(work, 'archive-damaged')
    await archive.exportCompany({ conn: db, reposDir, companyId: co.A, outDir: damaged })
    const deptFile = join(damaged, 'rows', 'departments.json')
    writeFileSync(deptFile, readFileSync(deptFile, 'utf8').replace('営業部', '乗っ取り'))
    expect((await archive.restoreCompany({ conn, reposDir: reposTo, archiveDir: damaged })).ok).toBe(false)

    // A consistent archive (digests updated) with one row of company B inside.
    const smuggled = join(work, 'archive-smuggled')
    await archive.exportCompany({ conn: db, reposDir, companyId: co.A, outDir: smuggled })
    const stopsFile = join(smuggled, 'rows', 'agent_stops.json')
    const stops = JSON.parse(readFileSync(stopsFile, 'utf8'))
    stops.push({ ...stops[0], id: 'stop-smuggled', company_id: co.B })
    writeFileSync(stopsFile, JSON.stringify(stops))
    const m = JSON.parse(readFileSync(join(smuggled, 'manifest.json'), 'utf8'))
    m.counts.agent_stops = stops.length
    m.files['rows/agent_stops.json'] = createHash('sha256').update(readFileSync(stopsFile)).digest('hex')
    writeFileSync(join(smuggled, 'manifest.json'), JSON.stringify(m))
    expect(await archive.restoreCompany({ conn, reposDir: reposTo, archiveDir: smuggled }))
      .toEqual({ ok: false, reason: 'a row of "agent_stops" belongs to another company' })

    expect(conn.prepare('SELECT COUNT(*) AS n FROM companies').get()).toEqual(companiesBefore)
    expect(existsSync(join(reposTo, `${co.A}.git`))).toBe(false)
    conn.close()
  })

  it('refuses to write over an existing archive directory', async () => {
    await expect(archive.exportCompany({ conn: db, reposDir, companyId: co.A, outDir: out })).rejects.toThrow(/already exists/)
  })
})
