/**
 * Integration Test: groups (見える人のまとまり) and read-restricted places in a company without the
 * shared folder (server.md "Groups", owner decisions 2026-11-07).
 *
 * Guards:
 * - groups are kept by owners/admins only (a member and a department manager get 403 and no
 *   name); one name once; members of the company only; a group some rule names cannot be deleted
 *   (409 GROUP_IN_USE with the places); a member leaving the company leaves every group; another
 *   company's group is a group that does not exist; every change is in permission_history;
 * - a department (or a place inside one) restricted to a group: its records are seen only by the
 *   group's members and owners/admins — on every path (detail, query + count, 探す, あなたの番,
 *   見られる人, notices, the AI's token routes); a change of who is in the group applies at once;
 * - a place inside a restricted place cannot be widened by a deeper rule;
 * - names never leak: a member (or a manager) who cannot read a place does not get its name from
 *   /me/write-access, /permissions or the place refusal (the same answer as a place that does
 *   not exist);
 * - only owners/admins change who reads: a manager's restricting rule, any edit at or inside a
 *   restricted place, and a manager adding people to a department that grants read there → 403;
 *   a department holding a restricted place cannot be deleted (409 RESTRICTED_PLACES_INSIDE);
 * - a company with the shared folder is unchanged: read restriction outside private folders and
 *   group rules are refused, and a stored `everyone: no read` row there is not a gate.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest'

const currentUser = vi.hoisted(() => ({ id: 'rp-owner' as string | null }))
vi.mock('../../src/lib/auth', () => ({
  getUserFromRequest: vi.fn().mockImplementation(async () =>
    currentUser.id ? { id: currentUser.id, email: `${currentUser.id}@example.com`, name: currentUser.id, image: null, emailVerified: true } : null),
  getUsersByIds: vi.fn().mockReturnValue(new Map()),
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
import { permissionsRoute } from '../../src/routes/permissions'
import { permissionRulesRoute } from '../../src/routes/permission-rules'
import { groupsRoute } from '../../src/routes/groups'
import { recordsRoute } from '../../src/routes/records'
import { recordsAiRoute } from '../../src/routes/records-ai'
import { viewersRoute } from '../../src/routes/viewers'
import { notificationsRoute } from '../../src/routes/notifications'
import { setRepoGitTimeoutsForTests } from '../../src/adapters/git-repo-store'
import { listScopesWithRules } from '../../src/adapters/sqlite/permission-store'
import { services } from '../../src/composition'

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })

const app = new Hono()
app.route('/api/companies', companiesRoute)
app.route('/api/companies/:companyId/departments', departmentsRoute)
app.route('/api/companies/:companyId', permissionsRoute)
app.route('/api/companies/:companyId', permissionRulesRoute)
app.route('/api/companies/:companyId', groupsRoute)
app.route('/api/companies/:companyId', recordsRoute)
app.route('/api/companies/:companyId', viewersRoute)
app.route('/api/companies/:companyId', notificationsRoute)
app.route('/api/records-ai', recordsAiRoute)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

async function call(method: string, path: string, body?: unknown, as = 'rp-owner', headers: Record<string, string> = {}) {
  currentUser.id = as
  try {
    const res = await app.request(path, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    const text = await res.text()
    let json: Json = null
    try { json = JSON.parse(text) } catch { json = text }
    return { status: res.status, body: json, text }
  } finally {
    currentUser.id = 'rp-owner'
  }
}

let none: string
let other: string
let git: string
const co = (path: string) => `/api/companies/${none}${path}`
const PEOPLE: Array<[string, string]> = [['rp-admin', 'admin'], ['rp-alice', 'member'], ['rp-bob', 'member'], ['rp-mgr', 'member'], ['rp-carol', 'member']]
let hrId: string
let groupId: string

function addMembers(companyId: string, people: Array<[string, string]>) {
  const at = new Date().toISOString()
  for (const [user, role] of people) {
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(`m-${companyId}-${user}`, user, companyId, role, at, at)
  }
}

beforeAll(async () => {
  initDatabase()
  process.env.OPERATOR_USER_IDS = 'rp-owner'
  setRepoGitTimeoutsForTests({ local: 60_000, push: 120_000 })
  process.env.GIT_TEMPLATE_DIR = mkdtempSync(join(tmpdir(), 'acb-rp-templates-'))
  const a = await call('POST', '/api/companies', { name: 'Restricted Co', folderKind: 'none' })
  expect(a.status).toBe(201)
  none = a.body.data.id
  const b = await call('POST', '/api/companies', { name: 'Other Co', folderKind: 'none' })
  other = b.body.data.id
  const g = await call('POST', '/api/companies', { name: 'Git Co' })
  expect(g.status).toBe(201)
  git = g.body.data.id
  addMembers(none, PEOPLE)
  addMembers(git, [['rp-bob', 'member']])
  const departments = await call('GET', co('/departments'))
  hrId = departments.body.data.find((d: Json) => d.folder === '人事部').id
  expect((await call('PUT', co(`/departments/${hrId}/managers`), { userIds: ['rp-mgr'] })).status).toBe(200)
})

const history = (companyId: string) =>
  db.prepare('SELECT action, by_user AS byUser, detail FROM permission_history WHERE company_id = ? ORDER BY seq').all(companyId) as Array<{ action: string; byUser: string; detail: string }>

describe('groups: kept by owners and admins', () => {
  it('an owner and an admin create, rename and fill a group; a member and a manager get 403 and no name', async () => {
    const made = await call('POST', co('/groups'), { name: '採用チーム', userIds: ['rp-alice'] })
    expect(made.status).toBe(201)
    groupId = made.body.data.id
    expect(made.body.data).toMatchObject({ name: '採用チーム', memberIds: ['rp-alice'], usedIn: [] })
    expect((await call('PATCH', co(`/groups/${groupId}`), { name: '採用の人' }, 'rp-admin')).body.data.name).toBe('採用の人')
    for (const who of ['rp-bob', 'rp-mgr']) {
      const listed = await call('GET', co('/groups'), undefined, who)
      expect(listed.status).toBe(403)
      expect(listed.text).not.toContain('採用')
      expect((await call('POST', co('/groups'), { name: 'x' }, who)).status).toBe(403)
      expect((await call('PUT', co(`/groups/${groupId}/members`), { userIds: [who] }, who)).status).toBe(403)
      expect((await call('DELETE', co(`/groups/${groupId}`), undefined, who)).status).toBe(403)
    }
    expect((await call('GET', co('/groups'))).body.data.groups.map((g: Json) => g.name)).toEqual(['採用の人'])
  })

  it('one name once (A–Z folded), members of the company only, names 1–40 characters', async () => {
    expect((await call('POST', co('/groups'), { name: 'Team' })).status).toBe(201)
    const again = await call('POST', co('/groups'), { name: ' team ' })
    expect(again).toMatchObject({ status: 409, body: { code: 'GROUP_NAME_TAKEN' } })
    expect((await call('POST', co('/groups'), { name: 'よそ', userIds: ['someone-else'] })).body.code).toBe('BAD_MEMBER')
    expect((await call('POST', co('/groups'), { name: '' })).body.code).toBe('BAD_GROUP_NAME')
    expect((await call('POST', co('/groups'), { name: 'あ'.repeat(41) })).body.code).toBe('BAD_GROUP_NAME')
  })

  it("another company's group is a group that does not exist", async () => {
    const theirs = await call('POST', `/api/companies/${other}/groups`, { name: 'よその会社' })
    expect(theirs.status).toBe(201)
    const missing = await call('PATCH', co('/groups/no-such-group'), { name: 'z' })
    const cross = await call('PATCH', co(`/groups/${theirs.body.data.id}`), { name: 'z' })
    expect(cross).toEqual(missing)
    expect(cross.status).toBe(404)
    expect((await call('PUT', co('/permissions/scopes/by-path'), { path: '経理部', rules: [{ subjectType: 'everyone', canRead: false, canWrite: false }, { subjectType: 'group', subjectId: theirs.body.data.id, canWrite: false }] })).body.error).toBe('Unknown group')
    expect(listScopesWithRules(db, other).flatMap(s => s.rules).some(r => r.subjectType === 'group')).toBe(false)
  })
})

describe('a department restricted to a group', () => {
  let open: string
  let hidden: string
  let deeper: string
  const TITLE = '採用面接の評価'

  beforeAll(async () => {
    // Made while 人事部 is open: bob's request (his turn, his notice).
    const t = await call('POST', co('/records/item'), { type: 'task', title: `${TITLE}（前から）`, folder: '人事部', fields: { assignee: 'rp-bob' } })
    expect(t.status).toBe(201)
    open = t.body.data.record.id
    const notices = await call('GET', co('/me/notifications'), undefined, 'rp-bob')
    expect(notices.text).toContain(`${TITLE}（前から）`)

    const put = await call('PUT', co('/permissions/scopes/by-path'), {
      path: '人事部',
      rules: [{ subjectType: 'everyone', canRead: false, canWrite: false }, { subjectType: 'group', subjectId: groupId, canRead: true, canWrite: true }],
    })
    expect(put.status).toBe(200)
    const h = await call('POST', co('/records/item'), { type: 'task', title: TITLE, folder: '人事部', fields: { assignee: 'rp-alice' } })
    expect(h.status).toBe(201)
    hidden = h.body.data.record.id
    // A place inside it that says everyone reads: the department's restriction still holds.
    expect((await call('PUT', co('/permissions/scopes/by-path'), { path: '人事部/面接', rules: [{ subjectType: 'everyone', canRead: true, canWrite: true }] })).status).toBe(200)
    const d = await call('POST', co('/records/item'), { type: 'task', title: `${TITLE}（面接）`, folder: '人事部/面接', fields: { assignee: 'rp-alice' } })
    expect(d.status).toBe(201)
    deeper = d.body.data.record.id
  })

  const leaks = async (who: string) => {
    const answers = [
      await call('POST', co('/records/query'), { type: 'task', limit: 200 }, who),
      await call('POST', co('/records/query'), { type: 'task', text: '採用', countOnly: true }, who),
      await call('POST', co('/records/find'), { text: '採用', today: '2026-11-07' }, who),
      await call('GET', co('/records/my-turn'), undefined, who),
      await call('POST', co('/viewers'), { records: [open, hidden, deeper] }, who),
      await call('GET', co('/me/notifications'), undefined, who),
    ]
    return answers.map(a => a.text).join('\n')
  }

  it('a member outside the group finds them nowhere: detail, query, count, 探す, あなたの番, 見られる人, notices', async () => {
    for (const id of [open, hidden, deeper]) {
      const missing = await call('GET', co('/records/item/record-that-is-not-there'), undefined, 'rp-bob')
      expect(await call('GET', co(`/records/item/${id}`), undefined, 'rp-bob')).toMatchObject({ status: missing.status, body: missing.body })
    }
    const seen = await leaks('rp-bob')
    expect(seen).not.toContain(TITLE)
    for (const id of [open, hidden, deeper]) expect(seen).not.toContain(id)
    const count = await call('POST', co('/records/query'), { type: 'task', text: '採用', countOnly: true }, 'rp-bob')
    expect(count.body.data.total).toBe(0)
  })

  it("the AI's token routes leave them out too", async () => {
    const issued = await call('POST', co('/me/record-tokens'), { conversationId: 'rp-conv', agent: 'claude-code', scope: 'read' }, 'rp-bob')
    expect(issued.status).toBe(201)
    const auth = { Authorization: `Bearer ${issued.body.data.token}` }
    const answers = [
      await call('POST', '/api/records-ai/query', { type: 'task' }, 'none', auth),
      await call('GET', '/api/records-ai/my-turn', undefined, 'none', auth),
      await call('GET', `/api/records-ai/item/${hidden}`, undefined, 'none', auth),
    ]
    expect(answers[0].status).toBe(200)
    expect(answers[2].status).toBe(404)
    expect(answers.map(a => a.text).join('\n')).not.toContain(TITLE)
  })

  it("the group's members, owners and admins read them; a manager outside the group does not", async () => {
    for (const who of ['rp-alice', 'rp-owner', 'rp-admin']) {
      for (const id of [hidden, deeper]) expect((await call('GET', co(`/records/item/${id}`), undefined, who)).status).toBe(200)
    }
    expect((await call('GET', co(`/records/item/${hidden}`), undefined, 'rp-mgr')).status).toBe(404)
    expect(await leaks('rp-alice')).toContain(TITLE)
  })

  it('who is in the group decides at once', async () => {
    expect((await call('PUT', co(`/groups/${groupId}/members`), { userIds: ['rp-bob'] })).status).toBe(200)
    expect((await call('GET', co(`/records/item/${hidden}`), undefined, 'rp-bob')).status).toBe(200)
    expect((await call('GET', co(`/records/item/${hidden}`), undefined, 'rp-alice')).status).toBe(404)
    expect((await call('PUT', co(`/groups/${groupId}/members`), { userIds: ['rp-alice'] })).status).toBe(200)
    expect((await call('GET', co(`/records/item/${hidden}`), undefined, 'rp-bob')).status).toBe(404)
    expect((await call('GET', co(`/records/item/${hidden}`), undefined, 'rp-alice')).status).toBe(200)
  })

  it('a group a rule names cannot be deleted; the answer names the places', async () => {
    const r = await call('DELETE', co(`/groups/${groupId}`))
    expect(r).toMatchObject({ status: 409, body: { code: 'GROUP_IN_USE', places: ['人事部'] } })
    expect((await call('GET', co('/groups'))).body.data.groups.find((g: Json) => g.id === groupId).usedIn).toEqual(['人事部'])
  })

  it('every change of groups and rules is recorded: who and what', () => {
    const entries = history(none)
    expect(entries.map(e => e.action)).toEqual(expect.arrayContaining(['group-create', 'group-rename', 'group-members', 'rules-replace']))
    const restricted = entries.find(e => e.action === 'rules-replace' && JSON.parse(e.detail).places[0].path === '人事部')!
    expect(restricted.byUser).toBe('rp-owner')
    expect(JSON.parse(restricted.detail).places[0].after).toEqual([
      { subjectType: 'everyone', subjectId: null, canRead: false, canWrite: false },
      { subjectType: 'group', subjectId: groupId, canRead: true, canWrite: true },
    ])
    expect(entries.find(e => e.action === 'group-rename')!.byUser).toBe('rp-admin')
  })
})

describe('names of places never leak', () => {
  beforeAll(async () => {
    // rp-mgr is in the group (reads 人事部) but not in 人事部/評価, read by alice alone.
    expect((await call('PUT', co(`/groups/${groupId}/members`), { userIds: ['rp-alice', 'rp-mgr'] })).status).toBe(200)
    expect((await call('PUT', co('/permissions/scopes/by-path'), {
      path: '人事部/評価',
      rules: [{ subjectType: 'everyone', canRead: false, canWrite: false }, { subjectType: 'user', subjectId: 'rp-alice', canRead: true, canWrite: true }],
    })).status).toBe(200)
  })

  it('/me/write-access names a restricted place to its readers only', async () => {
    const bob = await call('GET', co('/me/write-access'), undefined, 'rp-bob')
    expect(bob.status).toBe(200)
    expect(bob.text).not.toContain('人事部')
    // Neither may write there, so without the filter both places would be listed with write: false.
    const mgr = await call('GET', co('/me/write-access'), undefined, 'rp-mgr')
    expect(mgr.status).toBe(200)
    expect(mgr.text).not.toContain('評価')
  })

  it("a manager's /permissions leaves out what they cannot read; they edit nothing in a restricted place", async () => {
    const view = await call('GET', co('/permissions'), undefined, 'rp-mgr')
    expect(view.status).toBe(200)
    expect(view.text).not.toContain('評価')
    const folders = await call('GET', co(`/permissions/folders?path=${encodeURIComponent('人事部')}`), undefined, 'rp-mgr')
    expect(folders.status).toBe(403)
    expect(folders.text).not.toContain('評価')
    expect((await call('GET', co(`/permissions/folders?path=${encodeURIComponent('人事部')}`))).body.data.folders.map((f: Json) => f.name)).toEqual(['評価', '面接'])
  })

  it('placing a record in a place one cannot read answers like a place that does not exist', async () => {
    const body = (folder: string) => ({ type: 'task', title: 'どこかへ', folder, fields: { assignee: 'rp-bob' } })
    const nowhere = await call('POST', co('/records/item'), body('どこにもない'), 'rp-bob')
    expect(nowhere.status).toBe(400)
    for (const folder of ['人事部', '人事部/評価']) {
      expect(await call('POST', co('/records/item'), body(folder), 'rp-bob')).toMatchObject({ status: nowhere.status, body: nowhere.body })
    }
  })
})

describe('only owners and admins change who reads', () => {
  it("a manager cannot restrict their department, edit inside a restricted one, or add people where the department grants read", async () => {
    // 総務 is managed by rp-mgr too, and open.
    const departments = await call('GET', co('/departments'))
    const somu = departments.body.data.find((d: Json) => d.folder === '総務').id
    expect((await call('PUT', co(`/departments/${somu}/managers`), { userIds: ['rp-mgr'] })).status).toBe(200)
    const restrict = await call('PUT', co('/permissions/scopes/by-path'), { path: '総務', rules: [{ subjectType: 'everyone', canRead: false, canWrite: false }, { subjectType: 'user', subjectId: 'rp-mgr', canRead: true, canWrite: true }] }, 'rp-mgr')
    expect(restrict).toMatchObject({ status: 403, body: { code: 'READERS_OWNER_ONLY' } })
    expect((await call('POST', co('/permissions/rules'), { path: '総務', subjectType: 'everyone', canRead: false, canWrite: false }, 'rp-mgr')).status).toBe(403)
    // Write-only rules stay a manager's.
    expect((await call('POST', co('/permissions/rules'), { path: '総務', subjectType: 'everyone', canRead: true, canWrite: false }, 'rp-mgr')).status).toBe(201)
    expect((await call('PUT', co('/permissions/scopes/by-path'), { path: '人事部', rules: [{ subjectType: 'everyone', canRead: true, canWrite: true }] }, 'rp-mgr')).status).toBe(403)

    // 人事部 also lets the people who belong to 人事部 read: a manager may take people off, not add them.
    expect((await call('PUT', co('/permissions/scopes/by-path'), {
      path: '人事部',
      rules: [{ subjectType: 'everyone', canRead: false, canWrite: false }, { subjectType: 'group', subjectId: groupId, canRead: true, canWrite: true }, { subjectType: 'department', subjectId: hrId, canRead: true, canWrite: false }],
    })).status).toBe(200)
    expect((await call('PUT', co(`/departments/${hrId}/members`), { userIds: ['rp-carol'] })).status).toBe(200)
    const add = await call('PUT', co(`/departments/${hrId}/members`), { userIds: ['rp-carol', 'rp-bob'] }, 'rp-mgr')
    expect(add).toMatchObject({ status: 403, body: { code: 'READERS_OWNER_ONLY' } })
    expect((await call('PUT', co(`/departments/${hrId}/members`), { userIds: [] }, 'rp-mgr')).status).toBe(200)
    expect((await call('PUT', co(`/departments/${hrId}/members`), { userIds: ['rp-bob'] })).status).toBe(200)
    expect((await call('PUT', co(`/departments/${hrId}/members`), { userIds: [] })).status).toBe(200)
  })

  it('who belongs to a department is recorded with the rules: who, when, before and after', () => {
    const entries = history(none).filter(e => e.action === 'department-members').map(e => ({ by: e.byUser, ...JSON.parse(e.detail) }))
    expect(entries.filter(e => e.departmentId === hrId)).toEqual([
      { by: 'rp-owner', departmentId: hrId, before: [], after: ['rp-carol'] },
      { by: 'rp-mgr', departmentId: hrId, before: ['rp-carol'], after: [] },
      { by: 'rp-owner', departmentId: hrId, before: [], after: ['rp-bob'] },
      { by: 'rp-owner', departmentId: hrId, before: ['rp-bob'], after: [] },
    ])
    // The refused add left nothing behind.
    expect(entries.some(e => e.by === 'rp-mgr' && e.after.includes('rp-bob'))).toBe(false)
  })

  it('without the shared folder a rule that edits must also read', async () => {
    const r = await call('POST', co('/permissions/rules'), { path: '経理部', subjectType: 'user', subjectId: 'rp-bob', canRead: false, canWrite: true })
    expect(r).toMatchObject({ status: 400, body: { code: 'WRITE_NEEDS_READ' } })
  })

  it('a department holding a restricted place cannot be deleted', async () => {
    const r = await call('DELETE', co(`/departments/${hrId}`))
    expect(r).toMatchObject({ status: 409, body: { code: 'RESTRICTED_PLACES_INSIDE' } })
  })
})

describe('leaving the company', () => {
  it('takes the member out of every group and department, and records both', async () => {
    expect((await call('PUT', co(`/departments/${hrId}/members`), { userIds: ['rp-alice', 'rp-carol'] })).status).toBe(200)
    const r = await call('DELETE', `/api/companies/${none}/members/rp-alice`)
    expect(r.status).toBe(200)
    const g = (await call('GET', co('/groups'))).body.data.groups.find((x: Json) => x.id === groupId)
    expect(g.memberIds).not.toContain('rp-alice')
    const left = history(none).filter(e => JSON.parse(e.detail).via === 'left-company').map(e => ({ action: e.action, by: e.byUser, ...JSON.parse(e.detail) }))
    expect(left).toEqual([
      { action: 'department-members', by: 'rp-owner', departmentId: hrId, before: ['rp-alice', 'rp-carol'], after: ['rp-carol'], via: 'left-company' },
      { action: 'group-members', by: 'rp-owner', groupId, before: ['rp-alice', 'rp-mgr'], after: ['rp-mgr'], via: 'left-company' },
    ])
  })
})

describe('a company with the shared folder is unchanged', () => {
  const gco = (path: string) => `/api/companies/${git}${path}`

  it('refuses read restriction outside private folders and group rules', async () => {
    const read = await call('POST', gco('/permissions/rules'), { path: '人事部', subjectType: 'everyone', canRead: false, canWrite: false })
    expect(read).toMatchObject({ status: 400, body: { code: 'READ_RESTRICTION_UNAVAILABLE' } })
    const made = await call('POST', gco('/groups'), { name: 'git のまとまり' })
    expect(made.status).toBe(201)
    const named = await call('POST', gco('/permissions/rules'), { path: '人事部', subjectType: 'group', subjectId: made.body.data.id, canWrite: true })
    expect(named.status).toBe(400)
    expect(named.body.error).toMatch(/without the shared folder/)
  })

  it('a stored `everyone: no read` row there is not a read-restricted place', () => {
    const scope = db.prepare('SELECT id FROM scopes WHERE company_id = ? AND path = ?').get(git, '経理部') as { id: string }
    db.prepare('INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('rp-git-row', scope.id, 'everyone', null, 0, 0, new Date().toISOString())
    expect(listScopesWithRules(db, git).some(s => s.readRestricted)).toBe(false)
    expect(listScopesWithRules(db, none).filter(s => s.readRestricted).map(s => s.path).sort()).toEqual(['人事部', '人事部/評価'])
    void services
  })
})
