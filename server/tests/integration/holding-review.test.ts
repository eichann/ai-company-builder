/**
 * Integration Test: the holding place — the review (private-folders.md "Holding: review"; design memo
 * §4, stage S3) through the real application, the real push checker and real scope repositories.
 *
 * A member taken off a private folder's readers handed over what their PC never sent (S2). The
 * folder's managers take it in or discard it. Each test names the rule it guards: who reviews (I5:
 * readers who are owner / admin or the department's manager; a folder no longer private: owners /
 * admins; anyone else the 404 of an item that does not exist), taking in as the reviewer's own push
 * (the push checker judges every path again: write permission, `.personal`, secrets, protected
 * config), never over a later change (alongside / overwrite / deletions only of unchanged files), once
 * only (two take-ins, take-in and discard, a take-in that stopped halfway settled by the folder's
 * history, the clock never expiring an item being taken in) — and no answer or log line naming the
 * folder to anyone who is not its reviewer.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { createHash } from 'crypto'
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { makeTempDir } from '../../shared/testing/temp-dirs'

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
    getUsersByIds: vi.fn().mockImplementation((ids: string[]) => new Map(ids.map(id => [id, { email: `${id}@example.com`, name: id === 'u-v1' ? '佐藤' : `Name ${id}` }]))),
    auth: {
      handler: vi.fn().mockResolvedValue(new Response('', { status: 200 })),
      api: { getSession: vi.fn().mockResolvedValue(null) },
    },
  }
})

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any

const CO = 'hrco'
const DEPT = '人事'
const OTHER_DEPT = '営業'
/** The folder's name: never in an answer to someone who does not review it, never in a log line. */
const FOLDER_NAME = '査定_非公開'
/** A folder the member handed over files in: never in a log line. */
const ENTRY_DIR = '面談記録'
const HOLDING_ROOT = join(process.env.DATA_DIR!, 'holding')
const DAY = 24 * 60 * 60 * 1000

let workDir: string
let db: import('better-sqlite3').Database
let app: Loose
let services: Loose
const printed: string[] = []
/** Answers to callers who are not the item's reviewers: they must not name the folder. */
const outsiders: string[] = []

const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex')
const git = (args: string[], cwd?: string) => execFileSync('git', args, { stdio: 'pipe', ...(cwd ? { cwd } : {}) }).toString()

async function as(user: string | null, method: string, path: string, body?: unknown, raw?: Uint8Array) {
  const headers: Record<string, string> = user ? { 'x-test-user': `u-${user}` } : {}
  const init: RequestInit = { method, headers }
  if (raw) {
    init.body = raw
    headers['Content-Type'] = 'application/octet-stream'
    headers['Content-Length'] = String(raw.byteLength)
  } else if (body !== undefined) {
    init.body = JSON.stringify(body)
    headers['Content-Type'] = 'application/json'
  }
  const res: Response = await app.request(`http://acb.test${path}`, init)
  const buf = Buffer.from(await res.arrayBuffer())
  const text = buf.toString('utf8')
  let json: Loose = null
  try { json = JSON.parse(text) } catch { /* bytes */ }
  return { status: res.status, body: json, text, buf, headers: res.headers }
}

/** A call by someone who must learn nothing about the folder. */
async function outsider(user: string, method: string, path: string, body?: unknown) {
  const r = await as(user, method, path, body)
  outsiders.push(r.text)
  return r
}

const H = `/api/companies/${CO}/holding`

let folderCount = 0
interface Folder { scopeId: string; repo: string; name: string; path: string }

/** A private folder of 人事 with its readers, its repository seeded with `files` (its base). */
async function folderWith(files: Record<string, string>, readers: { viewers: string[]; editors: string[] }): Promise<Folder & { base: string }> {
  const name = `${FOLDER_NAME}${folderCount++ || ''}`
  const made = await as('owner', 'POST', `/api/companies/${CO}/private-folders`, {
    parentPath: DEPT, name, viewers: readers.viewers.map(u => `u-${u}`), editors: readers.editors.map(u => `u-${u}`), force: true,
  })
  if (made.status !== 201) throw new Error(`create failed: ${made.status} ${made.text}`)
  const scopeId = made.body.data.scopeId
  const { privateRepoPath } = await import('../../src/lib/private-folders')
  const repoId = (db.prepare(`SELECT id FROM scope_repos WHERE scope_id = ?`).get(scopeId) as { id: string }).id
  const repo = privateRepoPath(CO, repoId)
  const base = commitTo(repo, files, 'base')
  return { scopeId, repo, name, path: `${DEPT}/${name}`, base }
}

/**
 * A commit landing on a scope repository's main (as a member's sync would), written with plumbing
 * straight into the repository — a test setup step, not what is under test (no hook run). Its id.
 */
function commitTo(repo: string, files: Record<string, string | null>, message: string): string {
  const env = {
    ...process.env, GIT_INDEX_FILE: join(workDir, `index-${Math.random().toString(16).slice(2)}`),
    GIT_AUTHOR_NAME: 'member', GIT_AUTHOR_EMAIL: 'member@example.com', GIT_COMMITTER_NAME: 'member', GIT_COMMITTER_EMAIL: 'member@example.com',
  }
  const run = (args: string[], input?: string) => execFileSync('git', ['-C', repo, ...args], { env, stdio: 'pipe', ...(input !== undefined ? { input } : {}) }).toString().trim()
  const parent = run(['rev-parse', 'refs/heads/main'])
  run(['read-tree', parent])
  for (const [p, content] of Object.entries(files)) {
    if (content === null) { run(['update-index', '--index-info'], `0 ${'0'.repeat(40)}\t${p}\n`); continue }
    const blob = run(['hash-object', '-w', '--stdin'], content)
    run(['update-index', '--add', '--cacheinfo', `100644,${blob},${p}`])
  }
  const tree = run(['write-tree'])
  const commit = run(['commit-tree', tree, '-p', parent, '-m', message])
  run(['update-ref', 'refs/heads/main', commit, parent])
  rmSync(env.GIT_INDEX_FILE, { force: true })
  return commit
}

const tipOf = (repo: string) => git(['-C', repo, 'rev-parse', 'refs/heads/main']).trim()
const fileAt = (repo: string, path: string) => { try { return git(['-C', repo, 'show', `refs/heads/main:${path}`]) } catch { return null } }
const filesAt = (repo: string) => git(['-C', repo, 'ls-tree', '-r', '--name-only', '-z', 'refs/heads/main']).split('\0').filter(Boolean).sort()

interface Entry { path: string; kind: 'changed' | 'deleted' | 'backup' | 'personal' | 'names-only'; content?: string; label?: string }

let deviceCount = 0
/** `v1` is taken off the folder's readers and hands over `entries` (against `base`): the waiting item. */
async function handOver(folder: Folder & { base: string }, readersAfter: { viewers: string[]; editors: string[] }, entries: Entry[]): Promise<string> {
  const r = await as('owner', 'PUT', `/api/companies/${CO}/private-folders/${folder.scopeId}/members`, {
    viewers: readersAfter.viewers.map(u => `u-${u}`), editors: readersAfter.editors.map(u => `u-${u}`),
  })
  if (r.status !== 200) throw new Error(`members failed: ${r.status}`)
  const ticket = (db.prepare(`SELECT id FROM holding_tickets WHERE company_id = ? AND scope_id = ? AND user_id = 'u-v1' AND state = 'open'`).get(CO, folder.scopeId) as { id: string }).id
  const manifest = entries.map(e => {
    const bytes = e.content !== undefined ? Buffer.from(e.content) : null
    return { path: e.path, kind: e.kind, size: bytes?.length ?? 0, sha256: bytes ? sha(bytes) : null, ...(e.label ? { label: e.label } : {}) }
  })
  const started = await as('v1', 'POST', `/api/me/holding/tickets/${ticket}/items`, { deviceKey: `device-${deviceCount++}-abc`, baseCommit: folder.base, manifest })
  if (started.status !== 200) throw new Error(`item failed: ${started.status} ${started.text}`)
  const itemId = started.body.data.itemId
  for (const e of entries) {
    if (e.content === undefined) continue
    const bytes = Buffer.from(e.content)
    if (!started.body.data.missing.includes(sha(bytes))) continue
    const put = await as('v1', 'PUT', `/api/me/holding/items/${itemId}/blobs/${sha(bytes)}`, undefined, bytes)
    if (put.status !== 204) throw new Error(`put failed: ${put.status} ${put.text}`)
  }
  const done = await as('v1', 'POST', `/api/me/holding/items/${itemId}/finish`)
  if (done.status !== 200) throw new Error(`finish failed: ${done.status} ${done.text}`)
  return itemId
}

const itemRow = (itemId: string) => db.prepare(`SELECT * FROM holding_items WHERE id = ?`).get(itemId) as Loose
const history = (action: string, itemId: string) => db.prepare(`SELECT detail, by_user FROM permission_history WHERE company_id = ? AND action = ? AND detail LIKE ?`).all(CO, action, `%${itemId}%`) as Loose[]
const commitsWithLine = (repo: string, itemId: string) => git(['-C', repo, 'log', '--format=%H', `--grep=ACB-Holding-Item: ${itemId}`, '--fixed-strings', 'refs/heads/main']).split('\n').filter(Boolean)

/** Readers: keeper edits; mgr (人事's manager) and salesMgr (営業's manager) view; v1 is the one who leaves. */
const READERS = { viewers: ['v1', 'mgr', 'salesMgr', 'keeper', 'mgrEd'], editors: ['v1', 'keeper', 'mgrEd'] }
const AFTER = { viewers: ['mgr', 'salesMgr', 'keeper', 'mgrEd'], editors: ['keeper', 'mgrEd'] }

beforeAll(async () => {
  for (const method of ['log', 'warn', 'error', 'info'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { printed.push(args.map(String).join(' ')) })
  }
  workDir = makeTempDir('acb-holding-review-')
  const dbModule = await import('../../src/db')
  dbModule.initDatabase()
  db = dbModule.db
  const now = new Date().toISOString()
  db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(CO, CO, `${CO}-slug`, 'u-owner', now, now)
  const Database = (await import('better-sqlite3')).default
  const authDb = new Database(join(process.env.DATA_DIR!, 'auth.sqlite'))
  const members: Array<[string, string]> = [
    ['owner', 'owner'], ['admin', 'admin'], ['v1', 'member'], ['keeper', 'member'], ['mgr', 'member'], ['mgrEd', 'member'],
    ['mgrNR', 'member'], ['salesMgr', 'member'], ['plain', 'member'],
  ]
  for (const [u, role] of members) {
    authDb.prepare('INSERT OR IGNORE INTO user (id, email, name) VALUES (?, ?, ?)').run(`u-${u}`, `${u}@example.com`, u === 'v1' ? '佐藤' : u)
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${u}`, `u-${u}`, CO, role, now, now)
  }
  authDb.close()
  const { ensureCompanyScope, ensureDepartmentScope } = await import('../../src/adapters/sqlite/permission-store')
  ensureCompanyScope(db, CO)
  for (const [id, folder] of [['d-hr', DEPT], ['d-sales', OTHER_DEPT]]) {
    db.prepare(`INSERT INTO departments (id, company_id, name, folder, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`).run(id, CO, folder, folder, now, now)
    ensureDepartmentScope(db, CO, id, folder)
  }
  for (const [dept, user] of [['d-hr', 'u-mgr'], ['d-hr', 'u-mgrEd'], ['d-hr', 'u-mgrNR'], ['d-sales', 'u-salesMgr']]) {
    db.prepare(`INSERT INTO department_managers (company_id, department_id, user_id, created_at) VALUES (?, ?, ?, ?)`).run(CO, dept, user, now)
  }

  const { configureBareRepo } = await import('../../src/routes/git')
  const bare = join(process.env.REPOS_DIR!, `${CO}.git`)
  git(['init', '-q', '--bare', '--initial-branch=main', bare])
  configureBareRepo(bare)
  const seed = join(workDir, 'seed')
  git(['init', '-q', '--initial-branch=main', seed])
  git(['config', 'user.name', 'seed'], seed)
  git(['config', 'user.email', 'seed@example.com'], seed)
  for (const d of [DEPT, OTHER_DEPT]) {
    mkdirSync(join(seed, d), { recursive: true })
    writeFileSync(join(seed, d, 'README.md'), 'x\n')
  }
  git(['add', '-A'], seed)
  git(['commit', '-q', '--no-verify', '-m', 'seed'], seed)
  git(['push', '-q', bare, 'HEAD:main'], seed)

  const cv = await import('../../src/lib/client-version')
  cv.setPrivateFoldersClientCutoffForTests('20260101000000')
  services = (await import('../../src/composition')).services
  app = (await import('../../src/app')).app
})

afterAll(() => {
  expect(outsiders.length).toBeGreaterThan(10)
  // Nobody who does not review the item learned the folder's name or a path the member sent.
  for (const text of outsiders) {
    expect(text).not.toContain(FOLDER_NAME)
    expect(text).not.toContain(ENTRY_DIR)
  }
  // No log line names the folder or an entry path.
  for (const line of printed) {
    expect(line).not.toContain(FOLDER_NAME)
    expect(line).not.toContain(ENTRY_DIR)
  }
  vi.restoreAllMocks()
  rmSync(workDir, { recursive: true, force: true })
})

describe('who reviews (I5)', () => {
  it('readers who are owner / admin or the department\'s manager; anyone else gets the 404 of nothing', async () => {
    const folder = await folderWith({ [`${ENTRY_DIR}/a.md`]: 'A\n' }, READERS)
    const itemId = await handOver(folder, AFTER, [{ path: `${ENTRY_DIR}/a.md`, kind: 'changed', content: 'A, more\n' }])
    for (const user of ['owner', 'admin', 'mgr']) {
      const list = await as(user, 'GET', H)
      expect(list.status).toBe(200)
      const mine = list.body.data.items.find((i: Loose) => i.itemId === itemId)
      expect(mine).toMatchObject({ folderPath: folder.path, folderGone: false, userId: 'u-v1', userName: '佐藤', cause: 'readers', state: 'waiting' })
      expect((await as(user, 'GET', `${H}/${itemId}`)).status).toBe(200)
    }
    // A manager of another department who reads the folder; a manager of 人事 who does not read it;
    // a plain reader; a member who reads nothing; the member who handed it over.
    const unknown = await outsider('mgrNR', 'GET', `${H}/00000000-0000-4000-8000-000000000000`)
    expect(unknown.status).toBe(404)
    for (const user of ['salesMgr', 'mgrNR', 'keeper', 'plain', 'v1']) {
      expect((await outsider(user, 'GET', H)).body.data.items.map((i: Loose) => i.itemId)).not.toContain(itemId)
      for (const [method, path, body] of [
        ['GET', `${H}/${itemId}`], ['GET', `${H}/${itemId}/files/0`], ['POST', `${H}/${itemId}/take`, { files: [0] }], ['POST', `${H}/${itemId}/discard`],
      ] as Array<[string, string, unknown?]>) {
        const r = await outsider(user, method, path, body)
        expect([r.status, r.body]).toEqual([unknown.status, unknown.body])
      }
    }
    expect(itemRow(itemId).state).toBe('waiting')
    expect(tipOf(folder.repo)).toBe(folder.base)
  })

  it('an item of a deleted folder: owners / admins only, download or discard; never taken in', async () => {
    const folder = await folderWith({ 'x.md': 'x\n' }, READERS)
    const itemId = await handOver(folder, AFTER, [{ path: `${ENTRY_DIR}/b.md`, kind: 'changed', content: 'B\n' }])
    const del = await as('owner', 'DELETE', `/api/companies/${CO}/private-folders/${folder.scopeId}?confirm=${encodeURIComponent(folder.name)}`)
    expect(del.status).toBe(200)
    expect((await outsider('mgr', 'GET', `${H}/${itemId}`)).status).toBe(404)
    const seen = await as('admin', 'GET', `${H}/${itemId}`)
    expect(seen.body.data).toMatchObject({ folderGone: true, folderPath: folder.path })
    expect(seen.body.data.files[0]).toMatchObject({ takeable: false, held: true })
    expect((await as('owner', 'GET', `${H}/${itemId}/files/0`)).text).toBe('B\n')
    const take = await as('owner', 'POST', `${H}/${itemId}/take`, { files: [0] })
    expect([take.status, take.body.code]).toEqual([409, 'FOLDER_GONE'])
    expect(itemRow(itemId).state).toBe('waiting')
    const gone = await as('owner', 'POST', `${H}/${itemId}/discard`)
    expect(gone.body.data).toEqual({ state: 'discarded' })
    expect(existsSync(join(HOLDING_ROOT, CO, itemId))).toBe(false)
    expect(history('holding-discarded', itemId)).toHaveLength(1)
  })
})

describe('taking in', () => {
  it('one commit: unchanged files replaced, changed ones alongside, deletions only of unchanged files', async () => {
    const folder = await folderWith({
      [`${ENTRY_DIR}/same.md`]: 'base\n', [`${ENTRY_DIR}/theirs.md`]: 'base\n', [`${ENTRY_DIR}/gone.md`]: 'base\n', [`${ENTRY_DIR}/kept.md`]: 'base\n',
    }, READERS)
    const itemId = await handOver(folder, AFTER, [
      { path: `${ENTRY_DIR}/same.md`, kind: 'changed', content: 'member\n' },
      { path: `${ENTRY_DIR}/theirs.md`, kind: 'changed', content: 'member\n' },
      { path: `${ENTRY_DIR}/new.md`, kind: 'changed', content: 'new\n' },
      { path: `${ENTRY_DIR}/gone.md`, kind: 'deleted' },
      { path: `${ENTRY_DIR}/kept.md`, kind: 'deleted' },
      { path: '.personal/memo.md', kind: 'personal', content: 'note\n' },
    ])
    // Someone changed two files after the member's base.
    commitTo(folder.repo, { [`${ENTRY_DIR}/theirs.md`]: 'keeper\n', [`${ENTRY_DIR}/kept.md`]: 'keeper\n' }, 'later')
    const detail = (await as('mgrEd', 'GET', `${H}/${itemId}`)).body.data
    expect(detail.files.map((f: Loose) => [f.idx, f.standing, f.takeable])).toEqual([
      [0, 'unchanged', true], [1, 'changed', true], [2, 'unchanged', true], [3, 'unchanged', true], [4, 'changed', true], [5, 'unchanged', false],
    ])
    const before = tipOf(folder.repo)
    const take = await as('mgrEd', 'POST', `${H}/${itemId}/take`, { files: [0, 1, 2, 3, 4] })
    expect(take.status).toBe(200)
    const day = new Date(Date.parse(itemRow(itemId).finished_at) + 9 * 3600_000).toISOString().slice(5, 10)
    const alongside = `${ENTRY_DIR}/theirs（佐藤さんの版 ${day}）.md`
    expect(take.body.data).toEqual({
      state: 'taken', commit: tipOf(folder.repo),
      placed: [
        { idx: 0, path: `${ENTRY_DIR}/same.md`, how: 'placed' },
        { idx: 1, path: alongside, how: 'alongside' },
        { idx: 2, path: `${ENTRY_DIR}/new.md`, how: 'placed' },
        { idx: 3, path: `${ENTRY_DIR}/gone.md`, how: 'deleted' },
      ],
      skipped: [{ idx: 4, reason: 'changed' }],
    })
    // Exactly one commit on top, with the line that marks it, the member's name and a count — nothing of the content.
    expect(git(['-C', folder.repo, 'rev-list', `${before}..refs/heads/main`]).trim().split('\n')).toHaveLength(1)
    const message = git(['-C', folder.repo, 'log', '-1', '--format=%B', 'refs/heads/main'])
    expect(message).toBe(`佐藤さんの預かりから取り込み（4件）\n\nACB-Holding-Item: ${itemId}\n\n`)
    expect(fileAt(folder.repo, `${ENTRY_DIR}/same.md`)).toBe('member\n')
    expect(fileAt(folder.repo, `${ENTRY_DIR}/theirs.md`)).toBe('keeper\n')
    expect(fileAt(folder.repo, alongside)).toBe('member\n')
    expect(fileAt(folder.repo, `${ENTRY_DIR}/gone.md`)).toBeNull()
    expect(fileAt(folder.repo, `${ENTRY_DIR}/kept.md`)).toBe('keeper\n')
    expect(filesAt(folder.repo).some(p => p.startsWith('.personal'))).toBe(false)
    expect(itemRow(itemId)).toMatchObject({ state: 'taken', decided_by: 'u-mgrEd', decision_commit: tipOf(folder.repo), blobs_deleted_at: expect.any(String) })
    expect(existsSync(join(HOLDING_ROOT, CO, itemId))).toBe(false)
    expect(history('holding-taken', itemId)).toHaveLength(1)
    // Decided once: again, or a discard, is told someone decided first.
    for (const [path, body] of [[`${H}/${itemId}/take`, { files: [0] }], [`${H}/${itemId}/discard`, undefined]] as const) {
      const again = await as('owner', 'POST', path, body)
      expect([again.status, again.body.code]).toEqual([409, 'ALREADY_DECIDED'])
    }
  })

  it('files go under the folders as the folder already spells them, never a second spelling (Codex P2)', async () => {
    const folder = await folderWith({ 'Reports/a.md': 'base\n' }, READERS)
    const itemId = await handOver(folder, AFTER, [
      { path: 'reports/new.md', kind: 'changed', content: 'new\n' },
      { path: 'reports/a.md', kind: 'changed', content: 'member\n' },
    ])
    commitTo(folder.repo, { 'Reports/a.md': 'keeper\n' }, 'later')
    const take = await as('owner', 'POST', `${H}/${itemId}/take`, { files: [0, 1] })
    expect(take.status).toBe(200)
    const day = new Date(Date.parse(itemRow(itemId).finished_at) + 9 * 3600_000).toISOString().slice(5, 10)
    expect(take.body.data.placed).toEqual([
      { idx: 0, path: 'Reports/new.md', how: 'placed' },
      { idx: 1, path: `Reports/a（佐藤さんの版 ${day}）.md`, how: 'alongside' },
    ])
    expect(filesAt(folder.repo).filter(p => p.toLowerCase().startsWith('reports/')).every(p => p.startsWith('Reports/'))).toBe(true)
  })

  it('a chosen file with no place now (a file where its folder was) refuses the take-in; nothing is dropped', async () => {
    const folder = await folderWith({ 'dir/x.md': 'base\n' }, READERS)
    const itemId = await handOver(folder, AFTER, [{ path: 'dir/x.md', kind: 'changed', content: 'member\n' }, { path: 'ok.md', kind: 'changed', content: 'ok\n' }])
    commitTo(folder.repo, { 'dir/x.md': null, dir: 'now a file\n' }, 'later')
    const before = tipOf(folder.repo)
    const take = await as('owner', 'POST', `${H}/${itemId}/take`, { files: [0, 1] })
    expect([take.status, take.body.code, take.body.files]).toEqual([409, 'PATH_TAKEN', [0]])
    expect(itemRow(itemId)).toMatchObject({ state: 'waiting', blobs_deleted_at: null })
    expect(tipOf(folder.repo)).toBe(before)
    expect((await as('owner', 'GET', `${H}/${itemId}/files/0`)).text).toBe('member\n')
  })

  it('overwrite replaces a file someone changed since, when chosen', async () => {
    const folder = await folderWith({ 'f.md': 'base\n' }, READERS)
    const itemId = await handOver(folder, AFTER, [{ path: 'f.md', kind: 'changed', content: 'member\n' }])
    commitTo(folder.repo, { 'f.md': 'keeper\n' }, 'later')
    const take = await as('owner', 'POST', `${H}/${itemId}/take`, { files: [0], whenChanged: 'overwrite' })
    expect(take.body.data.placed).toEqual([{ idx: 0, path: 'f.md', how: 'overwritten' }])
    expect(fileAt(folder.repo, 'f.md')).toBe('member\n')
  })

  it('本人のメモ and names only are never taken in; a body that is not valid changes nothing', async () => {
    const folder = await folderWith({ 'f.md': 'base\n' }, READERS)
    const itemId = await handOver(folder, AFTER, [
      { path: '.personal/memo.md', kind: 'personal', content: 'note\n' },
      { path: 'big.mov', kind: 'names-only' },
      { path: 'f.md', kind: 'changed', content: 'member\n' },
    ])
    for (const files of [[0], [1], [9]]) {
      const r = await as('owner', 'POST', `${H}/${itemId}/take`, { files })
      expect([r.status, r.body.code, r.body.files]).toEqual([400, 'NOT_TAKEABLE', files])
    }
    for (const body of [{}, { files: [] }, { files: ['0'] }, { files: [2], whenChanged: 'merge' }]) {
      expect((await as('owner', 'POST', `${H}/${itemId}/take`, body)).body.code).toBe('INVALID')
    }
    expect(itemRow(itemId).state).toBe('waiting')
    expect(tipOf(folder.repo)).toBe(folder.base)
    // 本人のメモ can still be downloaded.
    expect((await as('owner', 'GET', `${H}/${itemId}/files/0`)).text).toBe('note\n')
  })
})

describe('the push checker judges the take-in as the reviewer (I6)', () => {
  it('a manager who only views the folder is refused WRITE_DENIED; the item stays and nothing lands', async () => {
    const folder = await folderWith({ 'f.md': 'base\n' }, READERS)
    const itemId = await handOver(folder, AFTER, [{ path: 'f.md', kind: 'changed', content: 'member\n' }])
    const r = await as('mgr', 'POST', `${H}/${itemId}/take`, { files: [0] })
    expect(r.status).toBe(409)
    expect(r.body.code).toBe('TAKE_REFUSED')
    expect(r.body.refused).toEqual([{ marker: 'WRITE_DENIED', paths: ['f.md'] }])
    expect(r.body.error).toContain('このフォルダを変える権限がありません')
    expect(itemRow(itemId)).toMatchObject({ state: 'waiting', decided_by: null })
    expect(tipOf(folder.repo)).toBe(folder.base)
    // An editor manager takes it in.
    expect((await as('mgrEd', 'POST', `${H}/${itemId}/take`, { files: [0] })).status).toBe(200)
  })

  it('paths stored at upload are judged again: .personal, protected config for a manager, a secret in the held content', async () => {
    const folder = await folderWith({ 'f.md': 'base\n' }, READERS)
    const itemId = await handOver(folder, AFTER, [
      { path: '.personal/x.md', kind: 'changed', content: 'mine\n' },
      { path: '.mcp.json', kind: 'changed', content: '{}\n' },
      { path: 'clean.md', kind: 'changed', content: 'clean\n' },
    ])
    const personal = await as('mgrEd', 'POST', `${H}/${itemId}/take`, { files: [0] })
    expect(personal.body.refused.map((x: Loose) => x.marker)).toContain('PERSONAL_PATH')
    const config = await as('mgrEd', 'POST', `${H}/${itemId}/take`, { files: [1] })
    expect(config.body.refused.map((x: Loose) => x.marker)).toContain('PROTECTED_CONFIG')
    // A content changed on the server's disk after it was received (the upload scanned it): judged again now.
    const clean = sha(Buffer.from('clean\n'))
    writeFileSync(join(HOLDING_ROOT, CO, itemId, clean), 'AKIAIOSFODNN7EXAMPLE\n')
    const secret = await as('owner', 'POST', `${H}/${itemId}/take`, { files: [2] })
    expect(secret.body.refused.map((x: Loose) => x.marker)).toContain('SECRET_DETECTED')
    expect(itemRow(itemId).state).toBe('waiting')
    expect(tipOf(folder.repo)).toBe(folder.base)
    expect(commitsWithLine(folder.repo, itemId)).toEqual([])
  })
})

describe('once only, and stopping halfway (I6, checklist 7)', () => {
  it('who the reviewer is now is read again under the lock: an admin demoted while the take-in waited gets the 404', async () => {
    const folder = await folderWith({ 'f.md': 'base\n' }, READERS)
    const itemId = await handOver(folder, AFTER, [{ path: 'm.md', kind: 'changed', content: 'member\n' }])
    const { processCompanyLock } = await import('../../src/adapters/system')
    let take: Promise<Loose> | null = null
    await processCompanyLock.run(CO, async () => {
      take = outsider('admin', 'POST', `${H}/${itemId}/take`, { files: [0] })
      await new Promise(resolve => setTimeout(resolve, 200))
      db.prepare(`UPDATE memberships SET role = 'member' WHERE company_id = ? AND user_id = 'u-admin'`).run(CO)
    })
    try {
      const r = await take!
      expect([r.status, r.body]).toEqual([404, { error: 'Not found' }])
      expect(itemRow(itemId).state).toBe('waiting')
      expect(tipOf(folder.repo)).toBe(folder.base)
    } finally {
      db.prepare(`UPDATE memberships SET role = 'admin' WHERE company_id = ? AND user_id = 'u-admin'`).run(CO)
    }
  })

  it('two take-ins at once: one commit, the other is told someone decided first', async () => {
    const folder = await folderWith({ 'f.md': 'base\n' }, READERS)
    const itemId = await handOver(folder, AFTER, [{ path: 'g.md', kind: 'changed', content: 'member\n' }])
    const [a, b] = await Promise.all([
      as('owner', 'POST', `${H}/${itemId}/take`, { files: [0] }),
      as('mgrEd', 'POST', `${H}/${itemId}/take`, { files: [0] }),
    ])
    expect([a.status, b.status].sort()).toEqual([200, 409])
    expect([a, b].find(r => r.status === 409)!.body.code).toBe('ALREADY_DECIDED')
    expect(commitsWithLine(folder.repo, itemId)).toHaveLength(1)
  })

  it('a take-in racing a discard: whichever comes first decides; nothing is half done', async () => {
    const folder = await folderWith({ 'f.md': 'base\n' }, READERS)
    const itemId = await handOver(folder, AFTER, [{ path: 'h.md', kind: 'changed', content: 'member\n' }])
    const [take, discard] = await Promise.all([
      as('owner', 'POST', `${H}/${itemId}/take`, { files: [0] }),
      as('admin', 'POST', `${H}/${itemId}/discard`),
    ])
    expect([take.status, discard.status].sort()).toEqual([200, 409])
    const row = itemRow(itemId)
    if (take.status === 200) {
      expect(row.state).toBe('taken')
      expect(commitsWithLine(folder.repo, itemId)).toHaveLength(1)
    } else {
      expect(row.state).toBe('discarded')
      expect(commitsWithLine(folder.repo, itemId)).toHaveLength(0)
    }
  })

  it('an item being taken in is never expired by the clock; one past its 30 days is not taken in', async () => {
    const folder = await folderWith({ 'f.md': 'base\n' }, READERS)
    const itemId = await handOver(folder, AFTER, [{ path: 'i.md', kind: 'changed', content: 'member\n' }])
    const old = new Date(Date.now() - 31 * DAY).toISOString()
    db.prepare(`UPDATE holding_items SET finished_at = ?, state = 'taking', decided_by = 'u-owner' WHERE id = ?`).run(old, itemId)
    await services.privateHolding.sweep(CO)
    expect(itemRow(itemId).state).toBe('taking')
    expect(existsSync(join(HOLDING_ROOT, CO, itemId))).toBe(true)
    // Settled (no commit carries it: waiting again), then it is past its 30 days.
    const take = await as('owner', 'POST', `${H}/${itemId}/take`, { files: [0] })
    expect([take.status, take.body.code]).toEqual([410, 'EXPIRED'])
    expect(itemRow(itemId).state).toBe('waiting')
    await services.serverClock.runOnce()
    expect(itemRow(itemId).state).toBe('expired')
  })

  it('a take-in that stopped after its commit landed is settled as taken by the folder\'s history, never taken twice', async () => {
    const folder = await folderWith({ 'f.md': 'base\n' }, READERS)
    const itemId = await handOver(folder, AFTER, [{ path: 'j.md', kind: 'changed', content: 'member\n' }])
    const take = await as('owner', 'POST', `${H}/${itemId}/take`, { files: [0] })
    expect(take.status).toBe(200)
    // As if the process stopped after the push, before the item was marked.
    db.prepare(`UPDATE holding_items SET state = 'taking', decision_commit = NULL WHERE id = ?`).run(itemId)
    const again = await as('owner', 'POST', `${H}/${itemId}/take`, { files: [0] })
    expect([again.status, again.body.code]).toEqual([409, 'ALREADY_DECIDED'])
    expect(itemRow(itemId)).toMatchObject({ state: 'taken', decision_commit: take.body.data.commit })
    expect(commitsWithLine(folder.repo, itemId)).toHaveLength(1)
  })

  it('a take-in whose folder history cannot be read stays being taken in — never given back to be taken twice (Codex P2)', async () => {
    const folder = await folderWith({ 'f.md': 'base\n' }, READERS)
    const itemId = await handOver(folder, AFTER, [{ path: 'l.md', kind: 'backup', content: 'member\n' }])
    const take = await as('owner', 'POST', `${H}/${itemId}/take`, { files: [0] })
    expect(take.status).toBe(200)
    db.prepare(`UPDATE holding_items SET state = 'taking', decision_commit = NULL WHERE id = ?`).run(itemId)
    // The repository cannot be read for a moment.
    renameSync(folder.repo, `${folder.repo}.away`)
    try {
      const again = await as('owner', 'POST', `${H}/${itemId}/take`, { files: [0] })
      expect([again.status, again.body.code]).toEqual([503, 'BUSY'])
      await services.serverClock.runOnce()
      expect(itemRow(itemId).state).toBe('taking')
    } finally {
      renameSync(`${folder.repo}.away`, folder.repo)
    }
    const discard = await as('owner', 'POST', `${H}/${itemId}/discard`)
    expect([discard.status, discard.body.code]).toEqual([409, 'ALREADY_DECIDED'])
    expect(itemRow(itemId)).toMatchObject({ state: 'taken', decision_commit: take.body.data.commit })
    expect(commitsWithLine(folder.repo, itemId)).toHaveLength(1)
  })

  it('a take-in that stopped before its commit: the clock gives the item back to the reviewers', async () => {
    const folder = await folderWith({ 'f.md': 'base\n' }, READERS)
    const itemId = await handOver(folder, AFTER, [{ path: 'k.md', kind: 'changed', content: 'member\n' }])
    db.prepare(`UPDATE holding_items SET state = 'taking', decided_by = 'u-owner' WHERE id = ?`).run(itemId)
    await services.serverClock.runOnce()
    expect(itemRow(itemId)).toMatchObject({ state: 'waiting', decided_by: null })
    expect((await as('owner', 'POST', `${H}/${itemId}/take`, { files: [0] })).status).toBe(200)
    expect(fileAt(folder.repo, 'k.md')).toBe('member\n')
  })
})

describe('looking at an item', () => {
  it('each entry as held, as the base had it, as the folder has it now; always a download', async () => {
    const folder = await folderWith({ 'f.md': 'base\n' }, READERS)
    const itemId = await handOver(folder, AFTER, [{ path: 'f.md', kind: 'changed', content: 'member\n' }])
    commitTo(folder.repo, { 'f.md': 'keeper\n' }, 'later')
    const held = await as('mgr', 'GET', `${H}/${itemId}/files/0`)
    expect(held.text).toBe('member\n')
    expect(held.headers.get('content-type')).toBe('application/octet-stream')
    expect(held.headers.get('content-disposition')).toContain('attachment')
    expect(held.headers.get('x-content-type-options')).toBe('nosniff')
    expect((await as('mgr', 'GET', `${H}/${itemId}/files/0?version=base`)).text).toBe('base\n')
    expect((await as('mgr', 'GET', `${H}/${itemId}/files/0?version=current`)).text).toBe('keeper\n')
    expect((await as('mgr', 'GET', `${H}/${itemId}/files/7`)).status).toBe(404)
    expect(history('holding-downloaded', itemId)).toHaveLength(1)
  })

  it('the admin home counts the items each reviewer may decide, and those the clock discards within 7 days', async () => {
    const home = async (u: string) => (await as(u, 'GET', `/api/companies/${CO}/home`)).body.data.attention.holding
    const visible = (await as('owner', 'GET', H)).body.data.items as Loose[]
    const before = await home('owner')
    expect(before.waiting).toBe(visible.length)
    const folder = await folderWith({ 'f.md': 'base\n' }, READERS)
    const itemId = await handOver(folder, AFTER, [{ path: 'z.md', kind: 'changed', content: 'z\n' }])
    db.prepare(`UPDATE holding_items SET finished_at = ? WHERE id = ?`).run(new Date(Date.now() - 25 * DAY).toISOString(), itemId)
    const after = await home('owner')
    expect(after).toEqual({ waiting: before.waiting + 1, expiringSoon: before.expiringSoon + 1 })
    // A manager of another department reviews none of these.
    expect(await home('salesMgr')).toEqual({ waiting: 0, expiringSoon: 0 })
  })
})
