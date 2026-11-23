/**
 * Integration Test: the holding place — the member's upload (private-folders.md "Holding: the
 * member's upload"; design memo §3.2–3.3, stage S2) through the real application.
 *
 * Someone taken off a private folder's readers holds a ticket (S1). With it, and only with it,
 * their app hands over what never reached the server. Each test names the rule it guards:
 * one entry check (another user's / another company's / unknown ticket or item = the same 404),
 * 410 EXPIRED / CANCELLED only to the ticket's own member, the caps (names only; 413 for a body
 * over the file cap), no secret kept (by name, and by content when it arrives), idempotency
 * (devices, blobs, finish), the blob store on disk (0700 / 0600, nothing half-written), the
 * server clock's retention, the operator's erasure — and no answer or log line naming the folder.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { createHash } from 'crypto'
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

vi.mock('../../src/lib/auth', async () => {
  const Database = (await import('better-sqlite3')).default
  const { join: joinPath } = await import('path')
  const { noteRequestUser } = await import('../../src/lib/request-log')
  return {
    authDb: new Database(joinPath(process.env.DATA_DIR!, 'auth.sqlite')),
    getUserFromRequest: vi.fn().mockImplementation(async (req: Request) => {
      const id = req.headers.get('x-test-user')
      if (id) noteRequestUser(req, id)
      return id ? { id, email: `${id}@example.com`, name: id, image: null, emailVerified: true } : null
    }),
    getUsersByIds: vi.fn().mockImplementation((ids: string[]) => new Map(ids.map(id => [id, { email: `${id}@example.com`, name: `Name ${id}` }]))),
    auth: {
      handler: vi.fn().mockResolvedValue(new Response('', { status: 200 })),
      api: { getSession: vi.fn().mockResolvedValue(null) },
    },
  }
})

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any

const CO = 'phco'
const OTHER_CO = 'phco2'
const DEPT = '人事'
/** The folder's name: it must never appear in an answer or a log line. */
const FOLDER_NAME = '評価_極秘'
const FOLDER_PATH = `${DEPT}/${FOLDER_NAME}`
/** An entry path the member sends: it must never be logged either. */
const ENTRY_DIR = '査定メモ'
const HOLDING_ROOT = join(process.env.DATA_DIR!, 'holding')

let workDir: string
let db: import('better-sqlite3').Database
let app: Loose
let services: Loose
const printed: string[] = []
const answered: string[] = []

const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex')
const git = (args: string[], cwd?: string) => execFileSync('git', args, { stdio: 'pipe', ...(cwd ? { cwd } : {}) }).toString()

async function as(user: string | null, method: string, path: string, body?: unknown, raw?: Uint8Array) {
  const headers: Record<string, string> = user ? { 'x-test-user': `u-${user}` } : {}
  const init: RequestInit = { method, headers }
  if (raw) {
    init.body = raw
    headers['Content-Type'] = 'application/octet-stream'
  } else if (body !== undefined) {
    init.body = JSON.stringify(body)
    headers['Content-Type'] = 'application/json'
  }
  const res: Response = await app.request(`http://acb.test${path}`, init)
  const text = await res.text()
  // Every answer of the holding place (the admin routes used to set up name the folder to its managers, on purpose).
  if (path.startsWith('/api/me/holding')) answered.push(text)
  let json: Loose = null
  try { json = JSON.parse(text) } catch { /* not JSON */ }
  return { status: res.status, body: json, text, headers: res.headers }
}

let folderCount = 0
/** A private folder read by `viewers`; then `lose` taken off: their tickets. */
async function ticketsFor(lose: string[], keep: string[] = ['keeper']): Promise<{ scopeId: string; tickets: Record<string, string> }> {
  const name = folderCount++ === 0 ? FOLDER_NAME : `${FOLDER_NAME}${folderCount}`
  const made = await as('owner', 'POST', `/api/companies/${CO}/private-folders`, {
    parentPath: DEPT, name, viewers: [...lose, ...keep].map(u => `u-${u}`), force: true,
  })
  if (made.status !== 201) throw new Error(`create failed: ${made.status} ${made.text}`)
  const scopeId = made.body.data.scopeId
  const r = await as('owner', 'PUT', `/api/companies/${CO}/private-folders/${scopeId}/members`, { viewers: keep.map(u => `u-${u}`) })
  if (r.status !== 200) throw new Error(`members failed: ${r.status}`)
  const tickets: Record<string, string> = {}
  for (const u of lose) {
    tickets[u] = (db.prepare(`SELECT id FROM holding_tickets WHERE company_id = ? AND scope_id = ? AND user_id = ? AND state = 'open'`).get(CO, scopeId, `u-${u}`) as { id: string }).id
  }
  return { scopeId, tickets }
}

const TEXT_A = new TextEncoder().encode('# 査定のメモ\nまだ送っていない変更\n')
const TEXT_B = new TextEncoder().encode('バックアップの版\n')
const NOTE = new TextEncoder().encode('本人のメモ\n')

function manifest(extra: Loose[] = []) {
  return [
    { path: `${ENTRY_DIR}/a.md`, kind: 'changed', size: TEXT_A.length, sha256: sha(TEXT_A) },
    { path: `${ENTRY_DIR}/old.md`, kind: 'deleted', size: 0, sha256: null },
    { path: `${ENTRY_DIR}/a.md`, kind: 'backup', size: TEXT_B.length, sha256: sha(TEXT_B), label: '同期の衝突 11/23 10:00' },
    { path: '.personal/note.md', kind: 'personal', size: NOTE.length, sha256: sha(NOTE) },
    { path: 'huge.mov', kind: 'names-only', size: 900, sha256: null },
    { path: `${ENTRY_DIR}/.env`, kind: 'changed', size: 12, sha256: sha('API_KEY=abc\n') },
    ...extra,
  ]
}

const item = (ticket: string, body: unknown) => as('v1', 'POST', `/api/me/holding/tickets/${ticket}/items`, body)
const put = (user: string, itemId: string, bytes: Uint8Array, hash = sha(bytes)) => as(user, 'PUT', `/api/me/holding/items/${itemId}/blobs/${hash}`, undefined, bytes)
const itemDir = (itemId: string, co = CO) => join(HOLDING_ROOT, co, itemId)
const filesOf = (itemId: string) => db.prepare(`SELECT idx, path, kind, sha256, stored, dropped FROM holding_files WHERE company_id = ? AND item_id = ? ORDER BY idx`).all(CO, itemId) as Loose[]
const itemRow = (itemId: string) => db.prepare(`SELECT * FROM holding_items WHERE id = ?`).get(itemId) as Loose

beforeAll(async () => {
  for (const method of ['log', 'warn', 'error', 'info'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { printed.push(args.map(String).join(' ')) })
  }
  workDir = mkdtempSync(join(tmpdir(), 'acb-private-holding-'))
  const dbModule = await import('../../src/db')
  dbModule.initDatabase()
  db = dbModule.db
  const now = new Date().toISOString()
  for (const [co, owner] of [[CO, 'u-owner'], [OTHER_CO, 'u-owner2']]) {
    db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(co, co, `${co}-slug`, owner, now, now)
  }
  const Database = (await import('better-sqlite3')).default
  const authDb = new Database(join(process.env.DATA_DIR!, 'auth.sqlite'))
  const members: Array<[string, string, string]> = [
    [CO, 'owner', 'owner'], [CO, 'v1', 'member'], [CO, 'v2', 'member'], [CO, 'v3', 'member'], [CO, 'keeper', 'member'],
    [OTHER_CO, 'owner2', 'owner'], [OTHER_CO, 'v1', 'member'],
  ]
  for (const [co, u, role] of members) {
    authDb.prepare('INSERT OR IGNORE INTO user (id, email, name) VALUES (?, ?, ?)').run(`u-${u}`, `${u}@example.com`, u)
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${co}-${u}`, `u-${u}`, co, role, now, now)
  }
  authDb.close()
  const { ensureCompanyScope, ensureDepartmentScope } = await import('../../src/adapters/sqlite/permission-store')
  ensureCompanyScope(db, CO)
  db.prepare(`INSERT INTO departments (id, company_id, name, folder, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`).run('d-hr', CO, DEPT, DEPT, now, now)
  ensureDepartmentScope(db, CO, 'd-hr', DEPT)

  const { configureBareRepo } = await import('../../src/routes/git')
  const bare = join(process.env.REPOS_DIR!, `${CO}.git`)
  git(['init', '-q', '--bare', '--initial-branch=main', bare])
  configureBareRepo(bare)
  const seed = join(workDir, 'seed')
  git(['init', '-q', '--initial-branch=main', seed])
  git(['config', 'user.name', 'seed'], seed)
  git(['config', 'user.email', 'seed@example.com'], seed)
  mkdirSync(join(seed, DEPT), { recursive: true })
  writeFileSync(join(seed, DEPT, 'README.md'), 'hr\n')
  git(['add', '-A'], seed)
  git(['commit', '-q', '--no-verify', '-m', 'seed'], seed)
  git(['push', '-q', bare, 'HEAD:main'], seed)

  const cv = await import('../../src/lib/client-version')
  cv.setPrivateFoldersClientCutoffForTests('20260101000000')
  services = (await import('../../src/composition')).services
  app = (await import('../../src/app')).app
})

afterEach(async () => {
  const { setHoldingRatesForTests } = await import('../../src/services/private-holding')
  setHoldingRatesForTests({ blobsPerHour: 6000, writesPerHour: 120 })
})

afterAll(() => {
  expect(answered.length).toBeGreaterThan(50)
  // Nothing the server answered or printed named the folder or a path the member sent (I3, request log).
  for (const text of answered) {
    expect(text).not.toContain(FOLDER_NAME)
    expect(text).not.toContain(DEPT)
    expect(text).not.toContain(ENTRY_DIR)
  }
  for (const line of printed) {
    expect(line).not.toContain(FOLDER_NAME)
    expect(line).not.toContain(ENTRY_DIR)
  }
  vi.restoreAllMocks()
  rmSync(workDir, { recursive: true, force: true })
})

describe('the member\'s tickets', () => {
  it('lists the caller\'s own tickets with the protocol and the caps, never the folder', async () => {
    const { scopeId, tickets } = await ticketsFor(['v1', 'v2'])
    const mine = await as('v1', 'GET', '/api/me/holding/tickets')
    // v2's ticket of the same folder and company is not v1's to see.
    expect(mine.body.data.tickets.map((x: Loose) => x.ticketId)).not.toContain(tickets.v2)
    expect(mine.status).toBe(200)
    expect(mine.body.data.protocol).toBe(1)
    const t = mine.body.data.tickets.find((x: Loose) => x.ticketId === tickets.v1)
    expect(t).toEqual({
      ticketId: tickets.v1, companyId: CO, scopeId, state: 'open', expiresAt: expect.any(String),
      limits: { fileBytes: 50 * 1024 * 1024, itemBytes: 500 * 1024 * 1024, files: 5000, devices: 3 },
    })
    // Someone else's tickets are not theirs to see.
    const keeper = await as('keeper', 'GET', '/api/me/holding/tickets')
    expect(keeper.body.data.tickets).toEqual([])
    expect((await as(null, 'GET', '/api/me/holding/tickets')).status).toBe(401)
  })

  it('a ticket closed more than 90 days ago is no longer listed; an open one past its expiry reads expired', async () => {
    const { tickets } = await ticketsFor(['v3'])
    db.prepare(`UPDATE holding_tickets SET expires_at = ? WHERE id = ?`).run('2020-01-01T00:00:00.000Z', tickets.v3)
    let list = (await as('v3', 'GET', '/api/me/holding/tickets')).body.data.tickets
    expect(list.find((x: Loose) => x.ticketId === tickets.v3).state).toBe('expired')
    db.prepare(`UPDATE holding_tickets SET state = 'expired', closed_at = ?, updated_at = ? WHERE id = ?`).run('2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', tickets.v3)
    list = (await as('v3', 'GET', '/api/me/holding/tickets')).body.data.tickets
    expect(list.find((x: Loose) => x.ticketId === tickets.v3)).toBeUndefined()
  })
})

describe('one entry check (I3)', () => {
  it('another user\'s ticket, another company\'s and an unknown one are the same 404', async () => {
    const { tickets } = await ticketsFor(['v1', 'v2'])
    const body = { deviceKey: 'device-v1-a', baseCommit: null, manifest: manifest() }
    const unknown = await item('00000000-0000-4000-8000-000000000000', body)
    const others = await item(tickets.v2, body)
    // A ticket of another company's member (v1 is a member there too, but this one is not theirs).
    db.prepare(`INSERT INTO holding_tickets (id, company_id, user_id, scope_id, repo_id, folder_path, cause, state, created_at, updated_at, expires_at, by_user)
      VALUES ('t-other-co', ?, 'u-owner2', 's-x', NULL, 'x', 'readers', 'open', ?, ?, '2999-01-01T00:00:00.000Z', 'u-owner2')`).run(OTHER_CO, new Date().toISOString(), new Date().toISOString())
    const otherCompany = await item('t-other-co', body)
    for (const r of [unknown, others, otherCompany]) {
      expect(r.status).toBe(404)
      expect(r.body).toEqual({ error: 'Not found' })
    }
    expect(db.prepare(`SELECT COUNT(*) AS n FROM holding_items WHERE ticket_id IN (?, 't-other-co')`).get(tickets.v2)).toEqual({ n: 0 })
  })

  it('another user\'s item is the same 404 for its blobs and finish, and nothing is stored', async () => {
    const { tickets } = await ticketsFor(['v1', 'v2'])
    const started = await as('v2', 'POST', `/api/me/holding/tickets/${tickets.v2}/items`, { deviceKey: 'device-v2-a', baseCommit: null, manifest: manifest() })
    expect(started.status).toBe(200)
    // v1 holds a ticket in this company too: the item is still not theirs.
    expect((await put('v1', started.body.data.itemId, TEXT_A)).body).toEqual({ error: 'Not found' })
    expect((await as('v1', 'POST', `/api/me/holding/items/${started.body.data.itemId}/finish`)).body).toEqual({ error: 'Not found' })
    expect(existsSync(itemDir(started.body.data.itemId))).toBe(false)
    expect(itemRow(started.body.data.itemId).state).toBe('receiving')
  })

  it('an expired ticket answers 410 EXPIRED; a cancelled one 410 CANCELLED to its member only', async () => {
    const { scopeId, tickets } = await ticketsFor(['v1', 'v2'])
    const body = (d: string) => ({ deviceKey: d, baseCommit: null, manifest: manifest() })
    db.prepare(`UPDATE holding_tickets SET expires_at = ? WHERE id = ?`).run('2020-01-01T00:00:00.000Z', tickets.v1)
    const expired = await item(tickets.v1, body('device-v1-exp'))
    expect(expired.status).toBe(410)
    expect(expired.body.code).toBe('EXPIRED')
    // v2 reads the folder again: their ticket is cancelled (S1); they are told, nobody else.
    const back = await as('owner', 'PUT', `/api/companies/${CO}/private-folders/${scopeId}/members`, { viewers: ['u-keeper', 'u-v2'] })
    expect(back.status).toBe(200)
    const cancelled = await as('v2', 'POST', `/api/me/holding/tickets/${tickets.v2}/items`, body('device-v2-c'))
    expect(cancelled.status).toBe(410)
    expect(cancelled.body.code).toBe('CANCELLED')
    expect((await item(tickets.v2, body('device-v1-c'))).body).toEqual({ error: 'Not found' })
  })

  it('an item received before its ticket expired is still answered as received, so the app removes its copy (I2)', async () => {
    const { tickets } = await ticketsFor(['v1'])
    const r = await item(tickets.v1, { deviceKey: 'device-v1-late', baseCommit: null, manifest: [{ path: 'gone.md', kind: 'deleted', size: 0, sha256: null }] })
    expect((await as('v1', 'POST', `/api/me/holding/items/${r.body.data.itemId}/finish`)).status).toBe(200)
    db.prepare(`UPDATE holding_tickets SET expires_at = ? WHERE id = ?`).run('2020-01-01T00:00:00.000Z', tickets.v1)
    const again = await item(tickets.v1, { deviceKey: 'device-v1-late', baseCommit: null, manifest: [{ path: 'gone.md', kind: 'deleted', size: 0, sha256: null }] })
    expect(again.status).toBe(409)
    expect(again.body.code).toBe('ALREADY_RECEIVED')
    expect((await as('v1', 'POST', `/api/me/holding/items/${r.body.data.itemId}/finish`)).body.data).toEqual({ state: 'waiting' })
  })
})

describe('upload', () => {
  it('takes the contents named, keeps secrets\' and large files\' names only, and stores them privately', async () => {
    const { tickets } = await ticketsFor(['v1'])
    const r = await item(tickets.v1, { deviceKey: 'device-v1-main', baseCommit: 'a'.repeat(40), manifest: manifest() })
    expect(r.status).toBe(200)
    const { itemId, missing, namesOnly } = r.body.data
    expect(new Set(missing)).toEqual(new Set([sha(TEXT_A), sha(TEXT_B), sha(NOTE)]))
    // The `.env` entry (index 5) is a name only — the server's own check of the file name (I7).
    expect(namesOnly).toEqual([5])
    expect(filesOf(itemId)[5]).toMatchObject({ kind: 'names-only', sha256: null, dropped: 'secret' })
    expect(filesOf(itemId)[4]).toMatchObject({ kind: 'names-only', sha256: null, dropped: null })

    // A content that is not the one named.
    const wrong = await put('v1', itemId, new TextEncoder().encode('別の中身'), sha(TEXT_A))
    expect(wrong.status).toBe(400)
    expect(wrong.body.code).toBe('HASH_MISMATCH')
    // A content the manifest never named.
    expect((await put('v1', itemId, new TextEncoder().encode('知らない'))).status).toBe(404)

    // finish before everything arrived
    const early = await as('v1', 'POST', `/api/me/holding/items/${itemId}/finish`)
    expect(early.status).toBe(409)
    expect(early.body.code).toBe('MISSING_FILES')

    for (const bytes of [TEXT_A, TEXT_B, NOTE]) expect((await put('v1', itemId, bytes)).status).toBe(204)
    // Again: already stored, the same 204.
    expect((await put('v1', itemId, TEXT_A)).status).toBe(204)

    const dir = itemDir(itemId)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(statSync(join(HOLDING_ROOT, CO)).mode & 0o777).toBe(0o700)
    expect(readdirSync(dir).sort()).toEqual([sha(TEXT_A), sha(TEXT_B), sha(NOTE)].sort())
    for (const bytes of [TEXT_A, TEXT_B, NOTE]) {
      expect(readFileSync(join(dir, sha(bytes)))).toEqual(Buffer.from(bytes))
      expect(statSync(join(dir, sha(bytes))).mode & 0o777).toBe(0o600)
    }

    const done = await as('v1', 'POST', `/api/me/holding/items/${itemId}/finish`)
    expect(done.status).toBe(200)
    expect(done.body.data).toEqual({ state: 'waiting' })
    // finish again while it waits: the same answer (the app may have crashed before removing its copy).
    expect((await as('v1', 'POST', `/api/me/holding/items/${itemId}/finish`)).body.data).toEqual({ state: 'waiting' })
    expect(itemRow(itemId)).toMatchObject({ state: 'waiting', base_commit: 'a'.repeat(40), folder_path: expect.stringMatching(new RegExp(`^${FOLDER_PATH}`)) })
    const history = db.prepare(`SELECT detail, by_user FROM permission_history WHERE company_id = ? AND action = 'holding-received'`).all(CO) as Loose[]
    expect(history.map(h => ({ ...JSON.parse(h.detail), by: h.by_user })).find(h => h.itemId === itemId)).toMatchObject({
      ticketId: tickets.v1, userId: 'u-v1', files: 6, held: 3, namesOnly: 2, by: 'u-v1',
    })
    // A received item takes no more contents and no new manifest.
    expect((await put('v1', itemId, TEXT_A)).body.code).toBe('ALREADY_RECEIVED')
    const again = await item(tickets.v1, { deviceKey: 'device-v1-main', baseCommit: null, manifest: manifest() })
    expect(again.status).toBe(409)
    expect(again.body.code).toBe('ALREADY_RECEIVED')
    // Decided later (or expired): finish says received, so the app removes its copy.
    db.prepare(`UPDATE holding_items SET state = 'discarded' WHERE id = ?`).run(itemId)
    expect((await as('v1', 'POST', `/api/me/holding/items/${itemId}/finish`)).body.code).toBe('ALREADY_RECEIVED')
  })

  it('drops a content holding a secret when it arrives: never on disk, its entries a name only (I7)', async () => {
    const { tickets } = await ticketsFor(['v1'])
    const secret = new TextEncoder().encode(`設定\nkey = AKIA${'ABCDEFGHIJKLMNOP'}\n`)
    const r = await item(tickets.v1, { deviceKey: 'device-v1-secret', baseCommit: null, manifest: [
      { path: `${ENTRY_DIR}/config.txt`, kind: 'changed', size: secret.length, sha256: sha(secret) },
      { path: `${ENTRY_DIR}/b.md`, kind: 'changed', size: TEXT_A.length, sha256: sha(TEXT_A) },
    ] })
    const { itemId } = r.body.data
    expect((await put('v1', itemId, secret)).status).toBe(204)
    expect(existsSync(join(itemDir(itemId), sha(secret)))).toBe(false)
    expect(filesOf(itemId)[0]).toMatchObject({ kind: 'names-only', dropped: 'secret', stored: 0 })
    expect(itemRow(itemId).total_bytes).toBe(TEXT_A.length)
    // Sent again: nothing kept, nothing more wanted.
    expect((await put('v1', itemId, secret)).status).toBe(204)
    expect(existsSync(join(itemDir(itemId), sha(secret)))).toBe(false)
    expect((await put('v1', itemId, TEXT_A)).status).toBe(204)
    expect((await as('v1', 'POST', `/api/me/holding/items/${itemId}/finish`)).status).toBe(200)
  })

  it('keeps the caps: a file and an item over them are names only; a body over the file cap is 413', async () => {
    const { tickets } = await ticketsFor(['v1'])
    const MB = 1024 * 1024
    const hex = (i: number) => i.toString(16).padStart(64, 'f')
    const big = await item(tickets.v1, { deviceKey: 'device-v1-caps', baseCommit: null, manifest: [
      { path: 'big.bin', kind: 'changed', size: 50 * MB + 1, sha256: hex(99) },
      { path: 'fits.bin', kind: 'changed', size: 50 * MB, sha256: hex(98) },
    ] })
    expect(big.status).toBe(200)
    expect(big.body.data.namesOnly).toEqual([0])
    expect(big.body.data.missing).toEqual([hex(98)])

    // Eleven distinct contents of 49 MB: ten fit in 500 MB, the eleventh is a name only; a repeat of
    // the first content is counted once.
    const over = await item(tickets.v1, { deviceKey: 'device-v1-caps', baseCommit: null, manifest: [
      ...Array.from({ length: 11 }, (_, i) => ({ path: `p${i}.bin`, kind: 'changed', size: 49 * MB, sha256: hex(i) })),
      { path: 'copy-of-p0.bin', kind: 'backup', size: 49 * MB, sha256: hex(0) },
    ] })
    expect(over.body.data.itemId).toBe(big.body.data.itemId)
    expect(over.body.data.namesOnly).toEqual([10])
    expect(itemRow(over.body.data.itemId).total_bytes).toBe(10 * 49 * MB)

    // A body over the file cap: 413, nothing stored.
    const tooBig = await put('v1', over.body.data.itemId, new Uint8Array(50 * MB + 1), hex(0))
    expect(tooBig.status).toBe(413)
    expect(tooBig.body.code).toBe('TOO_LARGE')
    expect(existsSync(itemDir(over.body.data.itemId))).toBe(false)
  })

  it('the company\'s 2 GB of waiting items is shared: a new item past it keeps names only', async () => {
    const { tickets } = await ticketsFor(['v1'])
    const MB = 1024 * 1024
    const held = (db.prepare(`SELECT COALESCE(SUM(total_bytes), 0) AS n FROM holding_items WHERE company_id = ? AND state IN ('receiving', 'waiting', 'taking')`).get(CO) as { n: number }).n
    db.prepare(`INSERT INTO holding_items (id, company_id, ticket_id, user_id, device_key, scope_id, folder_path, state, total_bytes, created_at, updated_at)
      VALUES ('filler-2', ?, ?, 'u-v1', 'device-filler-2', 's', 'x', 'waiting', ?, ?, ?)`).run(CO, tickets.v1, 2 * 1024 * MB - held - 10, new Date().toISOString(), new Date().toISOString())
    const r = await item(tickets.v1, { deviceKey: 'device-v1-co', baseCommit: null, manifest: [
      { path: 'small.md', kind: 'changed', size: 10, sha256: 'a'.repeat(64) },
      { path: 'one-more.md', kind: 'changed', size: 1, sha256: 'b'.repeat(64) },
    ] })
    expect(r.body.data.namesOnly).toEqual([1])
    expect(r.body.data.missing).toEqual(['a'.repeat(64)])
    db.prepare(`DELETE FROM holding_items WHERE id = 'filler-2'`).run()
  })

  it('one item per PC, at most three PCs; a repeat while receiving replaces the manifest and keeps what arrived', async () => {
    const { tickets } = await ticketsFor(['v1'])
    const first = await item(tickets.v1, { deviceKey: 'device-v1-p1', baseCommit: null, manifest: manifest() })
    const { itemId } = first.body.data
    expect((await put('v1', itemId, TEXT_A)).status).toBe(204)
    const repeat = await item(tickets.v1, { deviceKey: 'device-v1-p1', baseCommit: null, manifest: [
      { path: `${ENTRY_DIR}/a.md`, kind: 'changed', size: TEXT_A.length, sha256: sha(TEXT_A) },
      { path: '.personal/note.md', kind: 'personal', size: NOTE.length, sha256: sha(NOTE) },
    ] })
    expect(repeat.body.data.itemId).toBe(itemId)
    expect(repeat.body.data.missing).toEqual([sha(NOTE)])
    expect(filesOf(itemId)).toHaveLength(2)
    for (const d of ['device-v1-p2', 'device-v1-p3']) expect((await item(tickets.v1, { deviceKey: d, baseCommit: null, manifest: manifest() })).status).toBe(200)
    const fourth = await item(tickets.v1, { deviceKey: 'device-v1-p4', baseCommit: null, manifest: manifest() })
    expect(fourth.status).toBe(409)
    expect(fourth.body.code).toBe('TOO_MANY_DEVICES')
  })

  it('refuses a manifest that is not valid with one fixed answer, writing nothing', async () => {
    const { tickets } = await ticketsFor(['v1'])
    const bad: Loose[] = [
      null,
      { deviceKey: 'short', baseCommit: null, manifest: manifest() },
      { deviceKey: 'device-v1-bad', baseCommit: 'zz', manifest: manifest() },
      { deviceKey: 'device-v1-bad', baseCommit: null, manifest: [] },
      { deviceKey: 'device-v1-bad', baseCommit: null, manifest: [{ path: '../escape.md', kind: 'changed', size: 1, sha256: 'a'.repeat(64) }] },
      { deviceKey: 'device-v1-bad', baseCommit: null, manifest: [{ path: 'a.md', kind: 'deleted', size: 1, sha256: 'a'.repeat(64) }] },
      { deviceKey: 'device-v1-bad', baseCommit: null, manifest: [{ path: 'a.md', kind: 'changed', size: 1, sha256: null }] },
      { deviceKey: 'device-v1-bad', baseCommit: null, manifest: [{ path: 'a.md', kind: 'other', size: 1, sha256: null }] },
      { deviceKey: 'device-v1-bad', baseCommit: null, manifest: [
        { path: 'a.md', kind: 'changed', size: 1, sha256: 'a'.repeat(64) }, { path: 'b.md', kind: 'changed', size: 2, sha256: 'a'.repeat(64) },
      ] },
    ]
    for (const body of bad) {
      const r = await item(tickets.v1, body)
      expect(r.status).toBe(400)
      expect(r.body).toEqual({ error: 'Invalid request', code: 'INVALID' })
    }
    expect(db.prepare(`SELECT COUNT(*) AS n FROM holding_items WHERE ticket_id = ?`).get(tickets.v1)).toEqual({ n: 0 })
  })

  it('limits each member\'s requests', async () => {
    const { tickets } = await ticketsFor(['v1'])
    const { setHoldingRatesForTests } = await import('../../src/services/private-holding')
    setHoldingRatesForTests({ writesPerHour: 0 })
    const r = await item(tickets.v1, { deviceKey: 'device-v1-rate', baseCommit: null, manifest: manifest() })
    expect(r.status).toBe(429)
    expect(r.body.code).toBe('RATE_LIMITED')
    expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0)
    setHoldingRatesForTests({ writesPerHour: 120, blobsPerHour: 0 })
    const ok = await item(tickets.v1, { deviceKey: 'device-v1-rate', baseCommit: null, manifest: manifest() })
    expect((await put('v1', ok.body.data.itemId, TEXT_A)).status).toBe(429)
  })
})

describe('retention and erasure (I8)', () => {
  const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString()

  it('the server clock removes an unfinished item after 2 days, expires a waiting one after 30 and deletes its contents', async () => {
    const { tickets } = await ticketsFor(['v1'])
    const a = (await item(tickets.v1, { deviceKey: 'device-v1-r1', baseCommit: null, manifest: manifest() })).body.data.itemId
    await put('v1', a, TEXT_A)
    const b = (await item(tickets.v1, { deviceKey: 'device-v1-r2', baseCommit: null, manifest: manifest() })).body.data.itemId
    for (const bytes of [TEXT_A, TEXT_B, NOTE]) await put('v1', b, bytes)
    expect((await as('v1', 'POST', `/api/me/holding/items/${b}/finish`)).status).toBe(200)
    // A directory no row holds (a write that lost a race): removed too.
    mkdirSync(join(HOLDING_ROOT, CO, 'orphan-dir'), { recursive: true })

    // Not due yet: nothing changes.
    await services.serverClock.runOnce()
    expect(itemRow(a).state).toBe('receiving')
    expect(existsSync(join(HOLDING_ROOT, CO, 'orphan-dir'))).toBe(false)

    db.prepare(`UPDATE holding_items SET created_at = ? WHERE id = ?`).run(daysAgo(3), a)
    db.prepare(`UPDATE holding_items SET finished_at = ? WHERE id = ?`).run(daysAgo(31), b)
    const run = await services.serverClock.runOnce()
    expect(run.holdingSwept).toBeGreaterThanOrEqual(2)
    expect(itemRow(a)).toBeUndefined()
    expect(existsSync(itemDir(a))).toBe(false)
    expect(itemRow(b)).toMatchObject({ state: 'expired', blobs_deleted_at: expect.any(String) })
    expect(existsSync(itemDir(b))).toBe(false)
    // The names stay as the record.
    expect(filesOf(b)).toHaveLength(6)
    expect(db.prepare(`SELECT COUNT(*) AS n FROM permission_history WHERE company_id = ? AND action = 'holding-expired' AND detail LIKE ?`).get(CO, `%${b}%`)).toEqual({ n: 1 })
    // Again: nothing more.
    const second = await services.privateHolding.sweep(CO)
    expect(second).toBe(0)
    // The unfinished item's PC starts again on its next try.
    expect((await item(tickets.v1, { deviceKey: 'device-v1-r1', baseCommit: null, manifest: manifest() })).status).toBe(200)
  })

  it('the operator\'s erasure removes an item\'s contents and names; the app is told it was received', async () => {
    const { tickets } = await ticketsFor(['v1'])
    const id = (await item(tickets.v1, { deviceKey: 'device-v1-erase', baseCommit: null, manifest: manifest() })).body.data.itemId
    for (const bytes of [TEXT_A, TEXT_B, NOTE]) await put('v1', id, bytes)
    await as('v1', 'POST', `/api/me/holding/items/${id}/finish`)
    expect(await services.privateHolding.erase(CO, id, 'request')).toBe(true)
    expect(existsSync(itemDir(id))).toBe(false)
    expect(filesOf(id)).toEqual([])
    expect(itemRow(id)).toMatchObject({ state: 'discarded', total_bytes: 0, blobs_deleted_at: expect.any(String) })
    expect((await item(tickets.v1, { deviceKey: 'device-v1-erase', baseCommit: null, manifest: manifest() })).body.code).toBe('ALREADY_RECEIVED')
    // Another company's id erases nothing.
    expect(await services.privateHolding.erase(OTHER_CO, id, 'request')).toBe(false)
  })
})
