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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'fs'
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

async function as(user: string | null, method: string, path: string, body?: unknown, raw?: Uint8Array, length?: number) {
  const headers: Record<string, string> = user ? { 'x-test-user': `u-${user}` } : {}
  const init: RequestInit = { method, headers }
  if (raw) {
    init.body = raw
    headers['Content-Type'] = 'application/octet-stream'
    headers['Content-Length'] = String(length ?? raw.byteLength)
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

/**
 * A PUT whose body is sent slowly: its first byte, then the rest when `release()` is called.
 * `pulls()` says how far the server read (0 = never asked for the body).
 */
function heldPut(user: string, itemId: string, bytes: Uint8Array, hash = sha(bytes), length = bytes.byteLength) {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let pulls = 0
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      pulls++
      if (pulls === 1) { controller.enqueue(bytes.subarray(0, 1)); return }
      await gate
      controller.enqueue(bytes.subarray(1))
      controller.close()
    },
  }, { highWaterMark: 0 })
  const answer = (async () => {
    const res: Response = await app.request(`http://acb.test/api/me/holding/items/${itemId}/blobs/${hash}`, {
      method: 'PUT', body: stream, duplex: 'half',
      headers: { 'x-test-user': `u-${user}`, 'Content-Type': 'application/octet-stream', 'Content-Length': String(length) },
    } as RequestInit)
    const text = await res.text()
    answered.push(text)
    let json: Loose = null
    try { json = JSON.parse(text) } catch { /* empty */ }
    return { status: res.status, body: json }
  })()
  return { answer, release, pulls: () => pulls }
}

/** Until the server has read the first part of a held body (it now waits in the middle). */
async function untilReading(held: { pulls: () => number }) {
  for (let i = 0; i < 2000 && held.pulls() < 2; i++) await new Promise(resolve => setTimeout(resolve, 5))
  expect(held.pulls()).toBeGreaterThanOrEqual(2)
}

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
      limits: { fileBytes: 50 * 1024 * 1024, itemBytes: 500 * 1024 * 1024, ticketBytes: 1024 * 1024 * 1024, files: 5000, devices: 3 },
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

    // A content that is not the one named: another size, and the same size with other bytes.
    const wrong = await put('v1', itemId, new TextEncoder().encode('別の中身'), sha(TEXT_A))
    expect(wrong.status).toBe(400)
    expect(wrong.body.code).toBe('HASH_MISMATCH')
    const forged = await put('v1', itemId, new Uint8Array(TEXT_A.length).fill(65), sha(TEXT_A))
    expect(forged.status).toBe(400)
    expect(forged.body.code).toBe('HASH_MISMATCH')
    expect(existsSync(join(itemDir(itemId), sha(TEXT_A)))).toBe(false)
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
    // What counts against the room is what is stored: nothing yet.
    expect(itemRow(itemId).total_bytes).toBe(0)
    // Sent again: nothing kept, nothing more wanted.
    expect((await put('v1', itemId, secret)).status).toBe(204)
    expect(existsSync(join(itemDir(itemId), sha(secret)))).toBe(false)
    expect((await put('v1', itemId, TEXT_A)).status).toBe(204)
    expect(itemRow(itemId).total_bytes).toBe(TEXT_A.length)
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
    expect(over.body.data.missing).toHaveLength(10)

    // A body over the file cap: 413, nothing stored.
    // A Content-Length over the file cap: 413 before the body is read.
    const tooBig = await as('v1', 'PUT', `/api/me/holding/items/${over.body.data.itemId}/blobs/${hex(0)}`, undefined, new Uint8Array(8), 50 * MB + 1)
    expect(tooBig.status).toBe(413)
    expect(tooBig.body.code).toBe('TOO_LARGE')
    expect(existsSync(itemDir(over.body.data.itemId))).toBe(false)
  })

  it('the company\'s room counts stored contents only; with no room an entry is company-full, kept by the app, and nothing finishes (M3)', async () => {
    const { tickets } = await ticketsFor(['v1', 'v2'])
    const MB = 1024 * 1024
    const now = new Date().toISOString()
    // A big announcement that never uploads takes no room from anyone.
    const big = await as('v2', 'POST', `/api/me/holding/tickets/${tickets.v2}/items`, { deviceKey: 'device-v2-big', baseCommit: null, manifest: [
      ...Array.from({ length: 10 }, (_, i) => ({ path: `big${i}.bin`, kind: 'changed', size: 49 * MB, sha256: i.toString(16).padStart(64, 'c') })),
    ] })
    expect(big.body.data.companyFull).toEqual([])
    expect(itemRow(big.body.data.itemId).total_bytes).toBe(0)
    // The company's stored contents fill its room (another member's waiting item).
    const held = () => (db.prepare(`SELECT COALESCE(SUM(total_bytes), 0) AS n FROM holding_items WHERE company_id = ? AND state IN ('receiving', 'waiting', 'taking')`).get(CO) as { n: number }).n
    db.prepare(`INSERT INTO holding_items (id, company_id, ticket_id, user_id, device_key, scope_id, folder_path, state, total_bytes, created_at, updated_at)
      VALUES ('filler-co', ?, ?, 'u-v2', 'device-filler-co', 's', 'x', 'waiting', ?, ?, ?)`).run(CO, tickets.v2, 2 * 1024 * MB - held() - 5, now, now)
    const body = { deviceKey: 'device-v1-full', baseCommit: null, manifest: [
      { path: 'fits.md', kind: 'changed', size: 5, sha256: sha('12345') },
      { path: 'no-room.md', kind: 'changed', size: TEXT_A.length, sha256: sha(TEXT_A) },
    ] }
    const r = await item(tickets.v1, body)
    expect(r.body.data.namesOnly).toEqual([])
    expect(r.body.data.companyFull).toEqual([1])
    expect(r.body.data.missing).toEqual([sha('12345')])
    const { itemId } = r.body.data
    expect((await put('v1', itemId, new TextEncoder().encode('12345'))).status).toBe(204)
    const noRoom = await put('v1', itemId, TEXT_A)
    expect(noRoom.status).toBe(409)
    expect(noRoom.body.code).toBe('COMPANY_FULL')
    // Not finished half-held: the app keeps its copy.
    const finish = await as('v1', 'POST', `/api/me/holding/items/${itemId}/finish`)
    expect(finish.status).toBe(409)
    expect(finish.body.code).toBe('COMPANY_FULL')
    // Room again later: the same PC asks again and the entry is wanted; what arrived stays.
    db.prepare(`DELETE FROM holding_items WHERE id = 'filler-co'`).run()
    const again = await item(tickets.v1, body)
    expect(again.body.data).toMatchObject({ itemId, companyFull: [], missing: [sha(TEXT_A)] })
    // Full again when the content arrives: decided on what is stored, under the lock.
    db.prepare(`INSERT INTO holding_items (id, company_id, ticket_id, user_id, device_key, scope_id, folder_path, state, total_bytes, created_at, updated_at)
      VALUES ('filler-co2', ?, ?, 'u-v2', 'device-filler-co2', 's', 'x', 'waiting', ?, ?, ?)`).run(CO, tickets.v2, 2 * 1024 * MB - held(), now, now)
    const late = await put('v1', itemId, TEXT_A)
    expect(late.body.code).toBe('COMPANY_FULL')
    expect(existsSync(join(itemDir(itemId), sha(TEXT_A)))).toBe(false)
    expect(filesOf(itemId)[1]).toMatchObject({ dropped: 'company-full', stored: 0 })
    db.prepare(`DELETE FROM holding_items WHERE id = 'filler-co2'`).run()
  })

  it('one member\'s ticket has a share of its own (1 GB, all its PCs): beyond it a name only (M3)', async () => {
    const { tickets } = await ticketsFor(['v1'])
    const MB = 1024 * 1024
    const now = new Date().toISOString()
    db.prepare(`INSERT INTO holding_items (id, company_id, ticket_id, user_id, device_key, scope_id, folder_path, state, total_bytes, created_at, updated_at)
      VALUES ('filler-ticket', ?, ?, 'u-v1', 'device-filler-t', 's', 'x', 'waiting', ?, ?, ?)`).run(CO, tickets.v1, 1024 * MB - 10, now, now)
    const r = await item(tickets.v1, { deviceKey: 'device-v1-share', baseCommit: null, manifest: [
      { path: 'small.md', kind: 'changed', size: 10, sha256: 'a'.repeat(64) },
      { path: 'one-more.md', kind: 'changed', size: 1, sha256: 'b'.repeat(64) },
    ] })
    expect(r.body.data).toMatchObject({ namesOnly: [1], companyFull: [], missing: ['a'.repeat(64)] })
    db.prepare(`DELETE FROM holding_items WHERE id = 'filler-ticket'`).run()
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

describe('uploads at the same time and before the body (P1, P2, M2, L1, L3)', () => {
  it('a second PUT of the same content that loses the race never removes the content a received item holds (P1)', async () => {
    const { tickets } = await ticketsFor(['v1'])
    const { itemId } = (await item(tickets.v1, { deviceKey: 'device-v1-race', baseCommit: null, manifest: [
      { path: 'a.md', kind: 'changed', size: TEXT_A.length, sha256: sha(TEXT_A) },
    ] })).body.data
    const slow = heldPut('v1', itemId, TEXT_A)
    await untilReading(slow)
    // Meanwhile the same content arrives whole, and the item is finished.
    expect((await put('v1', itemId, TEXT_A)).status).toBe(204)
    expect((await as('v1', 'POST', `/api/me/holding/items/${itemId}/finish`)).status).toBe(200)
    slow.release()
    const late = await slow.answer
    expect(late.status).toBe(409)
    expect(late.body.code).toBe('ALREADY_RECEIVED')
    // The received item still has its content, and no temporary file is left.
    expect(readFileSync(join(itemDir(itemId), sha(TEXT_A)))).toEqual(Buffer.from(TEXT_A))
    expect(readdirSync(itemDir(itemId))).toEqual([sha(TEXT_A)])
  })

  it('a content the manifest stopped naming while it arrived is not kept, and the sweep removes files no stored entry names (P2)', async () => {
    const { tickets } = await ticketsFor(['v1'])
    const body = (manifest: Loose[]) => ({ deviceKey: 'device-v1-p2', baseCommit: null, manifest })
    const { itemId } = (await item(tickets.v1, body([
      { path: 'a.md', kind: 'changed', size: TEXT_A.length, sha256: sha(TEXT_A) },
      { path: 'b.md', kind: 'changed', size: TEXT_B.length, sha256: sha(TEXT_B) },
    ]))).body.data
    const slow = heldPut('v1', itemId, TEXT_A)
    await untilReading(slow)
    await item(tickets.v1, body([{ path: 'b.md', kind: 'changed', size: TEXT_B.length, sha256: sha(TEXT_B) }]))
    slow.release()
    expect((await slow.answer).status).toBe(404)
    expect(existsSync(join(itemDir(itemId), sha(TEXT_A)))).toBe(false)
    expect(itemRow(itemId).total_bytes).toBe(0)
    // Files in a live item's directory that no stored entry names, and old temporary files: the sweep removes them.
    expect((await put('v1', itemId, TEXT_B)).status).toBe(204)
    writeFileSync(join(itemDir(itemId), 'f'.repeat(64)), 'stray')
    writeFileSync(join(itemDir(itemId), '.tmp-0123456789abcdef'), 'left by a stopped upload')
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
    utimesSync(join(itemDir(itemId), '.tmp-0123456789abcdef'), old, old)
    writeFileSync(join(itemDir(itemId), '.tmp-fedcba9876543210'), 'an upload running now')
    await services.privateHolding.sweep(CO)
    expect(readdirSync(itemDir(itemId)).sort()).toEqual(['.tmp-fedcba9876543210', sha(TEXT_B)].sort())
    // The storage step itself: a content no not-dropped entry names is never marked stored (the
    // service then removes it) — also when the manifest changes during the rename.
    const { sqliteCompanyData } = await import('../../src/adapters/sqlite/company-data')
    const items = sqliteCompanyData(db).forCompany(CO).holdingItems
    expect(items.markStored(itemId, sha(TEXT_A), new Date().toISOString())).toBe(false)
    items.dropContent(itemId, sha(TEXT_B), 'company-full', new Date().toISOString())
    expect(items.markStored(itemId, sha(TEXT_B), new Date().toISOString())).toBe(false)
    expect(itemRow(itemId).total_bytes).toBe(0)
  })

  it('refuses before reading the body: someone else\'s item, no or a wrong Content-Length, over the cap, too many uploads (M2)', async () => {
    const { tickets } = await ticketsFor(['v1', 'v2'])
    const big = new Uint8Array(64).fill(7)
    const v2Item = (await as('v2', 'POST', `/api/me/holding/tickets/${tickets.v2}/items`, { deviceKey: 'device-v2-m2', baseCommit: null, manifest: [
      { path: 'x.bin', kind: 'changed', size: big.length, sha256: sha(big) },
    ] })).body.data.itemId
    const notMine = heldPut('v1', v2Item, big)
    expect((await notMine.answer).status).toBe(404)
    expect(notMine.pulls()).toBe(0)

    const { itemId } = (await item(tickets.v1, { deviceKey: 'device-v1-m2', baseCommit: null, manifest: [
      { path: 'x.bin', kind: 'changed', size: big.length, sha256: sha(big) },
      { path: 'y.md', kind: 'changed', size: TEXT_A.length, sha256: sha(TEXT_A) },
      { path: 'z.md', kind: 'changed', size: TEXT_B.length, sha256: sha(TEXT_B) },
    ] })).body.data
    const wrongLength = heldPut('v1', itemId, big, sha(big), big.length + 1)
    expect((await wrongLength.answer).body.code).toBe('HASH_MISMATCH')
    expect(wrongLength.pulls()).toBe(0)
    const overCap = heldPut('v1', itemId, big, sha(big), 50 * 1024 * 1024 + 1)
    expect((await overCap.answer).status).toBe(413)
    expect(overCap.pulls()).toBe(0)
    const noLength = await app.request(`http://acb.test/api/me/holding/items/${itemId}/blobs/${sha(big)}`, {
      method: 'PUT', headers: { 'x-test-user': 'u-v1' }, body: new ReadableStream({ start(c) { c.close() } }), duplex: 'half',
    } as RequestInit)
    expect(noLength.status).toBe(400)

    // Two uploads of this member are running: a third waits its turn.
    const one = heldPut('v1', itemId, big)
    const two = heldPut('v1', itemId, TEXT_A)
    await untilReading(one)
    await untilReading(two)
    const three = heldPut('v1', itemId, TEXT_B)
    const busy = await three.answer
    expect(busy.status).toBe(429)
    expect(busy.body.code).toBe('BUSY')
    expect(three.pulls()).toBe(0)
    one.release()
    two.release()
    expect((await one.answer).status).toBe(204)
    expect((await two.answer).status).toBe(204)
    expect((await put('v1', itemId, TEXT_B)).status).toBe(204)

    // And a few for the whole server.
    const { setHoldingRatesForTests } = await import('../../src/services/private-holding')
    setHoldingRatesForTests({ uploadsPerServer: 1 })
    const { itemId: other } = (await as('v2', 'POST', `/api/me/holding/tickets/${tickets.v2}/items`, { deviceKey: 'device-v2-m2b', baseCommit: null, manifest: [
      { path: 'n.md', kind: 'changed', size: NOTE.length, sha256: sha(NOTE) },
    ] })).body.data
    const running = heldPut('v1', v2Item, big)
    expect((await running.answer).status).toBe(404) // not theirs: never counted
    const first = heldPut('v2', v2Item, big)
    await untilReading(first)
    const second = heldPut('v2', other, NOTE)
    expect((await second.answer).body.code).toBe('BUSY')
    first.release()
    expect((await first.answer).status).toBe(204)
  })

  it('a secret is found in a binary content too, and a content lost from the disk is taken again (L1, L3)', async () => {
    const { tickets } = await ticketsFor(['v1'])
    const binary = new Uint8Array([0, 1, 2, 0, ...new TextEncoder().encode(`ghp_${'a'.repeat(36)}`), 0, 9])
    const { itemId } = (await item(tickets.v1, { deviceKey: 'device-v1-l1', baseCommit: null, manifest: [
      { path: 'blob.bin', kind: 'changed', size: binary.length, sha256: sha(binary) },
      { path: 'a.md', kind: 'changed', size: TEXT_A.length, sha256: sha(TEXT_A) },
    ] })).body.data
    expect((await put('v1', itemId, binary)).status).toBe(204)
    expect(existsSync(join(itemDir(itemId), sha(binary)))).toBe(false)
    expect(filesOf(itemId)[0]).toMatchObject({ kind: 'names-only', dropped: 'secret' })

    expect((await put('v1', itemId, TEXT_A)).status).toBe(204)
    rmSync(join(itemDir(itemId), sha(TEXT_A)))
    expect((await put('v1', itemId, TEXT_A)).status).toBe(204)
    expect(readFileSync(join(itemDir(itemId), sha(TEXT_A)))).toEqual(Buffer.from(TEXT_A))
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
