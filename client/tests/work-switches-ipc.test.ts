// workSwitches:* (electron/features/work-switches/ipc.ts): the company id from the renderer goes
// into the server URL, so one that could change the path — or a switch / value the server does
// not know — is refused before any request; a company refusal reaches the screen as its code.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createWorkSwitchesApi } from '../electron/features/work-switches/ipc'

function api(answer: { status: number; body: unknown } = { status: 200, body: { data: { autoRun: { on: false } } } }) {
  const calls: Array<{ url: string; method: string; body?: string }> = []
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, method: init.method ?? 'GET', body: init.body as string | undefined })
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'Content-Type': 'application/json' } })
  }) as typeof globalThis.fetch
  return { calls, switches: createWorkSwitchesApi({ baseUrl: () => 'https://acb.example', cookies: () => ['s=1'], fetch, log: { warn() {} } }) }
}

test('a company id that could change the server path, or an unknown switch or value, never reaches the server', async () => {
  const { calls, switches } = api()
  for (const [companyId, which, on] of [['../admin', 'autoRun', true], ['c%2F..', 'autoRun', true], ['c1', 'everything', true], ['c1', 'autoRun', 'yes'], ['c1', '__proto__', false]]) {
    const r = await switches.set(companyId, which, on)
    assert.equal(r.success === false && r.code, 'BAD_REQUEST')
  }
  assert.equal((await switches.get('c/1')).success, false)
  assert.deepEqual(calls, [])
  assert.equal((await switches.set('c1', 'readIncoming', false)).success, true)
  assert.deepEqual(calls.map(c => [c.method, c.url, c.body]), [['PUT', 'https://acb.example/api/companies/c1/me/work-switches', '{"switch":"readIncoming","on":false}']])
})

test('the company not allowing a switch comes back as its code and sentence, not as offline', async () => {
  const { switches } = api({ status: 409, body: { error: '会社の設定で止まっています。管理者に確かめてください。', code: 'WORK_SWITCH_COMPANY_OFF' } })
  assert.deepEqual(await switches.set('c1', 'autoRun', true), {
    success: false, offline: false, code: 'WORK_SWITCH_COMPANY_OFF', error: '会社の設定で止まっています。管理者に確かめてください。',
  })
})
