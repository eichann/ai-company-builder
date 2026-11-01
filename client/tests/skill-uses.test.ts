/**
 * Which company Skill a consultation used (`.claude/rules/records.md` "Which Skill").
 *
 * Guards:
 * - only Claude's `Skill` tool that ran counts (not a refused or failed one, not a plugin's
 *   `plugin:skill`, not a Read inside a skill's folder); the chat server hands it over with
 *   the consultation and still logs every event; an unattended turn hands nothing;
 * - the version is the git tree id of the skill folder at HEAD: the same on another PC with
 *   the same content, `dirty` when the folder has changes not in HEAD;
 * - nothing is reported for a skill inside a private folder (its name never leaves the PC),
 *   one only on this PC (not in HEAD), one found in two places, or a personal one of the same
 *   name; what is sent is the folder name, tree id and dirty — no path, no content;
 * - the same version is reported once; the AI's next record write waits for a report in flight.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createRecordsApi } from '../electron/records/api'
import { createSkillUseReporter, locateCompanySkill } from '../electron/services/skill-use-reporter'
import { withSkillSightings } from '../electron/chat-server'
import { skillLoadedBy, type AgentToolEvent, type SkillUseSighting } from '../shared/agent-events'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acb-skill-uses-'))
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }))
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
const sh = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, env, stdio: 'pipe' }).toString()
const git = async (root: string, args: string[]) => sh(root, args)
const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text) }

let n = 0
/** A company folder: a skill at the root, one in 営業, a private folder (own repository) with a skill, a local-only skill. */
function company() {
  const root = path.join(tmp, `co-${n++}`)
  fs.mkdirSync(root)
  sh(root, ['init', '-q', '--initial-branch=main'])
  write(path.join(root, '.claude/skills/sales-proposal/SKILL.md'), '---\nname: sales-proposal\n---\n提案書の作り方 v1\n')
  write(path.join(root, '.claude/skills/sales-proposal/templates/base.html'), '<html></html>\n')
  write(path.join(root, '営業/.claude/skills/visit-memo/SKILL.md'), '---\nname: visit-memo\n---\n')
  write(path.join(root, '.gitignore'), '# Private skills\n.claude/skills/my-own/\n秘密の案件/\n')
  sh(root, ['add', '-A'])
  sh(root, ['commit', '-q', '-m', 'init'])
  write(path.join(root, '.claude/skills/my-own/SKILL.md'), 'mine\n')
  const priv = path.join(root, '秘密の案件')
  fs.mkdirSync(priv)
  sh(priv, ['init', '-q', '--initial-branch=main'])
  write(path.join(priv, '.claude/skills/secret-deal/SKILL.md'), 'secret\n')
  sh(priv, ['add', '-A'])
  sh(priv, ['commit', '-q', '-m', 'init'])
  return root
}

function fakeServer(opts: { delayMs?: number } = {}) {
  const bodies: Array<Record<string, unknown>> = []
  const raw: string[] = []
  const fetch = (async (url: string, init: RequestInit) => {
    if (opts.delayMs) await new Promise(r => setTimeout(r, opts.delayMs))
    assert.match(url, /\/api\/companies\/co\/me\/skill-uses$/)
    raw.push(String(init.body))
    bodies.push(JSON.parse(String(init.body)))
    return new Response(JSON.stringify({ success: true, data: { recorded: true } }), { status: 200 })
  }) as unknown as typeof globalThis.fetch
  return { fetch, bodies, raw }
}
const reporter = (fetch: typeof globalThis.fetch, home?: string) =>
  createSkillUseReporter({ baseUrl: () => 'https://acb.example.jp', cookies: () => ['s=1'], git, fetch, home, log: { warn: () => {} } })
const sighting = (root: string, skill: string, workingDirectory?: string): SkillUseSighting => ({ companyId: 'co', conversationId: 'conv-1', companyRoot: root, workingDirectory, skill })

test('only a Skill tool call that ran counts', () => {
  const ev = (over: Partial<AgentToolEvent>) => ({ tool: 'Skill', skill: 'sales-proposal', decision: 'policy-default', outcome: 'ok', ...over }) as AgentToolEvent
  assert.equal(skillLoadedBy(ev({})), 'sales-proposal')
  assert.equal(skillLoadedBy(ev({ outcome: 'unfinished' })), 'sales-proposal')
  assert.equal(skillLoadedBy(ev({ outcome: undefined, decision: 'member-denied' })), undefined)
  assert.equal(skillLoadedBy(ev({ outcome: 'error' })), undefined)
  assert.equal(skillLoadedBy(ev({ skill: 'some-plugin:proposal' })), undefined)
  // Working inside a skill's folder is not loading it.
  assert.equal(skillLoadedBy(ev({ tool: 'Read' })), undefined)
})

test('the chat server hands a loaded Skill over with the consultation and still logs every event; no consultation → nothing', () => {
  const logged: AgentToolEvent[] = []
  const seen: SkillUseSighting[] = []
  const config = { onToolEvent: (e: AgentToolEvent) => { logged.push(e) }, onSkillUsed: (s: SkillUseSighting) => { seen.push(s) } }
  const turn = { companyId: 'co', conversationId: 'conv-1', companyRoot: '/c', workingDirectory: '/c/営業' }
  const host = withSkillSightings(config, turn)
  const skill = { tool: 'Skill', skill: 'sales-proposal', decision: 'policy-default', outcome: 'ok' } as AgentToolEvent
  const read = { tool: 'Read', skill: 'sales-proposal', decision: 'policy-default', outcome: 'ok' } as AgentToolEvent
  host.onToolEvent?.(skill)
  host.onToolEvent?.(read)
  assert.deepEqual(logged, [skill, read])
  assert.deepEqual(seen, [{ ...turn, skill: 'sales-proposal' }])
  // An unattended step or a chat without a company folder: the host as it was.
  assert.equal(withSkillSightings(config, undefined), config)
})

test('the version is the folder\'s tree id at HEAD, the same on another PC; dirty with local changes; only name, tree and dirty are sent', async () => {
  const root = company()
  const other = path.join(tmp, `clone-${n++}`)
  sh(tmp, ['clone', '-q', root, other])
  const tree = sh(root, ['rev-parse', 'HEAD:.claude/skills/sales-proposal']).trim()
  const server = fakeServer()
  const r = reporter(server.fetch)
  r.observe(sighting(root, 'sales-proposal', path.join(root, '営業')))
  r.observe({ ...sighting(other, 'sales-proposal'), conversationId: 'conv-2' })
  await r.settled('conv-1'); await r.settled('conv-2')
  assert.deepEqual(server.bodies, [
    { conversationId: 'conv-1', name: 'sales-proposal', tree, dirty: false },
    { conversationId: 'conv-2', name: 'sales-proposal', tree, dirty: false },
  ])
  // The same version again in the consultation: reported once.
  r.observe(sighting(root, 'sales-proposal'))
  await r.settled('conv-1')
  assert.equal(server.bodies.length, 2)
  // A changed template: the same tree id (HEAD's), dirty.
  write(path.join(root, '.claude/skills/sales-proposal/templates/base.html'), '<html>v2</html>\n')
  r.observe(sighting(root, 'sales-proposal'))
  await r.settled('conv-1')
  assert.deepEqual(server.bodies.at(-1), { conversationId: 'conv-1', name: 'sales-proposal', tree, dirty: true })
  // A department's skill, found from the working folder.
  r.observe(sighting(root, 'visit-memo', path.join(root, '営業', '顧客A')))
  await r.settled('conv-1')
  assert.equal(server.bodies.at(-1)?.name, 'visit-memo')
  assert.ok(server.raw.every(b => !b.includes(root) && !b.includes('営業') && !b.includes('.claude')))
})

test('nothing is reported for a skill in a private folder, one not in HEAD, a plugin\'s, one in two places or shadowed by the member\'s own', async () => {
  const root = company()
  const home = path.join(tmp, `home-${n++}`)
  write(path.join(home, '.claude/skills/visit-memo/SKILL.md'), 'personal\n')
  write(path.join(root, '営業/.claude/skills/sales-proposal/SKILL.md'), 'department copy\n')
  sh(root, ['add', '-A']); sh(root, ['commit', '-q', '-m', 'dept copy'])
  const server = fakeServer()
  const r = reporter(server.fetch, home)
  r.observe(sighting(root, 'secret-deal', path.join(root, '秘密の案件')))
  r.observe(sighting(root, 'my-own'))
  r.observe(sighting(root, 'tools:proposal'))
  r.observe(sighting(root, 'sales-proposal', path.join(root, '営業')))
  r.observe(sighting(root, 'visit-memo', path.join(root, '営業')))
  r.observe(sighting(root, 'no-such-skill'))
  await r.settled('conv-1')
  assert.deepEqual(server.bodies, [])
  assert.deepEqual(locateCompanySkill(root, path.join(root, '秘密の案件'), 'secret-deal'), { none: 'private' })
})

test('the AI\'s next record write waits for the consultation\'s report in flight; a read does not', async () => {
  const root = company()
  const server = fakeServer({ delayMs: 150 })
  const r = reporter(server.fetch)
  const order: string[] = []
  const fetch = (async (url: string, init: RequestInit) => {
    if (url.endsWith('/me/record-tokens')) return new Response(JSON.stringify({ success: true, data: { token: 'acb_rec_co.' + 'a'.repeat(64), tokenId: 't', scope: 'act' } }), { status: 201 })
    order.push(`${init.method} ${url.replace(/^.*records-ai/, '')} after ${server.bodies.length} report(s)`)
    return new Response(JSON.stringify({ success: true, data: {} }), { status: 200 })
  }) as unknown as typeof globalThis.fetch
  const api = createRecordsApi({ baseUrl: () => 'https://acb.example.jp', cookies: () => ['s=1'], fetch, beforeWrite: id => r.settled(id) })
  const access = await api.openTurn('co', { conversationId: 'conv-1', agent: 'claude-code', scope: 'act' })
  assert.ok(access)
  r.observe(sighting(root, 'sales-proposal'))
  await access.call('GET', '/my-turn')
  await access.call('POST', '/item/task-1/actions/start', { expectedVersion: 1 })
  assert.deepEqual(order, ['GET /my-turn after 0 report(s)', 'POST /item/task-1/actions/start after 1 report(s)'])
})
