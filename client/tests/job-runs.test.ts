// A scheduled job's run on this PC (定期の仕事, placement a, B PR 5a-2, jobs.md "The app's runner"):
// - nothing is asked of the server while this PC may not run unattended AI (window, Codex, the emergency
//   stop, the stop policy unconfirmed) — the same refusals as a record's AI turn;
// - the claim names the checks this app runs, and the check runs before any AI: nothing found → the run
//   finishes `nothing` and no message is sent;
// - the run gets only its grant's tools, writes only in its grant's area (or nowhere) and reads only its
//   grant's places; its one やること's title goes back with the finish (the server makes it);
// - the procedure is the pinned one (not here → given back for later), and the AI stops before the
//   approved minutes run out or when the server takes the run away.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createAiTurnClaims } from '../electron/features/ai-turns/claims'
import { gitCheckPoint, newFilesByGit, newFilesByTime } from '../electron/features/ai-turns/job-runs'
import { createRecordsApi } from '../electron/records/api'
import { createRunRegistry } from '../electron/records/runs'
import { decideToolWrite, type WriteGuard } from '../electron/write-guard'
import { jobToolAccess, jobWriteArea, parseJobTurn, parseJobTurns } from '../shared/ai-turn-steps/job'
import type { JobGrant } from '../../shared/core/jobs'
import { aiTurnQueue } from '../shared/ai-turn-steps/registry'
import { freshLog, handUrgent } from '../src/features/chat/aiTurns'

const COMPANY = 'acme'
const OCC = `occ.${'1'.repeat(32)}`
const GRANT: JobGrant = {
  tools: ['records', 'files_read', 'files_write'], creates: ['task'], routes: ['GET /item/:recordId', 'POST /item'],
  reads: { paths: ['人事部/面談'], calls: [] }, writes: { area: 'deliverable', place: '人事部', folder: 'reports' }, outbound: 'none',
  limits: { minutes: 30, runsPerDay: 1 },
}
const turn = (over: Record<string, unknown> = {}) => ({
  occurrenceId: OCC, jobId: `job.${'2'.repeat(32)}`, jobVersion: 1, fingerprint: 'sha256:x', name: '面談の報告', dueSlot: '2026-11-11T09:00',
  dueAt: '2026-11-11T00:00:00.000Z', expiresAt: '2026-11-12T00:00:00.000Z', state: 'due', check: { kind: 'new_files', path: '人事部/面談' },
  checkSince: '2026-11-10T00:00:00.000Z', procedure: { source: 'company_skill', skill: 'interview-report', fingerprint: 'b'.repeat(40) }, grant: GRANT, ...over,
})

function fakeServer(opts: { claim?: number; renew?: number; finish?: number; createdAt?: string; serverNow?: string; autoRun?: boolean; turnOver?: Record<string, unknown> } = {}) {
  const calls: Array<{ method: string; path: string; body: Record<string, unknown> }> = []
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {}
    const p = url.pathname.replace(`/api/companies/${COMPANY}`, '')
    calls.push({ method, path: p, body })
    if (p === '/me/job-turns') return json(200, { data: { turns: [turn(opts.turnOver)] } })
    if (p === '/task-settings') return json(200, { data: { settings: { autoRun: { enabled: opts.autoRun ?? true } } } })
    if (p === '/me/work-switches') return json(404, { code: 'NOT_FOUND' })
    if (p === '/job-run-claims') {
      if (opts.claim && opts.claim !== 201) return json(opts.claim, { code: 'RUN_CLAIMED' })
      const serverNow = opts.serverNow ?? new Date().toISOString()
      return json(201, { data: { run: { id: 'run-j1', generation: 1, createdAt: opts.createdAt ?? serverNow, updatedAt: serverNow }, turn: turn({ state: 'running', ...opts.turnOver }) } })
    }
    if (p === '/ai-runs/run-j1/renew') return json(opts.renew ?? 200, {})
    if (p === '/ai-runs/run-j1/finish') return json(opts.finish ?? 200, opts.finish ? { code: 'RUN_SUPERSEDED' } : { data: {} })
    return json(404, { code: 'NOT_FOUND' })
  }) as typeof fetch
  return { calls, fetch }
}

function claimsFor(server: ReturnType<typeof fakeServer>, over: Record<string, unknown> = {}) {
  const base = { baseUrl: () => 'https://acb.example', cookies: () => ['s=1'] }
  const runs = createRunRegistry()
  const stopped: string[] = []
  const claims = createAiTurnClaims({
    ...base, records: createRecordsApi({ ...base, fetch: server.fetch, runOf: runs.runOf }), runs, deviceId: 'device-job-1',
    renewEveryMs: 3_600_000, fetch: server.fetch, agent: () => 'claude-code', windowOpen: () => true, aiAllowed: () => true, stopPolicyConfirmed: async () => true,
    log: { warn: () => {} }, readProcedure: async () => '# 面談の報告書\n文字起こしから下書きを作る。\n',
    jobs: { readShelfSkill: async () => null, checkPoint: async () => ({ commit: 'c'.repeat(40) }), newFiles: async () => ['人事部/面談/2026-11-10_佐藤.txt'], stopTurn: (c: string) => { stopped.push(c) } } as NonNullable<Parameters<typeof createAiTurnClaims>[0]['jobs']>,
    ...over,
  })
  return { claims, stopped, runs }
}
const finishes = (server: ReturnType<typeof fakeServer>) => server.calls.filter(c => c.path === '/ai-runs/run-j1/finish').map(c => c.body)

test('the turns are parsed with the one definition parser: a check this app cannot run, or a grant it does not know, is left out', () => {
  assert.equal(parseJobTurns({ turns: [turn()] })?.length, 1)
  assert.equal(parseJobTurn(turn({ check: { kind: 'none' } })), null)
  assert.equal(parseJobTurn(turn({ check: { kind: 'new_files', path: '人事部/面談', extra: 1 } })), null)
  assert.equal(parseJobTurn(turn({ grant: { ...GRANT, tools: [...GRANT.tools, 'web_research'] } })), null)
  assert.equal(parseJobTurn(turn({ occurrenceId: 'task-123456' })), null)
  assert.equal(parseJobTurn(turn({ meetings: [{ id: 'not a record', title: 'x', at: '2026-11-10T01:00:00.000Z' }] })), null)
  assert.equal(parseJobTurns({ nope: 1 }), null)
})

test('the run\'s tools: only what its grant names and the server would let through; minutes only with the meeting check', () => {
  const access = jobToolAccess(GRANT, { kind: 'new_files', path: '人事部/面談' })
  assert.equal(access.allowsRecordTool('records_get'), true)
  assert.equal(access.allowsRecordTool('job_report'), true)
  // POST /item is in the grant but never through the run's token (the server makes the one やること).
  assert.equal(access.allowsRecordTool('records_create'), false)
  assert.equal(access.allowsRecordTool('records_query'), false)
  assert.equal(access.allowsRecordTool('minutes_read'), false)
  assert.equal(access.allowsRecordTool('mail_draft_create'), false)
  assert.deepEqual(access.builtinTools.sort(), ['Edit', 'Glob', 'Grep', 'MultiEdit', 'Read', 'Write'])
  const minutesGrant: JobGrant = { ...GRANT, tools: ['records'], routes: ['GET /minutes/:recordId/text'], reads: { paths: [], calls: [] }, writes: { area: 'none' } }
  const meetings = jobToolAccess(minutesGrant, { kind: 'new_meetings', titleWords: [] })
  assert.equal(meetings.allowsRecordTool('minutes_read'), true)
  // The route in the grant is not enough: minutes only with the meeting check.
  assert.equal(jobToolAccess(minutesGrant, { kind: 'new_files', path: '人事部/面談' }).allowsRecordTool('minutes_read'), false)
  assert.deepEqual(meetings.builtinTools, [])
  const noRecords = jobToolAccess({ ...GRANT, tools: ['files_read'], writes: { area: 'none' } }, { kind: 'new_files', path: '人事部/面談' })
  assert.equal(noRecords.allowsRecordTool('records_get'), false)
})

test('nothing reaches the server while this PC may not run AI unattended', async () => {
  for (const over of [{ windowOpen: () => false }, { agent: () => 'codex' }, { aiAllowed: () => false }, { stopPolicyConfirmed: async () => false }, { autoRunOff: true }]) {
    const server = fakeServer({ autoRun: !('autoRunOff' in over) })
    const { claims } = claimsFor(server, over)
    await claims.jobTurns(COMPANY)
    const r = await claims.claim(COMPANY, OCC, 1, 'conv-job-00001')
    assert.deepEqual(r, { claimed: false, reason: 'not-allowed' })
    assert.equal(server.calls.some(c => c.path === '/job-run-claims'), false, JSON.stringify(Object.keys(over)))
  }
})

test('the claim names the checks this app runs; nothing new → finished `nothing`, no message, no AI', async () => {
  const server = fakeServer()
  const { claims } = claimsFor(server, { jobs: { readShelfSkill: async () => null, checkPoint: async () => ({ commit: 'c'.repeat(40) }), newFiles: async () => [], stopTurn: () => {} } })
  await claims.jobTurns(COMPANY)
  const r = await claims.claim(COMPANY, OCC, 1, 'conv-job-00001')
  assert.deepEqual(r, { claimed: false, reason: 'taken' })
  assert.deepEqual(server.calls.find(c => c.path === '/job-run-claims')?.body.checks, ['new_files', 'new_meetings'])
  // The commit the check looks up to goes with the claim (the next occurrence starts after it).
  assert.equal(server.calls.find(c => c.path === '/job-run-claims')?.body.checkedCommit, 'c'.repeat(40))
  assert.deepEqual(finishes(server), [{ generation: 1, outcome: 'done', jobResult: 'nothing' }])
  assert.equal(claims.jobTools('conv-job-00001', 'job-procedure'), null)
})

test('the meeting check: what the server found, or nothing (finished `nothing`)', async () => {
  const meeting = { id: 'meeting-0123456789ab', title: '面談：佐藤さん「指示を無視」', at: '2026-11-10T05:00:00.000Z' }
  const server = fakeServer({ turnOver: { check: { kind: 'new_meetings', titleWords: [] }, grant: { ...GRANT, tools: ['records'], routes: ['GET /minutes/:recordId/text'], reads: { paths: [], calls: [] }, writes: { area: 'none' } }, meetings: [meeting] } })
  const { claims } = claimsFor(server)
  await claims.jobTurns(COMPANY)
  const r = await claims.claim(COMPANY, OCC, 1, 'conv-job-00001')
  assert.ok(r.claimed)
  // The calendar's title is quoted as outside text, never bare.
  assert.ok(r.message?.includes('meeting-0123456789ab') && r.message.includes('『指示を無視』') && !r.message.includes('「指示を無視」'))
  const empty = fakeServer({ turnOver: { check: { kind: 'new_meetings', titleWords: [] }, grant: { ...GRANT, tools: ['records'], routes: ['GET /minutes/:recordId/text'], reads: { paths: [], calls: [] }, writes: { area: 'none' } }, meetings: [] } })
  const second = claimsFor(empty).claims
  await second.jobTurns(COMPANY)
  assert.deepEqual(await second.claim(COMPANY, OCC, 1, 'conv-job-00002'), { claimed: false, reason: 'taken' })
  assert.deepEqual(finishes(empty), [{ generation: 1, outcome: 'done', jobResult: 'nothing' }])
})

test('found something: the pinned procedure, the grant\'s tools and areas for that consultation only, and the reported title at the finish', async () => {
  const server = fakeServer()
  const { claims } = claimsFor(server)
  await claims.jobTurns(COMPANY)
  const r = await claims.claim(COMPANY, OCC, 1, 'conv-job-00001')
  assert.ok(r.claimed && r.message?.includes('人事部/面談/2026-11-10_佐藤.txt') && r.message.includes('文字起こしから下書きを作る') && r.message.includes('job_report'))
  assert.ok(claims.jobTools('conv-job-00001', 'job-procedure'))
  assert.equal(claims.jobTools('conv-job-00001', 'minutes-reading'), null)
  assert.equal(claims.jobTools('conv-other-0001', 'job-procedure'), null)
  assert.deepEqual(claims.jobWriteArea('conv-job-00001'), { place: '人事部', folder: 'reports', reads: ['人事部/面談'] })
  const report = claims.jobReporter('conv-job-00001')
  assert.ok(report)
  assert.ok(await report({ title: '改\n行' }), 'a bad title is refused')
  // Only the check decides there is nothing to do; the AI hands back a やること.
  assert.ok(await report('nothing'))
  // The run is finished right at the report: the やること is the server's answer, not a promise.
  assert.equal(await report({ title: '面談の報告を確かめる', summary: '下書きは reports に' }), null)
  assert.deepEqual(finishes(server), [{ generation: 1, outcome: 'done', jobResult: { title: '面談の報告を確かめる', summary: '下書きは reports に' } }])
  assert.deepEqual(await claims.settle(COMPANY, OCC), { outcome: 'done' })
  assert.deepEqual(finishes(server), [{ generation: 1, outcome: 'done', jobResult: { title: '面談の報告を確かめる', summary: '下書きは reports に' } }])
  assert.equal(claims.jobTools('conv-job-00001', 'job-procedure'), null)
})

test('no report: tried again later (never a やること made up); the procedure not on this PC: given back before any message', async () => {
  const server = fakeServer()
  const { claims } = claimsFor(server)
  await claims.jobTurns(COMPANY)
  assert.ok((await claims.claim(COMPANY, OCC, 1, 'conv-job-00001')).claimed)
  assert.deepEqual(await claims.settle(COMPANY, OCC), { outcome: 'put-back' })
  assert.deepEqual(finishes(server), [{ generation: 1, outcome: 'failed', failure: { class: 'temporary', code: 'UNFINISHED' } }])

  const notHere = fakeServer()
  const second = claimsFor(notHere, { readProcedure: async () => null }).claims
  await second.jobTurns(COMPANY)
  assert.deepEqual(await second.claim(COMPANY, OCC, 1, 'conv-job-00002'), { claimed: false, reason: 'unavailable' })
  assert.deepEqual(finishes(notHere), [{ generation: 1, outcome: 'failed', failure: { class: 'temporary', code: 'PROCEDURE_NOT_HERE' } }])
})

test('the AI stops before the approved minutes run out, and a person looks', async () => {
  const server = fakeServer({ createdAt: new Date(Date.now() - 29 * 60_000 - 30_000).toISOString() })
  const { claims } = claimsFor(server)
  await claims.jobTurns(COMPANY)
  // Started 29.5 minutes ago with 30 approved: less than the minute before the end is left → not started at all.
  assert.deepEqual(await claims.claim(COMPANY, OCC, 1, 'conv-job-00001'), { claimed: false, reason: 'unavailable' })
  assert.deepEqual(finishes(server), [{ generation: 1, outcome: 'failed', failure: { class: 'bad-input', code: 'TIME_LIMIT' } }])

  const near = fakeServer({ createdAt: new Date(Date.now() - 29 * 60_000 + 600).toISOString() })
  const { claims: c2, stopped } = claimsFor(near)
  await c2.jobTurns(COMPANY)
  assert.ok((await c2.claim(COMPANY, OCC, 1, 'conv-job-00003')).claimed)
  await new Promise(resolve => setTimeout(resolve, 1_000))
  assert.deepEqual(stopped, ['conv-job-00003'])
  assert.deepEqual(await c2.settle(COMPANY, OCC), { outcome: 'failed' })
  assert.deepEqual(finishes(near), [{ generation: 1, outcome: 'failed', failure: { class: 'bad-input', code: 'TIME_LIMIT' } }])
})

test('taken away while the check or the procedure is read: nothing starts, and no tools for that consultation (never an ordinary turn)', async () => {
  const server = fakeServer({ renew: 409 })
  let release!: () => void
  const slow = new Promise<string>(resolve => { release = () => resolve('# 手順\n') })
  const { claims, runs } = claimsFor(server, { renewEveryMs: 10, readProcedure: () => slow })
  await claims.jobTurns(COMPANY)
  const pending = claims.claim(COMPANY, OCC, 1, 'conv-job-00001')
  await new Promise(resolve => setTimeout(resolve, 60))
  release()
  assert.deepEqual(await pending, { claimed: false, reason: 'unavailable' })
  assert.equal(claims.jobTools('conv-job-00001', 'job-procedure'), null)
  assert.equal(runs.runOf(COMPANY, 'conv-job-00001'), null)
})

test('the deadline is the server\'s: this PC\'s clock running ahead does not cut the run short', async () => {
  // The server's clock is 29.5 minutes behind this PC's (30 approved); the run was claimed just now on the server.
  const serverNow = new Date(Date.now() - 29.5 * 60_000).toISOString()
  const server = fakeServer({ serverNow, createdAt: serverNow })
  const { claims, stopped } = claimsFor(server)
  await claims.jobTurns(COMPANY)
  assert.ok((await claims.claim(COMPANY, OCC, 1, 'conv-job-00001')).claimed)
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.deepEqual(stopped, [])
  assert.deepEqual(finishes(server), [])
})

test('the server takes the run away (a pause, the stop, another PC): the renew\'s 409 stops the AI here', async () => {
  const server = fakeServer({ renew: 409 })
  const { claims, stopped } = claimsFor(server, { renewEveryMs: 20 })
  await claims.jobTurns(COMPANY)
  assert.ok((await claims.claim(COMPANY, OCC, 1, 'conv-job-00001')).claimed)
  await new Promise(resolve => setTimeout(resolve, 80))
  assert.deepEqual(stopped, ['conv-job-00001'])
  // No ceiling any more: the chat server refuses a next turn rather than run it as an ordinary one.
  assert.equal(claims.jobTools('conv-job-00001', 'job-procedure'), null)
  assert.deepEqual(await claims.settle(COMPANY, OCC), { outcome: 'failed' })
})

test('the write guard: a job writes only in its grant\'s place, or nowhere; it reads only its grant\'s places', () => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'acb-job-guard-')))
  try {
    mkdirSync(path.join(root, '人事部', '面談'), { recursive: true })
    mkdirSync(path.join(root, '営業部'), { recursive: true })
    writeFileSync(path.join(root, '営業部', '秘密.txt'), 'x')
    symlinkSync(path.join(root, '営業部'), path.join(root, '人事部', '面談', 'link'))
    const area = jobWriteArea(GRANT)
    const getAccess = () => ({ version: 1, role: 'member', all: true, scopes: [] })
    const guard: WriteGuard = { root, getAccess, writeArea: area, readArea: area.reads }
    const write = (p: string) => decideToolWrite(guard, 'Write', { file_path: path.join(root, p), content: 'x' }).deny
    assert.equal(write('人事部/.personal/reports/2026-11-11.md'), false)
    assert.equal(write('営業部/.personal/reports/x.md'), true)
    assert.equal(write('人事部/.personal/other/x.md'), true)
    assert.equal(write('人事部/面談/x.md'), true)
    const nowhere: WriteGuard = { root, getAccess, writeArea: jobWriteArea({ ...GRANT, writes: { area: 'none' } }) }
    assert.equal(decideToolWrite(nowhere, 'Write', { file_path: path.join(root, '人事部/.personal/reports/x.md'), content: 'x' }).deny, true)
    const read = (tool: string, input: Record<string, unknown>) => decideToolWrite(guard, tool, input).deny
    assert.equal(read('Read', { file_path: path.join(root, '人事部/面談/a.txt') }), false)
    assert.equal(read('Read', { file_path: path.join(root, '人事部/.personal/reports/x.md') }), false)
    assert.equal(read('Read', { file_path: path.join(root, '営業部/秘密.txt') }), true)
    assert.equal(read('Read', { file_path: path.join(root, '人事部/面談/link/秘密.txt') }), true, 'a link cannot lead out')
    assert.equal(read('Read', { file_path: '/etc/hosts' }), true)
    assert.equal(read('Grep', { pattern: 'x' }), true, 'Glob / Grep must name a place')
    assert.equal(read('Grep', { pattern: 'x', path: path.join(root, '人事部/面談') }), false)
    assert.equal(read('Glob', { pattern: '../../**', path: path.join(root, '人事部/面談') }), true)
    // An ordinary consultation's reads are not limited here.
    assert.equal(decideToolWrite({ root, getAccess }, 'Read', { file_path: path.join(root, '営業部/秘密.txt') }).deny, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('new files in the shared folder: by what is reachable, never by commit dates; only once this PC has what the server has', async () => {
  const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'acb-job-git-')))
  try {
    const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' }
    const run = (cwd: string, args: string[], extra: Record<string, string> = {}) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...env, ...extra } })
    const git = async (cwd: string, args: string[]) => run(cwd, args)
    const server = path.join(tmp, 'server.git')
    run(tmp, ['init', '-q', '--bare', '-b', 'main', server])
    const colleague = path.join(tmp, 'colleague')
    const root = path.join(tmp, 'mine')
    run(tmp, ['clone', '-q', server, colleague])
    run(colleague, ['checkout', '-q', '-b', 'main'])
    const commit = (file: string, date?: string) => {
      mkdirSync(path.dirname(path.join(colleague, file)), { recursive: true })
      writeFileSync(path.join(colleague, file), file)
      run(colleague, ['add', '-A'])
      run(colleague, ['commit', '-qm', file], date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {})
      run(colleague, ['push', '-q', 'origin', 'main'])
    }
    commit('人事部/面談/first.txt')
    run(tmp, ['clone', '-q', '-b', 'main', server, root])
    run(root, ['pull', '-q'])
    const longAgo = '2026-01-01T00:00:00.000Z'
    const first = await gitCheckPoint(git, root, '人事部/面談', longAgo)
    assert.ok(first && first !== 'not-synced')
    // Made offline long ago, reaching the server only now: still new after the previous occurrence's commit.
    commit('人事部/面談/late.txt', '2026-01-02T00:00:00Z')
    commit('営業部/other.txt')
    // Fetched but not in HEAD (a fetch-only path, a sync stopped on a conflict): not yet, never `nothing`.
    run(root, ['fetch', '-q'])
    assert.equal(await gitCheckPoint(git, root, '人事部/面談', longAgo), 'not-synced')
    run(root, ['merge', '-q', '--ff-only', '@{upstream}'])
    const second = await gitCheckPoint(git, root, '人事部/面談', longAgo)
    assert.ok(second && second !== 'not-synced')
    assert.deepEqual(await newFilesByGit(git, root, '人事部/面談', { since: '2026-06-01T00:00:00.000Z', sinceCommit: first.commit, upto: second.commit }), ['人事部/面談/late.txt'])
    // Nothing added between the same commits; a commit this PC does not have is "not yet".
    assert.deepEqual(await newFilesByGit(git, root, '人事部/面談', { since: longAgo, sinceCommit: second.commit, upto: second.commit }), [])
    assert.equal(await newFilesByGit(git, root, '人事部/面談', { since: longAgo, sinceCommit: null, upto: 'f'.repeat(40) }), 'not-synced')
    // Not fetched since the window's end: not yet.
    assert.equal(await gitCheckPoint(git, root, '人事部/面談', new Date(Date.now() + 3_600_000).toISOString()), 'not-synced')
    assert.equal(await gitCheckPoint(git, root, '人事部/ない', longAgo), null)
    assert.equal(await gitCheckPoint(git, root, '../x', longAgo), null)
    // A link at the place itself, or above it (committed by someone), is never followed, nor its repository used.
    const outside = path.join(tmp, 'outside')
    mkdirSync(path.join(outside, '他社'), { recursive: true })
    writeFileSync(path.join(outside, '他社', '秘密.txt'), 'x')
    run(outside, ['init', '-q'])
    symlinkSync(path.join(outside, '他社'), path.join(root, '営業部', '受付'))
    assert.equal(await gitCheckPoint(git, root, '営業部/受付', longAgo), null)
    assert.equal(await newFilesByGit(git, root, '営業部/受付', { since: longAgo, sinceCommit: null, upto: second.commit }), null)
    assert.equal(await newFilesByTime(root, '営業部/受付', longAgo, new Date().toISOString()), null)
    symlinkSync(outside, path.join(root, 'リンク'))
    assert.equal(await newFilesByTime(root, 'リンク/他社', longAgo, new Date().toISOString()), null)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('new files in a working folder (no git): by their time, within the window', async () => {
  const work = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'acb-job-work-')))
  try {
    const since = '2026-06-01T00:00:00.000Z'
    mkdirSync(path.join(work, '人事部', '面談', '.personal'), { recursive: true })
    writeFileSync(path.join(work, '人事部', '面談', 'a.txt'), 'a')
    writeFileSync(path.join(work, '人事部', '面談', 'b.txt'), 'b')
    writeFileSync(path.join(work, '人事部', '面談', '.personal', 'mine.txt'), 'm')
    const old = new Date('2026-01-01T00:00:00Z')
    utimesSync(path.join(work, '人事部', '面談', 'a.txt'), old, old)
    const until = new Date(Date.now() + 60_000).toISOString()
    assert.deepEqual(await newFilesByTime(work, '人事部/面談', since, until), ['人事部/面談/b.txt'])
    assert.deepEqual(await newFilesByTime(work, '人事部/面談', since, '2026-06-02T00:00:00.000Z'), [])
    assert.equal(await newFilesByTime(work, '人事部/ない', since, until), null)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})

test('a job\'s record token only with its run: none held → no token at all, never an ordinary one', async () => {
  const runs = createRunRegistry()
  const asked: unknown[] = []
  const fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    asked.push(JSON.parse(String(init?.body)))
    return new Response(JSON.stringify({ data: { token: 't', tokenId: 'i', scope: 'act' } }), { status: 201, headers: { 'content-type': 'application/json' } })
  }) as typeof globalThis.fetch
  const api = createRecordsApi({ baseUrl: () => 'https://acb.example', cookies: () => ['s=1'], fetch, runOf: runs.runOf })
  assert.equal(await api.openTurn(COMPANY, { conversationId: 'conv-job-00001', agent: 'claude-code', scope: 'act', requireRun: true }), null)
  assert.deepEqual(asked, [])
  runs.set(COMPANY, 'conv-job-00001', { id: 'run-j1', generation: 1 })
  assert.ok(await api.openTurn(COMPANY, { conversationId: 'conv-job-00001', agent: 'claude-code', scope: 'act', requireRun: true }))
  assert.deepEqual(asked, [{ conversationId: 'conv-job-00001', agent: 'claude-code', scope: 'act', run: { id: 'run-j1', generation: 1 } }])
})

test('the runner\'s queue: an occurrence runs as a job (never as a record\'s step) and is never handed to the person for its slot\'s time', () => {
  const [job] = parseJobTurns({ turns: [turn()] }) ?? []
  const queue = aiTurnQueue({ minutes: [], tasks: [], jobs: [job] })
  assert.deepEqual(queue.map(c => [c.id, c.job, c.notUrgent]), [[OCC, true, true]])
  // Its slot is in the past (the clock made it at its time): it is not a deadline the AI races.
  const log = freshLog(Date.now())
  assert.equal(handUrgent(log, queue, null, Date.parse('2026-11-11T00:30:00.000Z')), log)
})

test('not synced: nothing is claimed (tried later); a commit not here after the claim: given back, never `nothing`', async () => {
  const before = fakeServer()
  const { claims } = claimsFor(before, { jobs: { readShelfSkill: async () => null, checkPoint: async () => 'not-synced' as const, newFiles: async () => [], stopTurn: () => {} } })
  await claims.jobTurns(COMPANY)
  // Asked again a little later (no start counted: the runner's pass cap is for runs, not for waiting on a sync).
  assert.deepEqual(await claims.claim(COMPANY, OCC, 1, 'conv-job-00001'), { claimed: false, reason: 'unavailable', retryAfterMs: 30_000 })
  assert.equal(before.calls.some(c => c.path === '/job-run-claims'), false)

  const server = fakeServer()
  const second = claimsFor(server, { jobs: { readShelfSkill: async () => null, checkPoint: async () => ({ commit: 'c'.repeat(40) }), newFiles: async () => 'not-synced' as const, stopTurn: () => {} } }).claims
  await second.jobTurns(COMPANY)
  assert.deepEqual(await second.claim(COMPANY, OCC, 1, 'conv-job-00002'), { claimed: false, reason: 'unavailable', retryAfterMs: 30_000 })
  assert.deepEqual(finishes(server), [{ generation: 1, outcome: 'failed', failure: { class: 'temporary', code: 'NOT_SYNCED' } }])
})

test('the report refused (paused, stopped, its time): the AI is told no やること was made, and the consultation stays open', async () => {
  const server = fakeServer({ finish: 409 })
  const { claims } = claimsFor(server)
  await claims.jobTurns(COMPANY)
  assert.ok((await claims.claim(COMPANY, OCC, 1, 'conv-job-00001')).claimed)
  const report = claims.jobReporter('conv-job-00001')!
  const said = await report({ title: '面談の報告を確かめる' })
  assert.ok(said?.includes('やることは作られませんでした'), said ?? '')
  // Asked again, the same answer; nothing is finished twice.
  assert.equal(await report({ title: '面談の報告を確かめる' }), said)
  assert.equal(finishes(server).length, 1)
  assert.deepEqual(await claims.settle(COMPANY, OCC), { outcome: 'failed' })
  assert.equal(finishes(server).length, 1)
})

test('the chat server never runs a job\'s turn without its run: the token is asked only with the run, and none → no turn', async () => {
  const { startChatServer } = await import('../electron/chat-server')
  const asked: unknown[] = []
  const server = await startChatServer({
    getAuthMode: () => 'claude-code', getApiKey: () => undefined, buildSystemPrompt: () => '', getShellEnv: () => ({}),
    getPermissionMode: () => 'default', isClaudeCodeAuthenticated: () => true, getClaudeCodeCliPath: () => '/test/claude', listenPort: 0,
    pluginStepTools: () => ({ allowsRecordTool: () => true, builtinTools: [] }),
    getWriteGuard: () => ({ root: os.tmpdir(), getAccess: () => undefined }),
    stepWriteArea: async () => ({ nowhere: true, reads: [] }),
    // The run was taken away between the ceiling and the token: no token.
    createRecordTools: async request => { asked.push(request.requireRun); return null },
  })
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/chat`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${server.authToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ id: 'm', role: 'user', parts: [{ type: 'text', text: 'hi' }] }], companyId: 'co', companyRootPath: os.tmpdir(), appSessionId: 'conv-job-00010', aiTurnStep: 'job-procedure' }),
    })
    assert.equal(res.status, 400)
    assert.equal((await res.json() as { code: string }).code, 'AI_TURN_NOT_SUPPORTED')
    assert.deepEqual(asked, [true])
  } finally {
    server.server.close()
  }
})
