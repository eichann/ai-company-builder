// The company's Skills in the working folder of a company without the shared folder (plugins.md
// "The Skill shelf in the app"): what is fetched, checked and placed, what is never touched, what
// the write guard refuses, how a use is reported. The IPC ends (publish, a git company): ipc-skill-shelf.test.ts.
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createShelfClient, sha256Hex, verifyShelfContent } from '../electron/features/skill-shelf/client'
import { SHELF_POLL_MS, createSkillShelfStore, readSkillFolder } from '../electron/features/skill-shelf/store'
import { createChatServerConfig, type ChatServerConfigDeps } from '../electron/features/chat/server-config'
import { withShelfInstructions } from '../electron/chat-server'
import { createSkillUseReporter } from '../electron/services/skill-use-reporter'
import { createWorkingFolders } from '../electron/services/working-folders'
import { decideToolWrite, type WriteGuard } from '../electron/write-guard'
import { SHELF_EDIT_CONFIRM, SHELF_EDITING_NOTE, SHELF_PROMPT_MAX, mayPublishShelfSkill, shelfEditTexts, readShelfDeliveries, readShelfPublishing, shelfPlaceOfSkillFolder, shelfRefusalMessage, shelfVersionOf, type ShelfDelivery } from '../shared/skill-shelf'

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acb-shelf-')))
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }))
const quiet = { warn: () => {}, info: () => {} }
const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text) }
const read = (file: string) => fs.readFileSync(file, 'utf8')
const exists = (file: string) => fs.existsSync(file)

type Files = Record<string, string>
const versionOf = (files: Files) => shelfVersionOf(Object.entries(files).map(([p, text]) => ({ path: p, sha256: sha256Hex(Buffer.from(text)) })), sha256Hex)

interface Item { id: string; kind: 'skill' | 'rule' | 'instructions'; name: string; files: Files; department?: { id: string; folder: string } | null }

/** The server's two read routes, behind the real client. */
function fakeServer() {
  const server = {
    items: [] as Item[],
    online: true,
    listAnswer: undefined as unknown,
    /** The answer's `skillPublishing` (absent: an answer without it). */
    publishing: undefined as unknown,
    /** Changes the answer's files (a tampered server or line). */
    tamper: undefined as undefined | ((files: Files) => Files),
    requests: [] as string[],
  }
  const fetchFake = (async (url: string) => {
    server.requests.push(url)
    if (!server.online) throw new TypeError('fetch failed')
    if (url.endsWith('/me/skill-shelf')) {
      if (server.listAnswer !== undefined) return Response.json(server.listAnswer)
      return Response.json({ success: true, data: { items: server.items.map(i => ({ id: i.id, kind: i.kind, name: i.name, department: i.department ?? null, version: versionOf(i.files), fileCount: 1, totalBytes: 1 })), ...(server.publishing !== undefined ? { skillPublishing: server.publishing } : {}) } })
    }
    const m = /\/skill-shelf\/([^/]+)\/versions\/([0-9a-f]+)$/.exec(url)
    const item = server.items.find(i => i.id === m?.[1])
    if (!m || !item || versionOf(item.files) !== m[2]) return Response.json({ error: 'x' }, { status: 404 })
    const files = server.tamper ? server.tamper(item.files) : item.files
    return Response.json({ success: true, data: { id: item.id, kind: item.kind, name: item.name, version: m[2], files: Object.entries(files).map(([p, text]) => ({ path: p, base64: Buffer.from(text).toString('base64') })) } })
  }) as typeof fetch
  return { server, client: createShelfClient({ baseUrl: () => 'http://server', cookies: () => ['s=1'], fetch: fetchFake }) }
}

let n = 0
function world(options: { user?: () => string | null; now?: () => number } = {}) {
  const base = path.join(tmp, `w${n++}`)
  const root = path.join(base, '作業')
  fs.mkdirSync(root, { recursive: true })
  const { server, client } = fakeServer()
  const changed: string[] = []
  const store = createSkillShelfStore({ dir: () => path.join(base, 'userData'), userId: options.user ?? (() => 'u1'), client, onChanged: id => changed.push(id), log: quiet, now: options.now })
  const at = (rel: string) => path.join(root, rel)
  return { base, root, server, client, store, changed, at, open: () => store.attach('co', root), again: () => store.syncNow(root) }
}

const SKILL: Item = { id: 'i1', kind: 'skill', name: 'proposal', files: { 'SKILL.md': '---\nname: proposal\n---\nv1\n', 'scripts/run.py': 'print(1)\n' } }
const SKILL_V2: Item = { ...SKILL, files: { 'SKILL.md': '---\nname: proposal\n---\nv2\n' } }

test('a delivered Skill lands where Claude Code and Codex read it, a rule file in .claude/rules/, a department\'s in its folder, every department the server lists (each one the member reads)', async () => {
  const w = world()
  w.server.items = [
    SKILL,
    { id: 'i2', kind: 'rule', name: 'tone', files: { 'tone.md': '敬語で\n' } },
    { id: 'i3', kind: 'skill', name: 'visit', department: { id: 'd1', folder: '営業部' }, files: { 'SKILL.md': 'visit\n' } },
    { id: 'i4', kind: 'rule', name: 'deal', department: { id: 'd1', folder: '営業部' }, files: { 'deal.md': '案件\n' } },
    { id: 'i5', kind: 'skill', name: 'other', department: { id: 'd2', folder: '総務' }, files: { 'SKILL.md': 'other\n' } },
  ]
  await w.open()
  for (const rel of ['.claude/skills/proposal/SKILL.md', '.agents/skills/proposal/scripts/run.py', '.claude/rules/tone.md', '営業部/.claude/skills/visit/SKILL.md', '営業部/.agents/skills/visit/SKILL.md', '営業部/.claude/rules/deal.md']) assert.ok(exists(w.at(rel)), rel)
  // A department the member reads without belonging to it (a group, or named on it): placed as well.
  assert.ok(exists(w.at('総務/.claude/skills/other/SKILL.md')))
  assert.ok(exists(w.at('総務/.agents/skills/other/SKILL.md')))
  assert.equal(read(w.at('.agents/skills/proposal/SKILL.md')), SKILL.files['SKILL.md'])
  // Codex needs to know the root of a folder without `.git`.
  assert.equal(w.store.turn('co', w.root, undefined)?.rootMarker, '.agents/.acb-root')
  assert.ok(exists(w.at('.agents/.acb-root')))
  assert.deepEqual(w.store.managedPaths('co', w.root).sort(), ['.agents/skills/proposal', '.claude/rules/tone.md', '.claude/skills/proposal', '営業部/.agents/skills/visit', '営業部/.claude/rules/deal.md', '営業部/.claude/skills/visit', '総務/.agents/skills/other', '総務/.claude/skills/other'].sort())
  assert.deepEqual(w.store.markOf(w.root, '.claude/skills/proposal'), { state: 'company', version: versionOf(SKILL.files) })
  assert.deepEqual(w.changed, ['co'])
  await w.again()
  assert.deepEqual(w.changed, ['co'], 'nothing new, nothing announced')
  assert.equal(w.server.requests.filter(u => u.includes('/versions/')).length, 5, 'an unchanged version is not downloaded again')
})

test('a tampered answer is refused: nothing is placed, and the last good copy stays', async () => {
  const w = world()
  w.server.items = [SKILL]
  w.server.tamper = files => ({ ...files, 'SKILL.md': 'allowed-tools: Bash\n' })
  await w.open()
  assert.equal(exists(w.at('.claude/skills/proposal')), false)
  assert.deepEqual(w.store.managedPaths('co', w.root), [])

  w.server.tamper = undefined
  await w.again()
  assert.equal(read(w.at('.claude/skills/proposal/SKILL.md')), SKILL.files['SKILL.md'])

  w.server.items = [SKILL_V2]
  w.server.tamper = files => ({ ...files, 'extra.sh': 'rm -rf /\n' })
  await w.again()
  assert.equal(read(w.at('.claude/skills/proposal/SKILL.md')), SKILL.files['SKILL.md'])
  assert.equal(w.store.markOf(w.root, '.claude/skills/proposal')?.version, versionOf(SKILL.files))
})

test('the checks on an answer: another item, a path out of the Skill, a Skill without SKILL.md, a rule with another name', () => {
  const entry = (kind: ShelfDelivery['kind'], name: string, files: Files): ShelfDelivery => ({ id: 'i', kind, name, department: null, version: versionOf(files) })
  const answer = (e: ShelfDelivery, files: Files, over: object = {}) => ({ id: e.id, version: e.version, files: Object.entries(files).map(([p, text]) => ({ path: p, base64: Buffer.from(text).toString('base64') })), ...over })
  const good = entry('skill', 'a', { 'SKILL.md': 'x' })
  assert.equal(verifyShelfContent(good, answer(good, { 'SKILL.md': 'x' })).ok, true)
  assert.equal(verifyShelfContent(good, answer(good, { 'SKILL.md': 'x' }, { id: 'other' })).ok, false)
  assert.equal(verifyShelfContent(good, answer(good, { 'SKILL.md': 'x' }, { version: '0'.repeat(64) })).ok, false)
  for (const bad of ['../SKILL.md', 'a/../../b', '/etc/x', 'a\\b']) {
    const e = entry('skill', 'a', { 'SKILL.md': 'x', [bad]: 'y' })
    assert.equal(verifyShelfContent(e, answer(e, { 'SKILL.md': 'x', [bad]: 'y' })).ok, false, bad)
  }
  const noSkill = entry('skill', 'a', { 'other.md': 'x' })
  assert.equal(verifyShelfContent(noSkill, answer(noSkill, { 'other.md': 'x' })).ok, false)
  const rule = entry('rule', 'tone', { 'other.md': 'x' })
  assert.equal(verifyShelfContent(rule, answer(rule, { 'other.md': 'x' })).ok, false)
  const clash = entry('skill', 'a', { 'SKILL.md': 'x', 'a.md': '1', 'A.md': '2' })
  assert.equal(verifyShelfContent(clash, answer(clash, { 'SKILL.md': 'x', 'a.md': '1', 'A.md': '2' })).ok, false)
})

test('a write that fails half-way leaves the last good Skill whole and nothing half-written; what a killed sync left is swept', async () => {
  const w = world()
  w.server.items = [SKILL]
  await w.open()
  w.server.items = [{ ...SKILL, files: { 'SKILL.md': 'new\n', 'scripts/run.py': 'new\n' } }]
  const realWrite = fs.writeFileSync
  let writes = 0
  const broken = mock.method(fs, 'writeFileSync', ((file: fs.PathOrFileDescriptor, data: string, options?: fs.WriteFileOptions) => {
    if (String(file).includes('.shelf-') && ++writes === 2) throw new Error('disk full')
    return realWrite(file, data, options)
  }) as typeof fs.writeFileSync)
  await w.again()
  broken.mock.restore()
  assert.deepEqual(Object.keys(await folderFiles(w.at('.claude/skills/proposal'))).sort(), ['SKILL.md', 'scripts/run.py'])
  assert.equal(read(w.at('.claude/skills/proposal/SKILL.md')), SKILL.files['SKILL.md'])
  assert.equal(read(w.at('.claude/skills/proposal/scripts/run.py')), SKILL.files['scripts/run.py'])
  assert.deepEqual(fs.readdirSync(w.at('.claude')).filter(name => name.startsWith('.shelf-')), [])

  write(w.at('.claude/.shelf-dead/SKILL.md'), 'half\n')
  await w.again()
  assert.equal(exists(w.at('.claude/.shelf-dead')), false)
  assert.equal(read(w.at('.claude/skills/proposal/SKILL.md')), 'new\n')
})

async function folderFiles(folder: string): Promise<Files> {
  const files = await readSkillFolder(folder)
  return Object.fromEntries((files ?? []).map(f => [f.path, f.bytes.toString()]))
}

test('what stops being delivered is removed; the member\'s own Skills and rules are never touched', async () => {
  const w = world()
  write(w.at('.claude/skills/mine/SKILL.md'), 'mine\n')
  write(w.at('.claude/rules/my-rule.md'), 'mine\n')
  w.server.items = [SKILL, { id: 'i2', kind: 'rule', name: 'tone', files: { 'tone.md': '敬語で\n' } }]
  await w.open()
  w.server.items = []
  await w.again()
  for (const rel of ['.claude/skills/proposal', '.agents/skills/proposal', '.claude/rules/tone.md']) assert.equal(exists(w.at(rel)), false, rel)
  assert.equal(read(w.at('.claude/skills/mine/SKILL.md')), 'mine\n')
  assert.equal(read(w.at('.claude/rules/my-rule.md')), 'mine\n')
  assert.deepEqual(w.store.managedPaths('co', w.root), [])
})

test('no longer reading a department (out of its group) takes its items away; offline or an unreadable answer takes nothing away', async () => {
  const w = world()
  const dept: Item = { id: 'i3', kind: 'skill', name: 'visit', department: { id: 'd1', folder: '営業部' }, files: { 'SKILL.md': 'visit\n' } }
  w.server.items = [SKILL, dept]
  await w.open()
  w.server.online = false
  await w.again()
  w.server.online = true
  w.server.listAnswer = { success: true, data: { nothing: true } }
  await w.again()
  w.server.listAnswer = undefined
  assert.ok(exists(w.at('.claude/skills/proposal/SKILL.md')))
  assert.ok(exists(w.at('営業部/.claude/skills/visit/SKILL.md')))
  // The server lists only places the member reads: 営業部 is no longer listed.
  w.server.items = [SKILL]
  await w.again()
  assert.equal(exists(w.at('営業部/.claude/skills/visit')), false)
  assert.ok(exists(w.at('.claude/skills/proposal/SKILL.md')))
})

test('a name clash: the member\'s Skill stays as it is, the company\'s is placed nowhere, and the app says so', async () => {
  const w = world()
  write(w.at('.claude/skills/proposal/SKILL.md'), 'my own proposal\n')
  w.server.items = [SKILL, { id: 'i2', kind: 'rule', name: 'tone', files: { 'tone.md': '敬語で\n' } }]
  write(w.at('.claude/rules/tone.md'), 'my tone\n')
  await w.open()
  assert.equal(read(w.at('.claude/skills/proposal/SKILL.md')), 'my own proposal\n')
  assert.equal(read(w.at('.claude/rules/tone.md')), 'my tone\n')
  assert.equal(exists(w.at('.agents/skills/proposal')), false, 'all or nothing: the two agents never see different Skills of one name')
  assert.deepEqual(w.store.markOf(w.root, '.claude/skills/proposal'), { state: 'clash', version: versionOf(SKILL.files) })
  assert.deepEqual(w.store.managedPaths('co', w.root), [], 'it is theirs: the AI may change it')
  assert.deepEqual(w.store.ruleClashes(w.root), ['tone'])
  assert.equal(w.server.requests.filter(u => u.includes('/versions/')).length, 0)
  // Theirs goes away: the company's comes.
  fs.rmSync(w.at('.claude/skills/proposal'), { recursive: true })
  await w.again()
  assert.equal(read(w.at('.claude/skills/proposal/SKILL.md')), SKILL.files['SKILL.md'])
  assert.equal(w.store.markOf(w.root, '.claude/skills/proposal')?.state, 'company')
})

test('a local change to a delivered Skill or rule is put back by the next fetch; what the system adds is not a change', async () => {
  const w = world()
  w.server.items = [SKILL, { id: 'i2', kind: 'rule', name: 'tone', files: { 'tone.md': '敬語で\n' } }]
  await w.open()
  const fetched = () => w.server.requests.filter(u => u.includes('/versions/')).length
  const before = fetched()
  const made = ['.DS_Store', 'tools/app/node_modules/a.js', 'tools/app/.tool-output.log', 'scripts/__pycache__/a.pyc', 'scripts/b.pyc', 'venv/bin/python', '.venv/x', '.cache/x', 'tools/app/.next/x', '.env', '.env.local', 'package-lock.json', 'tools/app/dist/a.js', 'tools/app/build/a.js']
  for (const rel of made) write(w.at(`.claude/skills/proposal/${rel}`), 'x')
  await w.again()
  assert.equal(fetched(), before, 'running a Skill\'s tool is no change')
  for (const rel of made) assert.ok(exists(w.at(`.claude/skills/proposal/${rel}`)), rel)
  assert.equal((await w.store.versionOf(w.root, '.claude/skills/proposal'))?.dirty, false)

  write(w.at('.claude/skills/proposal/SKILL.md'), 'hacked\n')
  write(w.at('.agents/skills/proposal/more.sh'), 'added\n')
  write(w.at('.claude/rules/tone.md'), 'hacked\n')
  await w.again()
  assert.equal(read(w.at('.claude/skills/proposal/SKILL.md')), SKILL.files['SKILL.md'])
  assert.equal(exists(w.at('.agents/skills/proposal/more.sh')), false)
  assert.equal(read(w.at('.claude/rules/tone.md')), '敬語で\n')
})

test('the member\'s folder that already is the listed version is taken over, and given back when it stops being delivered', async () => {
  const w = world()
  for (const [p, text] of Object.entries(SKILL.files)) write(w.at(`.claude/skills/proposal/${p}`), text)
  w.server.items = [SKILL]
  await w.open()
  assert.equal(w.store.markOf(w.root, '.claude/skills/proposal')?.state, 'company')
  assert.ok(exists(w.at('.agents/skills/proposal/SKILL.md')))
  w.server.items = []
  await w.again()
  assert.ok(exists(w.at('.claude/skills/proposal/SKILL.md')), 'it was theirs first')
  assert.equal(exists(w.at('.agents/skills/proposal')), false, 'the copy the app made goes')
  assert.equal(w.store.markOf(w.root, '.claude/skills/proposal'), undefined)
})

test('「手元で直す」 keeps the version the member started from: publishing cannot replace a colleague\'s newer one unseen', async () => {
  const w = world()
  w.server.items = [SKILL]
  await w.open()
  await w.store.release(w.root, '.claude/skills/proposal')
  w.server.items = [SKILL_V2]
  await w.again()
  assert.deepEqual(w.store.markOf(w.root, '.claude/skills/proposal'), { state: 'editing', version: versionOf(SKILL.files) })
})

test('「手元で直す」 has a way back: with the member\'s copy gone, the company\'s Skill returns', async () => {
  const w = world()
  w.server.items = [SKILL]
  await w.open()
  await w.store.release(w.root, '.claude/skills/proposal')
  fs.rmSync(w.at('.claude/skills/proposal'), { recursive: true })
  await w.again()
  assert.equal(read(w.at('.agents/skills/proposal/SKILL.md')), SKILL.files['SKILL.md'])
  assert.equal(w.store.markOf(w.root, '.claude/skills/proposal')?.state, 'company')
  await w.again()
  assert.equal(w.store.markOf(w.root, '.claude/skills/proposal')?.state, 'company', 'and it stays the company\'s')
})

test('「手元で直す」: the Skill is the member\'s from then on, nothing overwrites it, and publishing makes it the company\'s again', async () => {
  const w = world()
  w.server.items = [SKILL]
  await w.open()
  assert.equal(await w.store.release(w.root, '.claude/skills/nothing'), false)
  assert.equal(await w.store.release(w.root, '.claude/skills/proposal'), true)
  assert.equal(exists(w.at('.agents/skills/proposal')), false)
  assert.deepEqual(w.store.managedPaths('co', w.root), [])
  await w.again()
  assert.deepEqual(w.store.managedPaths('co', w.root), [], 'even unchanged it is not taken back')
  assert.equal(w.store.markOf(w.root, '.claude/skills/proposal')?.state, 'editing')
  write(w.at('.claude/skills/proposal/SKILL.md'), 'better\n')
  await w.again()
  assert.equal(read(w.at('.claude/skills/proposal/SKILL.md')), 'better\n')

  w.server.items = [{ ...SKILL, files: await folderFiles(w.at('.claude/skills/proposal')) }]
  await w.store.published(w.root, '.claude/skills/proposal')
  await w.again()
  assert.equal(w.store.markOf(w.root, '.claude/skills/proposal')?.state, 'company')
  assert.equal(read(w.at('.agents/skills/proposal/SKILL.md')), 'better\n')
})

test('a placement that fails half-way still leaves the Skill managed: guarded, and removed when it stops being delivered', async () => {
  const w = world()
  const elsewhere = path.join(w.base, 'elsewhere')
  fs.mkdirSync(elsewhere)
  fs.symlinkSync(elsewhere, w.at('.agents'))
  w.server.items = [SKILL]
  await w.open()
  assert.ok(exists(w.at('.claude/skills/proposal/SKILL.md')))
  assert.deepEqual(fs.readdirSync(elsewhere), [], 'the second copy failed')
  assert.ok(w.store.managedPaths('co', w.root).includes('.claude/skills/proposal'))
  w.server.items = []
  await w.again()
  assert.equal(exists(w.at('.claude/skills/proposal')), false)
})

test('an app killed right after writing a first fetch: the Skill is the company\'s, never "the member\'s own, given back"', async () => {
  const w = world()
  w.server.items = [SKILL]
  // What was on disk at the moment the last copy landed: the kill.
  let atTheKill: string | null = null
  const dir = path.join(w.base, 'userData', 'co')
  const realRename = fs.renameSync
  const spy = mock.method(fs, 'renameSync', ((from: fs.PathLike, to: fs.PathLike) => {
    realRename(from, to)
    if (String(to).endsWith('.agents/skills/proposal')) atTheKill = exists(dir) ? read(path.join(dir, fs.readdirSync(dir)[0])) : null
  }) as typeof fs.renameSync)
  await w.open()
  spy.mock.restore()
  const file = path.join(dir, fs.readdirSync(dir)[0])
  if (atTheKill === null) fs.rmSync(file)
  else fs.writeFileSync(file, atTheKill)

  const revived = createSkillShelfStore({ dir: () => path.join(w.base, 'userData'), userId: () => 'u1', client: w.client, log: quiet })
  await revived.attach('co', w.root)
  w.server.items = []
  await revived.syncNow(w.root)
  assert.equal(exists(w.at('.claude/skills/proposal')), false)
  assert.equal(exists(w.at('.agents/skills/proposal')), false)
})

test('something the member made while the fetch ran stays theirs', async () => {
  const w = world()
  w.server.items = [SKILL]
  const content = w.client.content
  const store = createSkillShelfStore({
    dir: () => path.join(w.base, 'userData'), userId: () => 'u1', log: quiet,
    client: { list: w.client.list, content: async (id, entry) => { write(w.at('.claude/skills/proposal/SKILL.md'), 'mine, just now\n'); return content(id, entry) } },
  })
  await store.attach('co', w.root)
  assert.equal(read(w.at('.claude/skills/proposal/SKILL.md')), 'mine, just now\n')
  assert.equal(store.markOf(w.root, '.claude/skills/proposal')?.state, 'clash')
  assert.deepEqual(store.managedPaths('co', w.root), [])
})

test('a manifest edited to point elsewhere removes nothing outside what its item names', async () => {
  const w = world()
  const outside = path.join(w.base, 'outside')
  write(path.join(outside, 'keep.txt'), 'keep\n')
  w.server.items = [SKILL]
  await w.open()
  const dir = path.join(w.base, 'userData', 'co')
  const file = path.join(dir, fs.readdirSync(dir)[0])
  const manifest = JSON.parse(read(file)) as { items: Array<{ paths: string[] }> }
  manifest.items[0].paths = ['../outside']
  fs.writeFileSync(file, JSON.stringify(manifest))
  w.server.items = []
  const fresh = createSkillShelfStore({ dir: () => path.join(w.base, 'userData'), userId: () => 'u1', client: w.client, log: quiet })
  await fresh.attach('co', w.root)
  assert.ok(exists(path.join(outside, 'keep.txt')))
})

test('two companies never mix: one company\'s text and files are not another\'s, and a folder in use is known, also from an earlier run', async () => {
  const w = world()
  w.server.items = [{ id: 't1', kind: 'instructions', name: 'instructions', files: { 'CLAUDE.md': 'A社の指示\n' } }, SKILL]
  await w.store.attach('a', w.root)
  assert.equal(w.store.takenByAnother('a', w.root), false)
  assert.equal(w.store.takenByAnother('b', w.root), true)
  assert.equal(w.store.takenByAnother('b', path.join(w.base, 'other')), false)
  assert.equal(w.store.turn('b', w.root, undefined), undefined)
  assert.deepEqual(w.store.managedPaths('b', w.root), [])
  const restarted = createSkillShelfStore({ dir: () => path.join(w.base, 'userData'), userId: () => 'u1', client: w.client, log: quiet })
  assert.equal(restarted.takenByAnother('b', w.root), true)
  assert.equal(restarted.takenByAnother('a', w.root), false)
  w.server.online = false
  await restarted.attach('b', w.root)
  assert.equal(restarted.turn('b', w.root, undefined), undefined, 'even attached by mistake, B reads B\'s manifest only')

  // In one run too, with A's manifest in memory.
  await w.store.attach('b', w.root)
  assert.equal(w.store.turn('b', w.root, undefined), undefined)

  // Nothing kept on disk yet (offline at the first opening): still A's in this run.
  const v = world()
  v.server.online = false
  await v.store.attach('a', v.root)
  assert.equal(v.store.takenByAnother('b', v.root), true)
})

test('a link in the working folder never carries a delivered file out of it', async () => {
  const w = world()
  const outside = path.join(w.base, 'outside')
  fs.mkdirSync(outside)
  fs.symlinkSync(outside, w.at('.claude'))
  w.server.items = [SKILL]
  await w.open()
  assert.deepEqual(fs.readdirSync(outside), [])

  const v = world()
  v.server.items = [SKILL]
  await v.open()
  // The Skill replaced by a link: the link goes, what it pointed at stays.
  const kept = path.join(v.base, 'kept')
  write(path.join(kept, 'SKILL.md'), 'kept\n')
  fs.rmSync(v.at('.claude/skills/proposal'), { recursive: true })
  fs.symlinkSync(kept, v.at('.claude/skills/proposal'))
  await v.again()
  assert.equal(fs.lstatSync(v.at('.claude/skills/proposal')).isDirectory(), true)
  assert.equal(read(path.join(kept, 'SKILL.md')), 'kept\n')

  // Taking a Skill away never follows a link to somewhere else.
  const u = world()
  u.server.items = [SKILL]
  await u.open()
  const elsewhere = path.join(u.base, 'elsewhere')
  fs.renameSync(u.at('.claude'), elsewhere)
  fs.symlinkSync(elsewhere, u.at('.claude'))
  u.server.items = []
  await u.again()
  assert.ok(exists(path.join(elsewhere, 'skills/proposal/SKILL.md')))
})

test('instruction texts go to the turn, not to any file: the company\'s and the shown department\'s, the signed-in member\'s only, a changed one left out', async () => {
  let user: string | null = 'u1'
  const w = world({ user: () => user })
  w.server.items = [
    { id: 't1', kind: 'instructions', name: 'instructions', files: { 'CLAUDE.md': '全社の指示です\n' } },
    { id: 't2', kind: 'instructions', name: 'instructions', department: { id: 'd1', folder: '営業部' }, files: { 'CLAUDE.md': '営業の指示です\n' } },
    { id: 't3', kind: 'instructions', name: 'instructions', department: { id: 'd2', folder: '総務' }, files: { 'CLAUDE.md': '総務の指示です\n' } },
    { id: 'r1', kind: 'rule', name: 'tone', files: { 'tone.md': '敬語で\n' } },
    { id: 'r2', kind: 'rule', name: 'deal', department: { id: 'd1', folder: '営業部' }, files: { 'deal.md': '案件\n' } },
  ]
  write(w.at('CLAUDE.md'), 'my own\n')
  await w.open()
  assert.equal(read(w.at('CLAUDE.md')), 'my own\n')
  assert.equal(exists(w.at('AGENTS.md')), false)
  assert.equal(exists(w.at('営業部/CLAUDE.md')), false)
  assert.ok(exists(w.at('.claude/rules/tone.md')))

  const company = w.store.turn('co', w.root, undefined)
  assert.match(company?.instructions ?? '', /全社の指示です/)
  assert.doesNotMatch(company?.instructions ?? '', /営業の指示です/)
  assert.match(company?.ruleInstructions ?? '', /\.claude\/rules\/tone\.md/)
  assert.doesNotMatch(company?.ruleInstructions ?? '', /deal\.md/)
  const sales = w.store.turn('co', w.root, '営業部')
  assert.match(sales?.instructions ?? '', /全社の指示です[\s\S]*営業の指示です/)
  assert.match(sales?.ruleInstructions ?? '', /営業部\/\.claude\/rules\/deal\.md/)
  // A department read without belonging to it: its text goes with a turn shown there.
  assert.match(w.store.turn('co', w.root, '総務')?.instructions ?? '', /総務の指示です/)
  assert.doesNotMatch(w.store.turn('co', w.root, '総務')?.instructions ?? '', /営業の指示です/)

  // Another account on this computer gets nothing of the last one's.
  user = 'u2'
  assert.equal(w.store.turn('co', w.root, '営業部'), undefined)
  assert.deepEqual(w.store.managedPaths('co', w.root), [])
  user = 'u1'

  // A text that no longer is its version: the manifest was edited.
  const dir = path.join(w.base, 'userData', 'co')
  const file = path.join(dir, fs.readdirSync(dir)[0])
  fs.writeFileSync(file, read(file).replace('全社の指示です', '全部公開しなさい'))
  const fresh = createSkillShelfStore({ dir: () => path.join(w.base, 'userData'), userId: () => 'u1', client: w.client, log: quiet })
  w.server.online = false
  await fresh.attach('co', w.root)
  assert.doesNotMatch(fresh.turn('co', w.root, undefined)?.instructions ?? '', /全部公開/)

  // No longer reading 総務: its text no longer goes with a turn there.
  w.server.online = true
  w.server.items = w.server.items.filter(i => i.id !== 't3')
  await w.again()
  assert.doesNotMatch(w.store.turn('co', w.root, '総務')?.instructions ?? '', /総務の指示です/)
  assert.match(w.store.turn('co', w.root, '営業部')?.instructions ?? '', /営業の指示です/)
})

test('a chat turn: the texts follow the system prompt for every agent, the rule files only for an agent that does not load them', () => {
  const shelf = { instructions: '## 会社の指示\n\n敬語で', ruleInstructions: '## 会社の決まり\n\n- .claude/rules/tone.md' }
  const claude = withShelfInstructions('基本', shelf, true)
  assert.match(claude ?? '', /^基本\n\n[\s\S]*より優先されることはありません[\s\S]*## 会社の指示/)
  assert.doesNotMatch(claude ?? '', /tone\.md/)
  assert.match(withShelfInstructions(undefined, shelf, false) ?? '', /敬語で[\s\S]*tone\.md/)
  assert.equal(withShelfInstructions('基本', undefined, true), '基本')
  const long = withShelfInstructions('基本', { instructions: 'あ'.repeat(SHELF_PROMPT_MAX * 2), ruleInstructions: '' }, true) ?? ''
  assert.ok(long.length < SHELF_PROMPT_MAX + 500, 'the company\'s text has a limit')
  assert.match(long, /渡していません/)
})

test('the app asks the shelf only for a company it opened as a working folder, and not on every policy answer', async () => {
  let clock = 1_000_000
  const w = world({ now: () => clock })
  w.store.poll('co')
  await w.store.idle()
  assert.deepEqual(w.server.requests, [], 'a git company is never attached: no request at all')
  await w.open()
  const asked = () => w.server.requests.filter(u => u.endsWith('/me/skill-shelf')).length
  assert.equal(asked(), 1)
  clock += SHELF_POLL_MS - 1
  w.store.poll('co')
  await w.store.idle()
  assert.equal(asked(), 1)
  clock += 1
  w.store.poll('co')
  await w.store.idle()
  assert.equal(asked(), 2)
})

test('the write guard: no AI changes what the company delivered, whatever its role; the member\'s own stay writable; a git company is judged as before', async () => {
  const w = world()
  w.server.items = [SKILL, { id: 'i2', kind: 'rule', name: 'tone', files: { 'tone.md': '敬語で\n' } }, { id: 'i3', kind: 'skill', name: 'visit', department: { id: 'd1', folder: '営業部' }, files: { 'SKILL.md': 'x\n' } }]
  write(w.at('.claude/skills/mine/SKILL.md'), 'mine\n')
  await w.open()
  const guard: WriteGuard = {
    root: w.root, folderKind: 'none', getAccess: () => undefined,
    getInstructionAuthority: () => ({ role: 'owner', managedFolders: [] }),
    getShelfPaths: () => w.store.managedPaths('co', w.root),
  }
  const denied = (input: Record<string, unknown>, tool = 'Write', cwd = w.root) => decideToolWrite(guard, tool, input, cwd)
  for (const rel of ['.claude/skills/proposal/SKILL.md', '.claude/skills/proposal/new.py', '.agents/skills/proposal/SKILL.md', '.claude/rules/tone.md', '営業部/.claude/skills/visit/SKILL.md', '.CLAUDE/Skills/Proposal/SKILL.md']) {
    const d = denied({ file_path: w.at(rel), content: 'x' })
    assert.equal(d.deny, true, rel)
    assert.match(d.deny ? d.message : '', /AI は変更できません/)
  }
  const rule = denied({ file_path: w.at('.claude/rules/tone.md'), content: 'x' })
  assert.equal(rule.deny && rule.code, 'instruction-file')
  const skill = denied({ file_path: w.at('.claude/skills/proposal/SKILL.md'), old_string: 'a', new_string: 'b' }, 'Edit')
  assert.equal(skill.deny && skill.code, 'skill-file')
  assert.equal(denied({ command: 'echo x > .claude/skills/proposal/SKILL.md' }, 'Bash').deny, true)
  assert.equal(denied({ file_path: 'SKILL.md', content: 'x' }, 'Write', w.at('.claude/skills/proposal')).deny, true)
  // A link leading in.
  fs.symlinkSync(w.at('.claude/skills/proposal'), w.at('door'))
  assert.equal(denied({ file_path: w.at('door/SKILL.md'), content: 'x' }).deny, true)

  for (const rel of ['.claude/skills/mine/SKILL.md', '.claude/skills/new/SKILL.md', '.claude/rules/mine.md', 'CLAUDE.md', '営業部/メモ.md']) assert.equal(denied({ file_path: w.at(rel), content: 'x' }).deny, false, rel)

  const git: WriteGuard = { ...guard, folderKind: undefined }
  assert.equal(decideToolWrite(git, 'Write', { file_path: w.at('.claude/skills/proposal/SKILL.md'), content: 'x' }, w.root).deny, false, 'an owner in a git company: only the push rules')
})

test('the chat wiring: the guard and the turn read the shelf for a working folder only', async () => {
  const workingFolders = createWorkingFolders()
  workingFolders.add('/Users/me/作業')
  const seen: string[] = []
  const deps = {
    workingFolders,
    skillShelf: { managedPaths: () => ['.claude/skills/x'], turn: (_c: string, root: string) => { seen.push(root); return { instructions: 'i', ruleInstructions: '' } } },
    writeAccess: { refresh: async () => undefined, get: () => undefined },
    privateFolders: { refreshReadable: async () => {}, refreshAuthority: async () => {}, authority: () => undefined, readable: () => [], guardView: () => undefined },
    companyFiles: {}, claudeCli: {}, config: { load: () => ({}) }, shellEnv: { env: () => ({}) },
  } as unknown as ChatServerConfigDeps
  const config = createChatServerConfig(deps)
  const none = await config.getWriteGuard!('c1', '/Users/me/作業')
  assert.equal(decideToolWrite(none, 'Write', { file_path: '/Users/me/作業/.claude/skills/x/SKILL.md', content: 'x' }).deny, true)
  const git = await config.getWriteGuard!('c1', '/Users/me/会社')
  assert.equal(git.getShelfPaths, undefined)
  assert.equal(config.shelfTurn?.('c1', '/Users/me/会社', undefined), undefined)
  assert.deepEqual(seen, [])
  assert.equal(config.shelfTurn?.('c1', '/Users/me/作業', undefined)?.instructions, 'i')
})

test('a use is reported with the shelf\'s version, `dirty` when the files differ; the member\'s own Skill is not reported; a git folder still asks git', async () => {
  const w = world()
  w.server.items = [SKILL]
  write(w.at('.claude/skills/mine/SKILL.md'), 'mine\n')
  await w.open()
  const bodies: Array<Record<string, unknown>> = []
  const gitCalls: string[][] = []
  const reporter = createSkillUseReporter({
    baseUrl: () => 'http://server', cookies: () => ['s=1'], log: quiet,
    git: async (_root, args) => { gitCalls.push(args); throw new Error('no git') },
    shelfVersion: (root, rel) => (root === w.root ? w.store.versionOf(root, rel) : undefined),
    fetch: (async (_url: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return Response.json({ recorded: true }) }) as typeof fetch,
  })
  const use = async (skill: string, conversationId: string, companyRoot = w.root) => {
    reporter.observe({ companyId: 'co', conversationId, companyRoot, skill } as never)
    await reporter.settled(conversationId)
  }
  await use('proposal', 'c1')
  assert.deepEqual(bodies, [{ conversationId: 'c1', name: 'proposal', tree: versionOf(SKILL.files), dirty: false }])
  write(w.at('.claude/skills/proposal/SKILL.md'), 'changed\n')
  await use('proposal', 'c2')
  assert.equal(bodies[1].dirty, true)
  await use('mine', 'c3')
  assert.equal(bodies.length, 2)
  assert.deepEqual(gitCalls, [])

  const gitRoot = path.join(w.base, 'git')
  write(path.join(gitRoot, '.claude/skills/g/SKILL.md'), 'g\n')
  await use('g', 'c4', gitRoot)
  assert.equal(gitCalls.length, 1)
})

test('the delivery answer: only places that can be placed, and an unreadable answer is no answer', () => {
  const v = 'a'.repeat(64)
  const item = (over: object) => ({ id: 'i', kind: 'skill', name: 'a', version: v, department: null, ...over })
  assert.equal(readShelfDeliveries(null), undefined)
  assert.equal(readShelfDeliveries({ items: 'x' }), undefined)
  assert.deepEqual(readShelfDeliveries({ items: [] }), [])
  for (const bad of [{ name: '../x' }, { name: 'A b' }, { kind: 'plugin' }, { version: 'short' }, { id: '' }, { department: { id: 'd', folder: '../外' } }, { department: { id: 'd', folder: 'a/b' } }, { department: { id: 'd', folder: '.hidden' } }, { department: { id: 7, folder: '総務' } }]) {
    assert.deepEqual(readShelfDeliveries({ items: [item(bad)] }), [], JSON.stringify(bad))
  }
  assert.equal(readShelfDeliveries({ items: [item({ department: { id: 'd', folder: '営業部' } })] })?.length, 1)
  // Every department the server lists is taken: it lists only those the member reads (no 所属 of its own here).
  assert.deepEqual(readShelfDeliveries({ items: [item({ department: { id: 'd', folder: '総務', belongs: false } })] })?.map(d => d.department), [{ id: 'd', folder: '総務' }])
})

test('the button and the publish\'s department lookup name a department folder the same way: the button is never shown for a place the publish cannot find', async () => {
  const departments = [{ id: 'd1', folder: 'Sales' }, { id: 'd2', folder: '営業部' }]
  const lookup = createShelfClient({ baseUrl: () => 'http://server', cookies: () => [], fetch: (async () => Response.json({ success: true, data: departments })) as typeof fetch })
  const publishing = { company: false, departmentFolders: departments.map(d => d.folder) }
  // A Mac may hand the folder in NFD; a member may type another ASCII case: both are that department.
  for (const [spelling, id] of [['Sales', 'd1'], ['sales', 'd1'], ['営業部'.normalize('NFD'), 'd2'], ['総務', undefined]] as const) {
    const offered = mayPublishShelfSkill(publishing, `${spelling}/.claude/skills/a`)
    const found = await lookup.departmentId('co', spelling)
    assert.equal(found, id, spelling)
    assert.equal(offered, found !== undefined, `the button and the lookup agree for ${spelling}`)
  }
})

test('「手元で直す」 tells of publishing only someone who may publish there; anyone else is told how to get the company\'s back', () => {
  assert.deepEqual(shelfEditTexts(true), { confirm: SHELF_EDIT_CONFIRM, note: SHELF_EDITING_NOTE })
  const local = shelfEditTexts(false)
  for (const text of [local.confirm, local.note]) {
    assert.doesNotMatch(text, /公開/)
    assert.match(text, /フォルダを消/)
    assert.match(text, /届/)
  }
})

test('会社に公開 is offered only where the server says the member may publish a Skill; an answer without it offers it nowhere', async () => {
  const publishing = readShelfPublishing({ skillPublishing: { company: false, departmentFolders: ['営業部', '../外', 3] } })
  assert.deepEqual(publishing, { company: false, departmentFolders: ['営業部'] })
  assert.equal(mayPublishShelfSkill(publishing, '営業部/.claude/skills/a'), true)
  assert.equal(mayPublishShelfSkill(publishing, '総務/.claude/skills/a'), false)
  assert.equal(mayPublishShelfSkill(publishing, '.claude/skills/a'), false)
  assert.equal(mayPublishShelfSkill({ company: true, departmentFolders: [] }, '.claude/skills/a'), true)
  assert.equal(mayPublishShelfSkill({ company: true, departmentFolders: [] }, '営業部/.claude/skills/a'), false)
  // Not a place a Skill is published from.
  assert.equal(mayPublishShelfSkill({ company: true, departmentFolders: ['営業部'] }, '営業部/x/.claude/skills/a'), false)
  for (const odd of [undefined, null, {}, { skillPublishing: 'yes' }, { skillPublishing: { company: 'true' } }]) {
    assert.deepEqual(readShelfPublishing(odd), { company: false, departmentFolders: [] }, JSON.stringify(odd))
  }

  // Through the store: what the last list said, kept with the folder's manifest, changed by the next list.
  const w = world()
  w.server.items = [SKILL]
  w.server.publishing = { company: false, departmentFolders: ['営業部'] }
  await w.open()
  assert.equal(w.store.mayPublish(w.root, '営業部/.claude/skills/mine'), true)
  assert.equal(w.store.mayPublish(w.root, '.claude/skills/mine'), false)
  const fresh = createSkillShelfStore({ dir: () => path.join(w.base, 'userData'), userId: () => 'u1', client: w.client, log: quiet })
  w.server.online = false
  await fresh.attach('co', w.root)
  assert.equal(fresh.mayPublish(w.root, '営業部/.claude/skills/mine'), true, 'kept for a start without the server')
  w.server.online = true
  w.server.publishing = undefined
  const before = w.changed.length
  await w.again()
  assert.equal(w.store.mayPublish(w.root, '営業部/.claude/skills/mine'), false)
  assert.equal(w.changed.length, before + 1, 'the panel is told to look again')
})

test('what can be published from: a Skill folder at the root or directly in a department; refusals keep the server\'s plain sentence', () => {
  assert.deepEqual(shelfPlaceOfSkillFolder('.claude/skills/a'), { departmentFolder: null, name: 'a' })
  assert.deepEqual(shelfPlaceOfSkillFolder('営業部/.claude/skills/a'), { departmentFolder: '営業部', name: 'a' })
  for (const rel of ['営業部/案件/.claude/skills/a', '.claude/skills', 'a/b/c', '.agents/skills/a', '.claude/skills/A b']) assert.equal(shelfPlaceOfSkillFolder(rel), null, rel)
  assert.equal(shelfRefusalMessage(409, { error: 'ほかの人が先に変えました。' }), 'ほかの人が先に変えました。')
  assert.match(shelfRefusalMessage(500, { error: 'Internal Server Error' }), /公開できませんでした（500）/)
  assert.match(shelfRefusalMessage(502, null), /公開できませんでした/)
})
