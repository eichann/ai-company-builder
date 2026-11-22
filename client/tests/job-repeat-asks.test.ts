/**
 * 「毎週同じ時間にやりましょうか？」 (jobs.md "Member proposals" "Asking after repeats (PR D)"):
 * - a company Skill the AI loaded on a 3rd distinct day makes that turn carry the question, once; the same day again does
 *   not count; a turn that carried it and loaded the Skill marks it asked for good (whatever the AI said);
 * - the switch off counts and asks nothing; the store keeps only Skill names and dates;
 * - only a turn that offers the job proposal tools is asked or counted (never a job run, 「AI の番」 or a step), and only a
 *   Skill the AI really loaded counts.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createJobRepeatAsks } from '../electron/features/jobs/repeat-asks'
import { repeatAskForTurn, withSkillSightings } from '../electron/chat-server'
import { JOB_PROPOSAL_CREATE_TOOL } from '../electron/records/job-proposal-tools'
import { readRepeatFile } from '../shared/job-repeat-asks'
import type { AgentToolEvent } from '../shared/agent-events'

function world() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acb-repeat-'))
  const company = path.join(dir, 'company')
  const skill = (name: string, under = company) => {
    fs.mkdirSync(path.join(under, '.claude', 'skills', name), { recursive: true })
    fs.writeFileSync(path.join(under, '.claude', 'skills', name, 'SKILL.md'), '# x')
  }
  skill('minutes')
  skill('weekly')
  const file = path.join(dir, 'user', 'job-repeat-asks.json')
  let now = new Date(2026, 10, 2, 10, 0)
  let user: string | null = 'u1'
  const asks = createJobRepeatAsks({ file: () => file, userId: () => user, now: () => now, home: path.join(dir, 'home') })
  const turn = (companyId = 'co') => asks.turn({ companyId, companyRoot: company, workingDirectory: company })
  return {
    dir, company, file, asks, turn, skill,
    day: (d: number, h = 10) => { now = new Date(2026, 10, d, h, 0) },
    as: (u: string | null) => { user = u },
  }
}

/** One turn on the current day: the question it carried, then the Skills the AI loaded in it. */
function turnUsing(w: ReturnType<typeof world>, ...skills: string[]): string {
  const t = w.turn()
  assert.ok(t)
  for (const s of skills) t.skillUsed(s)
  return t.instructions
}

test('the 3rd distinct day carries the question once; loading it then marks it asked for good', () => {
  const w = world()
  w.day(2); assert.equal(turnUsing(w, 'minutes'), '')
  w.day(9); assert.equal(turnUsing(w, 'minutes'), '')
  w.day(16)
  const third = turnUsing(w, 'minutes')
  assert.match(third, /「minutes」/)
  assert.match(third, /毎週/)
  assert.match(third, /1回だけ/)
  // Asked: never again, the same day or later, whatever the AI said or the member answered.
  assert.equal(turnUsing(w, 'minutes'), '')
  // Used again on more days afterwards: still never asked (an asked Skill is not counted again).
  for (const d of [23, 30, 37]) { w.day(d); assert.equal(turnUsing(w, 'minutes'), '') }
  w.day(44); assert.equal(turnUsing(w), '')
})

test('several uses on one day count once', () => {
  const w = world()
  w.day(2); turnUsing(w, 'minutes', 'minutes'); turnUsing(w, 'minutes')
  w.day(2, 15); turnUsing(w, 'minutes')
  w.day(3); assert.equal(turnUsing(w, 'minutes', 'minutes'), '')
  w.day(3, 18); assert.equal(turnUsing(w), '', 'two days, however many uses')
  w.day(4); assert.match(turnUsing(w), /「minutes」/)
})

test('a turn that carried the question but did not load the Skill marks nothing; another Skill only counts', () => {
  const w = world()
  w.day(2); turnUsing(w, 'minutes')
  w.day(3); turnUsing(w, 'minutes')
  w.day(4); assert.match(turnUsing(w, 'weekly'), /「minutes」/)
  assert.match(turnUsing(w), /「minutes」/, 'still due: it was not loaded in the turn that carried it')
  turnUsing(w, 'minutes')
  assert.equal(turnUsing(w), '')
})

test('only a company Skill counts: a personal one, a private folder\'s one or one not there never does', () => {
  const w = world()
  w.skill('mine', path.join(w.dir, 'home'))
  w.skill('mine')
  const priv = path.join(w.company, '人事', '評価')
  fs.mkdirSync(path.join(priv, '.git'), { recursive: true })
  w.skill('secret', priv)
  for (const d of [2, 3, 4]) {
    w.day(d)
    const t = w.asks.turn({ companyId: 'co', companyRoot: w.company, workingDirectory: priv })!
    assert.equal(t.instructions, '')
    for (const s of ['mine', 'secret', 'gone', '../x', 'a:b']) t.skillUsed(s)
  }
  assert.equal(fs.existsSync(w.file), false, 'nothing was stored')
  // A Skill removed after it was counted is not named.
  w.day(5); turnUsing(w, 'weekly'); w.day(6); turnUsing(w, 'weekly')
  fs.rmSync(path.join(w.company, '.claude', 'skills', 'weekly'), { recursive: true })
  w.day(7); assert.equal(turnUsing(w), '')
})

test('the switch off: nothing asked or counted; turned on again it starts from nothing, asked marks kept', () => {
  const w = world()
  assert.deepEqual(w.asks.setting('co'), { success: true, on: true })
  w.day(2); turnUsing(w, 'minutes'); w.day(3); turnUsing(w, 'minutes')
  assert.deepEqual(w.asks.setOn('co', false), { success: true, on: false })
  w.day(4)
  assert.equal(w.turn(), undefined)
  assert.deepEqual(w.asks.setting('co'), { success: true, on: false })
  const stored = readRepeatFile(JSON.parse(fs.readFileSync(w.file, 'utf8')))!
  assert.deepEqual(Object.values(stored.members)[0], { off: true, skills: {} })
  w.asks.setOn('co', true)
  assert.equal(turnUsing(w, 'minutes'), '', 'the days before were forgotten')
  w.day(5); assert.equal(turnUsing(w, 'minutes'), '')
  w.day(6); assert.match(turnUsing(w, 'minutes'), /「minutes」/)
  w.asks.setOn('co', false); w.asks.setOn('co', true)
  w.day(30); turnUsing(w, 'minutes'); w.day(31); turnUsing(w, 'minutes')
  w.day(32); assert.equal(turnUsing(w), '', 'an asked mark survives the switch')
  assert.deepEqual(w.asks.setOn('co', 'yes'), { success: false })
})

test('per member and company; nobody signed in is never asked', () => {
  const w = world()
  for (const d of [2, 3]) { w.day(d); turnUsing(w, 'minutes') }
  w.day(4)
  w.as('u2'); assert.equal(turnUsing(w), '')
  w.as('u1'); assert.equal(w.turn('other')!.instructions, '')
  w.as(null); assert.equal(w.turn(), undefined)
  assert.deepEqual(w.asks.setting('co'), { success: false })
  w.as('u1'); assert.match(turnUsing(w), /「minutes」/)
})

test('the store holds Skill names and dates only — no conversation, text or path', () => {
  const w = world()
  for (const d of [2, 3, 4]) { w.day(d); turnUsing(w, 'minutes', 'weekly') }
  const text = fs.readFileSync(w.file, 'utf8')
  assert.ok(!text.includes(w.company) && !text.includes('company') && !text.includes('conv'))
  const keys = new Set<string>()
  JSON.parse(text, (k, v) => { if (k && Number.isNaN(Number(k))) keys.add(k); return v })
  assert.deepEqual([...keys].filter(k => !['version', 'members', 'skills', 'days', 'asked', 'minutes', 'weekly', 'u1/co'].includes(k)), [])
  assert.equal(fs.statSync(w.file).mode & 0o077, 0, 'owner-only')
  // What is read back keeps only that shape: anything else in the file is dropped.
  const read = readRepeatFile({ version: 1, members: { 'u1/co': { skills: { minutes: { days: ['2026-11-02', 'hello'], text: 'x' }, 'bad name': { days: ['2026-11-02'] } }, note: 'x' } } })
  assert.deepEqual(read, { version: 1, members: { 'u1/co': { skills: { minutes: { days: ['2026-11-02'] } } } } })
})

test('a store that cannot be read: nothing is asked or written over it', () => {
  const w = world()
  fs.mkdirSync(path.dirname(w.file), { recursive: true })
  fs.writeFileSync(w.file, '{ not json')
  w.day(2)
  assert.equal(w.turn(), undefined)
  assert.deepEqual(w.asks.setOn('co', false), { success: false })
  assert.equal(fs.readFileSync(w.file, 'utf8'), '{ not json')
  // One that exists but cannot be read at all (here a folder in its place) is not taken as empty either.
  const v = world()
  fs.mkdirSync(v.file, { recursive: true })
  assert.equal(v.turn(), undefined)
  assert.deepEqual(v.asks.setting('co'), { success: false })
})

test('the turn\'s sink gets only a Skill the AI really loaded', () => {
  const seen: string[] = []
  const sink: { current?: (s: string) => void } = {}
  const host = withSkillSightings({ onToolEvent: () => {} }, { companyId: 'co', conversationId: 'conv-1', companyRoot: '/c' }, sink)
  const ev = (over: Partial<AgentToolEvent>) => host.onToolEvent!({ tool: 'Skill', skill: 'minutes', outcome: 'ok', ...over } as AgentToolEvent)
  ev({}) // before the turn knows it offers the tools: nothing
  sink.current = s => seen.push(s)
  ev({}); ev({ outcome: undefined }); ev({ outcome: 'error' }); ev({ skill: 'plugin:x' }); ev({ tool: 'Read' })
  assert.deepEqual(seen, ['minutes'])
  // No consultation (an unattended step): the host is unchanged, nothing reaches a sink.
  const plain = { onToolEvent: () => {} }
  assert.equal(withSkillSightings(plain, undefined, sink), plain)
})

test('a turn offering the tools gets the question and connects its Skill sink; an unattended one or one without the tools neither', () => {
  const used: string[] = []
  const ask = () => ({ instructions: '\n\n【ask】', skillUsed: (s: string) => used.push(s) })
  const offered = { specs: [{ name: 'records_get' }, { name: JOB_PROPOSAL_CREATE_TOOL }] } as never
  const turn = { unattended: false, records: offered, companyId: 'co', companyRoot: '/c' }
  const sink: { current?: (s: string) => void } = {}
  assert.equal(repeatAskForTurn(ask, turn, sink), '\n\n【ask】')
  sink.current?.('minutes')
  assert.deepEqual(used, ['minutes'])
  for (const [why, t] of [
    ['an unattended step', { ...turn, unattended: true }],
    ['no job proposal tools', { ...turn, records: { specs: [{ name: 'records_get' }] } as never }],
    ['no record tools', { ...turn, records: undefined }],
  ] as const) {
    const s: { current?: (s: string) => void } = {}
    assert.equal(repeatAskForTurn(ask, t, s), '', why)
    assert.equal(s.current, undefined, why)
  }
  assert.equal(repeatAskForTurn(() => { throw new Error('x') }, turn, {}), '', 'a failure never reaches the turn')
})

async function chatTurn(body: Record<string, unknown>, extra: Record<string, unknown> = {}, offered = true) {
  const { startChatServer } = await import('../electron/chat-server')
  const asked: unknown[] = []
  const server = await startChatServer({
    getAuthMode: () => 'claude-code', getApiKey: () => undefined, buildSystemPrompt: () => '', getShellEnv: () => ({}),
    getPermissionMode: () => 'default', isClaudeCodeAuthenticated: () => true, getClaudeCodeCliPath: () => '/test/claude', listenPort: 0,
    getWriteGuard: () => ({ root: os.tmpdir(), getAccess: () => undefined }),
    createRecordTools: async (request: { jobProposals?: boolean }) => ({
      specs: request.jobProposals && offered ? [{ name: JOB_PROPOSAL_CREATE_TOOL }, { name: 'records_get' }] : [{ name: 'records_get' }],
      instructions: '', close: async () => {}, execute: async () => '', readTask: async () => null,
    }),
    jobRepeatAsk: (turn: unknown) => { asked.push(turn); return { instructions: '', skillUsed: () => {} } },
    ...extra,
  } as never)
  const abort = new AbortController()
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/chat`, {
      method: 'POST', signal: abort.signal,
      headers: { Authorization: `Bearer ${server.authToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ id: 'm', role: 'user', parts: [{ type: 'text', text: 'hi' }] }], companyId: 'co', companyRootPath: os.tmpdir(), ...body }),
    })
    await res.text().catch(() => '')
  } catch { /* the turn itself is not what is tested */ } finally {
    abort.abort()
    server.server.close()
  }
  return asked.length
}

test('asked only in a turn that offers the job proposal tools — never a job run, 「AI の番」 or a step', async () => {
  assert.equal(await chatTurn({ appSessionId: 'conv-plain-0001' }), 1)
  assert.equal(await chatTurn({ appSessionId: 'conv-plain-0002' }, {}, false), 0, 'the tools not offered (a read token, a run-bound token)')
  const ceiling = { pluginStepTools: () => ({ allowsRecordTool: () => true, builtinTools: [] }), stepWriteArea: async () => ({ nowhere: true, reads: [] }) }
  assert.equal(await chatTurn({ appSessionId: 'conv-job-00001', aiTurnStep: 'job-procedure' }, ceiling), 0)
  assert.equal(await chatTurn({ appSessionId: 'conv-turn-0001', aiTurnStep: 'minutes-reading' }), 0)
  assert.equal(await chatTurn({ appSessionId: 'conv-step-0001' }, { stepWriteArea: async () => 'sales/.personal/deal-1' }), 0)
})
