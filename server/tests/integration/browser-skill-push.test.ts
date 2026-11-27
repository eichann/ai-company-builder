/**
 * Integration Test: whose change a company Skill's `browser.yaml` is (agent-browser.md "A Skill's browser declaration and
 * its approval"; owner decisions 2026-11-25). Real HTTP (git-http on a loopback port), real git http-backend, the real
 * push checker writing the ref updates it accepted, the real git / shelf source and the real service of the composition.
 *
 * Guards: an owner's push of a declaration counts as approved (who is kept) — the role is the one git-http
 * authenticated, never anything in the push; a skill editor's push waits; a push the checker refused writes nothing and
 * changes nothing; a text-only push keeps the frames and asks for the card once; the server reads its own repository at
 * the pushed commit; a company without the shared folder: the shelf's publisher decides the same way. The site is fictional.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { execFileSync, spawn, spawnSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import type { AddressInfo } from 'net'

vi.mock('../../src/lib/auth', () => ({
  getUserFromRequest: vi.fn().mockResolvedValue(null),
  getUsersByIds: vi.fn().mockReturnValue(new Map()),
  auth: {
    handler: vi.fn().mockResolvedValue(new Response('', { status: 200 })),
    api: { getSession: vi.fn().mockResolvedValue(null) },
  },
}))

import { configureBareRepo } from '../../src/routes/git'
import { makeTempDir } from '../../shared/testing/temp-dirs'

// Every real push starts the checker (node + tsx): seconds each on a loaded machine.
vi.setConfig({ testTimeout: 300_000, hookTimeout: 120_000 })

const CO = 'bsk-co'
const SHELF_CO = 'bsk-shelf'
const DOMAIN = 'shop.example.test'
const SKILL = 'order-copy'
const PATH = `.claude/skills/${SKILL}`

let workDir: string
let origin: string
let server: { close: () => void }
let clone: string
type Services = typeof import('../../src/composition').services
let services: Services
let db: import('better-sqlite3').Database

const owner = { companyId: CO, userId: 'u-owner', role: 'owner' }
const editor = { companyId: CO, userId: 'u-editor', role: 'member' }
const shelfOwner = { companyId: SHELF_CO, userId: 'u-owner', role: 'owner' }
const shelfEditor = { companyId: SHELF_CO, userId: 'u-editor', role: 'member' }

const yaml = (max: number) => `domain: ${DOMAIN}\nwrites:\n  - { method: POST, path: /api/orders/register, max: ${max} }\n`

function git(args: string[], cwd?: string): string {
  return execFileSync('git', args, { stdio: 'pipe', ...(cwd ? { cwd } : {}) }).toString()
}
function write(rel: string, content: string) {
  const full = join(clone, rel)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content)
}
function commit() {
  git(['add', '-A'], clone)
  git(['commit', '-q', '--no-verify', '-m', 'change'], clone)
}

/** Push the clone's HEAD as `token`'s account through git-http (async: the server runs in this process). */
function pushAs(token: string): Promise<{ ok: boolean; output: string }> {
  const url = `${origin.replace('http://', `http://git:${token}@`)}/api/git-http/${CO}.git`
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  for (const k of Object.keys(env)) if (k.startsWith('ACB_')) delete env[k]
  return new Promise((resolve) => {
    const p = spawn('git', ['push', url, 'HEAD:main'], { cwd: clone, env })
    let output = ''
    p.stdout.on('data', (d: Buffer) => { output += d.toString() })
    p.stderr.on('data', (d: Buffer) => { output += d.toString() })
    p.on('close', (code) => resolve({ ok: code === 0, output }))
  })
}

/** Wait until `check` holds (the after-push step runs off the request). */
async function until(check: () => Promise<boolean> | boolean, what: string) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return
    await new Promise(r => setTimeout(r, 50))
  }
  throw new Error(`timed out: ${what}`)
}
const latestRow = (companyId: string) => {
  return db.prepare('SELECT approved_by, how, mode FROM browser_skill_approvals WHERE company_id = ? ORDER BY seq DESC LIMIT 1').get(companyId) as { approved_by: string; how: string; mode: string } | undefined
}
const rowCount = (companyId: string) => {
  return (db.prepare('SELECT COUNT(*) AS n FROM browser_skill_approvals WHERE company_id = ?').get(companyId) as { n: number }).n
}
const noticeKeys = (companyId: string, userId: string) => {
  return (db.prepare('SELECT dedupe_key AS k FROM notifications WHERE company_id = ? AND user_id = ?').all(companyId, userId) as Array<{ k: string }>).map(r => r.k)
}
const code = (r: { ok: boolean; body?: { code?: unknown } }) => (r.ok ? 'ok' : r.body?.code)

beforeAll(async () => {
  workDir = makeTempDir('acb-browser-skill-push-')
  const Database = (await import('better-sqlite3')).default
  const dbModule = await import('../../src/db')
  dbModule.initDatabase()
  db = dbModule.db
  const now = new Date().toISOString()
  const live = new Date(Date.now() + 3600_000).toISOString()
  db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(CO, CO, CO, 'u-owner', now, now)
  db.prepare(`INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at, folder_kind) VALUES (?, ?, ?, ?, ?, ?, 'none')`).run(SHELF_CO, SHELF_CO, SHELF_CO, 'u-owner', now, now)
  const authDb = new Database(join(process.env.DATA_DIR!, 'auth.sqlite'))
  for (const [user, token] of [['u-owner', 'tok-owner'], ['u-editor', 'tok-editor'], ['u-plain', 'tok-plain']]) {
    authDb.prepare('INSERT INTO user (id, email, name) VALUES (?, ?, ?)').run(user, `${user}@example.com`, user)
    authDb.prepare('INSERT INTO session (id, userId, token, expiresAt) VALUES (?, ?, ?, ?)').run(`s-${user}`, user, token, live)
  }
  authDb.close()
  for (const co of [CO, SHELF_CO]) {
    for (const [user, role] of [['u-owner', 'owner'], ['u-editor', 'member'], ['u-plain', 'member']]) {
      db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${user}-${co}`, user, co, role, now, now)
    }
    // 「Skill を直せる人」 for the whole company: the editor may change skill files.
    db.prepare('INSERT INTO skill_editors (company_id, department_id, user_id, created_at, created_by) VALUES (?, NULL, ?, ?, ?)').run(co, 'u-editor', now, 'u-owner')
  }
  const { ensureCompanyScope } = await import('../../src/adapters/sqlite/permission-store')
  ensureCompanyScope(db, CO)
  ensureCompanyScope(db, SHELF_CO)

  const bare = join(process.env.REPOS_DIR!, `${CO}.git`)
  git(['init', '-q', '--bare', '--initial-branch=main', bare])
  configureBareRepo(bare)
  clone = join(workDir, 'clone')
  git(['init', '-q', '--initial-branch=main', clone])
  git(['config', 'user.name', 'test'], clone)
  git(['config', 'user.email', 'test@example.com'], clone)
  writeFileSync(join(clone, 'README.md'), 'company\n')
  commit()
  git(['push', '-q', bare, 'main'], clone)

  services = (await import('../../src/composition')).services
  for (const member of [owner, shelfOwner]) {
    const r = services.agentBrowser.update(member, { mode: 'on', sites: [{ host: DOMAIN, level: 'write', assetHosts: [] }] })
    if (!r.ok) throw new Error(JSON.stringify(r.body))
  }

  const { Hono } = await import('hono')
  const { serve } = await import('@hono/node-server')
  const { gitHttpRoute } = await import('../../src/routes/git-http')
  const app = new Hono()
  app.route('/api/git-http', gitHttpRoute)
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info: AddressInfo) => {
      origin = `http://127.0.0.1:${info.port}`
      resolve()
    })
  })
})

afterAll(() => {
  server?.close()
  rmSync(workDir, { recursive: true, force: true })
})

describe('the push checker hands over what it accepted, and only that', () => {
  it('writes the ref updates to ACB_PUSH_NOTES on accept, nothing on reject', () => {
    const bare = join(workDir, 'notes.git')
    git(['init', '-q', '--bare', '--initial-branch=main', bare])
    configureBareRepo(bare)
    const local = join(workDir, 'notes-clone')
    git(['init', '-q', '--initial-branch=main', local])
    git(['config', 'user.name', 'test'], local)
    git(['config', 'user.email', 'test@example.com'], local)
    const policy = (role: string) => {
      const file = join(workDir, `policy-${role}.json`)
      writeFileSync(file, JSON.stringify({ version: 1, companyId: 'c', pusher: { id: 'p', role }, scopes: [{ id: 'root', path: '', kind: 'folder', rules: [{ id: 'r', subjectType: 'everyone', subjectId: null, canRead: true, canWrite: true }] }] }))
      return file
    }
    const notes = join(workDir, 'accepted.txt')
    const push = (role: string) => spawnSync('git', ['push', bare, 'main'], {
      cwd: local, encoding: 'utf-8',
      env: { ...process.env, ACB_PUSHER_ROLE: role, ACB_NODE: process.execPath, ACB_PUSH_POLICY: policy(role), ACB_PUSH_NOTES: notes },
    })
    writeFileSync(join(local, 'a.md'), 'a\n')
    git(['add', '-A'], local); git(['commit', '-q', '-m', 'a'], local)
    expect(push('member').status).toBe(0)
    const tip = git(['rev-parse', 'HEAD'], local).trim()
    expect(readFileSync(notes, 'latin1')).toBe(`${'0'.repeat(tip.length)} ${tip} refs/heads/main\n`)
    rmSync(notes)
    mkdirSync(join(local, '.claude/skills/x'), { recursive: true })
    writeFileSync(join(local, '.claude/skills/x/browser.yaml'), yaml(1))
    git(['add', '-A'], local); git(['commit', '-q', '-m', 'b'], local)
    const refused = push('member')
    expect(refused.status).not.toBe(0)
    expect(existsSync(notes)).toBe(false)
  })
})

describe('a company with the shared folder: whose push it was', () => {
  it('an owner\'s push of a declaration counts as approved; the server reads its own repository', async () => {
    write(`${PATH}/SKILL.md`, '# copy an order\n')
    write(`${PATH}/browser.yaml`, yaml(1))
    commit()
    expect((await pushAs('tok-owner')).ok).toBe(true)
    await until(() => rowCount(CO) === 1, 'the owner\'s change recorded')
    expect(latestRow(CO)).toEqual({ approved_by: 'u-owner', how: 'edited', mode: 'per_run' })
    const frames = await services.browserSkills.approvedFrames(editor, SKILL)
    expect(frames.ok && frames.value).toMatchObject({ mode: 'per_run', textChanged: false })
    expect(frames.ok && frames.value.frames.writes[0].max).toBe(1)
    // A commit made but never pushed changes nothing the server reads.
    write(`${PATH}/browser.yaml`, yaml(9))
    commit()
    const again = await services.browserSkills.approvedFrames(editor, SKILL)
    expect(again.ok && again.value.frames.writes[0].max).toBe(1)
    git(['reset', '-q', '--hard', 'HEAD~1'], clone)
  })

  it('a skill editor\'s push waits for an owner / admin, who is told', async () => {
    write(`${PATH}/browser.yaml`, yaml(2))
    commit()
    expect((await pushAs('tok-editor')).ok).toBe(true)
    await until(() => noticeKeys(CO, 'u-owner').some(k => k.startsWith('browser_skill:waiting:')), 'the owner told')
    expect(rowCount(CO)).toBe(1)
    expect(code(await services.browserSkills.approvedFrames(owner, SKILL))).toBe('BROWSER_SKILL_NOT_APPROVED')
    expect(noticeKeys(CO, 'u-editor')).toEqual([])
    const list = await services.browserSkills.list(owner)
    const item = list.ok ? list.value.items.find(i => i.name === SKILL) : undefined
    expect(item?.status).toBe('waiting')
    const approved = await services.browserSkills.approve(owner, { skill: SKILL, declarationHash: item!.declarationHash, files: item!.files, mode: 'pre_approved' })
    expect(approved.ok).toBe(true)
    expect(code(await services.browserSkills.approvedFrames(editor, SKILL))).toBe('ok')
  })

  it('a push the checker refused changes nothing', async () => {
    write(`${PATH}/browser.yaml`, yaml(7))
    commit()
    const refused = await pushAs('tok-plain')
    expect(refused.ok).toBe(false)
    await new Promise(r => setTimeout(r, 300))
    expect(rowCount(CO)).toBe(2)
    const frames = await services.browserSkills.approvedFrames(owner, SKILL)
    expect(frames.ok && frames.value.frames.writes[0].max).toBe(2)
    git(['reset', '-q', '--hard', 'HEAD~1'], clone)
  })

  it('a text-only push keeps the frames and asks for the card once', async () => {
    write(`${PATH}/SKILL.md`, '# copy an order (step 3 fixed)\n')
    commit()
    expect((await pushAs('tok-editor')).ok).toBe(true)
    await until(() => noticeKeys(CO, 'u-owner').some(k => k.startsWith('browser_skill:text:')), 'the owner told of the text')
    const frames = await services.browserSkills.approvedFrames(owner, SKILL)
    expect(frames.ok && frames.value).toMatchObject({ mode: 'pre_approved', textChanged: true, needsRunCard: true })
    expect(rowCount(CO)).toBe(2)
  })
})

describe('an owner\'s text-only push after an editor\'s declaration (Codex review)', () => {
  it('approves nothing it did not change', async () => {
    const before = noticeKeys(CO, 'u-owner').filter(k => k.startsWith('browser_skill:waiting:')).length
    write(`${PATH}/browser.yaml`, yaml(3))
    commit()
    expect((await pushAs('tok-editor')).ok).toBe(true)
    await until(() => noticeKeys(CO, 'u-owner').filter(k => k.startsWith('browser_skill:waiting:')).length > before, 'the owner told')
    const rows = rowCount(CO)
    write(`${PATH}/SKILL.md`, '# copy an order (wording)\n')
    commit()
    expect((await pushAs('tok-owner')).ok).toBe(true)
    await new Promise(r => setTimeout(r, 1500))
    expect(rowCount(CO)).toBe(rows)
    expect(code(await services.browserSkills.approvedFrames(owner, SKILL))).toBe('BROWSER_SKILL_NOT_APPROVED')
  })
})

describe('the server\'s own copy at the pushed commit', () => {
  it('a push is read at its own commit, not at the tip someone moved since', async () => {
    const { browserSkillSource } = await import('../../src/adapters/browser-skill-source')
    const source = browserSkillSource({ companyData: (await import('../../src/adapters/sqlite/company-data')).sqliteCompanyData(db), hasCompanyFolder: () => true })
    const bare = join(process.env.REPOS_DIR!, `${CO}.git`)
    const first = git(['-C', bare, 'rev-parse', 'refs/heads/main']).trim()
    const rows = rowCount(CO)
    write(`${PATH}/browser.yaml`, yaml(4))
    commit()
    expect((await pushAs('tok-owner')).ok).toBe(true)
    // On top of the skill editor's pending declaration (above): the owner's change approves nothing (review M1).
    await new Promise(r => setTimeout(r, 1500))
    expect(rowCount(CO)).toBe(rows)
    expect(code(await services.browserSkills.approvedFrames(owner, SKILL))).toBe('BROWSER_SKILL_NOT_APPROVED')
    const second = git(['-C', bare, 'rev-parse', 'refs/heads/main']).trim()
    write(`${PATH}/browser.yaml`, yaml(6))
    commit()
    expect((await pushAs('tok-editor')).ok).toBe(true)
    // The owner's push, read after the editor's landed: still the owner's declaration.
    const read = await source.pushed(CO, `${first} ${second} refs/heads/main\n`)
    expect(read.map(c => [c.path, c.declaration])).toEqual([[PATH, yaml(4)]])
    // Another ref, a malformed line or a deletion reads nothing.
    expect(await source.pushed(CO, `${first} ${second} refs/heads/other\n`)).toEqual([])
    expect(await source.pushed(CO, `${first} ${'0'.repeat(40)} refs/heads/main\n`)).toEqual([])
    expect(await source.pushed(CO, 'not a line\n')).toEqual([])
  })
})

describe('a company without the shared folder: whose publish it was', () => {
  const files = (max: number, text = '# copy\n') => [
    { path: 'SKILL.md', base64: Buffer.from(text).toString('base64') },
    { path: 'browser.yaml', base64: Buffer.from(yaml(max)).toString('base64') },
  ]
  let version: string | null = null
  const publish = (member: typeof shelfOwner, max: number, text?: string) => {
    const r = services.skillShelf.publish(member, { kind: 'skill', name: SKILL, departmentId: null, expectedVersion: version, files: files(max, text) })
    if (!r.ok) throw new Error(JSON.stringify(r.body))
    version = r.value.item.version
  }

  it('an owner\'s publish counts as approved; a skill editor\'s waits', async () => {
    publish(shelfOwner, 1)
    await until(() => rowCount(SHELF_CO) === 1, 'the owner\'s publish recorded')
    expect(latestRow(SHELF_CO)).toEqual({ approved_by: 'u-owner', how: 'edited', mode: 'per_run' })
    expect(code(await services.browserSkills.approvedFrames(shelfEditor, SKILL))).toBe('ok')
    publish(shelfEditor, 3)
    await until(() => noticeKeys(SHELF_CO, 'u-owner').some(k => k.startsWith('browser_skill:waiting:')), 'the owner told')
    expect(rowCount(SHELF_CO)).toBe(1)
    expect(code(await services.browserSkills.approvedFrames(shelfOwner, SKILL))).toBe('BROWSER_SKILL_NOT_APPROVED')
  })

  it('an owner putting an earlier version back, or publishing a member\'s request, approves nothing (review M2)', async () => {
    // The after-publish step runs off the request (setImmediate + reads): give it time, then nothing may have been approved.
    const settled = () => new Promise(r => setTimeout(r, 1000))
    // Approve the editor's 3 on the page, then the owner restores the first version (max 1).
    const list = await services.browserSkills.list(shelfOwner)
    const item = list.ok ? list.value.items.find(i => i.name === SKILL) : undefined
    expect((await services.browserSkills.approve(shelfOwner, { skill: SKILL, declarationHash: item!.declarationHash, files: item!.files, mode: 'per_run' })).ok).toBe(true)
    const versions = services.skillShelf.versions(shelfOwner, (services.skillShelf.list(shelfOwner) as { ok: true; value: { items: Array<{ id: string; name: string }> } }).value.items.find(i => i.name === SKILL)!.id)
    if (!versions.ok) throw new Error(JSON.stringify(versions.body))
    const itemId = (services.skillShelf.list(shelfOwner) as { ok: true; value: { items: Array<{ id: string; name: string }> } }).value.items.find(i => i.name === SKILL)!.id
    const oldest = versions.value.versions[versions.value.versions.length - 1].version
    const rows = rowCount(SHELF_CO)
    const restored = services.skillShelf.restore(shelfOwner, itemId, { version: oldest, expectedVersion: version })
    if (!restored.ok) throw new Error(JSON.stringify(restored.body))
    version = restored.value.item.version
    await settled()
    expect(rowCount(SHELF_CO)).toBe(rows)
    expect(code(await services.browserSkills.approvedFrames(shelfOwner, SKILL))).toBe('BROWSER_SKILL_NOT_APPROVED')
    // A plain member asks; the owner publishes the request.
    const plain = { companyId: SHELF_CO, userId: 'u-plain', role: 'member' }
    const asked = services.skillShelf.createRequest(plain, { departmentId: null, name: SKILL, files: files(9) })
    if (!asked.ok) throw new Error(JSON.stringify(asked.body))
    const done = services.skillShelf.publishRequest(shelfOwner, asked.value.id, { requestVersion: asked.value.version, expectedVersion: version })
    if (!done.ok) throw new Error(JSON.stringify(done.body))
    await settled()
    expect(rowCount(SHELF_CO)).toBe(rows)
    expect(code(await services.browserSkills.approvedFrames(shelfOwner, SKILL))).toBe('BROWSER_SKILL_NOT_APPROVED')
  })
})

describe('department Skills (agent-browser.md "Department Skills")', () => {
  const SALES = '営業'
  const SALES_PATH = `${SALES}/.claude/skills/${SKILL}`
  const SUPPORT_PATH = `support/.claude/skills/${SKILL}`
  const rowsAt = (companyId: string, path: string) =>
    (db.prepare('SELECT approved_by, how FROM browser_skill_approvals WHERE company_id = ? AND skill_path = ? ORDER BY seq').all(companyId, path) as Array<{ approved_by: string; how: string }>)
  const listed = async (companyId: string) => {
    const r = await services.browserSkills.list({ companyId, userId: 'u-owner', role: 'owner' })
    if (!r.ok) throw new Error(JSON.stringify(r.body))
    return r.value.items
  }

  it('an owner\'s push of a department Skill is listed with its department and counts as approved; an editor\'s of another department waits', async () => {
    const companyRows = rowsAt(CO, PATH).length
    write(`${SALES_PATH}/SKILL.md`, '# copy an order (sales)\n')
    write(`${SALES_PATH}/browser.yaml`, yaml(2))
    // Deeper than a department folder: not a place of a browser Skill.
    write(`${SALES}/sub/.claude/skills/deep-one/browser.yaml`, yaml(1))
    commit()
    expect((await pushAs('tok-owner')).ok).toBe(true)
    await until(() => rowsAt(CO, SALES_PATH).length === 1, 'the department Skill recorded')
    expect(rowsAt(CO, SALES_PATH)).toEqual([{ approved_by: 'u-owner', how: 'edited' }])
    // The company's Skill of the same name took nothing from it.
    expect(rowsAt(CO, PATH)).toHaveLength(companyRows)
    const items = await listed(CO)
    expect(items.filter(i => i.name === SKILL).map(i => [i.path, i.department])).toEqual([[PATH, null], [SALES_PATH, SALES]])
    expect(items.some(i => i.name === 'deep-one')).toBe(false)
    const frames = await services.browserSkills.approvedFrames(editor, SALES_PATH)
    expect(frames.ok && frames.value).toMatchObject({ skill: SALES_PATH })
    expect(frames.ok && frames.value.frames.writes[0].max).toBe(2)
    // Two Skills of one name: the AI's name alone is refused, never guessed.
    expect(code(await services.browserSkills.resolve(editor, SKILL))).toBe('BROWSER_SKILL_AMBIGUOUS')

    // A skill editor (for the whole company) adds the same name in another department: it waits, the owner is told.
    const told = noticeKeys(CO, 'u-owner').length
    write(`${SUPPORT_PATH}/browser.yaml`, yaml(3))
    commit()
    expect((await pushAs('tok-editor')).ok).toBe(true)
    await until(() => noticeKeys(CO, 'u-owner').length > told, 'the owner told')
    expect(rowsAt(CO, SUPPORT_PATH)).toEqual([])
    expect(code(await services.browserSkills.approvedFrames(owner, SUPPORT_PATH))).toBe('BROWSER_SKILL_NOT_APPROVED')
    // Approving it on the page (by its path) approves that one only.
    const support = (await listed(CO)).find(i => i.path === SUPPORT_PATH)!
    expect(support.department).toBe('support')
    const approved = await services.browserSkills.approve(owner, { skill: SUPPORT_PATH, declarationHash: support.declarationHash, files: support.files, mode: 'per_run' })
    expect(approved.ok).toBe(true)
    expect(rowsAt(CO, SUPPORT_PATH)).toEqual([{ approved_by: 'u-owner', how: 'approved' }])
    expect(rowsAt(CO, SALES_PATH)).toHaveLength(1)
  })

  it('a Skill at a private folder\'s path is never listed or read, and its name appears nowhere', async () => {
    // As if the company repository held files at a path that is (now) a private folder: they are not its Skills.
    write('機密/.claude/skills/secret-plan/browser.yaml', yaml(1))
    commit()
    expect((await pushAs('tok-owner')).ok).toBe(true)
    const before = await listed(CO)
    expect(before.some(i => i.name === 'secret-plan')).toBe(true)
    const now = new Date().toISOString()
    db.prepare('INSERT INTO scope_repos (id, company_id, scope_id, created_at) VALUES (?, ?, ?, ?)').run('r-secret', CO, 's-secret', now)
    db.prepare("INSERT INTO scopes (id, company_id, path, kind, repo_id, created_at) VALUES (?, ?, '機密', 'folder', ?, ?)").run('s-secret', CO, 'r-secret', now)
    const after = await services.browserSkills.list(owner)
    expect(JSON.stringify(after)).not.toContain('secret-plan')
    expect(JSON.stringify(after)).not.toContain('機密')
    expect(code(await services.browserSkills.approvedFrames(owner, '機密/.claude/skills/secret-plan'))).toBe('BROWSER_SKILL_NOT_FOUND')
    expect(code(await services.browserSkills.resolve(owner, 'secret-plan'))).toBe('BROWSER_SKILL_NOT_FOUND')
  })

  it('a company without the shared folder: a department\'s shelf Skill, used only by who reads the department', async () => {
    const dept = await services.departments.create(shelfOwner, { name: SALES, folder: SALES })
    if (!dept.ok) throw new Error(JSON.stringify(dept.body))
    const files = [
      { path: 'SKILL.md', base64: Buffer.from('# copy (sales)\n').toString('base64') },
      { path: 'browser.yaml', base64: Buffer.from(yaml(4)).toString('base64') },
    ]
    const r = services.skillShelf.publish(shelfOwner, { kind: 'skill', name: SKILL, departmentId: dept.value.id, expectedVersion: null, files })
    if (!r.ok) throw new Error(JSON.stringify(r.body))
    await until(() => rowsAt(SHELF_CO, SALES_PATH).length === 1, 'the owner\'s department publish recorded')
    expect(rowsAt(SHELF_CO, SALES_PATH)).toEqual([{ approved_by: 'u-owner', how: 'edited' }])
    const items = await listed(SHELF_CO)
    expect(items.find(i => i.path === SALES_PATH)).toMatchObject({ department: SALES, name: SKILL })
    const plain = { companyId: SHELF_CO, userId: 'u-plain', role: 'member' }
    const frames = await services.browserSkills.approvedFrames(plain, SALES_PATH)
    expect(frames.ok && frames.value.frames.writes[0].max).toBe(4)
    // The department is made readable by its own people only: the plain member no longer uses its Skill.
    services.permissionEditor.replaceRules(shelfOwner, SALES, [{ subjectType: 'everyone', subjectId: null, canRead: false, canWrite: false }])
    expect(code(await services.browserSkills.approvedFrames(plain, SALES_PATH))).toBe('BROWSER_SKILL_NOT_FOUND')
    // Their name alone now means the company's Skill of that name, the one they may use.
    const which = await services.browserSkills.resolve(plain, SKILL)
    expect(which.ok && which.value).toBe(`.claude/skills/${SKILL}`)
    expect(code(await services.browserSkills.approvedFrames(shelfOwner, SALES_PATH))).toBe('ok')
  })
})

describe('department Skills: the review of #879 (real git)', () => {
  const rowsAt = (path: string) => (db.prepare('SELECT COUNT(*) AS n FROM browser_skill_approvals WHERE company_id = ? AND skill_path = ?').get(CO, path) as { n: number }).n

  it('an owner moving or copying a pending declaration to another department does not approve it', async () => {
    const from = `pending/.claude/skills/mover`
    const moved = `moved/.claude/skills/mover`
    const copied = `copied/.claude/skills/mover`
    write(`${from}/browser.yaml`, yaml(8))
    commit()
    expect((await pushAs('tok-editor')).ok).toBe(true)
    await until(() => noticeKeys(CO, 'u-owner').some(k => k.includes('pending/mover')), 'the owner told of the editor\'s Skill')
    expect(rowsAt(from)).toBe(0)
    // The owner moves it to another department (git mv): the old commit held it at `pending/`, still waiting.
    git(['mv', 'pending', 'moved'], clone)
    commit()
    expect((await pushAs('tok-owner')).ok).toBe(true)
    // The pusher is not told of their own change: give the after-push step its time, then nothing may be approved.
    await new Promise(r => setTimeout(r, 2000))
    expect(rowsAt(moved)).toBe(0)
    expect(code(await services.browserSkills.approvedFrames(owner, moved))).toBe('BROWSER_SKILL_NOT_APPROVED')
    // …and copies it: the same declaration still waits at `moved/`.
    write(`${copied}/browser.yaml`, yaml(8))
    commit()
    expect((await pushAs('tok-owner')).ok).toBe(true)
    // (as above)
    await new Promise(r => setTimeout(r, 2000))
    expect(rowsAt(copied)).toBe(0)
    // A copy is the owner's own approval only when every place holding that declaration has it approved.
    const approveAtPath = async (path: string) => {
      const view = await services.browserSkills.list(owner)
      const item = view.ok ? view.value.items.find(i => i.path === path) : undefined
      expect((await services.browserSkills.approve(owner, { skill: path, declarationHash: item!.declarationHash, files: item!.files, mode: 'per_run' })).ok).toBe(true)
    }
    await approveAtPath(moved)
    await approveAtPath(copied)
    const again = `again/.claude/skills/mover`
    write(`${again}/browser.yaml`, yaml(8))
    commit()
    expect((await pushAs('tok-owner')).ok).toBe(true)
    await until(() => rowsAt(again) === 1, 'the copy of an approved one approved')
  })

  it('a company Skill folder without browser.yaml makes its name ambiguous for the AI', async () => {
    write('.claude/skills/plain-one/SKILL.md', '# plain\n')
    write('sales2/.claude/skills/plain-one/browser.yaml', yaml(1))
    commit()
    expect((await pushAs('tok-owner')).ok).toBe(true)
    await until(() => rowsAt('sales2/.claude/skills/plain-one') === 1, 'the department one landed')
    expect(code(await services.browserSkills.resolve(editor, 'plain-one'))).toBe('BROWSER_SKILL_AMBIGUOUS')
    const listed = await services.browserSkills.list(owner)
    expect(listed.ok && listed.value.items.some(i => i.path === '.claude/skills/plain-one')).toBe(false)
  })
})

describe('department Skills: places the source cannot fully look into (adapter, real git)', () => {
  /** A bare repository for `companyId` whose top folders are `folders`, each with `<folder>/.claude/skills/order-copy/browser.yaml`. */
  function repoWith(companyId: string, folders: string[]) {
    const bare = join(process.env.REPOS_DIR!, `${companyId}.git`)
    git(['init', '-q', '--bare', '--initial-branch=main', bare])
    // Plumbing (never core.precomposeunicode): a folder name is kept exactly as written, NFD included.
    const run = (args: string[], input?: string) => execFileSync('git', ['-C', bare, ...args], { input, stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim()
    const blob = run(['hash-object', '-w', '--stdin'], yaml(1))
    const skill = run(['mktree'], `100644 blob ${blob}\tbrowser.yaml\n`)
    const skills = run(['mktree'], `040000 tree ${skill}\torder-copy\n`)
    const claude = run(['mktree'], `040000 tree ${skills}\tskills\n`)
    const dept = run(['mktree'], `040000 tree ${claude}\t.claude\n`)
    const root = run(['mktree', '-z'], folders.map(f => `040000 tree ${dept}\t${f}\0`).join(''))
    const commitId = run(['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit-tree', root, '-m', 'skills'])
    run(['update-ref', 'refs/heads/main', commitId])
  }
  const sourceOf = async () => {
    const { browserSkillSource } = await import('../../src/adapters/browser-skill-source')
    return browserSkillSource({ companyData: (await import('../../src/adapters/sqlite/company-data')).sqliteCompanyData(db), hasCompanyFolder: () => true })
  }
  const names = (n: number) => Array.from({ length: n }, (_, i) => `f${String(i).padStart(3, '0')}`)

  it('exactly 500 top folders are all looked into; 501 are not, and a name is then never resolved alone', async () => {
    repoWith('bsk-500', names(500))
    repoWith('bsk-501', names(501))
    const source = await sourceOf()
    const five = await source.withName('bsk-500', 'order-copy')
    expect(five.paths).toHaveLength(500)
    expect(five.complete).toBe(true)
    // The approval list holds at most 100 Skills: it says it is not complete.
    expect((await source.list('bsk-500')).complete).toBe(false)
    const over = await source.withName('bsk-501', 'order-copy')
    expect(over.paths).toHaveLength(500)
    expect(over.complete).toBe(false)
  })

  it('a top folder whose name is not NFC is not looked into, and the answer says it is not complete', async () => {
    repoWith('bsk-nfd', ['営業', 'ガイド'.normalize('NFD')])
    const source = await sourceOf()
    const found = await source.withName('bsk-nfd', 'order-copy')
    expect(found.paths).toEqual(['営業/.claude/skills/order-copy'])
    expect(found.complete).toBe(false)
    expect(await source.list('bsk-nfd')).toEqual({ paths: ['営業/.claude/skills/order-copy'], complete: false })
    // Only NFC names: complete.
    repoWith('bsk-nfc', ['営業', 'ガイド'])
    expect((await source.withName('bsk-nfc', 'order-copy')).complete).toBe(true)
  })
})

describe('a Skill\'s steps at the folder version the frames come from (agent-browser.md "The operator works from the approved steps")', () => {
  /** A bare repository whose company Skill `steps-seal` holds `browser.yaml` and the given step files; returns the commit. */
  function commitSkill(companyId: string, files: Record<string, string>, parent?: string): string {
    const bare = join(process.env.REPOS_DIR!, `${companyId}.git`)
    if (!existsSync(bare)) git(['init', '-q', '--bare', '--initial-branch=main', bare])
    const run = (args: string[], input?: string | Buffer) => execFileSync('git', ['-C', bare, ...args], { input, stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim()
    const entries = Object.entries({ 'browser.yaml': yaml(1), ...files }).sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([name, text]) => `100644 blob ${run(['hash-object', '-w', '--stdin'], Buffer.from(text, 'utf8'))}\t${name}\n`).join('')
    const skill = run(['mktree'], entries)
    const skills = run(['mktree'], `040000 tree ${skill}\tsteps-seal\n`)
    const claude = run(['mktree'], `040000 tree ${skills}\tskills\n`)
    const root = run(['mktree'], `040000 tree ${claude}\t.claude\n`)
    const commitId = run(['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit-tree', root, ...(parent ? ['-p', parent] : []), '-m', 'steps'])
    run(['update-ref', 'refs/heads/main', commitId])
    return commitId
  }

  it('git: the step files as stored, bound to the version read — a later push never changes what an earlier version gives', async () => {
    const { browserSkillSource } = await import('../../src/adapters/browser-skill-source')
    const source = browserSkillSource({ companyData: (await import('../../src/adapters/sqlite/company-data')).sqliteCompanyData(db), hasCompanyFolder: () => true })
    const first = commitSkill('bsk-steps', { 'SKILL.md': '# 手順\r\n1. 【コピー】する\n\n', 'site-notes.md': 'メモ\n', 'other.md': 'not a step' })
    const v1 = await source.read('bsk-steps', '.claude/skills/steps-seal')
    expect(await source.stepFiles('bsk-steps', v1!)).toEqual([
      { name: 'SKILL.md', text: '# 手順\r\n1. 【コピー】する\n\n' },
      { name: 'site-notes.md', text: 'メモ\n' },
    ])
    commitSkill('bsk-steps', { 'SKILL.md': '# 手順 v2\n' }, first)
    const v2 = await source.read('bsk-steps', '.claude/skills/steps-seal')
    expect(v2!.files).not.toBe(v1!.files)
    expect(await source.stepFiles('bsk-steps', v2!)).toEqual([{ name: 'SKILL.md', text: '# 手順 v2\n' }])
    // The earlier version still gives its own text.
    expect((await source.stepFiles('bsk-steps', v1!))?.[0]).toEqual({ name: 'SKILL.md', text: '# 手順\r\n1. 【コピー】する\n\n' })
    // Over the limit: never read in part.
    commitSkill('bsk-steps', { 'SKILL.md': 'x'.repeat(64 * 1024 + 1) })
    const big = await source.read('bsk-steps', '.claude/skills/steps-seal')
    expect(await source.stepFiles('bsk-steps', big!)).toEqual([{ name: 'SKILL.md', tooLarge: true }])
    // Not an object id: cannot be read.
    expect(await source.stepFiles('bsk-steps', { path: '.claude/skills/steps-seal', files: 'git:not-an-id' })).toBeNull()
  })

  it('the shelf: the step files of exactly the version named; the seal is the hash of the text the operator gets', async () => {
    const files = [
      { path: 'SKILL.md', base64: Buffer.from('# 棚の手順\n').toString('base64') },
      { path: 'browser.yaml', base64: Buffer.from(yaml(1)).toString('base64') },
    ]
    const r = services.skillShelf.publish(shelfOwner, { kind: 'skill', name: 'steps-seal', departmentId: null, expectedVersion: null, files })
    if (!r.ok) throw new Error(JSON.stringify(r.body))
    const path = '.claude/skills/steps-seal'
    const seal = await services.browserSkills.stepsSeal(shelfOwner, path, `shelf:${r.value.item.version}`)
    const { createHash } = await import('crypto')
    expect(seal).toEqual({ state: 'sealed', hash: `sha256:${createHash('sha256').update('# SKILL.md\n# 棚の手順\n', 'utf8').digest('hex')}` })
    expect(await services.browserSkills.stepsSeal(shelfOwner, path, 'shelf:no-such-version')).toBeNull()
  })
})
