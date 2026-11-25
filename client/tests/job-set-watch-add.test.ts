/**
 * 「会議のあとの見張りを足す」 (4b-4 PR6b, jobs.md "Member proposals" "A set watch from the app"; `electron/features/jobs/proposals.ts`,
 * `shared/job-proposals.ts`, `src/features/jobs/model.ts`):
 * - main sends only an opened combination and Skill names of the right shape, the three keys, with the session and the app's
 *   schemas (5 included) — anything else is refused before any call;
 * - the candidate is shown only as the server built it: a set watch of an opened combination run by a department Skill, with the
 *   server's fingerprint;
 * - the Skills listed are only well-formed ones; a server without the route has none (not an error);
 * - the screen's pick: the Skill it runs must be one with its reasons, reads at most four and never the run Skill, only Skills
 *   listed; the button is not offered once the member has a set watch.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createJobProposalsApi } from '../electron/features/jobs/proposals'
import { setWatchProposalDefinition } from '../../shared/core/job-proposals'
import { JOB_SET_WATCH_OPENED } from '../../shared/core/jobs'
import { readShownCandidate } from '../shared/job-proposals'
import { hasSetWatch, setWatchChoiceOf, toggleSetWatchRead, type SetWatchPick } from '../src/features/jobs/model'
import type { MyJob } from '../shared/jobs'

const C = 'jc.' + 'a'.repeat(32)
const FP = 'sha256:' + 'f'.repeat(64)
const DEPT = '法人ソリューション'
const opened = () => JSON.parse(JSON.stringify(JOB_SET_WATCH_OPENED[0]))
const CHOICE = { trigger: opened(), skill: { place: DEPT, skill: 'sales-proposal-auto' }, readSkills: [{ place: DEPT, skill: 'sales-proposal-v1' }] }
const DEF = (() => {
  const d = setWatchProposalDefinition(CHOICE, 'me') as Record<string, unknown> & { run: { procedure: { fingerprint: string } } }
  d.run.procedure.fingerprint = 'c'.repeat(40)
  return { ...d, decision: { reasons: [{ code: 'requested', label: '提案を求められた' }] } }
})()

type Route = (method: string, path: string, body: unknown) => { status: number; body: unknown }
function api(route: Route) {
  const calls: Array<{ method: string; path: string; body: unknown; headers: Record<string, string> }> = []
  const fetch = (async (url: string, init: RequestInit) => {
    const path = url.replace('https://acb.example/api/companies/co', '')
    const body = init.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method: init.method ?? 'GET', path, body, headers: init.headers as Record<string, string> })
    const r = route(init.method ?? 'GET', path, body)
    return new Response(JSON.stringify(r.body), { status: r.status })
  }) as unknown as typeof globalThis.fetch
  return { api: createJobProposalsApi({ baseUrl: () => 'https://acb.example', cookies: () => ['s=SESSION'], fetch, log: { warn() {} } }), calls }
}
const ok = (data: unknown, status = 200) => ({ status, body: { success: true, data } })
const candidateAnswer = (definition: unknown = DEF) => ok({ id: C, definition, fingerprint: FP, createdAt: 'x', expiresAt: '2026-11-25T00:00:00Z', proposal: null }, 201)

test('the member\'s choice goes as the three keys, with the session and the schemas this app shows', async () => {
  const h = api(() => candidateAnswer())
  const r = await h.api.createSetWatch('co', CHOICE)
  assert.ok(r.success && r.candidate.id === C && r.candidate.definition.schema === 5)
  assert.deepEqual(h.calls.map(c => [c.method, c.path, c.body]), [['POST', '/me/job-candidates', CHOICE]])
  assert.equal(h.calls[0].headers.Cookie, 's=SESSION')
  assert.ok(h.calls[0].headers['X-ACB-Job-Schemas'].split(',').includes('5'))
})

test('anything but an opened combination and well-formed Skill names is refused before any call', async () => {
  const h = api(() => candidateAnswer())
  for (const [why, choice] of [
    ['a combination not opened', { ...CHOICE, trigger: { ...opened(), guards: ['after_acceptance'] } }],
    ['a time trigger', { ...CHOICE, trigger: { every: 'day', at: '09:00' } }],
    ['another key (a name)', { ...CHOICE, name: '勝手な名前' }],
    ['a path for a place', { ...CHOICE, skill: { place: `${DEPT}/sub`, skill: 'x' } }],
    ['a Skill name of another shape', { ...CHOICE, skill: { place: DEPT, skill: '../x' } }],
    ['five Skills read', { ...CHOICE, readSkills: ['a', 'b', 'c', 'd', 'e'].map(skill => ({ place: DEPT, skill })) }],
    ['a Skill read twice', { ...CHOICE, readSkills: [CHOICE.readSkills[0], CHOICE.readSkills[0]] }],
  ] as const) {
    const r = await h.api.createSetWatch('co', choice)
    assert.ok(!r.success && r.code === 'BAD_REQUEST', why)
  }
  assert.equal((await h.api.createSetWatch('../co', CHOICE)).success, false)
  assert.deepEqual(h.calls, [])
})

test('the candidate is shown only as a set watch of an opened combination with the server\'s fingerprint', async () => {
  assert.ok(readShownCandidate({ id: C, definition: DEF, fingerprint: FP, expiresAt: 'x' }, C))
  const notOpened = { ...DEF, trigger: { ...opened(), guards: ['after_acceptance'] } }
  for (const [why, data] of [
    ['a combination not opened', { id: C, definition: notOpened, fingerprint: FP, expiresAt: 'x' }],
    ['no fingerprint of the server\'s shape', { id: C, definition: DEF, fingerprint: 'abc', expiresAt: 'x' }],
  ] as const) {
    assert.equal(readShownCandidate(data, C), null, why)
    const r = await api(() => candidateAnswer(data.definition)).api.createSetWatch('co', CHOICE)
    if (why === 'a combination not opened') assert.equal(r.success, false, why)
  }
})

test('the Skills listed: well-formed ones only, each once; a server without the route has none (not an error)', async () => {
  const listed = await api(() => ok({ skills: [
    { place: DEPT, skill: 'sales-proposal-auto', runs: true }, { place: DEPT, skill: 'sales-proposal-auto', runs: true },
    { place: '.claude', skill: 'x', runs: true }, { place: DEPT, skill: 'Bad Name', runs: true }, { place: DEPT, skill: 'sales-proposal-v1', runs: 'yes' },
  ] })).api.setWatchSkills('co')
  assert.deepEqual(listed, { success: true, supported: true, skills: [{ place: DEPT, skill: 'sales-proposal-auto', runs: true }, { place: DEPT, skill: 'sales-proposal-v1', runs: false }] })
  // A server before it: its unknown path answers 404 with NOT_FOUND (since 2026-11-02) or with no code (earlier).
  for (const body of [{ error: 'Not found', code: 'NOT_FOUND' }, { error: 'Not found' }]) {
    const old = await api(() => ({ status: 404, body })).api.setWatchSkills('co')
    assert.deepEqual(old, { success: true, supported: false, skills: [] })
  }
})

test('the pick: it runs a Skill with its reasons, reads at most four and never itself, only Skills listed', () => {
  const skills = [
    { place: DEPT, skill: 'auto', runs: true }, { place: DEPT, skill: 'plain', runs: false },
    ...['a', 'b', 'c', 'd', 'e'].map(skill => ({ place: '営業部', skill, runs: false })),
  ]
  const pick: SetWatchPick = { combo: 0, run: `${DEPT}/auto`, reads: [] }
  assert.deepEqual(setWatchChoiceOf(pick, skills), { trigger: opened(), skill: { place: DEPT, skill: 'auto' }, readSkills: [] })
  assert.equal(setWatchChoiceOf({ ...pick, run: `${DEPT}/plain` }, skills), null)
  // Every opened line can be picked (4b-4 A3: the second, 「AI が議事録を読み終えたとき」), one past them never.
  assert.equal(setWatchChoiceOf({ ...pick, combo: 1 }, skills)?.trigger.event, 'first_read')
  assert.equal(setWatchChoiceOf({ ...pick, combo: JOB_SET_WATCH_OPENED.length }, skills), null)
  assert.equal(setWatchChoiceOf({ ...pick, reads: ['営業部/none'] }, skills), null)
  let p = pick
  for (const k of ['a', 'b', 'c', 'd', 'e']) p = toggleSetWatchRead(p, `営業部/${k}`)
  assert.deepEqual(p.reads, ['営業部/a', '営業部/b', '営業部/c', '営業部/d'])
  assert.deepEqual(toggleSetWatchRead(pick, `${DEPT}/auto`).reads, [])
  assert.deepEqual(toggleSetWatchRead(p, '営業部/a').reads, ['営業部/b', '営業部/c', '営業部/d'])
})

test('「見張りを足す」 is not offered once the member has a set watch', () => {
  const job = (trigger: unknown, state = 'active') => ({ trigger, state }) as unknown as MyJob
  assert.equal(hasSetWatch([job({ every: 'day', at: '09:00' })]), false)
  assert.equal(hasSetWatch([job(opened())]), true)
  assert.equal(hasSetWatch([job(opened(), 'retired')]), false)
  assert.equal(hasSetWatch(null), false)
})
