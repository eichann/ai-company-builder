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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { tmpdir } from 'os'
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
  workDir = mkdtempSync(join(tmpdir(), 'acb-browser-skill-push-'))
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
    write(`${PATH}/browser.yaml`, yaml(4))
    commit()
    expect((await pushAs('tok-owner')).ok).toBe(true)
    const second = git(['-C', bare, 'rev-parse', 'refs/heads/main']).trim()
    write(`${PATH}/browser.yaml`, yaml(6))
    commit()
    expect((await pushAs('tok-editor')).ok).toBe(true)
    // The owner's push, read after the editor's landed: still the owner's declaration.
    const read = await source.pushed(CO, `${first} ${second} refs/heads/main\n`)
    expect(read.map(c => [c.name, c.declaration])).toEqual([[SKILL, yaml(4)]])
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
})
