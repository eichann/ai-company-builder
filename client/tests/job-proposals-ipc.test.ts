/**
 * The member's own side of a proposal (jobs.md "Member proposals" "The app (PR C)", `electron/features/jobs/proposals.ts`):
 * - the card shows only a candidate the one parser reads as a member's proposal (schema 4) with the server's fingerprint;
 * - a candidate gone or withheld (the same 404) still shows what became of its proposal, found by the candidate's id;
 * - 「これで管理者に出す」 sends the candidate's id and the fingerprint, with the session, to the session route only;
 * - refusals are the app's fixed words (never the server's text), and a fingerprint the server withholds is never shown.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createJobProposalsApi } from '../electron/features/jobs/proposals'
import { proposalDefinition } from '../../shared/core/job-proposals'
import { jobProposalRefusalText, JOB_PROPOSAL_REFUSED_TEXT } from '../shared/job-proposals'

const C = 'jc.' + 'a'.repeat(32)
const P = 'jp.' + 'b'.repeat(32)
const FP = 'sha256:' + 'f'.repeat(64)
const DEF = proposalDefinition(
  { skill: 'minutes-summary', trigger: { every: 'week', weekday: 'mon', at: '09:00', businessDaysBefore: 0 }, check: { kind: 'new_meetings' }, reads: [], deliverable: null, readRecords: false, mailDrafts: false, minutes: 15, missed: { policy: 'skip', expiresAfterMinutes: 60 } },
  { actingUser: 'me', procedure: { source: 'company_skill', skill: 'minutes-summary', fingerprint: 'c'.repeat(40) }, skillName: 'minutes-summary', candidateId: C },
)
const PROPOSAL = { id: P, jobId: 'job.' + '1'.repeat(32), proposerId: 'me', candidateId: C, submittedVersion: 1, submittedFingerprint: FP, state: 'submitted', returnReason: null, decidedBy: null, decidedAt: null, createdAt: '2026-11-22T00:00:00Z' }

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

test('the card shows only a schema-4 candidate with the server\'s fingerprint', async () => {
  const shown = await api(() => ok({ id: C, definition: DEF, fingerprint: FP, createdAt: 'x', expiresAt: '2026-11-23T00:00:00Z', proposal: null })).api.candidate('co', C)
  assert.ok(shown.success && shown.candidate && shown.candidate.fingerprint === FP && shown.candidate.definition.schema === 4)
  for (const [why, data] of [
    ['schema 1 (not a proposal)', { id: C, definition: { ...DEF, schema: 1, origin: undefined }, fingerprint: FP, expiresAt: 'x' }],
    ['a definition the parser refuses', { id: C, definition: { ...DEF, name: '' }, fingerprint: FP, expiresAt: 'x' }],
    ['no fingerprint of the server\'s shape', { id: C, definition: DEF, fingerprint: 'abc', expiresAt: 'x' }],
    ['another candidate\'s answer', { id: 'jc.' + 'e'.repeat(32), definition: DEF, fingerprint: FP, expiresAt: 'x' }],
  ] as const) {
    const r = await api(() => ok(JSON.parse(JSON.stringify(data)))).api.candidate('co', C)
    assert.ok(r.success && r.candidate === null, why)
  }
})

test('gone or withheld (one 404): what became of its proposal, found by the candidate\'s id; none → gone', async () => {
  const listed = (proposals: unknown[]) => (method: string, path: string) => path === `/me/job-candidates/${C}` ? { status: 404, body: { success: false, code: 'JOB_CANDIDATE_NOT_FOUND', error: 'x' } } : ok({ proposals })
  const found = await api(listed([{ ...PROPOSAL, candidateId: 'jc.' + 'd'.repeat(32), id: 'jp.' + 'd'.repeat(32) }, { ...PROPOSAL, state: 'approved' }])).api.candidate('co', C)
  assert.ok(found.success && found.candidate === null && found.proposal?.id === P && found.proposal.state === 'approved')
  const gone = await api(listed([])).api.candidate('co', C)
  assert.ok(gone.success && gone.candidate === null && gone.proposal === null)
})

test('「これで管理者に出す」: the candidate\'s id and the fingerprint shown, with the session, to the session route', async () => {
  const h = api(() => ok({ proposal: PROPOSAL, created: true }, 201))
  const r = await h.api.submit('co', C, FP)
  assert.ok(r.success && r.proposal.id === P)
  assert.deepEqual(h.calls.map(c => [c.method, c.path, c.body]), [['POST', `/me/job-candidates/${C}/submit`, { fingerprint: FP }]])
  assert.equal(h.calls[0].headers.Cookie, 's=SESSION')
  // Renderer values never change the path: a bad id or fingerprint is refused before any call.
  const bad = api(() => ok({}))
  for (const [c, f] of [['jc.x/../../jobs', FP], [C, 'sha256:short'], [C, undefined], ['jp.' + 'b'.repeat(32), FP]]) {
    const out = await bad.api.submit('co', c, f)
    assert.ok(!out.success && out.code === 'BAD_REQUEST')
  }
  assert.equal((await bad.api.submit('../co', C, FP)).success, false)
  assert.deepEqual(bad.calls, [])
})

test('refusals are the app\'s fixed words, never the server\'s text; an unknown code is a general sentence', async () => {
  const refuse = (code: string) => api(() => ({ status: 409, body: { success: false, code, error: '営業/人事評価 は読めません' } })).api
  const place = await refuse('JOB_CANDIDATE_PLACE').submit('co', C, FP)
  assert.ok(!place.success && place.error === jobProposalRefusalText('JOB_CANDIDATE_PLACE') && !place.error.includes('人事'))
  const odd = await refuse('SOMETHING_NEW').submit('co', C, FP)
  assert.ok(!odd.success && odd.error === JOB_PROPOSAL_REFUSED_TEXT)
  for (const code of ['JOB_VERSION_FINGERPRINT', 'JOB_PROPOSALS_WAITING_LIMIT', 'JOB_PROPOSALS_DAY_LIMIT', 'JOB_SKILL_CHANGED', 'JOB_GRANT_EXCEEDS', 'JOB_PROPOSAL_DECIDED']) {
    assert.notEqual(jobProposalRefusalText(code), JOB_PROPOSAL_REFUSED_TEXT, code)
  }
})

test('a fingerprint the server withholds is never shown; a malformed one is none', async () => {
  const h = api(() => ok({ proposals: [{ ...PROPOSAL, submittedFingerprint: null }, { ...PROPOSAL, id: 'jp.' + 'c'.repeat(32), submittedFingerprint: '営業/人事' }] }))
  const r = await h.api.mine('co')
  assert.ok(r.success && r.supported && r.proposals.length === 2 && r.proposals.every(p => p.submittedFingerprint === null))
})

test('a server without member proposals: nothing to show, said as nothing', async () => {
  const r = await api(() => ({ status: 404, body: { success: false, error: 'Not Found' } })).api.mine('co')
  assert.deepEqual(r, { success: true, supported: false, proposals: [] })
})

test('取り下げる: the proposer\'s session route, ids checked first', async () => {
  const h = api(() => ok({ proposal: { ...PROPOSAL, state: 'withdrawn' } }))
  const r = await h.api.withdraw('co', P)
  assert.ok(r.success && r.proposal.state === 'withdrawn')
  assert.deepEqual(h.calls.map(c => [c.method, c.path]), [['POST', `/me/job-proposals/${P}/withdraw`]])
  assert.equal((await h.api.withdraw('co', C)).success, false)
  assert.equal(h.calls.length, 1)
})

test('「やめる」: the session route with the candidate\'s id; a discarded candidate is said as such; a server before it discarded nothing', async () => {
  const h = api(() => ok({ discarded: true }))
  assert.deepEqual(await h.api.discard('co', C), { success: true, supported: true })
  assert.deepEqual(h.calls.map(c => [c.method, c.path, c.headers.Cookie]), [['POST', `/me/job-candidates/${C}/discard`, 's=SESSION']])
  for (const bad of ['jc.x/../submit', 'jp.' + 'b'.repeat(32), undefined]) assert.equal((await h.api.discard('co', bad)).success, false)
  assert.equal(h.calls.length, 1)
  const old = await api(() => ({ status: 404, body: { success: false, error: 'Not Found' } })).api.discard('co', C)
  assert.deepEqual(old, { success: true, supported: false })
  const submitted = await api(() => ({ status: 409, body: { success: false, code: 'JOB_CANDIDATE_SUBMITTED', error: 'x' } })).api.discard('co', C)
  assert.ok(!submitted.success && submitted.code === 'JOB_CANDIDATE_SUBMITTED' && submitted.error === jobProposalRefusalText('JOB_CANDIDATE_SUBMITTED'))
  // An expired one is not "supported: false" (it names its code): the card reads it again and says it is gone.
  assert.equal((await api(() => ({ status: 404, body: { success: false, code: 'JOB_CANDIDATE_NOT_FOUND', error: 'x' } })).api.discard('co', C)).success, false)
  const read = await api(() => ({ status: 410, body: { success: false, code: 'JOB_CANDIDATE_DISCARDED', error: 'x' } })).api.candidate('co', C)
  assert.deepEqual(read, { success: true, candidate: null, proposal: null, discarded: true })
})

test('the zone the server names is kept only as a zone id', async () => {
  const shown = (timeZone: unknown) => api(() => ok({ id: C, definition: DEF, fingerprint: FP, expiresAt: 'x', proposal: null, timeZone })).api.candidate('co', C)
  const r = await shown('Asia/Tokyo')
  assert.ok(r.success && r.candidate?.timeZone === 'Asia/Tokyo')
  for (const odd of ['日本時間<script>', '../etc', 42, undefined]) {
    const x = await shown(odd)
    assert.ok(x.success && x.candidate !== null && x.candidate.timeZone === null, String(odd))
  }
})
