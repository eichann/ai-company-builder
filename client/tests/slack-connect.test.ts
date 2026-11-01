// 「Slack で許可」 in main (electron/features/slack/ipc.ts): main opens exactly
// the sign-in page the server named, in the system browser, and the renderer
// never gets that URL (its one-time state would let another page finish the
// member's permission) nor any server text; anything but Slack's sign-in page
// (or the practice Slack on this machine) is never opened. The 知らせの DM
// switch goes to the member's own `/me/slack/features` only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSlackApi } from '../electron/features/slack/ipc'
import { slackSectionView } from '../shared/slack'

const STATE = 'co1.' + 'a'.repeat(64)
const SLACK_URL = `https://slack.com/oauth/v2/authorize?client_id=1.2&user_scope=im:history&state=${STATE}&team=T0DIV`

function harness(answer: { status: number; body: unknown } | 'offline') {
  const opened: string[] = []
  const logs: string[] = []
  const requests: Array<{ url: string; method: string; body: unknown; cookie: string | null }> = []
  const api = createSlackApi({
    baseUrl: () => 'https://acb.test',
    cookies: () => ['session=abc'],
    shell: { openExternal: async (url: string) => { opened.push(url) } },
    log: { warn: (line: string) => logs.push(line) },
    fetch: (async (url: string, init: RequestInit) => {
      if (answer === 'offline') throw new TypeError(`fetch failed ${SLACK_URL}`)
      requests.push({ url, method: String(init.method), body: init.body ? JSON.parse(String(init.body)) : undefined, cookie: new Headers(init.headers).get('cookie') })
      return new Response(JSON.stringify(answer.body), { status: answer.status })
    }) as unknown as typeof fetch,
  })
  return { api, opened, logs, requests }
}

test('connect opens the server\'s sign-in page in the browser and answers only { success: true }', async () => {
  const h = harness({ status: 200, body: { success: true, data: { authorizeUrl: SLACK_URL, expiresAt: '2026-11-01T00:10:00Z' } } })
  const r = await h.api.connect('co1', ['read', 'notices'])
  assert.deepEqual(r, { success: true })
  assert.deepEqual(h.opened, [SLACK_URL])
  assert.deepEqual(h.requests, [{ url: 'https://acb.test/api/companies/co1/me/slack/connect', method: 'POST', body: { features: ['read', 'notices'] }, cookie: 'session=abc' }])
  assert.ok(!JSON.stringify(r).includes(STATE))
  assert.ok(!h.logs.join('\n').includes(STATE))
})

test('a URL that is not Slack\'s sign-in page is never opened', async () => {
  for (const url of [
    'https://evil.example/oauth/v2/authorize?state=x', // Slack's path on another host
    'https://slack.com.evil.example/oauth/v2/authorize',
    'https://evil.slack.com/oauth/v2/authorize',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'http://slack.com/oauth/v2/authorize', // http only on this machine (the practice Slack)
    'http://192.168.0.5:4012/oauth/v2/authorize',
    'https://slack.com/somewhere-else',
    'https://user:pass@slack.com/oauth/v2/authorize',
  ]) {
    const h = harness({ status: 200, body: { data: { authorizeUrl: url } } })
    const r = await h.api.connect('co1', ['read'])
    assert.equal(r.success, false, url)
    assert.deepEqual(h.opened, [], url)
  }
  const practice = harness({ status: 200, body: { data: { authorizeUrl: `http://127.0.0.1:4012/oauth/v2/authorize?state=${STATE}` } } })
  assert.deepEqual(await practice.api.connect('co1', ['read']), { success: true })
})

test('a refusal or an offline server answers a sentence built from the status and codes only, never the server\'s text', async () => {
  const quoting = harness({ status: 409, body: { error: `secret ${STATE} xoxp-fake-1`, code: 'SLACK_UNAVAILABLE', reason: 'off' } })
  const r = await quoting.api.connect('co1', ['read'])
  assert.deepEqual(r, { success: false, offline: false, error: '管理者が Slack を止めています。' })
  assert.deepEqual(quoting.opened, [])
  const status = await harness({ status: 500, body: { error: `secret ${STATE}` } }).api.status('co1')
  assert.deepEqual(status, { success: false, offline: false, error: 'うまくいきませんでした（サーバーの応答 500）。' })
  const off = harness('offline')
  const o = await off.api.disconnect('co1')
  assert.equal(o.success, false)
  assert.ok(!JSON.stringify(o).includes(STATE) && !off.logs.join('\n').includes(STATE))
})

test('the 知らせの DM switch sends { feature, on } to the member\'s own permission and shows the answer', async () => {
  const my = { available: true, reason: null, connected: true, status: 'active', features: ['read', 'notices'], featuresOff: ['notices'], practice: false }
  const h = harness({ status: 200, body: { success: true, data: my } })
  const r = await h.api.setFeature('co1', 'notices', false)
  assert.deepEqual(h.requests, [{ url: 'https://acb.test/api/companies/co1/me/slack/features', method: 'PUT', body: { feature: 'notices', on: false }, cookie: 'session=abc' }])
  assert.ok(r.success)
  const view = slackSectionView(r.data)
  assert.deepEqual(view.notices, { on: false })
  assert.deepEqual(view.allowed, ['自分あての DM とメンションを受け取る', '大事な知らせ（あなたの番）を DM で受け取る（オフにしています）'])
  assert.equal(view.canAddReply, true)
})

test('a member not yet connected is offered 「Slack で許可」 with DMs and notices; nothing while Slack is off', () => {
  const base = { reason: null, connected: false, status: null, features: [], featuresOff: [], practice: false } as const
  assert.deepEqual(slackSectionView({ ...base, available: true }).connectFeatures, ['read', 'notices'])
  const off = slackSectionView({ ...base, available: false, reason: 'off' })
  assert.equal(off.connectFeatures, null)
  assert.equal(off.notice, '管理者が Slack を止めています。')
})
