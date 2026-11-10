// 「Google で許可」 in main (electron/features/google/ipc.ts): main opens exactly
// the sign-in page the server named, in the system browser, and the renderer
// never gets that URL (its one-time state would let another page finish the
// member's permission) nor any server text; anything but Google's sign-in page
// (or the practice Google on this machine) is never opened.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createGoogleApi } from '../electron/features/google/ipc'

const STATE = 'co1.' + 'a'.repeat(64)
const GOOGLE_URL = `https://accounts.google.com/o/oauth2/v2/auth?client_id=x&state=${STATE}&code_challenge=abc`

function harness(answer: { status: number; body: unknown } | 'offline') {
  const opened: string[] = []
  const logs: string[] = []
  const requests: Array<{ url: string; method: string; body: unknown; cookie: string | null }> = []
  const api = createGoogleApi({
    baseUrl: () => 'https://acb.test',
    cookies: () => ['session=abc'],
    shell: { openExternal: async (url: string) => { opened.push(url) } },
    log: { warn: (line: string) => logs.push(line) },
    fetch: (async (url: string, init: RequestInit) => {
      if (answer === 'offline') throw new TypeError(`fetch failed ${GOOGLE_URL}`)
      requests.push({ url, method: String(init.method), body: init.body ? JSON.parse(String(init.body)) : undefined, cookie: new Headers(init.headers).get('cookie') })
      return new Response(JSON.stringify(answer.body), { status: answer.status })
    }) as unknown as typeof fetch,
  })
  return { api, opened, logs, requests }
}

test('connect opens the server\'s sign-in page in the browser and answers only { success: true }', async () => {
  const h = harness({ status: 200, body: { success: true, data: { authorizeUrl: GOOGLE_URL, expiresAt: '2026-11-01T00:10:00Z' } } })
  const r = await h.api.connect('co1', ['minutes'])
  assert.deepEqual(r, { success: true })
  assert.deepEqual(h.opened, [GOOGLE_URL])
  assert.deepEqual(h.requests, [{ url: 'https://acb.test/api/companies/co1/me/google/connect', method: 'POST', body: { features: ['minutes'] }, cookie: 'session=abc' }])
  assert.ok(!JSON.stringify(r).includes(STATE))
  assert.ok(!h.logs.join('\n').includes(STATE))
})

test('a URL that is not Google\'s sign-in page is never opened', async () => {
  for (const url of [
    'https://evil.example/o/oauth2/v2/auth?state=x', // Google's path on another host
    'https://accounts.google.com.evil.example/o/oauth2/v2/auth',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'http://accounts.google.com/o/oauth2/v2/auth', // http only on this machine (the practice Google)
    'http://192.168.0.5:4011/o/oauth2/v2/auth',
    'https://accounts.google.com/somewhere-else',
  ]) {
    const h = harness({ status: 200, body: { data: { authorizeUrl: url } } })
    const r = await h.api.connect('co1', ['minutes'])
    assert.equal(r.success, false, url)
    assert.deepEqual(h.opened, [], url)
  }
  const practice = harness({ status: 200, body: { data: { authorizeUrl: `http://127.0.0.1:4011/o/oauth2/v2/auth?state=${STATE}` } } })
  assert.deepEqual(await practice.api.connect('co1', ['minutes']), { success: true })
})

test('a refusal or an offline server answers a sentence built from the status only, never the server\'s text', async () => {
  const quoting = harness({ status: 409, body: { error: `secret ${STATE} 4/fake-code`, code: 'GOOGLE_UNAVAILABLE', reason: 'off' } })
  const r = await quoting.api.connect('co1', ['mail'])
  assert.deepEqual(r, { success: false, offline: false, error: '管理者が Google を止めています。' })
  assert.deepEqual(quoting.opened, [])
  const status = await harness({ status: 500, body: { error: `secret ${STATE}` } }).api.status('co1')
  assert.deepEqual(status, { success: false, offline: false, error: 'うまくいきませんでした（サーバーの応答 500）。' })
  const off = harness('offline')
  const o = await off.api.disconnect('co1')
  assert.equal(o.success, false)
  assert.ok(!JSON.stringify(o).includes(STATE) && !off.logs.join('\n').includes(STATE))
})

test('受信を読む is offered only to a connected member without it, and a feature the member turned off says so', async () => {
  const { googleSectionView } = await import('../shared/google')
  const base = { available: true, reason: null, connected: true, status: 'active' as const, googleEmail: 'sato@div.example', domain: 'div.example', practice: false }
  const without = googleSectionView({ ...base, features: ['minutes', 'mail'], featuresOff: [] })
  // 「許可をし直す」 only when the server names it: an older server leaves `renew` out.
  assert.equal(without.canRenewMinutes, false)
  assert.equal(googleSectionView({ ...base, features: ['minutes'], featuresOff: [], renew: ['minutes'] }).canRenewMinutes, true)
  assert.equal(without.canAddInbox, true)
  assert.deepEqual(without.allowed, ['予定と議事録を読む', 'メールを送る'])
  const off = googleSectionView({ ...base, features: ['minutes', 'inbox'], featuresOff: ['inbox'] })
  assert.equal(off.canAddInbox, false)
  assert.deepEqual(off.allowed, ['予定と議事録を読む', '受信を読む（オフにしています）'])
  assert.equal(googleSectionView({ ...base, connected: false, status: null, features: [], featuresOff: [] }).canAddInbox, false)
  // The company has 受信を読む off (its default): never offered, the server would refuse it.
  const companyOff = googleSectionView({ ...base, features: ['minutes', 'mail'], featuresOff: [], companyFeatures: ['minutes', 'mail'], seen: [] })
  assert.equal(companyOff.canAddInbox, false)
  assert.equal(googleSectionView({ ...base, features: ['minutes'], featuresOff: [], companyFeatures: ['minutes', 'mail', 'inbox'], seen: [] }).canAddInbox, true)
})

test('the card\'s ［Google Drive のファイルをつなぐ］: off with the plain note until the company sets Drive up; the first-use note until allowed', async () => {
  const { driveLinkView, DRIVE_LINK_SETUP_TEXT, DRIVE_FIRST_USE_TEXT } = await import('../shared/google')
  const base = { available: true, reason: null, connected: true, status: 'active' as const, googleEmail: 'sato@div.example', domain: 'div.example', practice: false, featuresOff: [], seen: [] }
  const status = (over: object) => ({ success: true as const, data: { ...base, features: ['minutes', 'drive'], companyFeatures: ['minutes', 'mail', 'drive'], ...over } as never })
  // The Picker not registered (Drive not offered), Google off or not set up: off, and who can fix it.
  assert.deepEqual(driveLinkView(status({ companyFeatures: ['minutes', 'mail'], features: ['minutes'] })), { usable: false, note: DRIVE_LINK_SETUP_TEXT })
  assert.deepEqual(driveLinkView(status({ available: false, reason: 'not-configured', companyFeatures: [], connected: false, features: [] })), { usable: false, note: DRIVE_LINK_SETUP_TEXT })
  // An older server (no companyFeatures) with Google off: still off.
  assert.deepEqual(driveLinkView(status({ available: false, reason: 'off', companyFeatures: undefined })), { usable: false, note: DRIVE_LINK_SETUP_TEXT })
  // Stopped by the operator / server not ready: off, in the app's usual words (not the admin's set-up).
  const { GOOGLE_UNAVAILABLE_TEXT } = await import('../shared/google')
  for (const reason of ['operator-stopped', 'vault-off'] as const) {
    assert.deepEqual(driveLinkView(status({ available: false, reason, companyFeatures: undefined })), { usable: false, note: GOOGLE_UNAVAILABLE_TEXT[reason] })
  }
  // Offered, not allowed yet: usable, and Google's page is announced (only the files they choose).
  assert.deepEqual(driveLinkView(status({ features: ['minutes'] })), { usable: true, note: DRIVE_FIRST_USE_TEXT })
  assert.deepEqual(driveLinkView(status({ connected: false, features: [] })), { usable: true, note: DRIVE_FIRST_USE_TEXT })
  assert.match(DRIVE_FIRST_USE_TEXT, /選んだファイルだけ/)
  assert.deepEqual(driveLinkView(status({})), { usable: true, note: null })
  // Not known (loading, offline, an older server without the list): offered; the press tells.
  assert.deepEqual(driveLinkView(null), { usable: true, note: null })
  assert.deepEqual(driveLinkView({ success: false, offline: true, error: 'x' }), { usable: true, note: null })
  assert.deepEqual(driveLinkView(status({ companyFeatures: undefined })), { usable: true, note: null })
  for (const t of [DRIVE_LINK_SETUP_TEXT, DRIVE_FIRST_USE_TEXT]) assert.doesNotMatch(t, /Picker|OAuth|スコープ|トークン|API/)
})

test('「Google でつなぐ」 (connectAll) asks for { all } and opens only the sign-in page; 「あとで」 is a PUT of /seen', async () => {
  const h = harness({ status: 200, body: { success: true, data: { authorizeUrl: GOOGLE_URL, expiresAt: '2026-11-01T00:10:00Z' } } })
  assert.deepEqual(await h.api.connectAll('co1'), { success: true })
  assert.deepEqual(h.opened, [GOOGLE_URL])
  assert.deepEqual(h.requests.map(r => [r.method, r.url, r.body]), [['POST', 'https://acb.test/api/companies/co1/me/google/connect', { all: true }]])
  const lookalike = harness({ status: 200, body: { data: { authorizeUrl: 'https://accounts.google.com.evil.example/o/oauth2/v2/auth' } } })
  assert.equal((await lookalike.api.connectAll('co1')).success, false)
  assert.deepEqual(lookalike.opened, [])
  const seen = harness({ status: 200, body: { success: true, data: { available: true, features: [], seen: ['minutes'] } } })
  assert.equal((await seen.api.markSeen('co1')).success, true)
  assert.deepEqual(seen.requests.map(r => [r.method, r.url]), [['PUT', 'https://acb.test/api/companies/co1/me/google/seen']])
})

test('「スプレッドシートを中継で使う」: 「やめる」 sends only the member\'s own switch of sheets; a refusal never carries the server\'s text', async () => {
  const ok = harness({ status: 200, body: { success: true, data: { available: true, reason: null, services: [], stopped: null, capPerDay: 500, usedToday: 0, records: [] } } })
  const r = await ok.api.setRelay('co1', false)
  assert.equal(r.success, true)
  assert.deepEqual(ok.requests.map(q => [q.method, q.url, q.body]), [
    ['PUT', 'https://acb.test/api/companies/co1/me/google/features', { feature: 'sheets', on: false }],
    ['GET', 'https://acb.test/api/companies/co1/me/google/relay', undefined],
  ])
  const refused = harness({ status: 409, body: { error: `server text ${STATE}`, code: 'GOOGLE_NOT_CONNECTED' } })
  const no = await refused.api.setRelay('co1', true)
  assert.equal(no.success, false)
  assert.ok(!JSON.stringify(no).includes(STATE))
  assert.equal(refused.requests.length, 1)
  // A view that is not the relay's shape is not handed to the renderer.
  const odd = harness({ status: 200, body: { data: { available: true } } })
  assert.equal((await odd.api.relay('co1')).success, false)
})

test('「済んだメールを Gmail でもアーカイブする」: shown only while the company offers it to a connected member; 「やめる」 sends only that switch', async () => {
  const { googleSectionView } = await import('../shared/google')
  const base = { available: true, reason: null, connected: true, status: 'active' as const, googleEmail: 'sato@div.example', domain: 'div.example', practice: false, featuresOff: [] as const }
  // The company does not offer it (its default), or an older server: no card.
  assert.equal(googleSectionView({ ...base, features: ['minutes', 'inbox'], offeredByName: ['sheets'] }).archive, null)
  assert.equal(googleSectionView({ ...base, features: ['minutes', 'inbox'] }).archive, null)
  assert.equal(googleSectionView({ ...base, connected: false, status: null, features: [], offeredByName: ['inbox_archive'] }).archive, null)
  // Offered: ［許可する］ until allowed; ［やめる］ while on; ［オンにする］ (no consent) when the member turned it off.
  assert.equal(googleSectionView({ ...base, features: ['minutes', 'inbox'], offeredByName: ['inbox_archive'] }).archive, 'allow')
  assert.equal(googleSectionView({ ...base, features: ['inbox', 'inbox_archive'], offeredByName: ['inbox_archive'] }).archive, 'on')
  assert.equal(googleSectionView({ ...base, features: ['inbox', 'inbox_archive'], featuresOff: ['inbox_archive'], offeredByName: ['inbox_archive'] }).archive, 'resume')

  const view = { available: true, reason: null, connected: true, status: 'active', features: ['inbox_archive'], featuresOff: ['inbox_archive'] }
  const ok = harness({ status: 200, body: { success: true, data: view } })
  assert.deepEqual(await ok.api.setArchive('co1', false), { success: true, data: view })
  assert.deepEqual(ok.requests.map(q => [q.method, q.url, q.body]), [['PUT', 'https://acb.test/api/companies/co1/me/google/features', { feature: 'inbox_archive', on: false }]])
  const refused = harness({ status: 409, body: { error: `server text ${STATE}`, code: 'GOOGLE_FEATURE_NOT_GRANTED' } })
  const no = await refused.api.setArchive('co1', true)
  assert.equal(no.success, false)
  assert.ok(!JSON.stringify(no).includes(STATE))
})
