/**
 * Integration Test: the company map end to end (light ontology 4-1 / 4-2,
 * `.claude/rules/records.md`) — real bare repository with the real push
 * checker, real git smart HTTP for a member's push, the records API.
 *
 * Guards:
 * - the feature is off until an owner/admin turns it on (members cannot);
 * - turning it on indexes the repository in full (type definitions + record
 *   files found by git grep), and a member's accepted push over git-http is
 *   indexed from its diff without anyone asking (afterPush);
 * - only owners/admins may change `.acb/types/` (a member's push is refused
 *   in [PROTECTED_CONFIG], the repository unchanged);
 * - for owners too, a definition change that removes a state is refused
 *   (reason line under the path); adding one with a higher version, and
 *   deleting a definition, are accepted;
 * - a decision is written by the server as its own commit through the push
 *   checker and indexed with its server state kept; one naming the linked
 *   customer is refused and nothing is committed; the same key commits once.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { execFileSync, spawn, spawnSync } from 'child_process'
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { tmpdir } from 'os'
import type { AddressInfo } from 'net'

const currentUser = vi.hoisted(() => ({ id: null as string | null }))
vi.mock('../../src/lib/auth', () => ({
  getUserFromRequest: vi.fn().mockImplementation(async () =>
    currentUser.id ? { id: currentUser.id, email: `${currentUser.id}@example.com`, name: currentUser.id, image: null, emailVerified: true } : null),
  getUsersByIds: vi.fn().mockReturnValue(new Map()),
  auth: {
    handler: vi.fn().mockResolvedValue(new Response('', { status: 200 })),
    api: { getSession: vi.fn().mockResolvedValue(null) },
  },
}))

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })

const CO = 'rec-co'
let workDir: string
let bare: string
let clone: string
let origin: string
let server: { close: () => void }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let services: any

const DEAL = (version: number, states: string) => `---
label: 商談
version: ${version}
fields:
  title: { label: 件名, kind: text, source: file }
links:
  customer: { label: 顧客, target: customer, cardinality: one }
states: ${states}
---
`
const CUSTOMER = '---\nlabel: 顧客\nversion: 1\nstates: []\n---\n'
const record = (id: string, type: string, title: string, links = '') => `---\nid: ${id}\ntype: ${type}\n${links ? `links:\n${links}` : ''}---\n# ${title}\n\n${title} の要約。\n`

function git(args: string[], cwd?: string): string {
  return execFileSync('git', args, { stdio: 'pipe', ...(cwd ? { cwd } : {}) }).toString()
}
function write(rel: string, content: string) {
  const full = join(clone, rel)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content)
}
function commit(message: string) {
  git(['add', '-A'], clone)
  git(['commit', '-q', '--no-verify', '-m', message], clone)
}
/** Local push as a role (the hook reads ACB_PUSHER_ROLE as git-http sets it). */
function pushAs(role: string): { ok: boolean; output: string } {
  const env = { ...process.env, ACB_PUSHER_ROLE: role }
  const r = spawnSync('git', ['push', bare, 'HEAD:main'], { cwd: clone, env, encoding: 'utf-8' })
  return { ok: r.status === 0, output: `${r.stdout}${r.stderr}` }
}
/** A member's push over git smart HTTP (async: the server runs in this process). */
function pushOverHttp(token: string): Promise<{ ok: boolean; output: string }> {
  const url = `${origin.replace('http://', `http://git:${token}@`)}/api/git-http/${CO}.git`
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  for (const k of Object.keys(env)) if (k.startsWith('ACB_')) delete env[k]
  return new Promise((resolve) => {
    const p = spawn('git', ['push', url, 'HEAD:main'], { cwd: clone, env })
    let output = ''
    p.stdout.on('data', (d: Buffer) => { output += d.toString() })
    p.stderr.on('data', (d: Buffer) => { output += d.toString() })
    p.on('close', code => resolve({ ok: code === 0, output }))
  })
}
const resetToRemote = () => git(['reset', '-q', '--hard', git(['-C', bare, 'rev-parse', 'main']).trim()], clone)

async function api(user: string | null, method: string, path: string, body?: unknown) {
  currentUser.id = user
  const res = await fetch(`${origin}/api/companies/${CO}/records${path}`, {
    method, headers: { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  return { status: res.status, body: await res.json() as { data?: Record<string, unknown>; code?: string } }
}
const titles = (r: { body: { data?: Record<string, unknown> } }) => ((r.body.data?.records ?? []) as Array<{ title: string }>).map(x => x.title).sort()

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'acb-records-'))
  const Database = (await import('better-sqlite3')).default
  const dbModule = await import('../../src/db')
  dbModule.initDatabase()
  const db = dbModule.db
  const now = new Date().toISOString()
  db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(CO, CO, CO, 'u-owner', now, now)
  for (const [user, role] of [['u-owner', 'owner'], ['u-member', 'member']]) {
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${user}`, user, CO, role, now, now)
  }
  const authDb = new Database(join(process.env.DATA_DIR!, 'auth.sqlite'))
  authDb.prepare('INSERT INTO user (id, email, name) VALUES (?, ?, ?)').run('u-member', 'u-member@example.com', 'u-member')
  authDb.prepare('INSERT INTO session (id, userId, token, expiresAt) VALUES (?, ?, ?, ?)').run('s-member', 'u-member', 'tok-member', new Date(Date.now() + 3600_000).toISOString())
  authDb.close()
  const { ensureCompanyScope } = await import('../../src/adapters/sqlite/permission-store')
  ensureCompanyScope(db, CO)

  const { configureBareRepo } = await import('../../src/routes/git')
  bare = join(process.env.REPOS_DIR!, `${CO}.git`)
  git(['init', '-q', '--bare', '--initial-branch=main', bare])
  configureBareRepo(bare)
  clone = join(workDir, 'clone')
  git(['init', '-q', '--initial-branch=main', clone])
  git(['config', 'user.name', 'test'], clone)
  git(['config', 'user.email', 'test@example.com'], clone)
  write('.acb/types/deal.md', DEAL(1, '[open, won, lost]'))
  write('.acb/types/customer.md', CUSTOMER)
  write('営業部/顧客/A社.md', record('customer-cust0001', 'customer', 'A社'))
  write('営業部/商談/提案.md', record('deal-deal0001', 'deal', 'A社 提案', '  customer: customer-cust0001\n'))
  write('営業部/メモ.md', '# ただのメモ\n')
  commit('seed')
  const seeded = pushAs('owner')
  if (!seeded.ok) throw new Error(seeded.output)

  services = (await import('../../src/composition')).services
  const { Hono } = await import('hono')
  const { serve } = await import('@hono/node-server')
  const { gitHttpRoute } = await import('../../src/routes/git-http')
  const { recordsRoute } = await import('../../src/routes/records')
  const app = new Hono()
  app.route('/api/git-http', gitHttpRoute)
  app.route('/api/companies/:companyId', recordsRoute)
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

const owner = { companyId: CO, userId: 'u-owner', role: 'owner' }

describe('the company map, end to end', () => {
  it('is off until an owner turns it on; a member cannot', async () => {
    expect(await api('u-member', 'POST', '/query', {})).toMatchObject({ status: 404, body: { code: 'RECORDS_DISABLED' } })
    expect((await api('u-member', 'PUT', '/settings', { enabled: true })).status).toBe(403)
    expect((await api('u-owner', 'PUT', '/settings', { enabled: true })).status).toBe(200)
  })

  it('turning it on indexes the repository in full', async () => {
    await services.records.refreshIndex(owner)
    expect(titles(await api('u-member', 'POST', '/query', {}))).toEqual(['A社', 'A社 提案'])
    const types = await api('u-member', 'GET', '/types')
    expect((types.body.data?.types as Array<{ definition: { name: string } }>).map(t => t.definition.name)).toEqual(['approval', 'customer', 'deal', 'decision', 'interaction', 'minutes', 'outbound_message', 'task'])
    const detail = await api('u-member', 'GET', '/item/customer-cust0001')
    expect(detail.body.data?.links).toEqual([expect.objectContaining({ name: 'customer', direction: 'in', record: expect.objectContaining({ id: 'deal-deal0001' }) })])
  })

  it('a member’s push over git-http is indexed without anyone asking', async () => {
    resetToRemote()
    write('営業部/商談/見積.md', record('deal-deal0002', 'deal', 'A社 見積', '  customer: customer-cust0001\n'))
    git(['mv', '営業部/商談/提案.md', '営業部/商談/提案書.md'], clone)
    commit('member edits')
    const pushed = await pushOverHttp('tok-member')
    expect(pushed.ok, pushed.output).toBe(true)
    let found: string[] = []
    for (let i = 0; i < 100 && found.length < 3; i++) {
      found = titles(await api('u-member', 'POST', '/query', {}))
      if (found.length < 3) await new Promise(r => setTimeout(r, 50))
    }
    expect(found).toEqual(['A社', 'A社 提案', 'A社 見積'])
    expect((await api('u-member', 'GET', '/item/deal-deal0001')).body.data?.record).toMatchObject({ path: '営業部/商談/提案書.md' })
  })

  it('only owners and admins change .acb/types/: a member’s push is refused, the repository unchanged', async () => {
    resetToRemote()
    const before = git(['-C', bare, 'rev-parse', 'main'])
    write('.acb/types/deal.md', DEAL(2, '[open, won, lost, paused]'))
    commit('member edits a type')
    const pushed = await pushOverHttp('tok-member')
    expect(pushed.ok).toBe(false)
    expect(pushed.output).toContain('[PROTECTED_CONFIG]')
    expect(pushed.output).toContain('- .acb/types/deal.md')
    expect(git(['-C', bare, 'rev-parse', 'main'])).toBe(before)
  })

  it('owners too cannot remove a state; adding one with a higher version, or deleting a definition, is accepted', async () => {
    resetToRemote()
    write('.acb/types/deal.md', DEAL(2, '[open, won]'))
    commit('remove a state')
    const refused = pushAs('owner')
    expect(refused.ok).toBe(false)
    expect(refused.output).toContain('- .acb/types/deal.md')
    expect(refused.output).toContain('状態「lost」を消す')

    resetToRemote()
    write('.acb/types/deal.md', DEAL(2, '[open, won, lost, paused]'))
    commit('add a state')
    expect(pushAs('owner').ok).toBe(true)
    unlinkSync(join(clone, '.acb/types/customer.md'))
    commit('delete a definition')
    expect(pushAs('admin').ok).toBe(true)

    await services.records.refreshIndex(owner)
    const types = await api('u-owner', 'GET', '/types')
    const list = types.body.data?.types as Array<{ definition: { name: string; states: string[] }; versions: number[] }>
    expect(list.find(t => t.definition.name === 'deal')).toMatchObject({ versions: [1, 2], definition: { states: ['open', 'won', 'lost', 'paused'] } })
    // A deleted definition stays in force (records use it) and is reported.
    expect(list.map(t => t.definition.name)).toContain('customer')
    const problems = await api('u-owner', 'GET', '/problems')
    expect(problems.body.data?.problems).toContainEqual(expect.objectContaining({ path: '.acb/types/customer.md', kind: 'type_file_removed' }))
  })

  it('a task through the engine: attached version checked against the repository, the milestone line committed through the push checker', async () => {
    // A server-only task (0.6), then its file once it has content: the index adopts it.
    const created = await api('u-owner', 'POST', '/item', { type: 'task', title: '提案書の見直し', fields: { assignee: 'u-member' } })
    expect(created.status).toBe(201)
    const id = (created.body.data?.record as { id: string }).id
    resetToRemote()
    write('営業部/タスク/見直し.md', `---\nid: ${id}\ntype: task\nlinks:\n  files: [営業部/商談/提案書.md]\n---\n# 提案書の見直し\n\n第2章を直す。\n`)
    commit('task file')
    expect(pushAs('owner').ok).toBe(true)
    await services.records.refreshIndex(owner)
    const tip = git(['-C', bare, 'rev-parse', 'main']).trim()

    expect((await api('u-member', 'POST', `/item/${id}/actions/start`, { expectedVersion: 1 })).status).toBe(200)
    const notPushed = await api('u-member', 'POST', `/item/${id}/actions/request_review`, {
      expectedVersion: 2, args: { reviewer: 'u-owner' }, attachments: [{ link: 'files', path: '営業部/商談/提案書.md', commit: 'f'.repeat(40) }],
    })
    expect(notPushed).toMatchObject({ status: 409, body: { code: 'ATTACHMENT_NOT_SYNCED' } })
    const review = await api('u-member', 'POST', `/item/${id}/actions/request_review`, {
      expectedVersion: 2, args: { reviewer: 'u-owner' }, attachments: [{ link: 'files', path: '営業部/商談/提案書.md', commit: tip }],
    })
    expect(review.status).toBe(200)
    expect((await api('u-owner', 'GET', '/my-turn')).body.data?.records).toEqual([expect.objectContaining({ id, state: 'review' })])

    expect((await api('u-owner', 'POST', `/item/${id}/actions/complete`, { expectedVersion: 3, note: '問題なし' })).status).toBe(200)
    let text = ''
    for (let i = 0; i < 200 && !text.includes('## 経緯'); i++) {
      try { text = git(['-C', bare, 'show', `main:営業部/タスク/見直し.md`]) } catch { text = '' }
      if (!text.includes('## 経緯')) await new Promise(r => setTimeout(r, 100))
    }
    expect(text).toMatch(/## 経緯\n\n- \d{4}-\d{2}-\d{2} 完了にする（u-owner）：問題なし\n/)
    expect(git(['-C', bare, 'log', '-1', '--format=%an'])).toContain('AI Company Builder')
    const history = await api('u-member', 'GET', `/item/${id}/history`)
    expect((history.body.data?.entries as Array<{ action: string }>).map(e => e.action)).toEqual(['create', 'start', 'request_review', 'complete'])
    expect((await api('u-member', 'GET', `/item/${id}/versions/2`)).body.data).toMatchObject({ version: 2, state: 'in_progress' })
  })

  it('a decision: the server commits its file through the push checker; the index keeps its state; a customer name is refused', async () => {
    const { db } = await import('../../src/db')
    const now = new Date().toISOString()
    db.prepare('INSERT INTO departments (id, company_id, name, folder, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('dep-sales', CO, '営業部', '営業部', now, now)
    const before = git(['-C', bare, 'rev-parse', 'main']).trim()
    const named = await api('u-member', 'POST', '/decisions', { folder: '営業部', title: 'A社に窓口を3つ出す', why: '要望があった', source: '商談', links: { deal: 'deal-deal0001' } })
    expect(named).toMatchObject({ status: 400, body: { code: 'NAME_IN_DECISION' } })
    expect(git(['-C', bare, 'rev-parse', 'main']).trim()).toBe(before)

    const made = await api('u-member', 'POST', '/decisions', {
      folder: '営業部', title: '対象の窓口を3つにする', why: 'チャット窓口も最初から入れたいとの要望', source: '商談のメモ', links: { deal: 'deal-deal0001' }, key: 'k-1',
    })
    expect(made.status).toBe(201)
    const id = (made.body.data?.record as { id: string }).id
    const text = git(['-C', bare, 'show', `main:営業部/意思決定/${id}.md`])
    expect(text).toContain(`id: ${id}\ntype: decision\nlinks:\n  deal: deal-deal0001\n---\n# 対象の窓口を3つにする`)
    expect(git(['-C', bare, 'log', '-1', '--format=%an'])).toContain('AI Company Builder')
    await services.records.refreshIndex(owner)
    const detail = await api('u-owner', 'GET', `/item/${id}`)
    expect(detail.body.data?.record).toMatchObject({ id, path: `営業部/意思決定/${id}.md`, state: 'unconfirmed', version: 1, fields: { recorded_by: 'human', decided_by: 'u-member' } })
    // Again with the same key: nothing new.
    const tip = git(['-C', bare, 'rev-parse', 'main']).trim()
    expect((await api('u-member', 'POST', '/decisions', { folder: '営業部', title: '対象の窓口を3つにする', why: '同じ', source: '同じ', key: 'k-1' })).status).toBe(200)
    expect(git(['-C', bare, 'rev-parse', 'main']).trim()).toBe(tip)
  })
})
