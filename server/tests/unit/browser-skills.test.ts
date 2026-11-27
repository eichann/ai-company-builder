/**
 * 「Skill の承認」 on the server (services/browser-skills.ts; agent-browser.md "A Skill's browser declaration and its
 * approval"), against a real database. The Skill's content comes from a stand-in of the server's own copy (the port the
 * git / shelf adapter fills: `browser-skill-push.test.ts` runs the real one through git-http). The site is fictional.
 *
 * Guards: no frames for a declaration nobody approved; a declaration changed by someone who is not an owner / admin
 * waits (owners / admins told, not the editor) while one an owner / admin changed counts as approved (who is kept); only
 * the other files changed → frames still given, the card needed once even when pre-approved, owners / admins told once;
 * revoked → no frames, and an edit after it does not approve; only the latest approval counts (a declaration put back
 * needs approving again); another company's approval counts nowhere else; only owners / admins list, approve, revoke;
 * an approval is for exactly the version seen; an unregistered domain → no frames and no approval; the notice's text only
 * for owners / admins.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { createHash, randomBytes } from 'crypto'
import { initDatabase } from '../../src/db'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import { sqliteMembershipRepository } from '../../src/adapters/sqlite/memberships'
import { createBrowserSkillService, type BrowserSkillService } from '../../src/services/browser-skills'
import type { BrowserSkillContent, BrowserSkillSource } from '../../src/ports/browser-skills'
import type { Member } from '../../src/services/access'
import type { Refusal } from '../../src/services/outcome'

const T0 = Date.parse('2026-11-25T00:00:00.000Z')
const CO = 'co-1'
const OTHER_CO = 'co-2'
const owner: Member = { companyId: CO, userId: 'u-owner', role: 'owner' }
const admin: Member = { companyId: CO, userId: 'u-admin', role: 'admin' }
const editor: Member = { companyId: CO, userId: 'u-editor', role: 'member' }
const otherOwner: Member = { companyId: OTHER_CO, userId: 'u-other', role: 'owner' }
const DOMAIN = 'shop.example.test'
const SKILL = 'order-copy'
/** The company's Skill of that name: its path, the store's key. */
const P = `.claude/skills/${SKILL}`
/** Two departments each with a Skill of the same name. */
const SALES = '営業'
const SUPPORT = 'support'
const SALES_P = `${SALES}/.claude/skills/${SKILL}`
const SUPPORT_P = `${SUPPORT}/.claude/skills/${SKILL}`

const yaml = (max = 1) => `domain: ${DOMAIN}\nwrites:\n  - { method: POST, path: /api/orders/register, max: ${max} }\nafter_read: [ "/api/orders/{created}" ]\n`

let conn: Database.Database
let now: number
let registered: Record<string, string[]>
let store: Record<string, Record<string, BrowserSkillContent>>
let svc: BrowserSkillService
/** The department folders each member reads (owners / admins read all), as the core's read rules would answer. */
let reads: Record<string, string[]>
/** Whether the server's copy could look into every place for a name (false: some were left out). */
let everyPlaceRead: boolean
/** Skill folders with no `browser.yaml` (a SKILL.md only), by company: the AI sees them, the approval list does not. */
let plainFolders: Record<string, string[]>
const iso = (ms: number) => new Date(ms).toISOString()
const sha = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex')

/** The server's own copy, as a test sets it (the real one is git or the shelf). */
const source: BrowserSkillSource = {
  list: async companyId => ({ paths: Object.keys(store[companyId] ?? {}).sort(), complete: everyPlaceRead }),
  // Every Skill folder of the name: those with `browser.yaml` (the store) and those without (`plainFolders`).
  withName: async (companyId, name) => ({
    paths: [...Object.keys(store[companyId] ?? {}), ...(plainFolders[companyId] ?? [])].filter(p => p.endsWith(`/${name}`)).sort(),
    complete: everyPlaceRead,
  }),
  read: async (companyId, path) => store[companyId]?.[path] ?? null,
  pushed: async () => [],
  shelfLanded: async () => null,
}
/** Put a Skill into the server's copy: a bare name is the company's, else a path. */
function put(companyId: string, skill: string, declaration: string, text = 'v1'): BrowserSkillContent {
  const path = skill.includes('/') ? skill : `.claude/skills/${skill}`
  const content = { path, declaration, files: `git:${sha(`${path}\0${declaration}\0${text}`).slice(0, 40)}` }
  store[companyId] = { ...(store[companyId] ?? {}), [path]: content }
  return content
}
/** A change landed by `by` (what afterPush / shelfChanged hand the service, without waiting for them). */
async function land(by: Member, declaration: string, text = 'v1', opts: { thenCurrent?: () => void; path?: string; elsewhere?: { paths: string[]; complete: boolean } } = {}) {
  const path = opts.path ?? P
  const before = store[by.companyId]?.[path]?.declaration ?? null
  const content = {
    ...put(by.companyId, path, declaration, text), declarationChanged: before !== declaration, previousDeclaration: before,
    sameElsewhere: opts.elsewhere ?? { paths: [], complete: true },
  }
  // Another change landing after this one, before it is read (the server reads its copy again: `current`).
  opts.thenCurrent?.()
  // `landed` is internal: reach it the way a push does, through a stand-in pushed() list.
  const was = source.pushed
  source.pushed = async () => [content]
  svc.afterPush(by.companyId, by, 'x')
  await new Promise(r => setTimeout(r, 5))
  source.pushed = was
}

function value<T>(r: { ok: true; value: T } | Refusal): T {
  if (!r.ok) throw new Error(JSON.stringify(r.body))
  return r.value
}
const code = (r: { ok: boolean; body?: { code?: unknown } }) => (r.ok ? 'ok' : r.body?.code)
const noticesOf = (userId: string) => conn.prepare('SELECT dedupe_key AS k FROM notifications WHERE company_id = ? AND user_id = ? ORDER BY created_at').all(CO, userId) as Array<{ k: string }>
const hashOf = async (m: Member, path = P) => value(await svc.list(m)).items.find(i => i.path === path)!.declarationHash
const approveAt = async (m: Member, path: string, mode: 'per_run' | 'pre_approved' = 'per_run') =>
  svc.approve(m, { skill: path, declarationHash: await hashOf(owner, path), files: store[m.companyId]?.[path]?.files ?? '', mode })

function join(companyId: string, userId: string, role: string) {
  conn.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${companyId}-${userId}`, userId, companyId, role, iso(T0), iso(T0))
}

beforeEach(() => {
  conn = new Database(':memory:')
  initDatabase(conn)
  for (const co of [CO, OTHER_CO]) conn.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(co, co, co, 'u-owner', iso(T0), iso(T0))
  join(CO, owner.userId, 'owner'); join(CO, admin.userId, 'admin'); join(CO, editor.userId, 'member')
  join(OTHER_CO, otherOwner.userId, 'owner')
  now = T0
  registered = { [CO]: [DOMAIN], [OTHER_CO]: [DOMAIN] }
  store = {}
  reads = { [editor.userId]: [SALES] }
  everyPlaceRead = true
  plainFolders = {}
  svc = createBrowserSkillService({
    companyData: sqliteCompanyData(conn),
    clock: { now: () => iso(now), nowMs: () => now },
    ids: { newId: () => randomBytes(8).toString('hex'), newToken: () => randomBytes(32).toString('hex') },
    memberships: sqliteMembershipRepository(conn),
    accounts: { byIds: ids => new Map(ids.map(id => [id, { name: `Name ${id}`, email: `${id}@example.com` }])) },
    source,
    registeredHosts: companyId => registered[companyId] ?? [],
    sha256: sha,
    readsPath: (member, path) => member.role === 'owner' || member.role === 'admin' || (reads[member.userId] ?? []).some(d => path === d || path.startsWith(`${d}/`)),
  })
})

describe('approving a Skill\'s declaration', () => {
  it('no frames until an owner / admin approves exactly the version seen', async () => {
    put(CO, SKILL, yaml())
    expect(code(await svc.approvedFrames(owner, SKILL))).toBe('BROWSER_SKILL_NOT_APPROVED')
    const seen = value(await svc.list(owner)).items[0]
    expect(seen).toMatchObject({ name: SKILL, status: 'waiting', domain: DOMAIN, approval: null })
    expect(seen.writes).toEqual(['/api/orders/register に送る（作る・保存する）：1回まで'])
    // A version not the one now (someone changed it meanwhile) is refused.
    expect(code(await svc.approve(owner, { skill: SKILL, declarationHash: `sha256:${'0'.repeat(64)}`, files: store[CO]?.[P]?.files ?? '', mode: 'per_run' }))).toBe('BROWSER_SKILL_CHANGED')
    // The declaration as shown but the steps' text changed since the page read it (independent review): refused too.
    expect(code(await svc.approve(owner, { skill: SKILL, declarationHash: seen.declarationHash, files: 'git:0000', mode: 'per_run' }))).toBe('BROWSER_SKILL_CHANGED')
    expect(code(await svc.approvedFrames(owner, SKILL))).toBe('BROWSER_SKILL_NOT_APPROVED')
    const approved = value(await svc.approve(admin, { skill: SKILL, declarationHash: seen.declarationHash, files: store[CO]?.[P]?.files ?? '', mode: 'per_run' }))
    expect(approved).toMatchObject({ status: 'approved', approval: { mode: 'per_run', how: 'approved', approvedBy: admin.userId } })
    const frames = value(await svc.approvedFrames(editor, SKILL))
    expect(frames).toMatchObject({ mode: 'per_run', textChanged: false, needsRunCard: true })
    expect(frames.frames.writes).toEqual([{ method: 'POST', path: '/api/orders/register', query: null, max: 1, fields: {} }])
    expect(frames.frames.afterRead).toEqual(['/api/orders/{created}'])
  })

  it('pre-approved needs no card', async () => {
    put(CO, SKILL, yaml())
    value(await svc.approve(owner, { skill: SKILL, declarationHash: await hashOf(owner), files: store[CO]?.[P]?.files ?? '', mode: 'pre_approved' }))
    expect(value(await svc.approvedFrames(owner, SKILL))).toMatchObject({ mode: 'pre_approved', needsRunCard: false })
  })

  it('only owners / admins list, approve and revoke', async () => {
    put(CO, SKILL, yaml())
    const hash = await hashOf(owner)
    expect(code(await svc.list(editor))).toBe('BROWSER_SKILL_FORBIDDEN')
    expect(code(await svc.approve(editor, { skill: SKILL, declarationHash: hash, files: store[CO]?.[P]?.files ?? '', mode: 'pre_approved' }))).toBe('BROWSER_SKILL_FORBIDDEN')
    expect(code(await svc.approvedFrames(owner, SKILL))).toBe('BROWSER_SKILL_NOT_APPROVED')
    value(await svc.approve(owner, { skill: SKILL, declarationHash: hash, files: store[CO]?.[P]?.files ?? '', mode: 'per_run' }))
    expect(code(svc.revoke(editor, { skill: SKILL }))).toBe('BROWSER_SKILL_FORBIDDEN')
    expect(code(await svc.approvedFrames(owner, SKILL))).toBe('ok')
  })

  it('a strict body', async () => {
    put(CO, SKILL, yaml())
    const hash = await hashOf(owner)
    for (const body of [null, {}, { skill: SKILL, declarationHash: hash }, { skill: SKILL, declarationHash: hash, mode: 'always' },
      { skill: '../x', declarationHash: hash, mode: 'per_run' }, { skill: SKILL, declarationHash: hash, mode: 'per_run', extra: 1 }]) {
      expect(code(await svc.approve(owner, body)), JSON.stringify(body)).toBe('BROWSER_SKILL_BAD_REQUEST')
    }
    expect(code(await svc.approve(owner, { skill: 'no-such', declarationHash: hash, files: store[CO]?.[P]?.files ?? '', mode: 'per_run' }))).toBe('BROWSER_SKILL_NOT_FOUND')
  })

  it('revoked → no frames; an edit by an owner afterwards does not approve it', async () => {
    put(CO, SKILL, yaml())
    value(await svc.approve(owner, { skill: SKILL, declarationHash: await hashOf(owner), files: store[CO]?.[P]?.files ?? '', mode: 'pre_approved' }))
    value(svc.revoke(admin, { skill: SKILL }))
    expect(code(await svc.approvedFrames(owner, SKILL))).toBe('BROWSER_SKILL_NOT_APPROVED')
    expect(value(await svc.list(owner)).items[0].status).toBe('revoked')
    expect(code(svc.revoke(admin, { skill: SKILL }))).toBe('BROWSER_SKILL_NOT_APPROVED')
    await land(owner, yaml(2))
    expect(code(await svc.approvedFrames(owner, SKILL))).toBe('BROWSER_SKILL_NOT_APPROVED')
  })

  it('only the latest approval counts: a declaration put back needs approving again', async () => {
    put(CO, SKILL, yaml(1))
    value(await svc.approve(owner, { skill: SKILL, declarationHash: await hashOf(owner), files: store[CO]?.[P]?.files ?? '', mode: 'per_run' }))
    put(CO, SKILL, yaml(2))
    value(await svc.approve(owner, { skill: SKILL, declarationHash: await hashOf(owner), files: store[CO]?.[P]?.files ?? '', mode: 'per_run' }))
    put(CO, SKILL, yaml(1))
    expect(code(await svc.approvedFrames(owner, SKILL))).toBe('BROWSER_SKILL_NOT_APPROVED')
  })

  it('another company\'s approval counts nowhere else', async () => {
    put(CO, SKILL, yaml())
    put(OTHER_CO, SKILL, yaml())
    value(await svc.approve(otherOwner, { skill: SKILL, declarationHash: (value(await svc.list(otherOwner)).items[0]).declarationHash, files: store[OTHER_CO]?.[P]?.files ?? '', mode: 'pre_approved' }))
    expect(code(await svc.approvedFrames(otherOwner, SKILL))).toBe('ok')
    expect(code(await svc.approvedFrames(owner, SKILL))).toBe('BROWSER_SKILL_NOT_APPROVED')
    expect(value(await svc.list(owner)).items[0].status).toBe('waiting')
    // Revoking here touches nothing of theirs.
    expect(code(svc.revoke(owner, { skill: SKILL }))).toBe('BROWSER_SKILL_NOT_APPROVED')
    expect(code(await svc.approvedFrames(otherOwner, SKILL))).toBe('ok')
  })

  it('a domain the company did not register: no frames, no approval', async () => {
    put(CO, SKILL, yaml())
    const hash = await hashOf(owner)
    value(await svc.approve(owner, { skill: SKILL, declarationHash: hash, files: store[CO]?.[P]?.files ?? '', mode: 'per_run' }))
    registered[CO] = ['other.example.test']
    expect(code(await svc.approvedFrames(owner, SKILL))).toBe('BROWSER_SKILL_DOMAIN_NOT_REGISTERED')
    expect(value(await svc.list(owner)).items[0]).toMatchObject({ status: 'invalid', problem: expect.stringContaining('登録されていません') })
    expect(code(await svc.approve(owner, { skill: SKILL, declarationHash: hash, files: store[CO]?.[P]?.files ?? '', mode: 'per_run' }))).toBe('BROWSER_SKILL_DOMAIN_NOT_REGISTERED')
  })

  it('a declaration that breaks the shape: no frames, no approval', async () => {
    put(CO, SKILL, `${yaml()}extra: 1\n`)
    const hash = await hashOf(owner)
    expect(value(await svc.list(owner)).items[0].status).toBe('invalid')
    expect(code(await svc.approve(owner, { skill: SKILL, declarationHash: hash, files: store[CO]?.[P]?.files ?? '', mode: 'per_run' }))).toBe('BROWSER_SKILL_BAD_DECLARATION')
    expect(code(await svc.approvedFrames(owner, SKILL))).toBe('BROWSER_SKILL_BAD_DECLARATION')
    store[CO][P] = { ...store[CO][P], declaration: 'too-large' }
    expect(code(await svc.approvedFrames(owner, SKILL))).toBe('BROWSER_SKILL_BAD_DECLARATION')
  })
})

describe('who changed the declaration', () => {
  it('an owner / admin\'s change counts as approved, who is kept (the mode stays)', async () => {
    await land(admin, yaml(1))
    expect(value(await svc.approvedFrames(owner, SKILL))).toMatchObject({ mode: 'per_run', textChanged: false, needsRunCard: true })
    expect(value(await svc.list(owner)).items[0].approval).toMatchObject({ how: 'edited', approvedBy: admin.userId, approvedByName: `Name ${admin.userId}` })
    value(await svc.approve(owner, { skill: SKILL, declarationHash: await hashOf(owner), files: store[CO]?.[P]?.files ?? '', mode: 'pre_approved' }))
    await land(owner, yaml(3))
    // Pre-approved stays, but the first run of a declaration changed this way shows the card once (independent review).
    const first = value(await svc.approvedFrames(owner, SKILL))
    expect(first).toMatchObject({ mode: 'pre_approved', textChanged: false, needsRunCard: true })
    expect(value(await svc.list(owner)).items[0].status).toBe('pre_approved')
    expect(svc.runCardShown(owner, SKILL, first.declarationHash, first.files)).toBe(true)
    expect(value(await svc.approvedFrames(owner, SKILL))).toMatchObject({ mode: 'pre_approved', needsRunCard: false })
    expect(value(await svc.approvedFrames(owner, SKILL)).frames.writes[0].max).toBe(3)
    expect(noticesOf(owner.userId)).toEqual([])
  })

  it('a skill editor\'s change waits for an owner / admin, who are told (not the editor)', async () => {
    await land(owner, yaml(1))
    expect(code(await svc.approvedFrames(owner, SKILL))).toBe('ok')
    await land(editor, yaml(5))
    expect(code(await svc.approvedFrames(owner, SKILL))).toBe('BROWSER_SKILL_NOT_APPROVED')
    expect(value(await svc.list(owner)).items[0].status).toBe('waiting')
    const keys = noticesOf(owner.userId).map(n => n.k)
    expect(keys).toHaveLength(1)
    expect(keys[0]).toMatch(/^browser_skill:waiting:order-copy:[0-9a-f]{16}$/)
    expect(noticesOf(admin.userId)).toHaveLength(1)
    expect(noticesOf(editor.userId)).toEqual([])
    expect(svc.noticeText(owner, keys[0])).toContain('Skill「order-copy」の宣言')
    expect(svc.noticeText(editor, keys[0])).toBeNull()
    // Landing the same again tells nobody twice.
    await land(editor, yaml(5))
    expect(noticesOf(owner.userId)).toHaveLength(1)
    // An owner approves it.
    value(await svc.approve(owner, { skill: SKILL, declarationHash: await hashOf(owner), files: store[CO]?.[P]?.files ?? '', mode: 'per_run' }))
    expect(value(await svc.approvedFrames(owner, SKILL)).frames.writes[0].max).toBe(5)
  })

  it('an owner / admin\'s change on top of a pending declaration waits (a pull --rebase carries it along; review M1)', async () => {
    await land(owner, yaml(1))
    await land(editor, yaml(5))
    expect(code(await svc.approvedFrames(owner, SKILL))).toBe('BROWSER_SKILL_NOT_APPROVED')
    await land(admin, yaml(6))
    expect(code(await svc.approvedFrames(owner, SKILL))).toBe('BROWSER_SKILL_NOT_APPROVED')
    // Told of this version too (the admin who pushed it is not).
    expect(noticesOf(owner.userId).filter(n => n.k.startsWith('browser_skill:waiting:'))).toHaveLength(2)
    expect(noticesOf(admin.userId).filter(n => n.k.startsWith('browser_skill:waiting:'))).toHaveLength(1)
    expect(value(await svc.list(owner)).items[0].status).toBe('waiting')
    // On top of an approved one it counts again.
    value(await svc.approve(owner, { skill: SKILL, declarationHash: await hashOf(owner), files: store[CO]?.[P]?.files ?? '', mode: 'per_run' }))
    await land(admin, yaml(7))
    expect(code(await svc.approvedFrames(owner, SKILL))).toBe('ok')
  })

  it('a waiting declaration nobody was told of is told when listed, once (review L4)', async () => {
    put(CO, SKILL, yaml(4))
    expect(noticesOf(owner.userId)).toEqual([])
    await svc.list(admin)
    await svc.list(owner)
    expect(noticesOf(owner.userId).map(n => n.k)).toEqual([expect.stringMatching(/^browser_skill:waiting:order-copy:/)])
    expect(noticesOf(admin.userId)).toHaveLength(1)
  })

  it('an owner / admin who changed only the text does not approve someone else\'s declaration (Codex review)', async () => {
    await land(owner, yaml(1))
    await land(editor, yaml(5))
    expect(code(await svc.approvedFrames(owner, SKILL))).toBe('BROWSER_SKILL_NOT_APPROVED')
    await land(admin, yaml(5), 'v2')
    expect(code(await svc.approvedFrames(owner, SKILL))).toBe('BROWSER_SKILL_NOT_APPROVED')
    expect(value(await svc.list(owner)).items[0].status).toBe('waiting')
  })

  it('a landing that is no longer what the server holds changes nothing (read in another order)', async () => {
    // An owner's change, read only after a skill editor's later change landed: not approved, and the editor's waits.
    await land(owner, yaml(1), 'v1', { thenCurrent: () => put(CO, SKILL, yaml(8), 'v1') })
    expect(code(await svc.approvedFrames(owner, SKILL))).toBe('BROWSER_SKILL_NOT_APPROVED')
    // An owner's approval made meanwhile is not superseded by an older landing.
    put(CO, SKILL, yaml(2))
    value(await svc.approve(owner, { skill: SKILL, declarationHash: await hashOf(owner), files: store[CO]?.[P]?.files ?? '', mode: 'pre_approved' }))
    await land(admin, yaml(3), 'v1', { thenCurrent: () => put(CO, SKILL, yaml(2)) })
    expect(value(await svc.approvedFrames(owner, SKILL))).toMatchObject({ mode: 'pre_approved' })
    expect(value(await svc.approvedFrames(owner, SKILL)).frames.writes[0].max).toBe(2)
  })

  it('a declaration that cannot be read is not approved by an owner\'s change either', async () => {
    await land(owner, `${yaml()}unknown: 1\n`)
    expect(code(await svc.approvedFrames(owner, SKILL))).toBe('BROWSER_SKILL_BAD_DECLARATION')
    registered[CO] = [DOMAIN]
    put(CO, SKILL, yaml())
    expect(code(await svc.approvedFrames(owner, SKILL))).toBe('BROWSER_SKILL_NOT_APPROVED')
  })
})

describe('only the steps\' text changed', () => {
  const textNotices = (userId: string) => noticesOf(userId).filter(n => n.k.startsWith('browser_skill:text:'))
  it('frames still given; the card needed once even when pre-approved; owners / admins told once', async () => {
    put(CO, SKILL, yaml())
    value(await svc.approve(owner, { skill: SKILL, declarationHash: await hashOf(owner), files: store[CO]?.[P]?.files ?? '', mode: 'pre_approved' }))
    await land(editor, yaml(), 'v2')
    const after = value(await svc.approvedFrames(owner, SKILL))
    expect(after).toMatchObject({ mode: 'pre_approved', textChanged: true, needsRunCard: true })
    expect(value(await svc.list(owner)).items[0].status).toBe('text_changed')
    const keys = textNotices(owner.userId).map(n => n.k)
    expect(keys).toHaveLength(1)
    expect(keys[0]).toMatch(/^browser_skill:text:order-copy:[0-9a-f]{16}$/)
    expect(svc.noticeText(admin, keys[0])).toContain('手順が直りました')
    expect(textNotices(editor.userId)).toEqual([])
    // Read again (the lazy check of approvedFrames / list): still one notice.
    await svc.approvedFrames(owner, SKILL)
    await svc.list(owner)
    expect(textNotices(owner.userId)).toHaveLength(1)
    // Step ⑤ showed the card: no more card, until the text moves again.
    expect(svc.runCardShown(owner, SKILL, after.declarationHash, after.files)).toBe(true)
    expect(value(await svc.approvedFrames(owner, SKILL))).toMatchObject({ textChanged: false, needsRunCard: false })
    put(CO, SKILL, yaml(), 'v3')
    expect(value(await svc.approvedFrames(owner, SKILL))).toMatchObject({ textChanged: true, needsRunCard: true })
    expect(textNotices(owner.userId)).toHaveLength(2)
    // Approving again counts the text as seen.
    value(await svc.approve(owner, { skill: SKILL, declarationHash: await hashOf(owner), files: store[CO]?.[P]?.files ?? '', mode: 'pre_approved' }))
    expect(value(await svc.approvedFrames(owner, SKILL))).toMatchObject({ textChanged: false, needsRunCard: false })
  })

  it('an admin\'s own text change tells the other owners / admins, not them', async () => {
    put(CO, SKILL, yaml())
    value(await svc.approve(owner, { skill: SKILL, declarationHash: await hashOf(owner), files: store[CO]?.[P]?.files ?? '', mode: 'per_run' }))
    await land(admin, yaml(), 'v2')
    expect(textNotices(owner.userId)).toHaveLength(1)
    expect(textNotices(admin.userId)).toEqual([])
    expect(value(await svc.approvedFrames(owner, SKILL)).textChanged).toBe(true)
  })

  it('runCardShown does nothing for another declaration', async () => {
    put(CO, SKILL, yaml())
    value(await svc.approve(owner, { skill: SKILL, declarationHash: await hashOf(owner), files: store[CO]?.[P]?.files ?? '', mode: 'pre_approved' }))
    put(CO, SKILL, yaml(), 'v2')
    expect(svc.runCardShown(owner, SKILL, `sha256:${'1'.repeat(64)}`, store[CO][P].files)).toBe(false)
    expect(value(await svc.approvedFrames(owner, SKILL)).needsRunCard).toBe(true)
  })
})

describe('the server\'s own copy', () => {
  it('frames come only from what the source holds now', async () => {
    put(CO, SKILL, yaml(1))
    value(await svc.approve(owner, { skill: SKILL, declarationHash: await hashOf(owner), files: store[CO]?.[P]?.files ?? '', mode: 'per_run' }))
    // The API takes no content: whatever an app holds, the source decides. A changed copy is another version.
    store[CO][P] = { ...store[CO][P], declaration: yaml(9) }
    expect(code(await svc.approvedFrames(owner, SKILL))).toBe('BROWSER_SKILL_NOT_APPROVED')
    delete store[CO][P]
    expect(code(await svc.approvedFrames(owner, SKILL))).toBe('BROWSER_SKILL_NOT_FOUND')
    expect(code(await svc.approvedFrames(owner, '../x'))).toBe('BROWSER_SKILL_NOT_FOUND')
  })

  it('the trigger keeps an approval fixed', () => {
    conn.prepare(`INSERT INTO browser_skill_approvals (company_id, skill_path, declaration_hash, mode, how, approved_by, approved_at) VALUES (?, '.claude/skills/x', 'sha256:a', 'per_run', 'approved', 'u', 't')`).run(CO)
    expect(() => conn.prepare(`UPDATE browser_skill_approvals SET declaration_hash = 'sha256:b'`).run()).toThrow(/fixed/)
    expect(() => conn.prepare(`UPDATE browser_skill_approvals SET mode = 'pre_approved'`).run()).toThrow(/fixed/)
    expect(() => conn.prepare(`UPDATE browser_skill_approvals SET seq = seq + 100`).run()).toThrow(/fixed/)
    conn.prepare(`UPDATE browser_skill_approvals SET revoked_at = 't2', revoked_by = 'u'`).run()
    expect(() => conn.prepare(`UPDATE browser_skill_approvals SET revoked_at = NULL, revoked_by = NULL`).run()).toThrow(/fixed/)
  })
})

describe('department Skills (a Skill is its path)', () => {
  it('a department Skill is listed with its department and can be approved; the company\'s by its path too', async () => {
    put(CO, SALES_P, yaml(2))
    put(CO, SKILL, yaml(1))
    const items = value(await svc.list(owner)).items
    expect(items.map(i => [i.path, i.department, i.name])).toEqual([[P, null, SKILL], [SALES_P, SALES, SKILL]])
    value(await approveAt(admin, SALES_P))
    const rows = conn.prepare('SELECT skill_path AS p FROM browser_skill_approvals WHERE company_id = ?').all(CO) as Array<{ p: string }>
    expect(rows.map(r => r.p)).toEqual([SALES_P])
    const frames = value(await svc.approvedFrames(editor, SALES_P))
    expect(frames).toMatchObject({ skill: SALES_P })
    expect(frames.frames.writes[0].max).toBe(2)
    // The company's Skill of the same name is another Skill: not approved by the department's approval.
    expect(code(await svc.approvedFrames(owner, P))).toBe('BROWSER_SKILL_NOT_APPROVED')
    expect(code(await svc.approvedFrames(owner, SKILL))).toBe('BROWSER_SKILL_NOT_APPROVED')
  })

  it('two departments with the same Skill name are kept apart: approval, revoke, notices', async () => {
    put(CO, SALES_P, yaml(1))
    put(CO, SUPPORT_P, yaml(1))
    value(await approveAt(owner, SALES_P, 'pre_approved'))
    expect(code(await svc.approvedFrames(owner, SALES_P))).toBe('ok')
    // The same declaration text in the other department is not approved by it.
    expect(code(await svc.approvedFrames(owner, SUPPORT_P))).toBe('BROWSER_SKILL_NOT_APPROVED')
    expect(value(await svc.list(owner)).items.find(i => i.path === SUPPORT_P)?.status).toBe('waiting')
    // Revoking one leaves the other.
    value(await approveAt(owner, SUPPORT_P))
    value(svc.revoke(owner, { skill: SUPPORT_P }))
    expect(code(await svc.approvedFrames(owner, SUPPORT_P))).toBe('BROWSER_SKILL_NOT_APPROVED')
    expect(code(await svc.approvedFrames(owner, SALES_P))).toBe('ok')
    // A waiting notice per Skill, though both have one name and one declaration.
    const before = noticesOf(owner.userId).filter(n => n.k.startsWith('browser_skill:waiting:')).length
    await land(editor, yaml(5), 'v1', { path: SALES_P })
    await land(editor, yaml(5), 'v1', { path: SUPPORT_P })
    const waiting = noticesOf(owner.userId).filter(n => n.k.startsWith('browser_skill:waiting:'))
    expect(waiting.length - before).toBe(2)
    for (const n of waiting) expect(n.k).toMatch(/^browser_skill:waiting:(営業|support)\/order-copy:[0-9a-f]{16}$/)
  })

  it('a name the AI gives is taken only when exactly one Skill of it is there for the member; two are refused, never guessed', async () => {
    put(CO, SALES_P, yaml(1))
    expect(value(await svc.resolve(editor, SKILL))).toBe(SALES_P)
    put(CO, SKILL, yaml(1))
    expect(code(await svc.resolve(editor, SKILL))).toBe('BROWSER_SKILL_AMBIGUOUS')
    const refused = await svc.resolve(owner, SKILL)
    expect(refused.ok ? null : (refused.body as { error?: string }).error).toContain('.claude/skills/<名前>')
    // The path always names one.
    expect(value(await svc.resolve(editor, SALES_P))).toBe(SALES_P)
    expect(value(await svc.resolve(editor, P))).toBe(P)
    // A department the member cannot read is not among the candidates.
    delete store[CO][P]
    put(CO, SUPPORT_P, yaml(1))
    expect(value(await svc.resolve(editor, SKILL))).toBe(SALES_P)
    expect(code(await svc.resolve(owner, SKILL))).toBe('BROWSER_SKILL_AMBIGUOUS')
    expect(code(await svc.resolve(editor, 'no-such'))).toBe('BROWSER_SKILL_NOT_FOUND')
    expect(code(await svc.resolve(editor, '営業/x/.claude/skills/order-copy'))).toBe('BROWSER_SKILL_NOT_FOUND')
  })

  it('a name is checked against every Skill of it, not the bounded list; when some place could not be looked into, one match is refused too (Codex review)', async () => {
    // The list (admin page) is bounded; the name's own lookup is not: a second Skill past the list's bound still counts.
    put(CO, SALES_P, yaml(1))
    put(CO, SUPPORT_P, yaml(1))
    const was = source.list
    source.list = async () => ({ paths: [SALES_P], complete: true })
    try {
      expect(code(await svc.resolve(owner, SKILL))).toBe('BROWSER_SKILL_AMBIGUOUS')
    } finally {
      source.list = was
    }
    delete store[CO][SUPPORT_P]
    expect(value(await svc.resolve(owner, SKILL))).toBe(SALES_P)
    everyPlaceRead = false
    expect(code(await svc.resolve(owner, SKILL))).toBe('BROWSER_SKILL_AMBIGUOUS')
    // A path still names exactly one.
    expect(value(await svc.resolve(owner, SALES_P))).toBe(SALES_P)
  })

  it('a member who cannot read the department cannot use its Skill (the same answer as a missing one), also mid-run', async () => {
    put(CO, SUPPORT_P, yaml(1))
    value(await approveAt(owner, SUPPORT_P, 'pre_approved'))
    const plain: Member = { companyId: CO, userId: 'u-plain', role: 'member' }
    expect(code(await svc.approvedFrames(editor, SUPPORT_P))).toBe('BROWSER_SKILL_NOT_FOUND')
    expect(code(await svc.approvedFrames(plain, SUPPORT_P))).toBe('BROWSER_SKILL_NOT_FOUND')
    expect(code(await svc.resolve(editor, SKILL))).toBe('BROWSER_SKILL_NOT_FOUND')
    // Reads it: frames; loses it during the run: the next look refuses.
    reads[editor.userId] = [SALES, SUPPORT]
    const frames = value(await svc.approvedFrames(editor, SUPPORT_P))
    expect(svc.stillApproved(editor, SUPPORT_P, frames.declarationHash, frames.approval)).toBe(true)
    reads[editor.userId] = [SALES]
    expect(svc.stillApproved(editor, SUPPORT_P, frames.declarationHash, frames.approval)).toBe(false)
    expect(code(await svc.approvedFrames(editor, SUPPORT_P))).toBe('BROWSER_SKILL_NOT_FOUND')
    // The company's Skill is used as before, whatever the member reads.
    put(CO, SKILL, yaml(1))
    value(await approveAt(owner, P))
    expect(code(await svc.approvedFrames(plain, SKILL))).toBe('ok')
  })

  it('an approval row written before department Skills (`.claude/skills/<name>`) still counts, by name and by path', async () => {
    put(CO, SKILL, yaml(1))
    const hash = await hashOf(owner)
    conn.prepare(`INSERT INTO browser_skill_approvals (company_id, skill_path, declaration_hash, mode, how, approved_by, approved_at, files_seen)
      VALUES (?, ?, ?, 'pre_approved', 'approved', ?, ?, ?)`).run(CO, P, hash, owner.userId, iso(T0), store[CO][P].files)
    expect(value(await svc.approvedFrames(editor, SKILL))).toMatchObject({ skill: P, mode: 'pre_approved', needsRunCard: false })
    expect(value(await svc.approvedFrames(editor, P))).toMatchObject({ skill: P, mode: 'pre_approved' })
    expect(value(await svc.list(owner)).items[0]).toMatchObject({ path: P, department: null, status: 'pre_approved' })
    // An older admin page sends the bare name: it means the company's Skill.
    expect(code(svc.revoke(owner, { skill: SKILL }))).toBe('ok')
    expect(code(await svc.approvedFrames(editor, SKILL))).toBe('BROWSER_SKILL_NOT_APPROVED')
  })

  it('an owner / admin\'s own edit of a department Skill counts as approval; a skill editor\'s waits', async () => {
    await land(admin, yaml(1), 'v1', { path: SALES_P })
    expect(value(await svc.approvedFrames(owner, SALES_P))).toMatchObject({ skill: SALES_P, mode: 'per_run' })
    expect(value(await svc.list(owner)).items.find(i => i.path === SALES_P)?.approval).toMatchObject({ how: 'edited', approvedBy: admin.userId })
    await land(editor, yaml(4), 'v1', { path: SALES_P })
    expect(code(await svc.approvedFrames(owner, SALES_P))).toBe('BROWSER_SKILL_NOT_APPROVED')
    // The company's Skill of the same name took nothing from these landings.
    expect(conn.prepare('SELECT COUNT(*) AS n FROM browser_skill_approvals WHERE company_id = ? AND skill_path = ?').get(CO, P)).toEqual({ n: 0 })
  })

  it('a path that is no Skill place is refused before anything is read', async () => {
    for (const skill of ['a/b/.claude/skills/x', '.claude/skills/x/', '../.claude/skills/x', '.hidden/.claude/skills/x', '営業/.claude/skills/X']) {
      expect(code(await svc.approve(owner, { skill, declarationHash: `sha256:${'0'.repeat(64)}`, files: 'git:0', mode: 'per_run' })), skill).toBe('BROWSER_SKILL_BAD_REQUEST')
      expect(code(await svc.approvedFrames(owner, skill)), skill).toBe('BROWSER_SKILL_NOT_FOUND')
    }
  })
})

describe('department Skills: the review of #879', () => {
  it('a company Skill without browser.yaml still makes its name ambiguous (the AI sees it): never silently another department\'s', async () => {
    put(CO, SALES_P, yaml(1))
    value(await approveAt(owner, SALES_P, 'pre_approved'))
    // `.claude/skills/order-copy` holds only a SKILL.md: not on the approval list, but the AI may mean it.
    plainFolders[CO] = [P]
    expect(value(await svc.list(owner)).items.map(i => i.path)).toEqual([SALES_P])
    expect(code(await svc.resolve(editor, SKILL))).toBe('BROWSER_SKILL_AMBIGUOUS')
    // A department folder without it counts the same, and a member who cannot read it is not asked about it.
    plainFolders[CO] = [SUPPORT_P]
    expect(code(await svc.resolve(owner, SKILL))).toBe('BROWSER_SKILL_AMBIGUOUS')
    expect(value(await svc.resolve(editor, SKILL))).toBe(SALES_P)
  })

  it('the approval list says when not every place could be looked into', async () => {
    put(CO, SKILL, yaml(1))
    expect(value(await svc.list(owner)).complete).toBe(true)
    everyPlaceRead = false
    expect(value(await svc.list(owner)).complete).toBe(false)
  })

  it('an owner / admin moving or copying a pending declaration to a new path does not approve it', async () => {
    // A skill editor's declaration waits at 営業.
    await land(editor, yaml(5), 'v1', { path: SALES_P })
    expect(code(await svc.approvedFrames(owner, SALES_P))).toBe('BROWSER_SKILL_NOT_APPROVED')
    // An owner moves it (before the push it stood at 営業) — still waiting at the new path.
    delete store[CO][SALES_P]
    await land(owner, yaml(5), 'v1', { path: SUPPORT_P, elsewhere: { paths: [SALES_P], complete: true } })
    expect(code(await svc.approvedFrames(owner, SUPPORT_P))).toBe('BROWSER_SKILL_NOT_APPROVED')
    // A copy of it to a third place: also waiting.
    const third = `経理/.claude/skills/${SKILL}`
    await land(admin, yaml(5), 'v1', { path: third, elsewhere: { paths: [SUPPORT_P], complete: true } })
    expect(code(await svc.approvedFrames(owner, third))).toBe('BROWSER_SKILL_NOT_APPROVED')
    expect(conn.prepare('SELECT COUNT(*) AS n FROM browser_skill_approvals WHERE company_id = ?').get(CO)).toEqual({ n: 0 })
    // Not every place looked into: waits too, even for a declaration nobody had.
    await land(owner, yaml(6), 'v1', { path: `人事/.claude/skills/${SKILL}`, elsewhere: { paths: [], complete: false } })
    expect(code(await svc.approvedFrames(owner, `人事/.claude/skills/${SKILL}`))).toBe('BROWSER_SKILL_NOT_APPROVED')
  })

  it('an owner / admin copying an approved declaration to a new path approves the copy; a brand-new one too', async () => {
    put(CO, SALES_P, yaml(2))
    value(await approveAt(owner, SALES_P))
    await land(admin, yaml(2), 'v1', { path: SUPPORT_P, elsewhere: { paths: [SALES_P], complete: true } })
    expect(value(await svc.approvedFrames(owner, SUPPORT_P))).toMatchObject({ skill: SUPPORT_P })
    await land(owner, yaml(7), 'v1', { path: `経理/.claude/skills/${SKILL}` })
    expect(code(await svc.approvedFrames(owner, `経理/.claude/skills/${SKILL}`))).toBe('ok')
  })

  it('a declaration whose approval was ever taken back is not approved again by an owner / admin putting it at a new path', async () => {
    put(CO, SALES_P, yaml(3))
    value(await approveAt(owner, SALES_P))
    value(svc.revoke(owner, { skill: SALES_P }))
    // Moved by an admin: the old path is gone, the new one is new — still the revoked declaration.
    delete store[CO][SALES_P]
    await land(admin, yaml(3), 'v1', { path: SUPPORT_P })
    expect(code(await svc.approvedFrames(owner, SUPPORT_P))).toBe('BROWSER_SKILL_NOT_APPROVED')
    expect(value(await svc.list(owner)).items.find(i => i.path === SUPPORT_P)?.status).toBe('waiting')
  })

  it('a notice names the Skill\'s department; the company\'s says 全社', async () => {
    await land(editor, yaml(5), 'v1', { path: SALES_P })
    await land(editor, yaml(5), 'v1')
    const keys = noticesOf(owner.userId).map(n => n.k).filter(k => k.startsWith('browser_skill:waiting:'))
    const sales = keys.find(k => k.includes(`${SALES}/`))!
    expect(sales).toMatch(/^browser_skill:waiting:営業\/order-copy:[0-9a-f]{16}$/)
    expect(svc.noticeText(owner, sales)).toContain('部署「営業」の Skill「order-copy」の宣言')
    const company = keys.find(k => k !== sales)!
    expect(svc.noticeText(owner, company)).toContain('全社の Skill「order-copy」の宣言')
    // A key naming no department folder is shown as nothing.
    expect(svc.noticeText(owner, 'browser_skill:waiting:.x/order-copy:0123456789abcdef')).toBeNull()
  })
})
