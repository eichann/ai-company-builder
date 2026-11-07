/**
 * Integration Test: the Skill shelf (「会社の Skill」, plugins.md "The Skill shelf") of a company
 * without the shared company folder.
 *
 * Guards:
 * - who may publish is the push checker's rule asked of the place path: owners/admins anywhere;
 *   「Skill を直せる人」 for the whole company or their department; a department manager inside their
 *   department; anyone else 403 SHELF_NOT_ALLOWED — and the place's write check still applies
 *   (a list grants no folder access);
 * - instruction texts and rule files: owners/admins, or a department's managers inside it (a skill
 *   editor is not enough); agent config inside a Skill folder: owners/admins only;
 * - auto-run parts (frontmatter hooks / mcpServers, `!` commands): owners/admins only, also when an
 *   earlier version is put back; text that is not the syntax passes;
 * - concurrency: a publish or restore against a version someone replaced → 409 with the current one;
 * - every version kept: restore an earlier one, take an item off, put it back;
 * - delivery and reading: a department restricted to a group — its items are listed, delivered
 *   and readable only by readers; anyone else gets the same answers as for an item / department
 *   that does not exist, and never its name; another company's item is one that does not exist;
 * - paths, names, sizes and secrets refused with their codes; nothing stored;
 * - the version is the sha256 of the canonical listing (the app recomputes it);
 * - a company with the shared folder: every endpoint 409 SKILL_SHELF_NOT_HERE.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest'

const currentUser = vi.hoisted(() => ({ id: 'sh-owner' as string | null }))
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

import { createHash } from 'crypto'
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

async function call(method: string, path: string, body?: unknown, as = 'sh-owner') {
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
    currentUser.id = 'sh-owner'
  }
}

let none: string
let other: string
let git: string
const co = (path: string) => `/api/companies/${none}${path}`
const PEOPLE: Array<[string, string]> = [
  ['sh-admin', 'admin'],
  ['sh-editor', 'member'], // 「Skill を直せる人」 for the whole company
  ['sh-sales-editor', 'member'], // 「Skill を直せる人」 for 営業部 only
  ['sh-mgr', 'member'], // 部署の管理役 of 営業部
  ['sh-bob', 'member'], // nothing
  ['sh-carol', 'member'], // in the group that reads 人事部
  ['sh-legal-editor', 'member'], // 「Skill を直せる人」 for 法務部, does not belong to it
]
const dept: Record<string, string> = {}

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64')
const skillFiles = (body: string, extra: Record<string, string> = {}) =>
  [{ path: 'SKILL.md', base64: b64(body) }, ...Object.entries(extra).map(([path, text]) => ({ path, base64: b64(text) }))]
const SKILL = '---\nname: x\ndescription: 見積を作る\n---\n見積の作り方。\n'
const publishSkill = (name: string, departmentId: string | null, body = SKILL, as = 'sh-owner', expectedVersion: string | null = null, extra: Record<string, string> = {}) =>
  call('POST', co('/skill-shelf'), { kind: 'skill', departmentId, name, files: skillFiles(body, extra), expectedVersion }, as)

function addMembers(companyId: string, people: Array<[string, string]>) {
  const at = new Date().toISOString()
  for (const [user, role] of people) {
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(`m-${companyId}-${user}`, user, companyId, role, at, at)
  }
}

beforeAll(async () => {
  initDatabase()
  process.env.OPERATOR_USER_IDS = 'sh-owner'
  setRepoGitTimeoutsForTests({ local: 60_000, push: 120_000 })
  process.env.GIT_TEMPLATE_DIR = mkdtempSync(join(tmpdir(), 'acb-sh-templates-'))
  const a = await call('POST', '/api/companies', { name: 'Shelf Co', folderKind: 'none' })
  expect(a.status).toBe(201)
  none = a.body.data.id
  other = (await call('POST', '/api/companies', { name: 'Other Shelf Co', folderKind: 'none' })).body.data.id
  const g = await call('POST', '/api/companies', { name: 'Git Shelf Co' })
  expect(g.status).toBe(201)
  git = g.body.data.id
  addMembers(none, PEOPLE)
  addMembers(git, [['sh-bob', 'member']])
  // A department made through the API: everyone reads, only the people who belong write.
  const legal = await call('POST', co('/departments'), { name: '法務部', folder: '法務部' })
  expect(legal.status).toBe(201)
  for (const d of (await call('GET', co('/departments'))).body.data) dept[d.folder] = d.id
  expect((await call('PUT', co(`/departments/${dept['営業部']}/managers`), { userIds: ['sh-mgr'] })).status).toBe(200)
  expect((await call('PUT', co('/skill-editors'), { departmentId: null, userIds: ['sh-editor'] })).status).toBe(200)
  expect((await call('PUT', co('/skill-editors'), { departmentId: dept['営業部'], userIds: ['sh-sales-editor'] })).status).toBe(200)
  expect((await call('PUT', co('/skill-editors'), { departmentId: dept['法務部'], userIds: ['sh-legal-editor'] })).status).toBe(200)
})

describe('a company with the shared folder', () => {
  it('every endpoint answers 409 SKILL_SHELF_NOT_HERE and nothing is stored', async () => {
    const g = (p: string) => `/api/companies/${git}${p}`
    const answers = [
      await call('GET', g('/skill-shelf')),
      await call('GET', g('/me/skill-shelf'), undefined, 'sh-bob'),
      await call('POST', g('/skill-shelf'), { kind: 'skill', departmentId: null, name: 'x', files: skillFiles(SKILL), expectedVersion: null }),
      await call('GET', g('/skill-shelf/any/versions')),
      await call('GET', g(`/skill-shelf/any/versions/${'0'.repeat(64)}`)),
      await call('POST', g('/skill-shelf/any/restore'), { version: '0'.repeat(64), expectedVersion: null }),
      await call('POST', g('/skill-shelf/any/unpublish'), { expectedVersion: null }),
    ]
    for (const a of answers) expect(a).toMatchObject({ status: 409, body: { code: 'SKILL_SHELF_NOT_HERE' } })
    expect(db.prepare('SELECT COUNT(*) AS n FROM shelf_items WHERE company_id = ?').get(git)).toEqual({ n: 0 })
  })
})

describe('who may publish a Skill (the push checker rule, by place)', () => {
  it('owner, admin and a company-wide skill editor publish a company Skill; a manager and a plain member are refused', async () => {
    expect((await publishSkill('quote', null)).status).toBe(201)
    expect((await publishSkill('quote-admin', null, SKILL, 'sh-admin')).status).toBe(201)
    expect((await publishSkill('quote-editor', null, SKILL, 'sh-editor')).status).toBe(201)
    for (const who of ['sh-mgr', 'sh-bob', 'sh-sales-editor']) {
      const refused = await publishSkill(`by-${who.slice(3)}`, null, SKILL, who)
      expect(refused).toMatchObject({ status: 403, body: { code: 'SHELF_NOT_ALLOWED', files: [{ path: 'SKILL.md', reason: 'not-allowed' }] } })
    }
    expect(db.prepare("SELECT COUNT(*) AS n FROM shelf_items WHERE company_id = ? AND name LIKE 'by-%'").get(none)).toEqual({ n: 0 })
  })

  it("a department's manager and its skill editor publish there, not in another department", async () => {
    expect((await publishSkill('sales-mgr', dept['営業部'], SKILL, 'sh-mgr')).status).toBe(201)
    expect((await publishSkill('sales-editor', dept['営業部'], SKILL, 'sh-sales-editor')).status).toBe(201)
    for (const who of ['sh-mgr', 'sh-sales-editor', 'sh-bob']) {
      expect((await publishSkill('acc', dept['経理部'], SKILL, who)).body.code).toBe('SHELF_NOT_ALLOWED')
    }
  })

  it('being named grants no folder access: the place must be writable (a department where only its people write)', async () => {
    const refused = await publishSkill('legal', dept['法務部'], SKILL, 'sh-legal-editor')
    expect(refused).toMatchObject({ status: 403, body: { code: 'SHELF_NOT_ALLOWED', files: [{ path: 'SKILL.md', reason: 'no-write' }] } })
    expect((await call('PUT', co(`/departments/${dept['法務部']}/members`), { userIds: ['sh-legal-editor'] })).status).toBe(200)
    expect((await publishSkill('legal', dept['法務部'], SKILL, 'sh-legal-editor')).status).toBe(201)
  })

  it('agent config inside a Skill folder is owner/admin only', async () => {
    const refused = await publishSkill('with-mcp', null, SKILL, 'sh-editor', null, { '.mcp.json': '{}', '.claude/settings.json': '{}' })
    expect(refused.status).toBe(403)
    expect(refused.body.files).toEqual([
      { path: '.mcp.json', reason: 'owner-admin-only' },
      { path: '.claude/settings.json', reason: 'owner-admin-only' },
    ])
    expect((await publishSkill('with-mcp', null, SKILL, 'sh-admin', null, { '.mcp.json': '{}' })).status).toBe(201)
  })
})

describe('instruction texts and rule files', () => {
  const instructions = (departmentId: string | null, text: string, as: string, expectedVersion: string | null = null) =>
    call('POST', co('/skill-shelf'), { kind: 'instructions', departmentId, text, expectedVersion }, as)
  const rule = (departmentId: string | null, name: string, as: string) =>
    call('POST', co('/skill-shelf'), { kind: 'rule', departmentId, name, text: '# 決まり\n敬語で書く。\n', expectedVersion: null }, as)

  it("the company's: owners and admins only (a skill editor or a manager is not enough)", async () => {
    expect((await instructions(null, '# 会社\n丁寧に。', 'sh-admin')).status).toBe(201)
    for (const who of ['sh-editor', 'sh-mgr', 'sh-bob']) {
      expect((await instructions(null, 'x', who, null)).status).toBe(403)
      expect((await rule(null, 'tone', who)).status).toBe(403)
    }
    expect((await rule(null, 'tone', 'sh-owner')).status).toBe(201)
  })

  it("a department's: its managers too; its skill editor not", async () => {
    expect((await instructions(dept['営業部'], '# 営業部\n見積は税込で。', 'sh-mgr')).status).toBe(201)
    expect((await rule(dept['営業部'], 'quotes', 'sh-mgr')).status).toBe(201)
    expect((await rule(dept['営業部'], 'quotes2', 'sh-sales-editor')).body.code).toBe('SHELF_NOT_ALLOWED')
    expect((await instructions(dept['経理部'], 'x', 'sh-mgr')).body.code).toBe('SHELF_NOT_ALLOWED')
  })

  it('the stored file is CLAUDE.md / <name>.md, and the name rule applies', async () => {
    const list = (await call('GET', co('/skill-shelf'))).body.data.items
    const inst = list.find((i: Json) => i.kind === 'instructions' && i.department === null)
    expect(inst.name).toBe('instructions')
    const content = await call('GET', co(`/skill-shelf/${inst.id}/versions/${inst.version}`))
    expect(content.body.data.files.map((f: Json) => f.path)).toEqual(['CLAUDE.md'])
    expect((await call('POST', co('/skill-shelf'), { kind: 'rule', departmentId: null, name: '../x', text: 'x', expectedVersion: null })).body.code).toBe('SHELF_BAD_NAME')
    expect((await call('POST', co('/skill-shelf'), { kind: 'instructions', departmentId: null, name: 'other', text: 'x', expectedVersion: null })).body.code).toBe('SHELF_BAD_NAME')
    expect((await call('POST', co('/skill-shelf'), { kind: 'rule', departmentId: null, name: 'empty', text: '  ', expectedVersion: null })).body.code).toBe('SHELF_EMPTY_TEXT')
  })
})

describe('auto-run parts: owners and admins only', () => {
  const HOOKS = '---\nname: x\nhooks:\n  PreToolUse: []\n---\nbody\n'
  const BANG = '---\nname: x\n---\n今日の日付: !`date`\n'
  const MCP_FLOW = '---\n{ name: x, "mcpServers": {} }\n---\n'

  it('a skill editor cannot add hooks, mcpServers or a ! command; an owner can', async () => {
    for (const body of [HOOKS, BANG, MCP_FLOW]) {
      const refused = await publishSkill('auto', null, body, 'sh-editor')
      expect(refused.status).toBe(403)
      expect(refused.body.files[0]).toMatchObject({ path: 'SKILL.md', reason: 'autorun' })
    }
    // A Markdown file deeper in the folder is read too.
    const deep = await publishSkill('auto', null, SKILL, 'sh-editor', null, { 'refs/how.md': BANG })
    expect(deep.body.files).toEqual([{ path: 'refs/how.md', reason: 'autorun', findings: ['!`…` コマンド'] }])
    expect((await publishSkill('auto', null, HOOKS, 'sh-owner')).status).toBe(201)
  })

  it('text that is not the syntax passes', async () => {
    const plain = '---\nname: x\ndescription: hooks の説明\n---\n`!important` と if ! grep は普通の文。\n'
    expect((await publishSkill('plain-text', null, plain, 'sh-editor')).status).toBe(201)
  })

  it('putting back a version with auto-run parts is owner/admin only, and the version says so', async () => {
    const first = await publishSkill('roll', null, '---\nname: x\nhooks: {}\n---\n', 'sh-owner')
    expect(first.status).toBe(201)
    const v1 = first.body.data.item.version
    const second = await publishSkill('roll', null, SKILL, 'sh-editor', v1)
    expect(second.status).toBe(200)
    const v2 = second.body.data.item.version
    const id = second.body.data.item.id
    const versions = (await call('GET', co(`/skill-shelf/${id}/versions`), undefined, 'sh-editor')).body.data.versions
    expect(versions.map((v: Json) => [v.version, v.autorun, v.current])).toEqual([[v2, false, true], [v1, true, false]])
    const refused = await call('POST', co(`/skill-shelf/${id}/restore`), { version: v1, expectedVersion: v2 }, 'sh-editor')
    expect(refused).toMatchObject({ status: 403, body: { code: 'SHELF_NOT_ALLOWED', files: [{ reason: 'autorun' }] } })
    expect((await call('POST', co(`/skill-shelf/${id}/restore`), { version: v1, expectedVersion: v2 }, 'sh-admin')).body.data.item.version).toBe(v1)
  })
})

describe('versions: concurrency, rollback, taking off', () => {
  it('a publish against a version someone replaced is refused with the current one; the same content changes nothing', async () => {
    const first = await publishSkill('conc', null)
    const v1 = first.body.data.item.version
    const second = await publishSkill('conc', null, `${SKILL}追記\n`, 'sh-editor', v1)
    expect(second.status).toBe(200)
    const v2 = second.body.data.item.version
    const stale = await publishSkill('conc', null, `${SKILL}別の追記\n`, 'sh-admin', v1)
    expect(stale).toMatchObject({ status: 409, body: { code: 'SHELF_VERSION_CHANGED', currentVersion: v2 } })
    const fresh = await publishSkill('conc', null, `${SKILL}別の追記\n`, 'sh-admin', null)
    expect(fresh).toMatchObject({ status: 409, body: { currentVersion: v2 } })
    const same = await publishSkill('conc', null, `${SKILL}追記\n`, 'sh-admin', v2)
    expect(same).toMatchObject({ status: 200, body: { data: { changed: false } } })
    expect((await call('GET', co(`/skill-shelf/${second.body.data.item.id}/versions`))).body.data.history).toHaveLength(2)
  })

  it('restore an earlier version, take it off, put it back; every step in the history', async () => {
    const v1 = (await publishSkill('roll2', null)).body.data.item
    const v2 = (await publishSkill('roll2', null, `${SKILL}v2\n`, 'sh-owner', v1.version)).body.data.item
    const restored = await call('POST', co(`/skill-shelf/${v1.id}/restore`), { version: v1.version, expectedVersion: v2.version }, 'sh-editor')
    expect(restored.body.data).toMatchObject({ changed: true, item: { version: v1.version, changedBy: { id: 'sh-editor', name: 'Name sh-editor' } } })
    const staleRestore = await call('POST', co(`/skill-shelf/${v1.id}/restore`), { version: v2.version, expectedVersion: v2.version })
    expect(staleRestore).toMatchObject({ status: 409, body: { currentVersion: v1.version } })
    expect((await call('POST', co(`/skill-shelf/${v1.id}/restore`), { version: 'f'.repeat(64), expectedVersion: v1.version })).body.code).toBe('SHELF_VERSION_NOT_FOUND')

    const off = await call('POST', co(`/skill-shelf/${v1.id}/unpublish`), { expectedVersion: v1.version }, 'sh-editor')
    expect(off.body.data.item.version).toBeNull()
    expect((await call('GET', co('/me/skill-shelf'), undefined, 'sh-bob')).body.data.items.map((i: Json) => i.name)).not.toContain('roll2')
    expect((await call('POST', co(`/skill-shelf/${v1.id}/unpublish`), { expectedVersion: v1.version }, 'sh-bob')).status).toBe(403)
    const back = await call('POST', co(`/skill-shelf/${v1.id}/restore`), { version: v2.version, expectedVersion: null })
    expect(back.body.data.item.version).toBe(v2.version)
    const history = (await call('GET', co(`/skill-shelf/${v1.id}/versions`))).body.data.history
    expect(history.map((h: Json) => h.action)).toEqual(['restore', 'unpublish', 'restore', 'publish', 'publish'])
  })

  it('the version is the sha256 of the canonical listing, and the files come back as sent', async () => {
    const files = skillFiles(SKILL, { 'tools/run.py': 'print(1)\n' })
    const made = await call('POST', co('/skill-shelf'), { kind: 'skill', departmentId: null, name: 'listing', files, expectedVersion: null })
    const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex')
    const listing = files.map(f => ({ path: f.path, sha: sha(Buffer.from(f.base64, 'base64')) }))
      .sort((a, b) => (a.path < b.path ? -1 : 1)).map(f => `${f.sha} ${f.path}\n`).join('')
    expect(made.body.data.item.version).toBe(sha(listing))
    const content = await call('GET', co(`/skill-shelf/${made.body.data.item.id}/versions/${sha(listing)}`), undefined, 'sh-bob')
    expect(content.body.data.files).toEqual(files)
    // Stored content that no longer matches its version is never handed out.
    db.prepare('UPDATE shelf_versions SET files = ? WHERE company_id = ? AND item_id = ?')
      .run(JSON.stringify([{ path: 'SKILL.md', base64: b64('changed') }]), none, made.body.data.item.id)
    expect((await call('GET', co(`/skill-shelf/${made.body.data.item.id}/versions/${sha(listing)}`))).body.code).toBe('SHELF_CONTENT_CHANGED')
  })
})

describe('reading and delivery follow who reads the place', () => {
  let hrSkill: string
  let hrVersion: string

  beforeAll(async () => {
    const group = await call('POST', co('/groups'), { name: '人事の人', userIds: ['sh-carol'] })
    expect(group.status).toBe(201)
    const put = await call('PUT', co('/permissions/scopes/by-path'), {
      path: '人事部',
      rules: [{ subjectType: 'everyone', canRead: false, canWrite: false }, { subjectType: 'group', subjectId: group.body.data.id, canRead: true, canWrite: true }],
    })
    expect(put.status).toBe(200)
    const made = await publishSkill('hr-secret-skill', dept['人事部'])
    expect(made.status).toBe(201)
    hrSkill = made.body.data.item.id
    hrVersion = made.body.data.item.version
  })

  it('a reader of the place gets it listed and delivered (belongs as stored); everyone else never sees its name', async () => {
    const carol = (await call('GET', co('/me/skill-shelf'), undefined, 'sh-carol')).body.data.items
    expect(carol.find((i: Json) => i.id === hrSkill)).toMatchObject({ name: 'hr-secret-skill', version: hrVersion, department: { folder: '人事部', belongs: false } })
    for (const who of ['sh-bob', 'sh-mgr', 'sh-editor']) {
      const mine = await call('GET', co('/me/skill-shelf'), undefined, who)
      const listed = await call('GET', co('/skill-shelf'), undefined, who)
      expect(mine.status).toBe(200)
      expect(mine.text).not.toContain('hr-secret-skill')
      expect(listed.text).not.toContain('hr-secret-skill')
      // Company-wide and readable departments' items are there.
      expect(mine.body.data.items.map((i: Json) => i.name)).toContain('quote')
    }
  })

  it('its versions and files answer exactly as for an item that does not exist', async () => {
    const pairs: Array<[string, string]> = [
      [`/skill-shelf/${hrSkill}/versions`, '/skill-shelf/no-such-item/versions'],
      [`/skill-shelf/${hrSkill}/versions/${hrVersion}`, `/skill-shelf/no-such-item/versions/${hrVersion}`],
    ]
    for (const [real, missing] of pairs) {
      const a = await call('GET', co(real), undefined, 'sh-bob')
      expect(a).toEqual(await call('GET', co(missing), undefined, 'sh-bob'))
      expect(a.status).toBe(404)
    }
    const restore = await call('POST', co(`/skill-shelf/${hrSkill}/restore`), { version: hrVersion, expectedVersion: hrVersion }, 'sh-bob')
    expect(restore).toEqual(await call('POST', co('/skill-shelf/no-such-item/restore'), { version: hrVersion, expectedVersion: hrVersion }, 'sh-bob'))
    const off = await call('POST', co(`/skill-shelf/${hrSkill}/unpublish`), { expectedVersion: hrVersion }, 'sh-mgr')
    expect(off).toEqual(await call('POST', co('/skill-shelf/no-such-item/unpublish'), { expectedVersion: hrVersion }, 'sh-mgr'))
    expect((await call('GET', co(`/skill-shelf/${hrSkill}/versions`), undefined, 'sh-carol')).status).toBe(200)
  })

  it('publishing into a department one cannot read answers as for a department that does not exist', async () => {
    const hidden = await publishSkill('x', dept['人事部'], SKILL, 'sh-editor')
    const missing = await publishSkill('x', 'no-such-department', SKILL, 'sh-editor')
    expect(hidden).toEqual(missing)
    expect(hidden).toMatchObject({ status: 404, body: { code: 'SHELF_PLACE_NOT_FOUND' } })
    expect(hidden.text).not.toContain('人事部')
  })

  it("another company's item is an item that does not exist, and is left unchanged", async () => {
    currentUser.id = 'sh-owner'
    const theirs = await call('POST', `/api/companies/${other}/skill-shelf`, { kind: 'skill', departmentId: null, name: 'theirs', files: skillFiles(SKILL), expectedVersion: null })
    expect(theirs.status).toBe(201)
    const id = theirs.body.data.item.id
    const v = theirs.body.data.item.version
    expect(await call('GET', co(`/skill-shelf/${id}/versions/${v}`))).toEqual(await call('GET', co(`/skill-shelf/no-such-item/versions/${v}`)))
    expect(await call('POST', co(`/skill-shelf/${id}/unpublish`), { expectedVersion: v })).toEqual(await call('POST', co('/skill-shelf/no-such-item/unpublish'), { expectedVersion: v }))
    expect(db.prepare('SELECT current_version FROM shelf_items WHERE company_id = ? AND id = ?').get(other, id)).toEqual({ current_version: v })
    const publishIntoTheirs = await publishSkill('x', (db.prepare('SELECT id FROM departments WHERE company_id = ? LIMIT 1').get(other) as { id: string }).id)
    expect(publishIntoTheirs.body.code).toBe('SHELF_PLACE_NOT_FOUND')
  })

  it("a department deleted takes its items with it", async () => {
    const tmp = await call('POST', co('/departments'), { name: '一時部', folder: '一時部' })
    const made = await publishSkill('tmp-skill', tmp.body.data.id)
    expect(made.status).toBe(201)
    expect((await call('DELETE', co(`/departments/${tmp.body.data.id}`))).status).toBe(200)
    expect(db.prepare('SELECT COUNT(*) AS n FROM shelf_items WHERE company_id = ? AND id = ?').get(none, made.body.data.item.id)).toEqual({ n: 0 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM shelf_versions WHERE company_id = ? AND item_id = ?').get(none, made.body.data.item.id)).toEqual({ n: 0 })
  })
})

describe('what is refused on upload (nothing stored)', () => {
  const count = () => (db.prepare('SELECT COUNT(*) AS n FROM shelf_versions WHERE company_id = ?').get(none) as { n: number }).n
  const upload = (files: Array<{ path: unknown; base64: string }>, name = 'bad') =>
    call('POST', co('/skill-shelf'), { kind: 'skill', departmentId: null, name, files, expectedVersion: null })

  it('paths that leave the folder or that a disk refuses', async () => {
    const before = count()
    for (const path of ['../SKILL.md', 'a/../../x', '/etc/passwd', 'a//b', './x', 'a\\b', 'a:b', 'con', 'x.', '', 7]) {
      const r = await upload([{ path: 'SKILL.md', base64: b64(SKILL) }, { path, base64: b64('x') }])
      expect(r.status, String(path)).toBe(400)
      expect(r.body.code, String(path)).toBe('SHELF_BAD_PATH')
    }
    const clash = await upload([{ path: 'SKILL.md', base64: b64(SKILL) }, { path: 'a.md', base64: b64('x') }, { path: 'A.md', base64: b64('y') }])
    expect(clash.body).toMatchObject({ code: 'SHELF_BAD_PATH', problem: 'clash' })
    const fileAndFolder = await upload([{ path: 'SKILL.md', base64: b64(SKILL) }, { path: 'x', base64: b64('x') }, { path: 'x/y', base64: b64('y') }])
    expect(fileAndFolder.body.code).toBe('SHELF_BAD_PATH')
    expect(count()).toBe(before)
  })

  it('names, SKILL.md, sizes, base64, secrets', async () => {
    const before = count()
    expect((await upload([{ path: 'SKILL.md', base64: b64(SKILL) }], 'Bad Name')).body.code).toBe('SHELF_BAD_NAME')
    expect((await upload([{ path: 'README.md', base64: b64('x') }])).body.code).toBe('SHELF_NO_SKILL_MD')
    expect((await upload([{ path: 'SKILL.md', base64: '***' }])).body.code).toBe('SHELF_BAD_CONTENT')
    const many = Array.from({ length: 201 }, (_, i) => ({ path: `f${i}.txt`, base64: b64('x') }))
    expect((await upload(many)).body.code).toBe('SHELF_TOO_MANY_FILES')
    const big = Buffer.alloc(2 * 1024 * 1024 + 1, 0x61).toString('base64')
    expect((await upload([{ path: 'SKILL.md', base64: b64(SKILL) }, { path: 'big.txt', base64: big }])).body.code).toBe('SHELF_FILE_TOO_LARGE')
    const nearly = Buffer.alloc(2 * 1024 * 1024 - 10, 0x61).toString('base64')
    const total = await upload([{ path: 'SKILL.md', base64: b64(SKILL) }, ...Array.from({ length: 5 }, (_, i) => ({ path: `p${i}.txt`, base64: nearly }))])
    expect(total.body.code).toBe('SHELF_TOO_LARGE')
    const secret = await upload([{ path: 'SKILL.md', base64: b64(SKILL) }, { path: 'env.txt', base64: b64(`KEY=${'AKIA'}${'ABCDEFGHIJKLMNOP'}`) }])
    expect(secret.body).toMatchObject({ code: 'SHELF_SECRET_DETECTED', path: 'env.txt', pattern: 'AWS Access Key ID' })
    const longText = await call('POST', co('/skill-shelf'), { kind: 'rule', departmentId: null, name: 'long', text: 'あ'.repeat(100_000), expectedVersion: null })
    expect(longText.body.code).toBe('SHELF_TOO_LARGE')
    expect((await call('POST', co('/skill-shelf'), { kind: 'plugin', departmentId: null, name: 'x', expectedVersion: null })).body.code).toBe('SHELF_BAD_KIND')
    expect((await call('POST', co('/skill-shelf'), { kind: 'skill', departmentId: null, name: 'x', files: skillFiles(SKILL), expectedVersion: 'v1' })).body.code).toBe('SHELF_BAD_VERSION')
    expect(count()).toBe(before)
  })
})
