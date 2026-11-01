// absences:* (electron/features/absences/ipc.ts): ids from the renderer go into the server
// URL, so one that could change the path is refused before any request.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAbsencesApi } from '../electron/features/absences/ipc'

function api() {
  const calls: Array<{ url: string; method: string; body?: string }> = []
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, method: init.method ?? 'GET', body: init.body as string | undefined })
    return new Response(JSON.stringify({ data: { removed: true } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof globalThis.fetch
  return { calls, absences: createAbsencesApi({ baseUrl: () => 'https://acb.example', cookies: () => ['s=1'], fetch, log: { warn() {} } }) }
}

test('a company or absence id that could change the server path never reaches the server', async () => {
  const { calls, absences } = api()
  for (const [companyId, absenceId] of [['../admin', 'a1'], ['c1', '../../members'], ['c1', 'a%2F..'], ['c1', 'a.b'], ['', 'a1'], ['c1', 7]]) {
    const r = await absences.remove(companyId, absenceId)
    assert.equal(r.success, false)
    assert.equal(r.success === false && r.code, 'BAD_REQUEST')
  }
  assert.equal((await absences.get('c/1')).success, false)
  assert.deepEqual(calls, [])
  assert.equal((await absences.remove('c1', 'absence-1')).success, true)
  assert.deepEqual(calls.map(c => [c.method, c.url]), [['DELETE', 'https://acb.example/api/companies/c1/absences/absence-1']])
})
