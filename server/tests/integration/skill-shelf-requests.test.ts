/**
 * Integration Test: 「会社に出してほしいと頼む」 (plugins.md "Requests to publish a Skill", owner
 * decision 2026-11-09) on the Skill shelf of a company without the shared folder.
 *
 * Guards:
 * - only someone who may NOT publish a Skill at a place asks (a publisher: 409 SHELF_REQUEST_NOT_NEEDED);
 * - what no publisher could take from them is refused when sent, with publishing's reasons (auto-run
 *   parts, agent config, secrets, paths) and nothing is stored;
 * - a request is seen by its sender and by those who may publish at its place, nobody else; a
 *   department request never reaches anyone who cannot read the department (its name included);
 * - only those who may publish there 公開する / 見送る (the sender: 403), once (409 after);
 *   公開する publishes a new version with the publisher's whole check, the history noting who
 *   asked; the request's files go; the sender's app sees 公開された / 見送られた with the reason;
 * - limits per member and per company; a new request at the same place replaces the earlier one;
 * - another company's request is one that does not exist; a company with the shared folder: 409.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest'

const currentUser = vi.hoisted(() => ({ id: 'rq-owner' as string | null }))
vi.mock('../../src/lib/auth', () => ({
  getUserFromRequest: vi.fn().mockImplementation(async () =>
    currentUser.id ? { id: currentUser.id, email: `${currentUser.id}@example.com`, name: currentUser.id, image: null, emailVerified: true } : null),
  getUsersByIds: vi.fn().mockImplementation((ids: string[]) =>
    new Map(ids.map(id => [id, { email: `${id}@example.com`, name: `Name ${id}` }]))),
  auth: {
    handler: vi.fn().mockResolvedValue(new Response('', { status: 200 })),
    api: { getSession: vi.fn().mockResolvedValue(null) },
  },
}))

import { mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Hono } from 'hono'
import { db, initDatabase } from '../../src/db'
import { companiesRoute } from '../../src/routes/companies'
import { departmentsRoute } from '../../src/routes/departments'
import { permissionRulesRoute } from '../../src/routes/permission-rules'
import { groupsRoute } from '../../src/routes/groups'
import { skillEditorsRoute } from '../../src/routes/skill-editors'
import { skillShelfRoute } from '../../src/routes/skill-shelf'
import { setRepoGitTimeoutsForTests } from '../../src/adapters/git-repo-store'
import { createHash } from 'node:crypto'
import { SHELF_REQUEST_LIMITS, shelfListing } from '../../shared/core/skill-shelf'

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })

const app = new Hono()
app.route('/api/companies', companiesRoute)
app.route('/api/companies/:companyId/departments', departmentsRoute)
app.route('/api/companies/:companyId', permissionRulesRoute)
app.route('/api/companies/:companyId', groupsRoute)
app.route('/api/companies/:companyId', skillEditorsRoute)
app.route('/api/companies/:companyId', skillShelfRoute)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

async function call(method: string, path: string, body?: unknown, as = 'rq-owner') {
  currentUser.id = as
  try {
    const res = await app.request(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    const text = await res.text()
    let json: Json = null
    try { json = JSON.parse(text) } catch { json = text }
    return { status: res.status, body: json, text }
  } finally {
    currentUser.id = 'rq-owner'
  }
}

let none: string
let other: string
let git: string
const co = (path: string) => `/api/companies/${none}${path}`
const PEOPLE: Array<[string, string]> = [
  ['rq-editor', 'member'], // 「Skill を直せる人」 for the whole company
  ['rq-mgr', 'member'], // 部署の管理役 of 営業部
  ['rq-bob', 'member'], // nothing
  ['rq-dan', 'member'], // nothing (the limits)
  ['rq-carol', 'member'], // in the group that reads 人事部
]
const dept: Record<string, string> = {}

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64')
const SKILL = '---\nname: x\ndescription: 見積を作る\n---\n見積の作り方。\n'
const files = (body = SKILL, extra: Record<string, string> = {}) =>
  [{ path: 'SKILL.md', base64: b64(body) }, ...Object.entries(extra).map(([path, text]) => ({ path, base64: b64(text) }))]
const ask = (name: string, departmentId: string | null, as: string, body = SKILL, extra: Record<string, string> = {}) =>
  call('POST', co('/skill-shelf-requests'), { departmentId, name, files: files(body, extra) }, as)
const listed = async (as: string) => (await call('GET', co('/skill-shelf-requests'), undefined, as))
const myRequests = async (as: string) => (await call('GET', co('/me/skill-shelf'), undefined, as)).body.data.requests as Json[]
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
/** The version the server gives these files (what an approver is shown). */
const versionOfFiles = (fs: Array<{ path: string; base64: string }>) =>
  sha(Buffer.from(shelfListing(fs.map(f => ({ path: f.path, sha256: sha(Buffer.from(f.base64, 'base64')) }))), 'utf8'))
const publishReq = (r: { id: string; version: string }, expectedVersion: string | null, as: string) =>
  call('POST', co(`/skill-shelf-requests/${r.id}/publish`), { requestVersion: r.version, expectedVersion }, as)
const declineReq = (r: { id: string; version: string }, as: string, reason?: string) =>
  call('POST', co(`/skill-shelf-requests/${r.id}/decline`), { requestVersion: r.version, reason }, as)
const stored = () => (db.prepare('SELECT COUNT(*) AS n FROM shelf_requests WHERE company_id = ?').get(none) as { n: number }).n

function addMembers(companyId: string, people: Array<[string, string]>) {
  const at = new Date().toISOString()
  for (const [user, role] of people) {
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(`m-${companyId}-${user}`, user, companyId, role, at, at)
  }
}

let groupId: string

beforeAll(async () => {
  initDatabase()
  process.env.OPERATOR_USER_IDS = 'rq-owner'
  setRepoGitTimeoutsForTests({ local: 60_000, push: 120_000 })
  process.env.GIT_TEMPLATE_DIR = mkdtempSync(join(tmpdir(), 'acb-rq-templates-'))
  none = (await call('POST', '/api/companies', { name: 'Request Co', folderKind: 'none' })).body.data.id
  other = (await call('POST', '/api/companies', { name: 'Other Request Co', folderKind: 'none' })).body.data.id
  git = (await call('POST', '/api/companies', { name: 'Git Request Co' })).body.data.id
  addMembers(none, PEOPLE)
  addMembers(git, [['rq-bob', 'member']])
  for (const d of (await call('GET', co('/departments'))).body.data) dept[d.folder] = d.id
  expect((await call('PUT', co(`/departments/${dept['営業部']}/managers`), { userIds: ['rq-mgr'] })).status).toBe(200)
  expect((await call('PUT', co('/skill-editors'), { departmentId: null, userIds: ['rq-editor'] })).status).toBe(200)
  // 人事部: read and written only by a group (carol); the company-wide skill editor does not read it.
  const group = await call('POST', co('/groups'), { name: '人事の人', userIds: ['rq-carol'] })
  groupId = group.body.data.id
  expect((await call('PUT', co('/permissions/scopes/by-path'), {
    path: '人事部',
    rules: [{ subjectType: 'everyone', canRead: false, canWrite: false }, { subjectType: 'group', subjectId: groupId, canRead: true, canWrite: true }],
  })).status).toBe(200)
})

describe('who asks', () => {
  it('a member who may not publish asks; someone who may publish there is told to publish', async () => {
    const made = await ask('quote', null, 'rq-bob')
    expect(made.status).toBe(201)
    expect(made.body.data).toMatchObject({ name: 'quote', department: null, state: 'pending', mine: true, canDecide: false, requestedBy: { id: 'rq-bob' } })
    for (const who of ['rq-owner', 'rq-editor']) {
      expect(await ask('quote', null, who)).toMatchObject({ status: 409, body: { code: 'SHELF_REQUEST_NOT_NEEDED' } })
    }
    // A department's manager publishes there, so asks only elsewhere.
    expect(await ask('sales', dept['営業部'], 'rq-mgr')).toMatchObject({ status: 409, body: { code: 'SHELF_REQUEST_NOT_NEEDED' } })
    expect((await ask('mgr-company', null, 'rq-mgr')).status).toBe(201)
  })

  it('what no publisher could take is refused when sent, with publishing\'s reasons, and nothing is stored', async () => {
    const before = stored()
    const hooks = await ask('hooked', null, 'rq-bob', '---\nname: h\ndescription: d\nhooks:\n  PreToolUse: []\n---\nbody\n')
    expect(hooks).toMatchObject({ status: 403, body: { code: 'SHELF_NOT_ALLOWED', files: [{ path: 'SKILL.md', reason: 'autorun' }] } })
    const bang = await ask('banged', null, 'rq-bob', '---\nname: b\ndescription: d\n---\n!`rm -rf ~`\n')
    expect(bang.body.files[0].reason).toBe('autorun')
    const mcp = await ask('with-mcp', null, 'rq-bob', SKILL, { '.mcp.json': '{}' })
    expect(mcp).toMatchObject({ status: 403, body: { code: 'SHELF_NOT_ALLOWED', files: [{ path: '.mcp.json', reason: 'owner-admin-only' }] } })
    const secret = await ask('secret', null, 'rq-bob', SKILL, { 'notes.txt': `key: ${'AKIA'}${'ABCDEFGHIJKLMNOP'}` })
    expect(secret).toMatchObject({ status: 400, body: { code: 'SHELF_SECRET_DETECTED' } })
    const outside = await call('POST', co('/skill-shelf-requests'), { departmentId: null, name: 'out', files: [...files(), { path: '../x', base64: b64('x') }] }, 'rq-bob')
    expect(outside).toMatchObject({ status: 400, body: { code: 'SHELF_BAD_PATH' } })
    expect((await call('POST', co('/skill-shelf-requests'), { departmentId: null, name: 'Bad Name', files: files() }, 'rq-bob')).body.code).toBe('SHELF_BAD_NAME')
    expect((await call('POST', co('/skill-shelf-requests'), { departmentId: null, name: 'nomd', files: [{ path: 'a.txt', base64: b64('a') }] }, 'rq-bob')).body.code).toBe('SHELF_NO_SKILL_MD')
    expect(stored()).toBe(before)
  })
})

describe('who sees a request', () => {
  it('its sender and those who may publish there; not other members', async () => {
    const sales = await ask('sales-quote', dept['営業部'], 'rq-bob')
    expect(sales.status).toBe(201)
    const id = sales.body.data.id
    for (const who of ['rq-owner', 'rq-editor', 'rq-mgr']) {
      const seen = (await listed(who)).body.data.requests.find((r: Json) => r.id === id)
      expect(seen).toMatchObject({ canDecide: true, mine: false, department: { id: dept['営業部'], name: '営業部' } })
      expect((await call('GET', co(`/skill-shelf-requests/${id}/files`), undefined, who)).status).toBe(200)
    }
    expect((await listed('rq-bob')).body.data.requests.find((r: Json) => r.id === id)).toMatchObject({ mine: true, canDecide: false })
    expect((await call('GET', co(`/skill-shelf-requests/${id}/files`), undefined, 'rq-bob')).body.data.files).toEqual(files())
    // Another plain member: not listed, and its files answer as for a request that does not exist.
    expect((await listed('rq-dan')).text).not.toContain(id)
    const theirs = await call('GET', co(`/skill-shelf-requests/${id}/files`), undefined, 'rq-dan')
    expect(theirs).toEqual(await call('GET', co('/skill-shelf-requests/no-such/files'), undefined, 'rq-dan'))
    expect(theirs.status).toBe(404)
  })

  it('a department request never reaches anyone who cannot read the department, its name included', async () => {
    const hr = await ask('hr-quote', dept['人事部'], 'rq-carol')
    expect(hr.status).toBe(201)
    const id = hr.body.data.id
    expect((await listed('rq-owner')).body.data.requests.find((r: Json) => r.id === id)).toMatchObject({ canDecide: true })
    // A company-wide skill editor who does not read 人事部.
    const editor = await listed('rq-editor')
    expect(editor.text).not.toContain(id)
    expect(editor.text).not.toContain('人事部')
    const files404 = await call('GET', co(`/skill-shelf-requests/${id}/files`), undefined, 'rq-editor')
    expect(files404).toEqual(await call('GET', co('/skill-shelf-requests/no-such/files'), undefined, 'rq-editor'))
    for (const action of ['publish', 'decline']) {
      const a = await call('POST', co(`/skill-shelf-requests/${id}/${action}`), { expectedVersion: null }, 'rq-editor')
      expect(a).toEqual(await call('POST', co(`/skill-shelf-requests/no-such/${action}`), { expectedVersion: null }, 'rq-editor'))
    }
    // Out of the group, the sender no longer sees it either (nor the department's name).
    expect((await myRequests('rq-carol')).map(r => r.id)).toContain(id)
    expect((await call('PUT', co(`/groups/${groupId}/members`), { userIds: [] })).status).toBe(200)
    const mine = await call('GET', co('/me/skill-shelf'), undefined, 'rq-carol')
    expect(mine.text).not.toContain(id)
    expect(mine.text).not.toContain('人事部')
    expect((await listed('rq-carol')).text).not.toContain(id)
    const gone = await call('GET', co(`/skill-shelf-requests/${id}/files`), undefined, 'rq-carol')
    expect(gone).toEqual(await call('GET', co('/skill-shelf-requests/no-such/files'), undefined, 'rq-carol'))
    expect((await call('PUT', co(`/groups/${groupId}/members`), { userIds: ['rq-carol'] })).status).toBe(200)
  })

  it("another company's request is one that does not exist, and is left unchanged", async () => {
    addMembers(other, [['rq-bob', 'member']])
    const theirs = await call('POST', `/api/companies/${other}/skill-shelf-requests`, { departmentId: null, name: 'theirs', files: files() }, 'rq-bob')
    expect(theirs.status).toBe(201)
    const id = theirs.body.data.id
    expect(await call('POST', co(`/skill-shelf-requests/${id}/decline`), {})).toEqual(await call('POST', co('/skill-shelf-requests/no-such/decline'), {}))
    expect(await call('GET', co(`/skill-shelf-requests/${id}/files`))).toEqual(await call('GET', co('/skill-shelf-requests/no-such/files')))
    expect(db.prepare('SELECT state FROM shelf_requests WHERE company_id = ? AND id = ?').get(other, id)).toEqual({ state: 'pending' })
  })
})

describe('公開する and 見送る', () => {
  it('the sender cannot decide; a publisher publishes once, as a new version noting who asked; its files go', async () => {
    const made = await ask('estimate', null, 'rq-bob', SKILL, { 'tools/a.txt': 'tool' })
    const id = made.body.data.id
    expect(await publishReq(made.body.data, null, 'rq-bob')).toMatchObject({ status: 403, body: { code: 'SHELF_REQUEST_NOT_DECIDER' } })
    const done = await publishReq(made.body.data, null, 'rq-editor')
    expect(done.status).toBe(200)
    expect(done.body.data.request).toMatchObject({ state: 'published', decidedBy: { id: 'rq-editor' }, publishedVersion: expect.any(String) })
    expect(done.body.data.item).toMatchObject({ kind: 'skill', name: 'estimate', department: null, fileCount: 2 })
    const versions = await call('GET', co(`/skill-shelf/${done.body.data.item.id}/versions`))
    expect(versions.body.data.history[0]).toMatchObject({ action: 'publish', by: { id: 'rq-editor' }, requestedBy: { id: 'rq-bob', name: 'Name rq-bob' } })
    expect(done.body.data.request.publishedVersion).toBe(done.body.data.item.version)
    // Decided: no second decision, no files kept.
    expect(await publishReq(made.body.data, null, 'rq-owner')).toMatchObject({ status: 409, body: { code: 'SHELF_REQUEST_DECIDED' } })
    expect(await declineReq(made.body.data, 'rq-owner')).toMatchObject({ status: 409, body: { code: 'SHELF_REQUEST_DECIDED' } })
    expect(await call('GET', co(`/skill-shelf-requests/${id}/files`), undefined, 'rq-bob')).toMatchObject({ status: 409, body: { code: 'SHELF_REQUEST_DECIDED' } })
    expect(db.prepare('SELECT files FROM shelf_requests WHERE company_id = ? AND id = ?').get(none, id)).toEqual({ files: null })
    expect((await myRequests('rq-bob')).find(r => r.id === id)).toMatchObject({ state: 'published', decidedAt: expect.any(String) })
  })

  it('公開する runs the whole publish check with the publisher\'s authority (a request stored before a rule changed)', async () => {
    // As an older server could have kept it: auto-run parts the request check now refuses.
    const hooked = '---\nname: h\ndescription: d\nhooks:\n  PreToolUse: []\n---\nbody\n'
    db.prepare(`INSERT INTO shelf_requests (id, company_id, department_id, name, requested_by, requested_at, version, files, file_count, total_bytes, autorun, state)
        VALUES ('rq-old', ?, NULL, 'old-hooked', 'rq-bob', ?, ?, ?, 1, ?, 0, 'pending')`)
      .run(none, new Date().toISOString(), versionOfFiles(files(hooked)), JSON.stringify(files(hooked)), hooked.length)
    const old = { id: 'rq-old', version: versionOfFiles(files(hooked)) }
    expect(await publishReq(old, null, 'rq-editor'))
      .toMatchObject({ status: 403, body: { code: 'SHELF_NOT_ALLOWED', files: [{ path: 'SKILL.md', reason: 'autorun' }] } })
    expect((await publishReq(old, null, 'rq-owner')).status).toBe(200)
  })

  it('publishing checks the version the publisher saw, like any publish', async () => {
    const first = await ask('versioned', null, 'rq-bob')
    expect((await publishReq(first.body.data, null, 'rq-owner')).status).toBe(200)
    const again = await ask('versioned', null, 'rq-bob', `${SKILL}二つめ。\n`)
    expect(again.body.data.currentVersion).toMatch(/^[0-9a-f]{64}$/)
    expect(await publishReq(again.body.data, null, 'rq-owner'))
      .toMatchObject({ status: 409, body: { code: 'SHELF_VERSION_CHANGED', currentVersion: again.body.data.currentVersion } })
    expect((await publishReq(again.body.data, again.body.data.currentVersion, 'rq-owner')).status).toBe(200)
  })

  it('見送る with a short reason (or none); the sender sees it', async () => {
    const made = await ask('declined', null, 'rq-bob')
    const id = made.body.data.id
    const long = await declineReq(made.body.data, 'rq-owner', 'あ'.repeat(SHELF_REQUEST_LIMITS.reasonLength + 1))
    expect(long).toMatchObject({ status: 400, body: { code: 'SHELF_BAD_REASON' } })
    const done = await declineReq(made.body.data, 'rq-owner', '  いまは使わないため  ')
    expect(done.body.data.request).toMatchObject({ state: 'declined', reason: 'いまは使わないため', decidedBy: { id: 'rq-owner' } })
    expect((await myRequests('rq-bob')).find(r => r.id === id)).toMatchObject({ state: 'declined', reason: 'いまは使わないため' })
    expect(db.prepare('SELECT files FROM shelf_requests WHERE company_id = ? AND id = ?').get(none, id)).toEqual({ files: null })
    // Asking again at the same place replaces the decided request with a pending one, under a new id.
    const again = await ask('declined', null, 'rq-bob', `${SKILL}直しました。\n`)
    expect(again.body.data).toMatchObject({ state: 'pending' })
    expect(again.body.data.id).not.toBe(id)
  })

  it('a request sent again after it was looked at: the old id and the old version decide nothing', async () => {
    const first = await ask('swap', null, 'rq-bob')
    const seen = (await call('GET', co(`/skill-shelf-requests/${first.body.data.id}/files`), undefined, 'rq-owner')).body.data
    expect(seen.version).toBe(first.body.data.version)
    // Swapped after the owner looked: a new id, the old one gone.
    const swapped = await ask('swap', null, 'rq-bob', `${SKILL}あとから足した中身。\n`)
    expect(swapped.body.data.id).not.toBe(first.body.data.id)
    expect(await publishReq(seen, null, 'rq-owner')).toMatchObject({ status: 404, body: { code: 'SHELF_REQUEST_NOT_FOUND' } })
    expect(await declineReq(seen, 'rq-owner')).toMatchObject({ status: 404, body: { code: 'SHELF_REQUEST_NOT_FOUND' } })
    // The new request with the version looked at before: refused, nothing published or decided.
    const changed = await publishReq({ id: swapped.body.data.id, version: seen.version }, null, 'rq-owner')
    expect(changed).toMatchObject({ status: 409, body: { code: 'SHELF_REQUEST_CHANGED', error: 'お願いの中身が変わりました。もう一度中身を見てください。' } })
    expect(await declineReq({ id: swapped.body.data.id, version: seen.version }, 'rq-owner')).toMatchObject({ status: 409, body: { code: 'SHELF_REQUEST_CHANGED' } })
    expect(await call('POST', co(`/skill-shelf-requests/${swapped.body.data.id}/publish`), { expectedVersion: null }, 'rq-owner')).toMatchObject({ status: 400, body: { code: 'SHELF_BAD_VERSION' } })
    expect((await call('GET', co('/skill-shelf'))).body.data.items.some((i: Json) => i.name === 'swap')).toBe(false)
    expect(db.prepare('SELECT state FROM shelf_requests WHERE company_id = ? AND id = ?').get(none, swapped.body.data.id)).toEqual({ state: 'pending' })
    // Looked at again: the new version publishes what was shown.
    const now = (await call('GET', co(`/skill-shelf-requests/${swapped.body.data.id}/files`), undefined, 'rq-owner')).body.data
    const done = await publishReq(now, null, 'rq-owner')
    expect(done.status).toBe(200)
    expect(done.body.data.item.version).toBe(now.version)
  })

  it('the files kept with a request are the version it names and follow the upload rules, or nothing is published', async () => {
    const made = await ask('tampered', null, 'rq-bob')
    // Files no longer matching the request's version (changed underneath): refused.
    db.prepare('UPDATE shelf_requests SET files = ? WHERE company_id = ? AND id = ?').run(JSON.stringify(files(`${SKILL}違う。\n`)), none, made.body.data.id)
    expect(await publishReq(made.body.data, null, 'rq-owner')).toMatchObject({ status: 409, body: { code: 'SHELF_REQUEST_CHANGED' } })
    // Files breaking the upload rules (a path no publish takes): refused with publishing's answer.
    const bad = [...files(), { path: '../escape.txt', base64: b64('x') }]
    db.prepare('UPDATE shelf_requests SET files = ?, version = ? WHERE company_id = ? AND id = ?').run(JSON.stringify(bad), versionOfFiles(bad), none, made.body.data.id)
    const refused = await publishReq({ id: made.body.data.id, version: versionOfFiles(bad) }, null, 'rq-owner')
    expect(refused.status).toBe(400)
    expect((await call('GET', co('/skill-shelf'))).body.data.items.some((i: Json) => i.name === 'tampered')).toBe(false)
  })
})

describe('limits', () => {
  it('a member has at most a few pending requests; a new one at the same place replaces theirs', async () => {
    for (let i = 0; i < SHELF_REQUEST_LIMITS.pendingPerMember; i++) expect((await ask(`dan-${i}`, null, 'rq-dan')).status).toBe(201)
    expect(await ask('dan-more', null, 'rq-dan')).toMatchObject({ status: 409, body: { code: 'SHELF_REQUEST_LIMIT' } })
    const replaced = await ask('dan-0', null, 'rq-dan', `${SKILL}新しい中身。\n`)
    expect(replaced.status).toBe(201)
    expect((db.prepare("SELECT COUNT(*) AS n FROM shelf_requests WHERE company_id = ? AND requested_by = 'rq-dan'").get(none) as { n: number }).n).toBe(SHELF_REQUEST_LIMITS.pendingPerMember)
  })

  it('a company has at most so many pending requests and bytes; those of someone who left do not count', async () => {
    const at = new Date().toISOString()
    const fill = (n: number, bytes: number) => {
      for (let i = 0; i < n; i++) {
        db.prepare(`INSERT INTO shelf_requests (id, company_id, department_id, name, requested_by, requested_at, version, files, file_count, total_bytes, autorun, state)
            VALUES (?, ?, NULL, ?, 'rq-fill', ?, ?, '[]', 1, ?, 0, 'pending')`).run(`fill-${i}`, none, `fill-${i}`, at, 'b'.repeat(64), bytes)
      }
    }
    const clear = () => db.prepare("DELETE FROM shelf_requests WHERE company_id = ? AND (id LIKE 'fill-%' OR requested_by = 'rq-carol')").run(none)
    const leave = () => db.prepare("DELETE FROM memberships WHERE company_id = ? AND user_id = 'rq-fill'").run(none)
    try {
      clear()
      const pending = (db.prepare("SELECT COUNT(*) AS n FROM shelf_requests WHERE company_id = ? AND state = 'pending'").get(none) as { n: number }).n
      // Count: filled up to the limit by a member still in the company.
      addMembers(none, [['rq-fill', 'member']])
      fill(SHELF_REQUEST_LIMITS.pendingPerCompany - pending, 1)
      expect(await ask('one-too-many', null, 'rq-carol')).toMatchObject({ status: 409, body: { code: 'SHELF_REQUEST_LIMIT', error: expect.stringContaining('会社全体') } })
      // The same rows from someone who left the company: nobody waits on them.
      leave()
      expect((await ask('one-too-many', null, 'rq-carol')).status).toBe(201)
      clear()
      // Bytes: one pending request holding all of them.
      addMembers(none, [['rq-fill', 'member']])
      fill(1, SHELF_REQUEST_LIMITS.pendingCompanyBytes)
      expect(await ask('too-big', null, 'rq-carol')).toMatchObject({ status: 409, body: { code: 'SHELF_REQUEST_LIMIT', error: expect.stringContaining('会社全体') } })
    } finally {
      clear()
      leave()
    }
  })
})

describe('a company with the shared folder', () => {
  it('every request endpoint answers 409 SKILL_SHELF_NOT_HERE', async () => {
    const g = (p: string) => `/api/companies/${git}${p}`
    const answers = [
      await call('GET', g('/skill-shelf-requests'), undefined, 'rq-bob'),
      await call('POST', g('/skill-shelf-requests'), { departmentId: null, name: 'x', files: files() }, 'rq-bob'),
      await call('GET', g('/skill-shelf-requests/any/files')),
      await call('POST', g('/skill-shelf-requests/any/publish'), { expectedVersion: null, requestVersion: 'a'.repeat(64) }),
      await call('POST', g('/skill-shelf-requests/any/decline'), {}),
    ]
    for (const a of answers) expect(a).toMatchObject({ status: 409, body: { code: 'SKILL_SHELF_NOT_HERE' } })
  })
})
