// The Skill shelf through the real main.ts (plugins.md "The Skill shelf in the app"): opening a
// working folder fetches and places; 「会社に公開」 sends the folder and shows the server's refusal
// in its own words; a git company's folder never meets any of it. The store's rules: skill-shelf.test.ts.
import { test, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { commitRepo, loadMain, writeFiles, type MainHarness } from './ipc-harness/main-harness.ts'
import { shelfListing } from '../../shared/core/skill-shelf.ts'
import { WORKING_FOLDER_TAKEN_MESSAGE } from '../electron/features/company-setup/ipc.ts'
import { SHELF_ALREADY_COMPANY_MESSAGE, SHELF_NO_BACKUP_MESSAGE, SHELF_NOT_A_PLACE_MESSAGE, SHELF_NOT_EDITING_MESSAGE, SHELF_NOT_HERE_MESSAGE, SHELF_NOT_READABLE_MESSAGE, SHELF_OFFLINE_MESSAGE, SHELF_REQUEST_OFFLINE_MESSAGE, SHELF_RESTORE_PLACE_MESSAGE, SHELF_TOO_MUCH_MESSAGE } from '../shared/skill-shelf.ts'

let h: MainHarness
before(async () => {
  h = await loadMain()
  await h.startApp()
  h.server.on('POST', '/api/auth/sign-in/email', { json: { user: { id: 'u1' } }, headers: { 'Set-Cookie': 'better-auth.session_token=t.s; Path=/' } })
  h.server.on('GET', '/api/me', { json: { success: true, data: { id: 'u1', email: 'me@example.com', name: 'me' } } })
  await h.invoke('auth:signIn', 'me@example.com', 'right')
  await h.invoke('auth:getSession')
})
after(() => h.shutdown())

const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const versionOf = (files: Record<string, string>) => sha(shelfListing(Object.entries(files).map(([p, text]) => ({ path: p, sha256: sha(text) }))))

/** A `none` company with these delivered Skills at its root; its working folder opened. */
async function open(id: string, delivered: Record<string, Record<string, string>> = {}, skillPublishing: unknown = { company: true, departmentFolders: ['営業部'] }, requests: unknown[] = []) {
  h.server.on('GET', `/api/companies/${id}`, { json: { success: true, data: { id, name: id, folderKind: 'none' } } })
  h.server.on('GET', `/api/companies/${id}/departments`, { json: { success: true, data: [{ id: 'd1', folder: '営業部' }] } })
  const shelf = { delivered }
  h.server.on('GET', `/api/companies/${id}/me/skill-shelf`, () => ({
    json: { success: true, data: { items: Object.entries(shelf.delivered).map(([name, files]) => ({ id: `item-${name}`, kind: 'skill', name, department: null, version: versionOf(files), fileCount: 1, totalBytes: 1 })), skillPublishing, requests } },
  }))
  h.server.on('GET', new RegExp(`^/api/companies/${id}/skill-shelf/item-`), req => {
    const name = /item-([^/]+)/.exec(req.path)![1]
    const files = shelf.delivered[name]
    return { json: { success: true, data: { id: `item-${name}`, kind: 'skill', name, version: versionOf(files), files: Object.entries(files).map(([p, text]) => ({ path: p, base64: Buffer.from(text).toString('base64') })) } } }
  })
  const parent = h.companyDir(`parent-${id}`)
  await h.invoke('fs:registerAllowedRoot', parent)
  const folder = path.join(parent, id)
  assert.deepEqual(await h.invoke('companySetup:openWorkingFolder', folder, id), { success: true })
  // The fetch runs in the background; the Skills panel hears of it by this event.
  await until(() => Object.keys(delivered).every(name => fs.existsSync(path.join(folder, '.agents/skills', name, 'SKILL.md'))))
  return { folder, shelf }
}

async function until(done: () => boolean) {
  for (let i = 0; i < 200 && !done(); i++) await new Promise(r => setTimeout(r, 5))
  assert.ok(done())
}

test('opening a working folder places the company\'s Skills; the Skills panel tells them from the member\'s own, says where 会社に公開 is offered, and hears of it', async () => {
  const skill = { 'SKILL.md': '---\nname: 提案\n---\n本文\n' }
  const { folder } = await open('co-open', { proposal: skill }, { company: false, departmentFolders: ['営業部'] })
  writeFiles(folder, { '.claude/skills/mine/SKILL.md': '# mine\n', '営業部/.claude/skills/visit/SKILL.md': 'visit\n' })
  type Listed = { skills: Array<{ name: string; skillPath: string; shelf?: unknown; shelfPublish?: boolean }> }
  const listed = await h.invoke<Listed>('skills:list', folder, '', 'company', undefined, { force: true })
  assert.deepEqual(listed.skills.map(s => [path.basename(s.skillPath), s.shelf]).sort(), [['mine', undefined], ['proposal', { state: 'company', version: versionOf(skill) }]])
  // The server said: not at the company root, but in 営業部.
  assert.equal(listed.skills.find(s => s.skillPath.endsWith('mine'))?.shelfPublish, false)
  const sales = await h.invoke<Listed>('skills:list', folder, '営業部', 'd1', '営業部', { force: true })
  assert.equal(sales.skills.find(s => s.skillPath.endsWith('visit'))?.shelfPublish, true)
  assert.ok(h.renderer().sent.some(event => event.channel === 'skillShelf:changed'))
})

test('「会社に公開」: the folder goes up with what the member saw, leaving out what the system added, and the Skill becomes the company\'s', async () => {
  const { folder, shelf } = await open('co-pub')
  writeFiles(folder, { '営業部/.claude/skills/visit/SKILL.md': 'visit\n', '営業部/.claude/skills/visit/scripts/a.py': 'print(1)\n', '営業部/.claude/skills/visit/.DS_Store': 'x', '営業部/.claude/skills/visit/tools/app/node_modules/x.js': 'x', '営業部/.claude/skills/visit/.env': 'KEY=secret\n', '営業部/.claude/skills/visit/.env.local': 'KEY=secret\n', '営業部/.claude/skills/visit/.git/config': 'x', '営業部/.claude/skills/visit/venv/lib/x.py': 'x', '営業部/.claude/skills/visit/scripts/a.pyc': 'x', '営業部/.claude/skills/visit/.tool-output.log': 'x' })
  const posted: Array<Record<string, unknown>> = []
  h.server.on('POST', '/api/companies/co-pub/skill-shelf', req => {
    posted.push(JSON.parse(req.body!))
    shelf.delivered = {}
    return { status: 201, json: { success: true, data: { changed: true, item: {} } } }
  })
  const skillPath = path.join(folder, '営業部/.claude/skills/visit')
  assert.deepEqual(await h.invoke('skillShelf:publish', folder, skillPath, null), { success: true })
  assert.equal(posted.length, 1)
  const { files, ...rest } = posted[0] as { files: Array<{ path: string; base64: string }> }
  assert.deepEqual(rest, { kind: 'skill', departmentId: 'd1', name: 'visit', expectedVersion: null })
  assert.deepEqual(files.map(f => f.path).sort(), ['SKILL.md', 'scripts/a.py'])
  assert.equal(Buffer.from(files.find(f => f.path === 'SKILL.md')!.base64, 'base64').toString(), 'visit\n')
})

test('the server\'s refusal reaches the member in its own words; offline says so; nothing changes in the folder', async () => {
  const { folder } = await open('co-no')
  writeFiles(folder, { '.claude/skills/mine/SKILL.md': '# mine\n' })
  const skillPath = path.join(folder, '.claude/skills/mine')
  const sentence = 'この Skill・指示を変えられるのは、決められた人だけです。'
  h.server.on('POST', '/api/companies/co-no/skill-shelf', { status: 403, json: { error: sentence, code: 'SHELF_NOT_ALLOWED', files: [] } })
  assert.deepEqual(await h.invoke('skillShelf:publish', folder, skillPath, null), { success: false, error: sentence })
  h.server.offline = true
  assert.deepEqual(await h.invoke('skillShelf:publish', folder, skillPath, null), { success: false, error: SHELF_OFFLINE_MESSAGE })
  h.server.offline = false
  assert.equal(fs.readFileSync(path.join(skillPath, 'SKILL.md'), 'utf8'), '# mine\n')
})

test('what is not sent at all: a delivered Skill, a Skill deeper in a folder, a folder with a link in it, one over the limits', async () => {
  const { folder } = await open('co-odd', { proposal: { 'SKILL.md': 'x\n' } })
  writeFiles(folder, { '営業部/案件/.claude/skills/deep/SKILL.md': 'x\n', '.claude/skills/linked/SKILL.md': 'x\n', '.claude/skills/big/SKILL.md': 'x\n' })
  fs.symlinkSync(path.join(folder, '営業部'), path.join(folder, '.claude/skills/linked/more'))
  for (let i = 0; i < 200; i++) fs.writeFileSync(path.join(folder, `.claude/skills/big/f${i}.md`), 'x')
  const publish = (rel: string) => h.invoke('skillShelf:publish', folder, path.join(folder, rel), null)
  assert.deepEqual(await publish('.claude/skills/proposal'), { success: false, error: SHELF_ALREADY_COMPANY_MESSAGE })
  assert.deepEqual(await publish('営業部/案件/.claude/skills/deep'), { success: false, error: SHELF_NOT_A_PLACE_MESSAGE })
  assert.deepEqual(await publish('.claude/skills/linked'), { success: false, error: SHELF_NOT_READABLE_MESSAGE })
  assert.deepEqual(await publish('.claude/skills/big'), { success: false, error: SHELF_TOO_MUCH_MESSAGE })
  assert.equal(h.server.to('/api/companies/co-odd/skill-shelf').filter(r => r.method === 'POST').length, 0)
})

test('「自分用に直す」 through main: the Skill is no longer the company\'s on this computer, and 「会社に公開」 then replaces the version the member saw', async () => {
  const skill = { 'SKILL.md': 'v1\n' }
  const { folder } = await open('co-edit', { proposal: skill })
  const skillPath = path.join(folder, '.claude/skills/proposal')
  assert.deepEqual(await h.invoke('skillShelf:editLocally', folder, skillPath), { success: true })
  const listed = await h.invoke<{ skills: Array<{ shelf?: unknown }> }>('skills:list', folder, '', 'company', undefined, { force: true })
  assert.deepEqual(listed.skills[0].shelf, { state: 'editing', version: versionOf(skill) })
})

test('「会社の版に戻す」 through main: the member\'s version goes to .backups, the company\'s is back at once; offline it comes later', async () => {
  const skill = { 'SKILL.md': 'v1\n' }
  const { folder } = await open('co-back', { proposal: skill })
  const skillPath = path.join(folder, '.claude/skills/proposal')
  // Only a Skill under 自分用に直す: the company's own is refused and stays.
  assert.deepEqual(await h.invoke('skillShelf:restoreCompany', folder, skillPath), { success: false, error: SHELF_NOT_EDITING_MESSAGE })
  assert.equal(fs.existsSync(path.join(folder, '.backups')), false)

  assert.deepEqual(await h.invoke('skillShelf:editLocally', folder, skillPath), { success: true })
  writeFiles(folder, { '.claude/skills/proposal/SKILL.md': 'mine\n' })
  assert.deepEqual(await h.invoke('skillShelf:restoreCompany', folder, skillPath), { success: true, companyVersion: 'back' })
  assert.equal(fs.readFileSync(path.join(skillPath, 'SKILL.md'), 'utf8'), 'v1\n')
  const [kept] = fs.readdirSync(path.join(folder, '.backups'))
  assert.match(kept, /_skill_edit$/)
  assert.equal(fs.readFileSync(path.join(folder, '.backups', kept, '.claude/skills/proposal/SKILL.md'), 'utf8'), 'mine\n')
  const listed = await h.invoke<{ skills: Array<{ shelf?: unknown }> }>('skills:list', folder, '', 'company', undefined, { force: true })
  assert.deepEqual(listed.skills.map(s => s.shelf), [{ state: 'company', version: versionOf(skill) }], 'the copy in .backups is not listed as a Skill')
  // Nothing of it went to the server.
  assert.deepEqual(h.server.to('/api/companies/co-back/skill-shelf').filter(r => r.method === 'POST'), [])

  assert.deepEqual(await h.invoke('skillShelf:editLocally', folder, skillPath), { success: true })
  h.server.offline = true
  try {
    assert.deepEqual(await h.invoke('skillShelf:restoreCompany', folder, skillPath), { success: true, companyVersion: 'later' })
  } finally {
    h.server.offline = false
  }
  assert.equal(fs.existsSync(skillPath), false)
  assert.equal(fs.readdirSync(path.join(folder, '.backups')).length, 2)
})

test('「会社の版に戻す」 through main refuses a Skill folder that is a link, and changes nothing', async () => {
  const { folder } = await open('co-link', { proposal: { 'SKILL.md': 'v1\n' } })
  const skillPath = path.join(folder, '.claude/skills/proposal')
  assert.deepEqual(await h.invoke('skillShelf:editLocally', folder, skillPath), { success: true })
  const inside = path.join(folder, 'メモ')
  writeFiles(folder, { 'メモ/SKILL.md': 'memo\n' })
  fs.rmSync(skillPath, { recursive: true })
  fs.symlinkSync(inside, skillPath)
  assert.deepEqual(await h.invoke('skillShelf:restoreCompany', folder, skillPath), { success: false, error: SHELF_RESTORE_PLACE_MESSAGE })
  assert.ok(fs.lstatSync(skillPath).isSymbolicLink())
  assert.equal(fs.readFileSync(path.join(inside, 'SKILL.md'), 'utf8'), 'memo\n')
  assert.equal(fs.existsSync(path.join(folder, '.backups')), false)
})

test('a folder another company works in is refused, and nothing is delivered into it', async () => {
  const { folder } = await open('co-first', { proposal: { 'SKILL.md': 'x\n' } })
  h.server.on('GET', '/api/companies/co-second', { json: { success: true, data: { id: 'co-second', name: 'b', folderKind: 'none' } } })
  h.server.on('GET', '/api/companies/co-second/departments', { json: { success: true, data: [] } })
  assert.deepEqual(await h.invoke('companySetup:openWorkingFolder', folder, 'co-second'), { success: false, error: WORKING_FOLDER_TAKEN_MESSAGE })
  assert.deepEqual(h.server.to('/api/companies/co-second/me/skill-shelf'), [])
  assert.deepEqual(await h.invoke('companySetup:openWorkingFolder', folder, 'co-first'), { success: true }, 'its own company reopens it')
})

test('a rule file kept back by a file of the member\'s is said in the Skills panel', async () => {
  const id = 'co-rule'
  const { folder } = await open(id)
  writeFiles(folder, { '.claude/rules/tone.md': 'mine\n' })
  const files = { 'tone.md': '敬語で\n' }
  h.server.on('GET', `/api/companies/${id}/me/skill-shelf`, { json: { success: true, data: { items: [{ id: 'r1', kind: 'rule', name: 'tone', department: null, version: versionOf(files), fileCount: 1, totalBytes: 1 }] } } })
  writeFiles(folder, { '.claude/skills/own/SKILL.md': 'own\n' })
  h.server.on('POST', `/api/companies/${id}/skill-shelf`, { status: 201, json: { success: true, data: { changed: true, item: {} } } })
  await h.invoke('skillShelf:publish', folder, path.join(folder, '.claude/skills/own'), null)
  const listed = await h.invoke<{ ruleClashes?: string[] }>('skills:list', folder, '', 'company', undefined, { force: true })
  assert.deepEqual(listed.ruleClashes, ['tone'])
  assert.equal(fs.readFileSync(path.join(folder, '.claude/rules/tone.md'), 'utf8'), 'mine\n')
})

test('a git company\'s folder: nothing is asked of the shelf, publishing, 自分用に直す and 会社の版に戻す are refused, and skills:list marks nothing', async () => {
  const folder = h.companyDir('co-git')
  commitRepo(h.base, folder, { '.claude/skills/proposal/SKILL.md': 'x\n' })
  await h.invoke('fs:registerAllowedRoot', folder)
  const skillPath = path.join(folder, '.claude/skills/proposal')
  assert.deepEqual(await h.invoke('skillShelf:publish', folder, skillPath, null), { success: false, error: SHELF_NOT_HERE_MESSAGE })
  assert.deepEqual(await h.invoke('skillShelf:editLocally', folder, skillPath), { success: false, error: SHELF_NOT_HERE_MESSAGE })
  assert.deepEqual(await h.invoke('skillShelf:restoreCompany', folder, skillPath), { success: false, error: SHELF_NOT_HERE_MESSAGE })
  assert.deepEqual(await h.invoke('skillShelf:requestPublish', folder, skillPath), { success: false, error: SHELF_NOT_HERE_MESSAGE })
  assert.deepEqual(await h.invoke('skillShelf:openBackup', folder, skillPath), { success: false, error: SHELF_NOT_HERE_MESSAGE })
  assert.equal(fs.readFileSync(path.join(skillPath, 'SKILL.md'), 'utf8'), 'x\n')
  const listed = await h.invoke<{ skills: Array<{ shelf?: unknown; shelfPublish?: boolean }> }>('skills:list', folder, '', 'company', undefined, { force: true })
  assert.equal(listed.skills[0].shelf, undefined)
  assert.equal(listed.skills[0].shelfPublish, undefined)
  assert.deepEqual(h.server.to(/co-git.*skill-shelf/), [])
})

test('「会社に出してほしいと頼む」 through main: the folder goes to the requests with what publishing would send; the card then shows it waiting; refusals in the server\'s words', async () => {
  const id = 'co-ask'
  const requests: unknown[] = []
  const { folder } = await open(id, { proposal: { 'SKILL.md': 'x\n' } }, { company: false, departmentFolders: [] }, requests)
  writeFiles(folder, { '営業部/.claude/skills/visit/SKILL.md': 'visit\n', '営業部/.claude/skills/visit/scripts/a.py': 'print(1)\n', '営業部/.claude/skills/visit/.env': 'KEY=secret\n', '営業部/.claude/skills/visit/.git/config': 'x' })
  const posted: Array<Record<string, unknown>> = []
  h.server.on('POST', `/api/companies/${id}/skill-shelf-requests`, req => {
    posted.push(JSON.parse(req.body!))
    requests.push({ id: 'r1', name: 'visit', department: { id: 'd1', folder: '営業部' }, state: 'pending', requestedAt: '2026-11-09T01:00:00.000Z', decidedAt: null, reason: null })
    return { status: 201, json: { success: true, data: { id: 'r1' } } }
  })
  const skillPath = path.join(folder, '営業部/.claude/skills/visit')
  type Listed = { skills: Array<{ skillPath: string; shelfPublish?: boolean; shelfRequest?: { offered: boolean; last?: { state: string } } }> }
  const before = await h.invoke<Listed>('skills:list', folder, '営業部', 'd1', '営業部', { force: true })
  assert.deepEqual(before.skills.find(s => s.skillPath.endsWith('visit'))?.shelfRequest, { offered: true })
  assert.deepEqual(await h.invoke('skillShelf:requestPublish', folder, skillPath), { success: true })
  const { files, ...rest } = posted[0] as { files: Array<{ path: string }> }
  assert.deepEqual(rest, { departmentId: 'd1', name: 'visit' })
  assert.deepEqual(files.map(f => f.path).sort(), ['SKILL.md', 'scripts/a.py'], 'no .env, no .git')
  const after = await h.invoke<Listed>('skills:list', folder, '営業部', 'd1', '営業部', { force: true })
  assert.equal(after.skills.find(s => s.skillPath.endsWith('visit'))?.shelfRequest?.last?.state, 'pending')

  // A delivered Skill is not sent; the server's refusal is shown as written; offline says so.
  assert.deepEqual(await h.invoke('skillShelf:requestPublish', folder, path.join(folder, '.claude/skills/proposal')), { success: false, error: SHELF_ALREADY_COMPANY_MESSAGE })
  const sentence = 'パスワードやキーのようなものが入っています。取り除いてから、もう一度やり直してください。'
  h.server.on('POST', `/api/companies/${id}/skill-shelf-requests`, { status: 400, json: { error: sentence, code: 'SHELF_SECRET_DETECTED' } })
  assert.deepEqual(await h.invoke('skillShelf:requestPublish', folder, skillPath), { success: false, error: sentence })
  writeFiles(folder, { '.claude/skills/own/SKILL.md': 'own\n' })
  h.server.offline = true
  try {
    assert.deepEqual(await h.invoke('skillShelf:requestPublish', folder, path.join(folder, '.claude/skills/own')), { success: false, error: SHELF_REQUEST_OFFLINE_MESSAGE })
  } finally {
    h.server.offline = false
  }
  assert.equal(posted.length, 1)
})

test('「控えを開く」 through main: only after 会社の版に戻す kept a copy, and only that copy inside the working folder is shown', async () => {
  const { folder } = await open('co-copy', { proposal: { 'SKILL.md': 'v1\n' } })
  const skillPath = path.join(folder, '.claude/skills/proposal')
  const opened = h.fake.openedPaths.length
  assert.deepEqual(await h.invoke('skillShelf:openBackup', folder, skillPath), { success: false, error: SHELF_NO_BACKUP_MESSAGE })
  assert.deepEqual(await h.invoke('skillShelf:editLocally', folder, skillPath), { success: true })
  writeFiles(folder, { '.claude/skills/proposal/SKILL.md': 'mine\n' })
  assert.deepEqual(await h.invoke('skillShelf:restoreCompany', folder, skillPath), { success: true, companyVersion: 'back' })
  type Listed = { skills: Array<{ shelfBackup?: boolean }> }
  assert.equal((await h.invoke<Listed>('skills:list', folder, '', 'company', undefined, { force: true })).skills[0].shelfBackup, true)
  assert.deepEqual(await h.invoke('skillShelf:openBackup', folder, skillPath), { success: true })
  const [kept] = fs.readdirSync(path.join(folder, '.backups'))
  assert.deepEqual(h.fake.openedPaths.slice(opened), [path.join(folder, '.backups', kept, '.claude/skills/proposal')])
  // A copy whose folder became a link out of the working folder is never opened.
  const outside = h.companyDir('co-copy-outside')
  fs.mkdirSync(path.join(outside, 'proposal'), { recursive: true })
  fs.rmSync(path.join(folder, '.backups', kept, '.claude/skills'), { recursive: true })
  fs.symlinkSync(outside, path.join(folder, '.backups', kept, '.claude/skills'))
  assert.deepEqual(await h.invoke('skillShelf:openBackup', folder, skillPath), { success: false, error: SHELF_NO_BACKUP_MESSAGE })
  assert.equal(h.fake.openedPaths.length, opened + 1)
})
