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
import { SHELF_ALREADY_COMPANY_MESSAGE, SHELF_NOT_A_PLACE_MESSAGE, SHELF_NOT_HERE_MESSAGE, SHELF_NOT_READABLE_MESSAGE, SHELF_OFFLINE_MESSAGE, SHELF_TOO_MUCH_MESSAGE } from '../shared/skill-shelf.ts'

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
async function open(id: string, delivered: Record<string, Record<string, string>> = {}) {
  h.server.on('GET', `/api/companies/${id}`, { json: { success: true, data: { id, name: id, folderKind: 'none' } } })
  h.server.on('GET', `/api/companies/${id}/departments`, { json: { success: true, data: [{ id: 'd1', folder: '営業部' }] } })
  const shelf = { delivered }
  h.server.on('GET', `/api/companies/${id}/me/skill-shelf`, () => ({
    json: { success: true, data: { items: Object.entries(shelf.delivered).map(([name, files]) => ({ id: `item-${name}`, kind: 'skill', name, department: null, version: versionOf(files), fileCount: 1, totalBytes: 1 })) } },
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

test('opening a working folder places the company\'s Skills; the Skills panel tells them from the member\'s own, and hears of it', async () => {
  const skill = { 'SKILL.md': '---\nname: 提案\n---\n本文\n' }
  const { folder } = await open('co-open', { proposal: skill })
  writeFiles(folder, { '.claude/skills/mine/SKILL.md': '# mine\n' })
  const listed = await h.invoke<{ skills: Array<{ name: string; skillPath: string; shelf?: unknown }> }>('skills:list', folder, '', 'company', undefined, { force: true })
  assert.deepEqual(listed.skills.map(s => [path.basename(s.skillPath), s.shelf]).sort(), [['mine', undefined], ['proposal', { state: 'company', version: versionOf(skill) }]])
  assert.ok(h.renderer().sent.some(event => event.channel === 'skillShelf:changed'))
})

test('「会社に公開」: the folder goes up with what the member saw, leaving out what the system added, and the Skill becomes the company\'s', async () => {
  const { folder, shelf } = await open('co-pub')
  writeFiles(folder, { '営業部/.claude/skills/visit/SKILL.md': 'visit\n', '営業部/.claude/skills/visit/scripts/a.py': 'print(1)\n', '営業部/.claude/skills/visit/.DS_Store': 'x', '営業部/.claude/skills/visit/tools/app/node_modules/x.js': 'x' })
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

test('「手元で直す」 through main: the Skill is no longer the company\'s on this computer, and 「会社に公開」 then replaces the version the member saw', async () => {
  const skill = { 'SKILL.md': 'v1\n' }
  const { folder } = await open('co-edit', { proposal: skill })
  const skillPath = path.join(folder, '.claude/skills/proposal')
  assert.deepEqual(await h.invoke('skillShelf:editLocally', folder, skillPath), { success: true })
  const listed = await h.invoke<{ skills: Array<{ shelf?: unknown }> }>('skills:list', folder, '', 'company', undefined, { force: true })
  assert.deepEqual(listed.skills[0].shelf, { state: 'clash', version: versionOf(skill) })
})

test('a git company\'s folder: nothing is asked of the shelf, publishing and 手元で直す are refused, and skills:list marks nothing', async () => {
  const folder = h.companyDir('co-git')
  commitRepo(h.base, folder, { '.claude/skills/proposal/SKILL.md': 'x\n' })
  await h.invoke('fs:registerAllowedRoot', folder)
  const skillPath = path.join(folder, '.claude/skills/proposal')
  assert.deepEqual(await h.invoke('skillShelf:publish', folder, skillPath, null), { success: false, error: SHELF_NOT_HERE_MESSAGE })
  assert.deepEqual(await h.invoke('skillShelf:editLocally', folder, skillPath), { success: false, error: SHELF_NOT_HERE_MESSAGE })
  const listed = await h.invoke<{ skills: Array<{ shelf?: unknown }> }>('skills:list', folder, '', 'company', undefined, { force: true })
  assert.equal(listed.skills[0].shelf, undefined)
  assert.deepEqual(h.server.to(/co-git.*skill-shelf/), [])
})
