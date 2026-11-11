// jobs:* (electron/features/jobs/ipc.ts, jobs.md "The screens"): the app shows the member only the jobs
// they are the responsible person of (an owner / admin's list holds every job of the company), asks for
// acceptance only of the approved version that names them, sends exactly the version and fingerprint
// shown, and never lets a renderer value change the server path.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createJobsApi } from '../electron/features/jobs/ipc'

const J1 = 'job.' + '1'.repeat(32)
const J2 = 'job.' + '2'.repeat(32)
const J3 = 'job.' + '3'.repeat(32)
const FP = 'sha256:' + 'a'.repeat(64)

const def = (actingUser: string) => ({
  schema: 1, name: 'x', actingUser, trigger: { every: 'day', at: '09:00', businessDaysOnly: true }, check: { kind: 'none' },
  run: { kind: 'operation', operation: 'create_task', title: '日報', dueBusinessDays: null }, placement: 'e',
  missed: { policy: 'skip', expiresAfterMinutes: 60 },
  grant: { tools: [], creates: ['task'], routes: [], reads: { paths: [], calls: [] }, writes: { area: 'none' }, outbound: 'none', limits: { minutes: 5, runsPerDay: 1 } },
})
const view = (id: string, actingUserId: string, approvedFor: string | null, accepted: boolean) => ({
  id, name: id, state: 'active', actingUserId, latestVersion: 1, approvedVersion: approvedFor ? 1 : null, accepted, pausedReason: null,
  waiting: accepted ? null : 'NOT_ACCEPTED', trigger: def('me').trigger, nextSlot: '2026-11-12T09:00',
  versions: [{ version: 1, fingerprint: FP, consentFingerprint: FP, definition: def(approvedFor ?? actingUserId) }],
})

function api(jobs: ReturnType<typeof view>[]) {
  const calls: Array<{ method: string; url: string; body?: string; cookie?: string }> = []
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ method: init.method ?? 'GET', url, body: init.body as string | undefined, cookie: (init.headers as Record<string, string>).Cookie })
    const path = url.replace('https://acb.example/api', '')
    const json = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    if (path === '/me') return json({ id: 'me' })
    if (path === '/companies/c1/jobs') return json({ stopped: false, canManage: true, jobs })
    const found = jobs.find(j => path === `/companies/c1/jobs/${j.id}`)
    if (found) return json(found)
    return json({ ok: true })
  }) as typeof globalThis.fetch
  return { calls, jobs: createJobsApi({ baseUrl: () => 'https://acb.example', cookies: () => ['s=1'], fetch, log: { warn() {} } }) }
}

test('only the jobs the member is responsible for are shown, and only theirs waits for their 「受け取る」', async () => {
  const { jobs } = api([view(J1, 'someone', 'someone', false), view(J2, 'me', 'me', false), view(J3, 'me', 'me', true)])
  const r = await jobs.mine('c1')
  assert.ok(r.success)
  assert.deepEqual(r.jobs.map(j => j.id), [J2, J3])
  assert.deepEqual(r.jobs.map(j => j.toAccept?.version ?? null), [1, null])
  assert.equal(r.jobs[0].toAccept?.fingerprint, FP)
  assert.equal(r.jobs[0].controls, true)
})

test('a draft naming the member, approved for someone else, is shown but asks them nothing', async () => {
  const { jobs } = api([view(J1, 'me', 'someone', false)])
  const r = await jobs.mine('c1')
  assert.ok(r.success)
  assert.equal(r.jobs[0].toAccept, null)
  assert.equal(r.jobs[0].controls, false)
})

test('accepting sends the version and fingerprint shown, with the session; renderer values never change the path', async () => {
  const { calls, jobs } = api([])
  for (const [company, id, version, fp] of [['../x', J1, 1, FP], ['c1', '../../jobs-stop', 1, FP], ['c1', J1, 0, FP], ['c1', J1, 1, 'sha256:zz'], ['c1', 'job.1', 1, FP]] as const) {
    const r = await jobs.accept(company, id, version, fp)
    assert.equal(r.success === false && r.code, 'BAD_REQUEST')
  }
  assert.equal((await jobs.pause('c1', `${J1}/../x`)).success, false)
  assert.deepEqual(calls, [])
  assert.ok((await jobs.accept('c1', J1, 2, FP)).success)
  assert.deepEqual(calls.map(c => [c.method, c.url, c.body, c.cookie]), [['POST', `https://acb.example/api/companies/c1/me/jobs/${J1}/accept`, JSON.stringify({ version: 2, fingerprint: FP }), 's=1']])
})
