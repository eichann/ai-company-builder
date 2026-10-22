/**
 * Integration Test: read-only company files for the chat AI (permission plan
 * §11) — GET /api/companies/:companyId/files/{tree,content,search}.
 *
 * Real bare repositories (the company's and a private folder's scope
 * repository) and real git; the JSON API through app.request with a mocked
 * session.
 *
 * - membership required; READ enforced on every path;
 * - a private folder the member cannot read answers exactly like a path that
 *   does not exist (tree, content, search, and no trace in any listing);
 * - readers get it from its own repository, with its commit;
 * - NFC / case-insensitive paths; binary refusal; byte cap and line ranges;
 * - search limits (matches, per file, time), regex errors, concurrency;
 * - a few thousand files stay fast.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'

const currentUser = vi.hoisted(() => ({ id: 'u-owner' as string | null }))

vi.mock('../../src/lib/auth', () => ({
  getUserFromRequest: vi.fn().mockImplementation(async () =>
    currentUser.id
      ? { id: currentUser.id, email: `${currentUser.id}@example.com`, name: currentUser.id, image: null, emailVerified: true }
      : null),
  getUsersByIds: vi.fn().mockReturnValue(new Map()),
  auth: {
    handler: vi.fn().mockResolvedValue(new Response('', { status: 200 })),
    api: { getSession: vi.fn().mockResolvedValue(null) },
  },
}))

import { Hono } from 'hono'
import { db, initDatabase } from '../../src/db'
import { companyFilesRoute } from '../../src/routes/company-files'
import { ensureCompanyScope } from '../../src/lib/permission-store'
import { createPrivateFolder, privateRepoPath } from '../../src/lib/private-folders'
import { buildView, parseRequestPath, searchFiles, withSearchSlot, CompanyFilesError } from '../../src/lib/company-files'

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 })

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any

const app = new Hono()
app.route('/api/companies/:companyId/files', companyFilesRoute)

const CO = 'cf-co'
const BIG = 'cf-big'
const REPOS_DIR = process.env.REPOS_DIR as string
const ts = () => new Date().toISOString()
let work: string
let gitEnv: NodeJS.ProcessEnv
const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, env: gitEnv, stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 }).toString()

const NFD_NAME = '第1回の教材.md'.normalize('NFD')

function writeTree(root: string, files: Record<string, string | Buffer>) {
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
  }
}

/** Commit `files` on top of `bare`'s main (or as its first commit) without running its hooks. */
function commitInto(bare: string, files: Record<string, string | Buffer>, name: string) {
  const dir = join(work, name)
  const hasMain = (() => { try { git(bare, ['rev-parse', '--verify', '--quiet', 'refs/heads/main']); return true } catch { return false } })()
  if (hasMain) git(work, ['clone', '-q', bare, dir])
  else git(work, ['init', '-q', '-b', 'main', dir])
  writeTree(dir, files)
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', name])
  // fetch into the bare repository: no receive hooks (the content is the test's, not a member's push)
  git(bare, ['fetch', '-q', dir, 'main:refs/heads/main'])
}

async function get(user: string | null, company: string, route: string, query: Record<string, string> = {}) {
  currentUser.id = user
  const qs = new URLSearchParams(query).toString()
  const res = await app.request(`/api/companies/${company}/files/${route}${qs ? `?${qs}` : ''}`)
  const text = await res.text()
  let body: Loose = null
  try { body = JSON.parse(text) } catch { /* not json */ }
  return { status: res.status, body }
}

let hrCommit: string
let execCommit: string

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'acb-company-files-'))
  gitEnv = {
    ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(work, 'gitconfig'),
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e',
  }
  for (const k of Object.keys(gitEnv)) if (k.startsWith('ACB_')) delete gitEnv[k]
  writeFileSync(gitEnv.GIT_CONFIG_GLOBAL as string, '')

  initDatabase()
  for (const co of [CO, BIG]) {
    db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(co, co, co, 'u-owner', ts(), ts())
    for (const [id, role] of [['owner', 'owner'], ['viewer', 'member'], ['other', 'member']]) {
      db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${co}-${id}`, `u-${id}`, co, role, ts(), ts())
    }
    ensureCompanyScope(db, co)
  }

  const bare = join(REPOS_DIR, `${CO}.git`)
  git(work, ['init', '-q', '--bare', '-b', 'main', bare])
  const bigText = Array.from({ length: 30_000 }, (_, i) => `line ${i + 1} ${'x'.repeat(70)}`).join('\n') + '\n'
  commitInto(bare, {
    'README.md': 'hello world\n共通キーワード in readme\n',
    [`コンテンツ/カリキュラム/${NFD_NAME}`]: '第1回: 共通キーワード\n二行目\n',
    'コンテンツ/カリキュラム/第2回.md': '第2回: 共通キーワード\n',
    '営業部/提案書.md': '提案: 共通キーワード\n',
    '人事/README.md': '人事の共有資料\n',
    'Upper/Case.md': 'Mixed Case Content\n',
    'many.md': Array.from({ length: 60 }, (_, i) => `hit ${i}`).join('\n') + '\n',
    'assets/logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0x0d]),
    'notes/binary.txt': Buffer.concat([Buffer.from('looks like text'), Buffer.from([0, 1, 2]), Buffer.from(' 共通キーワード')]),
    'big.txt': bigText,
    'noeol.txt': 'one\ntwo\nthree',
    // A long line where a backtracking engine (JavaScript's) explodes on
    // (x+x+)+y before reaching the real match at the end.
    'redos.txt': `${'x'.repeat(40)}z ${'あ'.repeat(400)} xxy\n`,
  }, 'seed')

  // Two private folders: one inside an existing department, one whose parent
  // exists only because of it. Only `viewer` (and the owner) may read them.
  const hr = await createPrivateFolder(db, { companyId: CO, path: '人事/評価', rules: { viewers: ['u-viewer'], editors: [] }, createdBy: 'u-owner' })
  commitInto(privateRepoPath(CO, hr.repoId), { '査定.md': '査定: 共通キーワード 給与テーブル\n', 'sub/面談メモ.md': '面談\n' }, 'hr-private')
  hrCommit = git(privateRepoPath(CO, hr.repoId), ['rev-parse', 'refs/heads/main']).trim()
  const ex = await createPrivateFolder(db, { companyId: CO, path: '役員/会議', rules: { viewers: ['u-viewer'], editors: [] }, createdBy: 'u-owner' })
  commitInto(privateRepoPath(CO, ex.repoId), { '議事録.md': '役員会: 共通キーワード\n' }, 'exec-private')
  execCommit = git(privateRepoPath(CO, ex.repoId), ['rev-parse', 'refs/heads/main']).trim()

  // A larger company for the performance sanity check.
  const bigBare = join(REPOS_DIR, `${BIG}.git`)
  git(work, ['init', '-q', '--bare', '-b', 'main', bigBare])
  const files: Record<string, string> = {}
  for (let d = 0; d < 50; d++) {
    for (let f = 0; f < 100; f++) files[`部署${d}/フォルダ${f % 10}/資料${f}.md`] = `# 資料 ${d}-${f}\n本文 ${d * 100 + f}\n${f === 42 ? 'ユニークな語句\n' : ''}`
  }
  commitInto(bigBare, files, 'big-seed')
}, 120_000)

afterAll(() => {
  rmSync(work, { recursive: true, force: true })
})

const names = (body: Loose) => (body.data.entries as Loose[]).map(e => e.path)

describe('access', () => {
  it('needs a session and membership', async () => {
    expect((await get(null, CO, 'tree')).status).toBe(401)
    expect((await get('u-stranger', CO, 'tree')).status).toBe(404)
    expect((await get('u-stranger', CO, 'search', { q: 'hello' })).status).toBe(404)
  })

  it('rejects paths that escape the repository', async () => {
    for (const path of ['../x', 'a/../../b', 'a\\b', 'a/./b']) {
      const r = await get('u-other', CO, 'tree', { path })
      expect(r.status).toBe(400)
      expect(r.body.code).toBe('INVALID_PATH')
    }
    expect(parseRequestPath('/コンテンツ//x/')).toEqual(['コンテンツ', 'x'])
    expect(parseRequestPath('a/../b')).toBeNull()
  })
})

describe('tree', () => {
  it('lists a folder with the commit of main; folders and files with sizes', async () => {
    const r = await get('u-other', CO, 'tree')
    expect(r.status).toBe(200)
    expect(r.body.data.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(r.body.data.path).toBe('')
    const readme = r.body.data.entries.find((e: Loose) => e.path === 'README.md')
    expect(readme).toMatchObject({ name: 'README.md', type: 'file', size: Buffer.byteLength('hello world\n共通キーワード in readme\n') })
    expect(r.body.data.entries.find((e: Loose) => e.path === 'コンテンツ')).toMatchObject({ type: 'folder' })
  })

  it('a non-reader sees no trace of private folders, at any depth', async () => {
    const root = await get('u-other', CO, 'tree', { depth: '10' })
    expect(root.status).toBe(200)
    const all = names(root.body)
    expect(all.some(p => p.includes('評価') || p.includes('役員') || p.includes('査定') || p.includes('会議'))).toBe(false)
    expect(all).toContain('人事/README.md')
    expect(JSON.stringify(root.body)).not.toMatch(/評価|役員|査定|会議/)
  })

  it('a reader sees them (marked private) and their contents', async () => {
    const hr = await get('u-viewer', CO, 'tree', { path: '人事' })
    expect(hr.body.data.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '人事/評価', type: 'folder', private: true }),
      expect.objectContaining({ path: '人事/README.md', type: 'file' }),
    ]))
    const inside = await get('u-viewer', CO, 'tree', { path: '人事/評価', depth: '2' })
    expect([...names(inside.body)].sort()).toEqual(['人事/評価/.gitignore', '人事/評価/sub', '人事/評価/sub/面談メモ.md', '人事/評価/査定.md'].sort())
    expect(inside.body.data.privateFolder).toEqual({ path: '人事/評価', commit: hrCommit })
    // the parent that exists only because of the private folder
    const exec = await get('u-viewer', CO, 'tree', { path: '役員' })
    expect(exec.status).toBe(200)
    expect(exec.body.data.entries).toEqual([expect.objectContaining({ path: '役員/会議', private: true })])
    const owner = await get('u-owner', CO, 'tree', { path: '役員/会議' })
    expect(owner.body.data.privateFolder).toEqual({ path: '役員/会議', commit: execCommit })
  })

  it('an unreadable private folder answers exactly like a path that never existed', async () => {
    const missing = await get('u-other', CO, 'tree', { path: '人事/存在しない' })
    expect(missing.status).toBe(404)
    for (const path of ['人事/評価', '人事/評価/sub', '人事/評価/査定.md', '役員', '役員/会議', '人事/評価'.normalize('NFD')]) {
      const r = await get('u-other', CO, 'tree', { path })
      expect(r.status).toBe(404)
      expect(r.body).toEqual(missing.body)
    }
  })

  it('a file is not a folder', async () => {
    const r = await get('u-other', CO, 'tree', { path: 'README.md' })
    expect(r.status).toBe(400)
    expect(r.body.code).toBe('NOT_A_FOLDER')
  })
})

describe('content', () => {
  it('reads a text file with line numbers and the whole-file facts', async () => {
    const r = await get('u-other', CO, 'content', { path: 'README.md' })
    expect(r.status).toBe(200)
    expect(r.body.data).toMatchObject({ path: 'README.md', startLine: 1, endLine: 2, totalLines: 2, hasMore: false, truncated: false, content: 'hello world\n共通キーワード in readme' })
    const tree = await get('u-other', CO, 'tree')
    expect(r.body.data.commit).toBe(tree.body.data.commit)
    const noeol = await get('u-other', CO, 'content', { path: 'noeol.txt', offset: '3' })
    expect(noeol.body.data).toMatchObject({ startLine: 3, endLine: 3, totalLines: 3, content: 'three', hasMore: false })
  })

  it('matches names in NFC and A–Z folded, answering with the stored spelling', async () => {
    const nfc = await get('u-other', CO, 'content', { path: `コンテンツ/カリキュラム/${NFD_NAME.normalize('NFC')}` })
    expect(nfc.status).toBe(200)
    expect(nfc.body.data.path).toBe(`コンテンツ/カリキュラム/${NFD_NAME}`)
    expect(nfc.body.data.content).toBe('第1回: 共通キーワード\n二行目')
    const folded = await get('u-other', CO, 'content', { path: 'upper/CASE.md' })
    expect(folded.body.data).toMatchObject({ path: 'Upper/Case.md', content: 'Mixed Case Content' })
  })

  it('refuses binaries (by name and by content)', async () => {
    for (const path of ['assets/logo.png', 'notes/binary.txt']) {
      const r = await get('u-other', CO, 'content', { path })
      expect(r.status).toBe(415)
      expect(r.body.code).toBe('BINARY_FILE')
    }
  })

  it('caps the bytes returned and pages by lines', async () => {
    const r = await get('u-other', CO, 'content', { path: 'big.txt', limit: '20000' })
    expect(r.status).toBe(200)
    const d = r.body.data
    expect(Buffer.byteLength(d.content)).toBeLessThanOrEqual(1024 * 1024)
    expect(d.size).toBeGreaterThan(1024 * 1024)
    expect(d).toMatchObject({ startLine: 1, truncated: true, hasMore: true })
    expect(d.nextOffset).toBe(d.endLine + 1)
    expect(d.totalLines).toBeUndefined()
    const page = await get('u-other', CO, 'content', { path: 'big.txt', offset: '10', limit: '3' })
    expect(page.body.data).toMatchObject({ startLine: 10, endLine: 12, hasMore: true, nextOffset: 13, truncated: false })
    expect(page.body.data.content.split('\n').map((l: string) => l.split(' ').slice(0, 2).join(' '))).toEqual(['line 10', 'line 11', 'line 12'])
    const tail = await get('u-other', CO, 'content', { path: 'big.txt', offset: '29999' })
    expect(tail.body.data).toMatchObject({ startLine: 29999, endLine: 30000, totalLines: 30000, hasMore: false })
    const small = await get('u-other', CO, 'content', { path: 'big.txt', maxBytes: '100' })
    expect(Buffer.byteLength(small.body.data.content)).toBeLessThanOrEqual(100)
    expect(small.body.data.truncated).toBe(true)
  })

  it('a folder is not a file', async () => {
    const r = await get('u-other', CO, 'content', { path: 'コンテンツ' })
    expect(r.status).toBe(400)
    expect(r.body.code).toBe('IS_A_FOLDER')
  })

  it('private content: readers get it with the folder\'s commit; others get the not-found answer', async () => {
    const r = await get('u-viewer', CO, 'content', { path: '人事/評価/査定.md' })
    expect(r.status).toBe(200)
    expect(r.body.data).toMatchObject({ commit: hrCommit, privateFolder: '人事/評価', content: '査定: 共通キーワード 給与テーブル' })
    const missing = await get('u-other', CO, 'content', { path: '人事/存在しない.md' })
    const hidden = await get('u-other', CO, 'content', { path: '人事/評価/査定.md' })
    expect(hidden.status).toBe(404)
    expect(hidden.body).toEqual(missing.body)
  })
})

describe('search', () => {
  it('finds lines with path, line number and text; skips binaries', async () => {
    const r = await get('u-other', CO, 'search', { q: '共通キーワード' })
    expect(r.status).toBe(200)
    const d = r.body.data
    const paths = d.matches.map((m: Loose) => m.path).sort()
    expect(paths).toEqual(['README.md', `コンテンツ/カリキュラム/${NFD_NAME}`, 'コンテンツ/カリキュラム/第2回.md', '営業部/提案書.md'].sort())
    expect(d.matches.find((m: Loose) => m.path === 'README.md')).toEqual({ path: 'README.md', line: 2, text: '共通キーワード in readme' })
    expect(d).toMatchObject({ truncated: false, timedOut: false, files: 4 })
    expect(d.privateFolders).toBeUndefined()
  })

  it('a reader also finds private matches; a non-reader finds nothing of them, even inside them', async () => {
    const r = await get('u-viewer', CO, 'search', { q: '共通キーワード', includePrivate: 'true' })
    const paths = r.body.data.matches.map((m: Loose) => m.path)
    expect(paths).toEqual(expect.arrayContaining(['人事/評価/査定.md', '役員/会議/議事録.md']))
    expect(r.body.data.privateFolders).toEqual({ '人事/評価': hrCommit, '役員/会議': execCommit })

    const other = await get('u-other', CO, 'search', { q: '給与' })
    expect(other.body.data.matches).toEqual([])
    expect(JSON.stringify(other.body)).not.toMatch(/評価|役員/)
    const missing = await get('u-other', CO, 'search', { q: '給与', path: '人事/存在しない' })
    for (const path of ['人事/評価', '役員', '人事/評価/査定.md']) {
      const hidden = await get('u-other', CO, 'search', { q: '給与', path })
      expect(hidden.status).toBe(404)
      expect(hidden.body).toEqual(missing.body)
    }
    const scoped = await get('u-viewer', CO, 'search', { q: '給与', path: '人事', includePrivate: 'true' })
    expect(scoped.body.data.matches).toEqual([{ path: '人事/評価/査定.md', line: 1, text: '査定: 共通キーワード 給与テーブル' }])
  })

  it('leaves private folders out unless includePrivate is set — for owners too; a path inside one is explicit', async () => {
    for (const user of ['u-owner', 'u-viewer']) {
      const plain = await get(user, CO, 'search', { q: '共通キーワード' })
      expect(plain.status).toBe(200)
      expect(plain.body.data.privateFolders).toBeUndefined()
      expect(plain.body.data.matches.map((m: Loose) => m.path).filter((p: string) => p.startsWith('人事/評価') || p.startsWith('役員/会議'))).toEqual([])
      const opted = await get(user, CO, 'search', { q: '共通キーワード', includePrivate: 'true' })
      expect(opted.body.data.privateFolders).toEqual({ '人事/評価': hrCommit, '役員/会議': execCommit })
      const below = await get(user, CO, 'search', { q: '給与', path: '人事' })
      expect(below.body.data.matches).toEqual([])
      const inside = await get(user, CO, 'search', { q: '給与', path: '人事/評価' })
      expect(inside.body.data.matches).toEqual([{ path: '人事/評価/査定.md', line: 1, text: '査定: 共通キーワード 給与テーブル' }])
      expect(inside.body.data.privateFolders).toEqual({ '人事/評価': hrCommit })
    }
    expect((await get('u-owner', CO, 'search', { q: 'x', includePrivate: 'maybe' })).status).toBe(400)
  })

  it('a path limits the search; case-insensitive by default, sensitive on request; regex', async () => {
    const scoped = await get('u-other', CO, 'search', { q: '共通キーワード', path: 'コンテンツ' })
    expect(scoped.body.data.matches).toHaveLength(2)
    expect(scoped.body.data.path).toBe('コンテンツ')
    expect((await get('u-other', CO, 'search', { q: 'mixed case' })).body.data.matches).toHaveLength(1)
    expect((await get('u-other', CO, 'search', { q: 'mixed case', caseSensitive: 'true' })).body.data.matches).toHaveLength(0)
    const re = await get('u-other', CO, 'search', { q: '第[0-9]回:', regex: 'true' })
    expect(re.body.data.matches).toHaveLength(2)
    // `.` is one character, not one byte
    expect((await get('u-other', CO, 'search', { q: '^第.回:', regex: 'true' })).body.data.matches).toHaveLength(2)
    const bad = await get('u-other', CO, 'search', { q: 'a(', regex: 'true' })
    expect(bad.status).toBe(400)
    expect(bad.body.code).toBe('INVALID_QUERY')
    expect((await get('u-other', CO, 'search', { q: '' })).status).toBe(400)
    expect((await get('u-other', CO, 'search', { q: 'x'.repeat(501) })).status).toBe(400)
  })

  it('never runs the member\'s regular expression in the server process (ReDoS)', async () => {
    let ticks = 0
    const timer = setInterval(() => { ticks++ }, 10)
    const started = Date.now()
    try {
      const r = await get('u-other', CO, 'search', { q: '(x+x+)+y', regex: 'true', path: 'redos.txt' })
      expect(r.status).toBe(200)
      expect(r.body.data.matches).toHaveLength(1)
      // The snippet is cut around git's match position (byte column → characters).
      const text: string = r.body.data.matches[0].text
      expect(text.startsWith('…')).toBe(true)
      expect(text.endsWith('xxy')).toBe(true)
    } finally {
      clearInterval(timer)
    }
    expect(Date.now() - started).toBeLessThan(5_000)
    // The event loop kept running meanwhile.
    expect(ticks).toBeGreaterThan(0)
  })

  it('bounds matches (total and per file) and reports truncation', async () => {
    const r = await get('u-other', CO, 'search', { q: 'hit', path: 'many.md', limit: '200' })
    expect(r.body.data.matches).toHaveLength(20) // per-file cap
    const limited = await get('u-other', CO, 'search', { q: 'line', path: 'big.txt', limit: '5' })
    expect(limited.body.data.matches).toHaveLength(5)
    expect(limited.body.data.truncated).toBe(true)
  })

  it('stops at the time limit and says so', async () => {
    const view = await buildView(db, CO, 'u-other', 'member')
    const r = await searchFiles(view, [], { query: 'line', regex: false, caseSensitive: false, limit: 200, timeoutMs: 1 })
    expect(r.timedOut).toBe(true)
  })

  it('runs at most two searches per company at a time and refuses beyond a short queue', async () => {
    const release: Array<() => void> = []
    const hold = () => new Promise<void>(resolve => release.push(resolve))
    const running = [withSearchSlot('cf-slots', hold), withSearchSlot('cf-slots', hold)]
    const queued = [1, 2, 3, 4].map(() => withSearchSlot('cf-slots', async () => 'ran'))
    await expect(withSearchSlot('cf-slots', async () => 'x')).rejects.toMatchObject({ code: 'BUSY' })
    expect(release).toHaveLength(2)
    release.forEach(r => r())
    await Promise.all(running)
    expect(await Promise.all(queued)).toEqual(['ran', 'ran', 'ran', 'ran'])
    expect(new CompanyFilesError('BUSY', 429, 'x').status).toBe(429)
  })
})

describe('a larger repository', () => {
  it('lists, reads and searches 5,000 files quickly', async () => {
    const t0 = Date.now()
    const tree = await get('u-other', BIG, 'tree', { depth: '10' })
    expect(tree.status).toBe(200)
    expect(tree.body.data.truncated).toBe(true)
    expect(tree.body.data.entries).toHaveLength(2000)
    const search = await get('u-other', BIG, 'search', { q: 'ユニークな語句' })
    expect(search.body.data.matches).toHaveLength(50)
    expect(search.body.data.truncated).toBe(true)
    const scoped = await get('u-other', BIG, 'search', { q: 'ユニークな語句', path: '部署7' })
    expect(scoped.body.data.matches).toEqual([{ path: '部署7/フォルダ2/資料42.md', line: 3, text: 'ユニークな語句' }])
    const read = await get('u-other', BIG, 'content', { path: '部署49/フォルダ9/資料99.md' })
    expect(read.body.data.content).toBe('# 資料 49-99\n本文 4999')
    expect(Date.now() - t0).toBeLessThan(15_000)
  })
})
