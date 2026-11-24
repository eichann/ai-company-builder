// A set watch's run on this PC (schema 5, 4b-4 PR5; owner memo 「4b-4 商談から提案書」 第6版 §4 / §5 / 付録 B2 / C2, jobs.md "The set
// watch" "The app runs it"):
// - only an app that runs it names its check (list and claim); the department folders must be here, else the AI is never called;
// - the judging gate failing ends the run `gate_failed` (no draft, no file check, never Claude instead);
// - the AI reads the pinned Skills from a read-only copy made from their git trees (not the working tree, no links), and only
//   that copy outside the company folder;
// - it writes only in a folder made new for this claim (none before it is made; never another proposal's folder);
// - the draft's images are copied only from the pinned `tools/assets/`, never over a file, never through a link;
// - the report: quotes checked against the minutes this run read, the files there, the images copied, the record kept on this
//   PC and read back — and only then the completion, fixed kinds only (no quote, company or folder).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createAiTurnClaims } from '../electron/features/ai-turns/claims'
import { createSetWatchFs, type SetRunRecord } from '../electron/features/ai-turns/set-watch-run'
import { createRecordsApi } from '../electron/records/api'
import { createRunRegistry } from '../electron/records/runs'
import { decideToolWrite, type WriteGuard } from '../electron/write-guard'
import { jobToolAccess, parseJobTurn, parseJobTurns } from '../shared/ai-turn-steps/job'
import { describePath } from '../shared/agent-events'
import { draftAssetNames, runFolderName, type DecisionGate } from '../shared/ai-turn-steps/set-watch'
import { JOB_MINUTES_ROUTE } from '../../shared/core/jobs'

const COMPANY = 'acme'
const OCC = `occ.${'5'.repeat(32)}`
const DEPT = '法人ソリューション'
const COPY_SKILL = 'sales-proposal-auto'
const ORIGINAL = 'sales-proposal-v1'
const MEETING = 'meeting-abcdef123456'
const REVIEW = 'task-abcdef123456'
const MINUTES = '佐藤：来月までに提案書を送ってください。\n鈴木：承知しました。予算は年間で300万円ほどです。'

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

/** A company folder whose shared branch holds both Skills (the copy with its reasons, the original with its images). */
function company() {
  const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'acb-setwatch-')))
  const root = path.join(tmp, 'company')
  const data = path.join(tmp, 'userData')
  const auto = path.join(root, DEPT, '.claude', 'skills', COPY_SKILL)
  const orig = path.join(root, DEPT, '.claude', 'skills', ORIGINAL)
  mkdirSync(auto, { recursive: true })
  mkdirSync(path.join(orig, 'tools', 'assets'), { recursive: true })
  writeFileSync(path.join(auto, 'SKILL.md'), '# 提案書のたたき台（承認された版）\n')
  writeFileSync(path.join(auto, 'decision.json'), JSON.stringify({ reasons: [{ code: 'asked_for_proposal', label: '提案を求められた' }, { code: 'internal', label: '社内の会議' }] }))
  writeFileSync(path.join(orig, 'SKILL.md'), '# 元の Skill\n')
  writeFileSync(path.join(orig, 'tools', 'assets', 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]))
  writeFileSync(path.join(orig, 'tools', 'assets', 'chart.png'), Buffer.from([1, 2, 3]))
  // A link committed in the Skill: never copied.
  symlinkSync('/etc/hosts', path.join(orig, 'tools', 'assets', 'hosts.png'))
  mkdirSync(path.join(root, DEPT, '提案書'), { recursive: true })
  writeFileSync(path.join(root, DEPT, '提案書', 'メモ.md'), 'x')
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'add', '-A')
  git(root, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'skills')
  const tree = (skill: string) => git(root, 'rev-parse', `HEAD:${DEPT}/.claude/skills/${skill}`)
  // The working tree changes after the approval: the run must still read the pinned version.
  writeFileSync(path.join(auto, 'SKILL.md'), '# 手で直した版（未承認）\n')
  return { tmp, root, data, autoTree: tree(COPY_SKILL), origTree: tree(ORIGINAL) }
}

function setGrant() {
  return {
    tools: ['files_read', 'files_write', 'records'], creates: ['task'], routes: [JOB_MINUTES_ROUTE],
    reads: { paths: [`${DEPT}/提案書`], calls: [] as string[], skills: [] as Array<{ place: string; skill: string; fingerprint: string }> },
    writes: { area: 'deliverable', place: DEPT, folder: '提案書' }, outbound: 'none', limits: { minutes: 30, runsPerDay: 10 },
  }
}

function setTurn(c: ReturnType<typeof company>, over: Record<string, unknown> = {}) {
  const grant = setGrant()
  grant.reads.skills = [{ place: DEPT, skill: ORIGINAL, fingerprint: c.origTree }]
  return {
    occurrenceId: OCC, jobId: `job.${'6'.repeat(32)}`, jobVersion: 1, fingerprint: 'sha256:x', name: '提案書のたたき台', dueSlot: '2026-11-23T10:00',
    dueAt: '2026-11-23T01:00:00.000Z', expiresAt: '2026-11-24T01:00:00.000Z', state: 'due', kind: 'event',
    source: { recordId: REVIEW, meetingId: MEETING }, check: { kind: 'matched_record' }, checkSince: '2026-11-23T01:00:00.000Z',
    procedure: { source: 'department_skill', place: DEPT, skill: COPY_SKILL, fingerprint: c.autoTree }, grant, ...over,
  }
}

function fakeServer(c: ReturnType<typeof company>, opts: { finish?: number; finishCode?: string; onFinish?: () => void; generation?: number; runView?: Record<string, unknown> } = {}) {
  const calls: Array<{ method: string; path: string; body: Record<string, unknown>; query: string }> = []
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {}
    const p = url.pathname.replace(`/api/companies/${COMPANY}`, '')
    calls.push({ method, path: p, body, query: url.search })
    if (p === '/me/job-turns') return json(200, { data: { turns: [setTurn(c)] } })
    if (p === '/task-settings') return json(200, { data: { settings: { autoRun: { enabled: true } } } })
    if (p === '/me/work-switches') return json(404, { code: 'NOT_FOUND' })
    if (p === '/job-run-claims') {
      const now = new Date().toISOString()
      return json(201, { data: { run: { id: 'run-s1', generation: opts.generation ?? 1, createdAt: now, updatedAt: now }, turn: setTurn(c, { state: 'running' }) } })
    }
    if (p === '/ai-runs/run-s1/renew') return json(200, { data: { run: { id: 'run-s1', generation: opts.generation ?? 1 } } })
    if (p === '/ai-runs/run-s1/finish') {
      opts.onFinish?.()
      return json(opts.finish ?? 200, opts.finish ? { code: opts.finishCode ?? 'JOB_SET_REPORT_BAD' } : { data: {} })
    }
    if (p === '/ai-runs/run-s0') return json(200, { data: { run: opts.runView } })
    return json(404, { code: 'NOT_FOUND' })
  }) as typeof fetch
  return { calls, fetch }
}

function claimsFor(c: ReturnType<typeof company>, server: ReturnType<typeof fakeServer>, over: { gate?: DecisionGate; setWatch?: null; recordsRoot?: () => string } = {}) {
  const base = { baseUrl: () => 'https://acb.example', cookies: () => ['s=1'] }
  const runs = createRunRegistry()
  const fs = createSetWatchFs({
    git: async (root, args) => git(root, ...args),
    gitBlob: async (root, sha) => execFileSync('git', ['cat-file', 'blob', sha], { cwd: root }),
    copiesRoot: () => path.join(c.data, 'job-skill-copies'),
    recordsRoot: over.recordsRoot ?? (() => path.join(c.data, 'job-set-runs')),
  })
  const stopped: string[] = []
  const claims = createAiTurnClaims({
    ...base, records: createRecordsApi({ ...base, fetch: server.fetch, runOf: runs.runOf }), runs, deviceId: 'device-set-1',
    renewEveryMs: 3_600_000, fetch: server.fetch, agent: () => 'claude-code', windowOpen: () => true, aiAllowed: () => true, stopPolicyConfirmed: async () => true,
    log: { warn: () => {} },
    jobs: {
      readShelfSkill: async () => null, fetchMark: async () => null, checkPoint: async () => null, newFiles: async () => null,
      stopTurn: (conv: string) => { stopped.push(conv) },
      ...(over.setWatch === null ? {} : { setWatch: fs }), ...(over.gate ? { gate: over.gate } : {}),
    },
  })
  return { claims, fs, stopped }
}
const finishes = (server: ReturnType<typeof fakeServer>) => server.calls.filter(x => x.path === '/ai-runs/run-s1/finish').map(x => x.body)
const records = (c: ReturnType<typeof company>): SetRunRecord[] => {
  const dir = path.join(c.data, 'job-set-runs', COMPANY, OCC)
  return existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(path.join(dir, f), 'utf8'))) : []
}

async function claimed(c: ReturnType<typeof company>, server: ReturnType<typeof fakeServer>, conv = 'conv-set-00001', over: Parameters<typeof claimsFor>[2] = {}) {
  const t = claimsFor(c, server, over)
  await t.claims.jobTurns(COMPANY)
  const r = await t.claims.claim(COMPANY, OCC, 1, conv, c.root)
  return { ...t, r, conv }
}

test('a set watch turn is read in its own frame, and only an app that runs it here names its check', async () => {
  const c = company()
  const parsed = parseJobTurn(setTurn(c))
  assert.equal(parsed?.set, true)
  assert.equal(parsed?.source?.meetingId, MEETING)
  // No meeting: not a turn this app runs; a meeting on an event turn of another check: neither.
  assert.equal(parseJobTurn(setTurn(c, { source: { recordId: REVIEW } })), null)
  assert.equal(parseJobTurns({ turns: [setTurn(c, { check: { kind: 'source_record', doneMark: 'none' } })] })?.length, 0)
  const server = fakeServer(c)
  const { claims, r } = await claimed(c, server)
  assert.equal(r.claimed, true)
  assert.match(server.calls.find(x => x.path === '/me/job-turns')!.query, /checks=matched_record/)
  assert.ok((server.calls.find(x => x.path === '/job-run-claims')!.body.checks as string[]).includes('matched_record'))
  // The ceiling: the minutes and the run's own tools; no time-job report for this consultation.
  const access = claims.jobTools('conv-set-00001', 'job-procedure')!
  for (const name of ['minutes_read', 'job_report', 'proposal_folder']) assert.ok(access.allowsRecordTool(name), name)
  assert.equal(claims.jobReporter('conv-set-00001'), null)
  assert.ok(claims.jobSetTools('conv-set-00001'))
  assert.equal(claims.jobSetTools('conv-other-0001'), null)
  // Without the file work an app neither asks for nor claims one.
  const plain = fakeServer(c)
  const t = claimsFor(c, plain, { setWatch: null })
  await t.claims.jobTurns(COMPANY)
  assert.doesNotMatch(plain.calls.find(x => x.path === '/me/job-turns')!.query, /matched_record/)
})

test('the department folder not on this PC: the AI is never called, a person is told', async () => {
  const c = company()
  execFileSync('rm', ['-rf', path.join(c.root, DEPT)])
  const server = fakeServer(c)
  const { r } = await claimed(c, server)
  assert.equal(r.claimed, false)
  assert.equal((r as { message?: string }).message, undefined)
  assert.deepEqual(finishes(server)[0].failure, { class: 'bad-input', code: 'DEPARTMENT_NOT_HERE' })
})

test('the gate failing: `gate_failed` alone, after the PC record — no draft, no copy, never Claude instead', async () => {
  const c = company()
  let recordAtFinish: SetRunRecord[] = []
  const server = fakeServer(c, { onFinish: () => { recordAtFinish = records(c) } })
  const { r } = await claimed(c, server, 'conv-set-00002', { gate: { judge: async () => 'failed' } })
  assert.equal(r.claimed, false)
  assert.equal((r as { message?: string }).message, undefined)
  assert.deepEqual(finishes(server)[0].jobResult, { decision: 'gate_failed' })
  assert.equal(recordAtFinish[0]?.state, 'sending')
  assert.equal(records(c)[0].state, 'sent')
  assert.equal(existsSync(path.join(c.data, 'job-skill-copies', COMPANY)), false)
})

test('the AI reads the pinned versions from a read-only copy of their trees — not the working tree, never a link', async () => {
  const c = company()
  const server = fakeServer(c)
  const { claims, r } = await claimed(c, server)
  const message = (r as { message: string }).message
  const area = claims.jobWriteArea('conv-set-00001')!
  const copy = area.readOutside!
  assert.ok(message.includes('# 提案書のたたき台（承認された版）'))
  assert.doesNotMatch(message, /手で直した版/)
  assert.ok(message.includes(copy))
  const skill = path.join(copy, DEPT, '.claude', 'skills', COPY_SKILL, 'SKILL.md')
  assert.equal(readFileSync(skill, 'utf8'), '# 提案書のたたき台（承認された版）\n')
  assert.throws(() => writeFileSync(skill, 'x'))
  assert.equal(existsSync(path.join(copy, DEPT, '.claude', 'skills', ORIGINAL, 'tools', 'assets', 'hosts.png')), false)
  // A tree not on this PC: tried later, nothing started.
  const gone = company()
  const s2 = fakeServer(gone)
  const t = claimsFor(gone, s2)
  await t.claims.jobTurns(COMPANY)
  const bad = setTurn(gone, { procedure: { source: 'department_skill', place: DEPT, skill: COPY_SKILL, fingerprint: 'f'.repeat(40) } })
  s2.calls.length = 0
  const fetch2 = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/job-run-claims')) {
      const now = new Date().toISOString()
      return new Response(JSON.stringify({ data: { run: { id: 'run-s1', generation: 1, createdAt: now, updatedAt: now }, turn: { ...bad, state: 'running' } } }), { status: 201 })
    }
    return s2.fetch(input, init)
  }) as typeof fetch
  const t2 = claimsFor(gone, { calls: s2.calls, fetch: fetch2 })
  await t2.claims.jobTurns(COMPANY)
  const r2 = await t2.claims.claim(COMPANY, OCC, 1, 'conv-set-00003', gone.root)
  assert.equal(r2.claimed, false)
  assert.deepEqual(finishes(s2)[0].failure, { class: 'temporary', code: 'PROCEDURE_NOT_HERE' })
  void t
})

function guardOf(root: string, area: NonNullable<ReturnType<ReturnType<typeof createAiTurnClaims>['jobWriteArea']>>): WriteGuard {
  return { root, getAccess: () => undefined, writeArea: area, readArea: area.reads }
}

test('reads: the pinned copy and the proposals folder; never another run\'s copy, the app\'s other data, or a link out of the copy', async () => {
  const c = company()
  const { claims } = await claimed(c, fakeServer(c))
  const area = claims.jobWriteArea('conv-set-00001')!
  const guard = guardOf(c.root, area)
  const copy = area.readOutside!
  const read = (p: string) => decideToolWrite(guard, 'Read', { file_path: p }, c.root)
  assert.equal(read(path.join(copy, DEPT, '.claude', 'skills', ORIGINAL, 'SKILL.md')).deny, false)
  assert.equal(decideToolWrite(guard, 'Glob', { path: copy, pattern: '**/*.md' }, c.root).deny, false)
  assert.equal(read(path.join(c.root, DEPT, '提案書', 'メモ.md')).deny, false)
  // The working tree's Skill, another run's copy, the app's records, a link placed in the copy: refused.
  assert.equal(read(path.join(c.root, DEPT, '.claude', 'skills', COPY_SKILL, 'SKILL.md')).deny, true)
  const other = path.join(c.data, 'job-skill-copies', COMPANY, 'occ.other.1')
  mkdirSync(other, { recursive: true })
  writeFileSync(path.join(other, 'x.md'), 'x')
  assert.equal(read(path.join(other, 'x.md')).deny, true)
  assert.equal(read(path.join(c.data, 'config.json')).deny, true)
  const dir = path.dirname(path.join(copy, DEPT, '.claude', 'skills', ORIGINAL, 'SKILL.md'))
  chmodSync(dir, 0o755)
  mkdirSync(path.join(c.data, 'job-set-runs'), { recursive: true })
  writeFileSync(path.join(c.data, 'job-set-runs', 'x.json'), '{}')
  symlinkSync(path.join(c.data, 'job-set-runs'), path.join(dir, 'out'))
  assert.equal(read(path.join(dir, 'out', 'x.json')).deny, true)
  assert.equal(read(path.join(copy, '..', 'occ.other.1', 'x.md')).deny, true)
})

test('writes: nothing before the run folder is made, then only inside it — never another proposal, the base, the copy', async () => {
  const c = company()
  const { claims } = await claimed(c, fakeServer(c))
  const area = claims.jobWriteArea('conv-set-00001')!
  const guard = guardOf(c.root, area)
  const write = (p: string) => decideToolWrite(guard, 'Write', { file_path: p, content: 'x' }, c.root)
  const base = path.join(c.root, DEPT, '.personal', '提案書')
  assert.equal(write(path.join(base, 'x.md')).deny, true)
  const tools = claims.jobSetTools('conv-set-00001')!
  const made = JSON.parse(await tools.execute('proposal_folder', { company: 'A社 (株)', meetingDate: '2026-11-23' }))
  assert.equal(made.folder, `${DEPT}/.personal/提案書/2026-11-23_A社_株`)
  // Asked again in the same claim: the same folder.
  assert.equal(JSON.parse(await tools.execute('proposal_folder', { company: 'B社' })).folder, made.folder)
  const run = path.join(c.root, made.folder)
  assert.deepEqual(JSON.parse(readFileSync(path.join(run, '.acb-job.json'), 'utf8')), { occurrenceId: OCC, runId: 'run-s1', generation: 1 })
  assert.equal(write(path.join(run, 'voices.md')).deny, false)
  assert.equal(write(path.join(base, '2026-11-01_C社', 'proposal.html')).deny, true)
  assert.equal(write(path.join(base, 'x.md')).deny, true)
  assert.equal(write(path.join(area.readOutside!, 'x.md')).deny, true)
  // A link inside the run folder leading to another proposal: refused where it lands.
  mkdirSync(path.join(base, '2026-11-01_C社'), { recursive: true })
  symlinkSync(path.join(base, '2026-11-01_C社'), path.join(run, 'old'))
  assert.equal(write(path.join(run, 'old', 'proposal.html')).deny, true)
})

test('each claim gets a new folder (`_2`), the earlier one untouched; a link on the way is never followed', async () => {
  const c = company()
  const first = await claimed(c, fakeServer(c))
  await first.claims.jobSetTools('conv-set-00001')!.execute('proposal_folder', { company: 'A社', meetingDate: '2026-11-23' })
  const earlier = path.join(c.root, DEPT, '.personal', '提案書', '2026-11-23_A社')
  writeFileSync(path.join(earlier, 'voices.md'), '人が直した')
  const again = await claimed(c, fakeServer(c, { generation: 2 }), 'conv-set-00009')
  const made = JSON.parse(await again.claims.jobSetTools('conv-set-00009')!.execute('proposal_folder', { company: 'A社', meetingDate: '2026-11-23' }))
  assert.equal(made.folder, `${DEPT}/.personal/提案書/2026-11-23_A社_2`)
  assert.equal(readFileSync(path.join(earlier, 'voices.md'), 'utf8'), '人が直した')
  assert.equal(JSON.parse(readFileSync(path.join(c.root, made.folder, '.acb-job.json'), 'utf8')).generation, 2)
  // The proposals folder is a link elsewhere: no folder is made.
  const d = company()
  const outside = path.join(d.tmp, 'elsewhere')
  mkdirSync(outside)
  mkdirSync(path.join(d.root, DEPT, '.personal'), { recursive: true })
  symlinkSync(outside, path.join(d.root, DEPT, '.personal', '提案書'))
  const t = await claimed(d, fakeServer(d))
  const refused = JSON.parse(await t.claims.jobSetTools('conv-set-00001')!.execute('proposal_folder', { company: 'A社' }))
  assert.ok(refused.error)
  assert.deepEqual(readdirSync(outside), [])
})

test('the folder name: the company made to fit the department folder rule, the day checked', () => {
  assert.equal(runFolderName('2026-11-23', '株式会社 A/B..社'), '2026-11-23_株式会社_A_B_社')
  assert.equal(runFolderName('2026-11-23', '../..'), '2026-11-23_会社名なし')
  assert.equal(runFolderName('2026/11/23', 'A'), null)
  assert.deepEqual(draftAssetNames('<img src="assets/logo.png"><img src="assets/../../x"><img src="assets/sub/a.png"><img src="assets/.hidden">'), ['logo.png'])
})

async function drafted(c: ReturnType<typeof company>, server: ReturnType<typeof fakeServer>, html = '<img src="assets/logo.png"><img src="assets/hosts.png"><img src="assets/../../etc/x.png">') {
  const t = await claimed(c, server)
  const tools = t.claims.jobSetTools('conv-set-00001')!
  const made = JSON.parse(await tools.execute('proposal_folder', { company: 'A社', meetingDate: '2026-11-23' }))
  const run = path.join(c.root, made.folder)
  for (const f of ['voices.md', '骨子（仮）.md', '確認してほしいこと.md']) writeFileSync(path.join(run, f), 'x')
  writeFileSync(path.join(run, 'proposal.html'), html)
  t.claims.jobMinutesRead('conv-set-00001', MEETING, MINUTES, 'notes:7')
  return { ...t, tools, run }
}
const REPORT = { decision: 'proceed', reason: 'asked_for_proposal', confidence: 0.8, unconfirmed: ['headcount'], evidence: [{ quote: '来月までに提案書を送ってください', speaker: '佐藤' }] }

test('the report: quotes, files and images checked, the PC record kept, then the completion — fixed kinds only', async () => {
  const c = company()
  let atFinish: SetRunRecord[] = []
  const server = fakeServer(c, { onFinish: () => { atFinish = records(c) } })
  const { tools, run, fs } = await drafted(c, server)
  void fs
  // A quote not in the minutes: refused, nothing sent.
  const wrong = JSON.parse(await tools.execute('job_report', { ...REPORT, evidence: [{ quote: '予算は無制限です、と言った' }] }))
  assert.match(wrong.error, /議事録に見つかりません/)
  // A reason the pinned list does not have: refused.
  assert.ok(JSON.parse(await tools.execute('job_report', { ...REPORT, reason: 'made_up' })).error)
  assert.deepEqual(finishes(server), [])
  const ok = JSON.parse(await tools.execute('job_report', REPORT))
  assert.equal(ok.ok, true)
  // The record was there, `sending`, before the completion left; then `sent`.
  assert.equal(atFinish[0]?.state, 'sending')
  assert.equal(atFinish[0]?.evidence?.[0].quote, '来月までに提案書を送ってください')
  assert.equal(records(c)[0].state, 'sent')
  const sent = finishes(server)
  assert.equal(sent.length, 1)
  assert.deepEqual(sent[0].jobResult, { decision: 'proceed', reason: 'asked_for_proposal', confidence: 0.8, unconfirmed: ['headcount'] })
  const wire = JSON.stringify(sent[0])
  for (const word of ['来月', '佐藤', 'A社', '提案書', '.personal']) assert.ok(!wire.includes(word), word)
  // Only the listed image; the link and the climbing name are not copied.
  assert.deepEqual(readdirSync(path.join(run, 'assets')), ['logo.png'])
  assert.deepEqual([...readFileSync(path.join(run, 'assets', 'logo.png'))], [0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255])
  // The copy is gone once sent; the images stay in the folder (4-T22).
  assert.equal(readdirSync(path.join(c.data, 'job-skill-copies', COMPANY)).length, 0)
  // Asked again: the same answer, nothing sent twice.
  assert.equal(JSON.parse(await tools.execute('job_report', REPORT)).ok, true)
  assert.equal(finishes(server).length, 1)
})

test('the draft\'s files missing: refused, nothing sent; an image already there is never overwritten; assets as a link copies nothing', async () => {
  const c = company()
  const server = fakeServer(c)
  const { tools, run } = await drafted(c, server)
  writeFileSync(path.join(run, '確認してほしいこと.md'), '')
  assert.match(JSON.parse(await tools.execute('job_report', REPORT)).error, /確認してほしいこと\.md/)
  assert.deepEqual(finishes(server), [])
  writeFileSync(path.join(run, '確認してほしいこと.md'), 'x')
  mkdirSync(path.join(run, 'assets'))
  writeFileSync(path.join(run, 'assets', 'logo.png'), '人が置いた画像')
  assert.equal(JSON.parse(await tools.execute('job_report', REPORT)).ok, true)
  assert.equal(readFileSync(path.join(run, 'assets', 'logo.png'), 'utf8'), '人が置いた画像')
  const d = company()
  const s2 = fakeServer(d)
  const t = await drafted(d, s2)
  const elsewhere = path.join(d.tmp, 'elsewhere')
  mkdirSync(elsewhere)
  symlinkSync(elsewhere, path.join(t.run, 'assets'))
  assert.ok(JSON.parse(await t.tools.execute('job_report', REPORT)).error)
  assert.deepEqual(readdirSync(elsewhere), [])
  assert.deepEqual(finishes(s2), [])
})

test('the PC record cannot be kept: nothing is sent, the run is given back', async () => {
  const c = company()
  const server = fakeServer(c)
  // A records place that cannot be written (a file where its folder should be).
  const blocked = path.join(c.tmp, 'not-a-folder')
  writeFileSync(blocked, 'x')
  const t = await claimed(c, server, 'conv-set-00004', { recordsRoot: () => blocked })
  const tools = t.claims.jobSetTools('conv-set-00004')!
  const made = JSON.parse(await tools.execute('proposal_folder', { company: 'B社', meetingDate: '2026-11-23' }))
  for (const f of ['voices.md', '骨子（仮）.md', '確認してほしいこと.md', 'proposal.html']) writeFileSync(path.join(c.root, made.folder, f), 'x')
  t.claims.jobMinutesRead('conv-set-00004', MEETING, MINUTES, null)
  assert.match(JSON.parse(await tools.execute('job_report', REPORT)).error, /書き残せなかった/)
  assert.deepEqual(finishes(server), [])
  assert.equal((await t.claims.settle(COMPANY, OCC)).outcome, 'put-back')
  assert.deepEqual(finishes(server)[0].failure, { class: 'temporary', code: 'PC_RECORD_NOT_KEPT' })
})

test('a decline needs no draft; quotes need this meeting\'s minutes read', async () => {
  const c = company()
  const server = fakeServer(c)
  const t = await claimed(c, server)
  const tools = t.claims.jobSetTools('conv-set-00001')!
  const decline = { decision: 'decline', reason: 'internal', confidence: 0.9 }
  assert.match(JSON.parse(await tools.execute('job_report', { ...decline, evidence: [{ quote: '来月までに提案書を送ってください' }] })).error, /minutes_read/)
  // Another meeting's minutes are not this run's.
  t.claims.jobMinutesRead('conv-set-00001', 'meeting-zzzzzz999999', MINUTES, null)
  assert.ok(JSON.parse(await tools.execute('job_report', { ...decline, evidence: [{ quote: '来月までに提案書を送ってください' }] })).error)
  // The AI cannot set the count: the app counts the file.
  assert.ok(JSON.parse(await tools.execute('job_report', { ...decline, updates: 2 })).error)
  assert.equal(JSON.parse(await tools.execute('job_report', decline)).ok, true)
  assert.deepEqual(finishes(server)[0].jobResult, decline)
  assert.equal(records(c)[0].minutesDocVersion, null)
})

const PROPOSALS = (over: Record<string, unknown> = {}) => JSON.stringify({
  版: 1, 会議: MEETING,
  更新案: [
    { 書き先: 'hubspot', 取引: '1000000001', 項目: '確度', 値: 'B', 根拠: '来月までに提案書を送ってください' },
    { 書き先: '係数表', 取引: '1000000001', 項目: '計上月', 値: [{ 月: '2026-12', 金額: 3000000 }] },
  ],
  ...over,
})

test('the update proposals: counted by the app from the fixed file only, `updates` sent only when some', async () => {
  const c = company()
  const server = fakeServer(c)
  const t = await claimed(c, server)
  const tools = t.claims.jobSetTools('conv-set-00001')!
  t.claims.jobMinutesRead('conv-set-00001', MEETING, MINUTES, 'notes:7,transcript:7')
  const made = JSON.parse(await tools.execute('proposal_folder', { company: 'A社' }))
  writeFileSync(path.join(c.root, made.folder, '更新案.json'), PROPOSALS())
  assert.equal(JSON.parse(await tools.execute('job_report', { decision: 'decline', reason: 'internal', confidence: 0.9 })).ok, true)
  assert.equal((finishes(server)[0].jobResult as { updates?: number }).updates, 2)
  const rec = records(c).find(r => r.state === 'sent')!
  assert.equal(rec.updatesFile, 'valid')
  assert.equal(rec.updates, 2)
  // The version of the minutes the run read is kept for 「議事録が直されています」 (T7).
  assert.equal(rec.minutesDocVersion, 'notes:7,transcript:7')
})

test('an update proposals\' file not of the shape: the AI is told once, then nothing is counted', async () => {
  const bad = [
    PROPOSALS({ 版: 2 }),
    PROPOSALS({ 会議: 'meeting-zzzzzz999999' }),
    PROPOSALS({ 更新案: [{ 書き先: 'hubspot', 取引: '1', 項目: '確度', 値: 'B' }, { 書き先: 'hubspot', 取引: '1', 項目: '確度', 値: 'C' }] }),
    PROPOSALS({ 更新案: [{ 書き先: 'hubspot', 取引: '1', 項目: '確度', 値: 'B', 根拠: '議事録に無い発言をここに書いた' }] }),
    PROPOSALS({ 更新案: [{ 書き先: 'メール', 取引: '1', 項目: '確度', 値: 'B' }] }),
    PROPOSALS({ 更新案: Array.from({ length: 21 }, (_, i) => ({ 書き先: '係数表', 取引: String(i), 項目: '計上月', 値: 1 })) }),
    '{ not json',
  ]
  for (const text of bad) {
    const c = company()
    const server = fakeServer(c)
    const t = await claimed(c, server)
    const tools = t.claims.jobSetTools('conv-set-00001')!
    t.claims.jobMinutesRead('conv-set-00001', MEETING, MINUTES, null)
    const made = JSON.parse(await tools.execute('proposal_folder', { company: 'A社' }))
    writeFileSync(path.join(c.root, made.folder, '更新案.json'), text)
    assert.match(JSON.parse(await tools.execute('job_report', { decision: 'decline', reason: 'internal', confidence: 0.9 })).error, /更新案\.json/, text)
    assert.deepEqual(finishes(server), [])
    assert.equal(JSON.parse(await tools.execute('job_report', { decision: 'decline', reason: 'internal', confidence: 0.9 })).ok, true)
    assert.equal((finishes(server)[0].jobResult as { updates?: number }).updates, undefined)
    assert.equal(records(c).find(r => r.state === 'sent')!.updatesFile, 'invalid')
  }
})

test('the completion refused (an older server, the run taken): the AI is told, the record says refused', async () => {
  const c = company()
  const server = fakeServer(c, { finish: 400 })
  const { tools } = await drafted(c, server)
  assert.ok(JSON.parse(await tools.execute('job_report', REPORT)).error)
  assert.equal(records(c)[0].state, 'refused')
})

test('a record whose completion\'s answer was lost: another generation finished it → not adopted; this one done → sent', async () => {
  const c = company()
  const recs = path.join(c.data, 'job-set-runs', COMPANY, OCC)
  mkdirSync(recs, { recursive: true })
  const rec: SetRunRecord = { v: 1, occurrenceId: OCC, runId: 'run-s0', generation: 1, state: 'sending', folder: null, at: '2026-11-23T01:00:00.000Z' }
  const file = path.join(recs, 'run-s0.1.json')
  const stateAfter = async (runView: Record<string, unknown>) => {
    writeFileSync(file, JSON.stringify(rec))
    const t = claimsFor(c, fakeServer(c, { runView }))
    await t.claims.jobTurns(COMPANY)
    // Looked at beside the listing (never in its way): give it a moment.
    for (let i = 0; i < 50 && JSON.parse(readFileSync(file, 'utf8')).state === 'sending'; i++) await new Promise(r => setTimeout(r, 20))
    return JSON.parse(readFileSync(file, 'utf8')).state
  }
  assert.equal(await stateAfter({ id: 'run-s0', state: 'running', generation: 2 }), 'not_adopted')
  assert.equal(await stateAfter({ id: 'run-s0', state: 'done', generation: 1 }), 'sent')
  assert.equal(await stateAfter({ id: 'run-s0', state: 'running', generation: 1 }), 'sending')
})

test('the tool ceiling of a set watch: the minutes route only through its check', () => {
  const access = jobToolAccess(setGrant() as never, { kind: 'matched_record' })
  assert.ok(access.allowsRecordTool('minutes_read'))
  assert.ok(access.allowsRecordTool('proposal_folder'))
  assert.equal(jobToolAccess(setGrant() as never, { kind: 'new_files', path: `${DEPT}/提案書` }).allowsRecordTool('proposal_folder'), false)
})

test('review: the action log never names what is below the proposals folder (customer names in run folders)', () => {
  const ctx = { companyRoot: '/co', unnamedBelow: [`${DEPT}/.personal/提案書`] }
  assert.deepEqual(describePath(`/co/${DEPT}/.personal/提案書/2026-11-23_A社/proposal.html`, ctx), { kind: 'file', path: `${DEPT}/.personal/提案書` })
  assert.deepEqual(describePath(`/co/${DEPT}/提案書/メモ.md`, ctx), { kind: 'file', path: `${DEPT}/提案書/メモ.md` })
  // Without the mark (every other consultation): as before.
  assert.deepEqual(describePath(`/co/${DEPT}/.personal/提案書/2026-11-23_A社/proposal.html`, { companyRoot: '/co' }), { kind: 'file', path: `${DEPT}/.personal/提案書/2026-11-23_A社/proposal.html` })
})

test('review: a set watch never reads a Skill of the company folder, even inside a read place; never writes the run mark', async () => {
  const c = company()
  const { claims } = await claimed(c, fakeServer(c))
  const area = claims.jobWriteArea('conv-set-00001')!
  // A grant reading the whole department: the working tree's Skills are still not read (only the pinned copy is).
  const guard: WriteGuard = { root: c.root, getAccess: () => undefined, writeArea: area, readArea: [DEPT] }
  assert.equal(decideToolWrite(guard, 'Read', { file_path: path.join(c.root, DEPT, '.claude', 'skills', COPY_SKILL, 'SKILL.md') }, c.root).deny, true)
  assert.equal(decideToolWrite(guard, 'Grep', { path: path.join(c.root, DEPT, '.claude', 'skills'), pattern: 'x' }, c.root).deny, true)
  assert.equal(decideToolWrite(guard, 'Read', { file_path: path.join(c.root, DEPT, '提案書', 'メモ.md') }, c.root).deny, false)
  const made = JSON.parse(await claims.jobSetTools('conv-set-00001')!.execute('proposal_folder', { company: 'A社' }))
  assert.equal(decideToolWrite(guard, 'Write', { file_path: path.join(c.root, made.folder, '.acb-job.json'), content: '{}' }, c.root).deny, true)
  assert.equal(decideToolWrite(guard, 'Write', { file_path: path.join(c.root, made.folder, 'voices.md'), content: 'x' }, c.root).deny, false)
})

test('review: a lost answer whose run went back at this generation is `refused`; the same Skill pinned twice is copied once', async () => {
  const c = company()
  const recs = path.join(c.data, 'job-set-runs', COMPANY, OCC)
  mkdirSync(recs, { recursive: true })
  const rec: SetRunRecord = { v: 1, occurrenceId: OCC, runId: 'run-s0', generation: 1, state: 'sending', folder: null, at: '2026-11-23T01:00:00.000Z' }
  writeFileSync(path.join(recs, 'run-s0.1.json'), JSON.stringify(rec))
  const back = claimsFor(c, fakeServer(c, { runView: { id: 'run-s0', state: 'waiting_person', generation: 1 } }))
  await back.claims.jobTurns(COMPANY)
  for (let i = 0; i < 50 && JSON.parse(readFileSync(path.join(recs, 'run-s0.1.json'), 'utf8')).state === 'sending'; i++) await new Promise(r => setTimeout(r, 20))
  assert.equal(JSON.parse(readFileSync(path.join(recs, 'run-s0.1.json'), 'utf8')).state, 'refused')
  const fs = back.fs
  const pin = { place: DEPT, skill: COPY_SKILL, fingerprint: c.autoTree }
  const copy = await fs.makeCopy(COMPANY, OCC, 7, c.root, [pin, pin])
  assert.ok(copy)
  assert.equal(copy!.skills.length, 1)
  assert.equal(await fs.makeCopy(COMPANY, OCC, 8, c.root, [pin, { ...pin, fingerprint: c.origTree }]), null)
})
