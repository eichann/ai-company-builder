/**
 * 「ブラウザ操作」 の記録 in the app (client/shared/browser-recorder.ts over shared/core/browser-recording.ts; agent-browser.md
 * "Recording"): what the window observes while a person records, turned into the kept form at once. The site is fictional
 * (`shop.example.test`). Guards: no password, Cookie, Authorization, CSRF / token / session field, value, link text, page
 * text or answer value reaches the recording (the whole JSON is searched); the same value is the same symbol inside one
 * recording and two recordings' symbols are unrelated (a fresh keyed hash per recording); the recording passes the
 * server's check as it is; the window's DevTools connection has one holder at a time.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createBrowserRecorder, createPageDebuggerOwner, type BrowserRecordingObservation } from '../shared/browser-recorder'
import { browserRecordingProblem, browserRecordingWithout, type BrowserRecordedSend } from '../../shared/core/browser-recording'
import { newRecordingDigest } from '../electron/features/browser/recording'

const DOMAIN = 'shop.example.test'
const SECRETS = {
  password: 'Hunter2-correct-horse',
  cookie: 'sid=session-cookie-value-123',
  authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature',
  csrf: 'csrf-token-value-QWERTY12345',
  session: 'sess-abcdef0123456789',
  customer: '山田花子',
  email: 'hanako@example.com',
  phone: '090-1234-5678',
  endDate: '2026-12-03',
  linkText: '山田花子さんの注文',
  answerValue: 'order-secret-name',
  query: 'searched-customer-name',
}

/** One person's run: login, open an order list, change a date, save; with every secret a page could show or send. */
function run(): BrowserRecordingObservation[] {
  const action = (o: unknown): BrowserRecordingObservation => ({ kind: 'action', payload: JSON.stringify(o) })
  return [
    { kind: 'page', url: `https://${DOMAIN}/login?next=/orders&email=${encodeURIComponent(SECRETS.email)}` },
    action({ type: 'change', inputType: 'email', label: 'メールアドレス', name: 'email', value: SECRETS.email }),
    // A password field: the page's script never sends its value; a value sent anyway is not kept.
    action({ type: 'change', inputType: 'password', label: 'パスワード', name: 'login_pw', value: SECRETS.password }),
    action({ type: 'click', role: 'button', label: 'ログイン' }),
    {
      kind: 'request', id: 'r1', method: 'POST', url: `https://${DOMAIN}/session`, resourceType: 'Document',
      contentType: 'application/x-www-form-urlencoded', hasBody: true,
      body: `email=${encodeURIComponent(SECRETS.email)}&login_pw=${SECRETS.password}&_token=${SECRETS.csrf}&remember=1`,
    },
    { kind: 'response', id: 'r1', status: 302 },
    { kind: 'page', url: `https://${DOMAIN}/orders/48213?tab=detail&q=${SECRETS.query}#top` },
    {
      kind: 'request', id: 'r2', method: 'GET', url: `https://${DOMAIN}/api/orders/48213?include=items`, resourceType: 'XHR', hasBody: false,
    },
    { kind: 'response', id: 'r2', status: 200 },
    {
      kind: 'response', id: 'r2', status: 0, json: JSON.stringify({
        id: 48213, name: SECRETS.answerValue, customer: { name: SECRETS.customer, phone: SECRETS.phone },
        'hanako@example.com': true, '7731': { note: 'x' }, items: [{ id: 'X1', qty: 2 }], access_token: SECRETS.session,
        end_date: SECRETS.endDate,
      }),
    },
    // A link: its text names a person; only the address pattern is kept.
    action({ type: 'click', role: 'link', href: `https://${DOMAIN}/customers/90211`, label: SECRETS.linkText }),
    action({ type: 'change', inputType: 'date', label: '受付終了日', name: 'end_date', value: SECRETS.endDate }),
    action({ type: 'change', inputType: 'text', label: `担当メモ（${SECRETS.phone}）`, name: 'memo', value: SECRETS.customer }),
    action({ type: 'click', role: 'button', label: '保存' }),
    {
      kind: 'request', id: 'r3', method: 'POST', url: `https://${DOMAIN}/api/orders/48213`, resourceType: 'Fetch',
      contentType: 'application/json', hasBody: true,
      body: JSON.stringify({ _method: 'PATCH', end_date: SECRETS.endDate, memo: SECRETS.customer, csrf_token: SECRETS.csrf, session_id: SECRETS.session }),
    },
    { kind: 'response', id: 'r3', status: 200 },
    // A part from another host, and one the window refused.
    { kind: 'request', id: 'r4', method: 'GET', url: 'https://cdn.example-assets.test/app.js', resourceType: 'Script', hasBody: false },
    { kind: 'response', id: 'r4', status: 200 },
    { kind: 'request', id: 'r5', method: 'GET', url: 'https://tracker.example-ads.test/p?u=' + SECRETS.email, resourceType: 'Image', hasBody: false },
    // A page script calling the action channel with junk: dropped.
    { kind: 'action', payload: '{not json' },
    { kind: 'action', payload: JSON.stringify({ type: 'other', value: SECRETS.password }) },
  ] as BrowserRecordingObservation[]
}

function record(digest = newRecordingDigest()) {
  // A second between observations, and five more before each page: the person reads a page before acting on it.
  let t = 1_000
  const recorder = createBrowserRecorder({ domain: DOMAIN, digest, now: () => t })
  for (const o of run()) {
    t += o.kind === 'page' ? 6_000 : 1_000
    recorder.observe(o)
  }
  return recorder.content()
}

test('no password, Cookie, Authorization, CSRF / token / session, value, link text, page text or answer value is kept', () => {
  const content = record()
  const json = JSON.stringify(content)
  for (const [what, secret] of Object.entries(SECRETS)) assert.equal(json.includes(secret), false, `${what} must not be kept`)
  // Nor any fragment that would identify them.
  for (const piece of ['Hunter2', 'eyJhbGci', 'QWERTY', 'hanako', '山田', '1234', '48213', '90211', '7731', 'csrf_token', 'session_id', 'access_token', '_token', 'login_pw', 'searched']) {
    assert.equal(json.includes(piece), false, piece)
  }
  assert.equal(browserRecordingProblem(content, DOMAIN), null, 'the recording passes the server\'s check as it is')
})

test('what is kept: address patterns, button and field labels, field names, symbols, status, key shape, other hosts', () => {
  const { steps, hosts } = record()
  const lines = steps.map(s => {
    if (s.kind === 'page') return `page ${s.address}`
    if (s.kind === 'click') return `click ${s.target} ${s.label ?? ''} ${s.address ?? ''}`.trim()
    if (s.kind === 'input') return `input ${s.label} ${s.name} ${s.value}${s.from ? ` from ${s.from.step}:${s.from.key}` : ''}`
    return `send ${s.method}${s.override ? `(${s.override})` : ''} ${s.address} [${(s.fields ?? []).map(f => `${f.name}=${f.value}`).join(',')}] ${s.status} ${s.answerKeys?.join(',') ?? '-'} after=${s.after}`
  })
  assert.deepEqual(lines, [
    'page /login?next&email',
    'input メールアドレス email 値1',
    'input パスワード {x} secret',
    'click button ログイン',
    'send POST /session [email=値1,remember=値2] 302 - after=4',
    'page /orders/{n}?tab&q',
    'send GET /api/orders/{n}?include [] 200 {n},{n}.note,id,name,customer,customer.name,customer.phone,{mail},items,items[].id,items[].qty,end_date after=null',
    'click link  /customers/{n}',
    'input 受付終了日 end_date 値3 from 7:end_date',
    'input 担当メモ({n}-{n}-{n}) memo 値4 from 7:customer.name',
    'click button 保存',
    'send POST(PATCH) /api/orders/{n} [end_date=値3,memo=値4] 200 - after=11',
  ])
  assert.deepEqual(hosts, [{ host: 'cdn.example-assets.test', loaded: true }, { host: 'tracker.example-ads.test', loaded: false }])
})

test('the same value is the same symbol inside one recording; two recordings\' symbols are unrelated', () => {
  const content = record()
  const save = content.steps.find((s): s is BrowserRecordedSend => s.kind === 'send' && s.override === 'PATCH')!
  const date = content.steps.find(s => s.kind === 'input' && s.name === 'end_date')
  assert.equal(date?.kind === 'input' && date.value, save.fields?.find(f => f.name === 'end_date')?.value)
  // A fresh keyed hash per recording: the same value never hashes alike in two recordings.
  const a = newRecordingDigest()
  const b = newRecordingDigest()
  assert.notEqual(a(SECRETS.endDate), b(SECRETS.endDate))
  assert.equal(a(SECRETS.endDate), a(SECRETS.endDate))
  // Symbols follow only the order inside their own recording.
  const one = createBrowserRecorder({ domain: DOMAIN, digest: a, now: () => 0 })
  const two = createBrowserRecorder({ domain: DOMAIN, digest: b, now: () => 0 })
  const typed = (r: typeof one, value: string) => r.observe({ kind: 'action', payload: JSON.stringify({ type: 'change', inputType: 'text', label: 'x', name: 'x', value }) })
  typed(one, 'first'); typed(one, 'second'); typed(one, 'first')
  typed(two, 'second'); typed(two, 'first')
  assert.deepEqual(one.content().steps.map(s => s.kind === 'input' && s.value), ['値1', '値2', '値1'])
  assert.deepEqual(two.content().steps.map(s => s.kind === 'input' && s.value), ['値1', '値2'])
})

test('a body the recorder cannot read keeps no field; an upload says so; a GET read twice is one line counted', () => {
  const r = createBrowserRecorder({ domain: DOMAIN, digest: newRecordingDigest(), now: () => 0 })
  r.observe({ kind: 'request', id: 'a', method: 'POST', url: `https://${DOMAIN}/upload`, resourceType: 'XHR', hasBody: true })
  r.observe({ kind: 'request', id: 'b', method: 'POST', url: `https://${DOMAIN}/raw`, resourceType: 'XHR', contentType: 'text/plain', body: SECRETS.password, hasBody: true })
  r.observe({ kind: 'request', id: 'c', method: 'GET', url: `https://${DOMAIN}/api/list?page=1`, resourceType: 'Fetch', hasBody: false })
  r.observe({ kind: 'request', id: 'd', method: 'GET', url: `https://${DOMAIN}/api/list?page=2`, resourceType: 'Fetch', hasBody: false })
  r.observe({
    kind: 'request', id: 'e', method: 'POST', url: `https://${DOMAIN}/files`, resourceType: 'XHR', hasBody: true,
    contentType: 'multipart/form-data; boundary=XyZ',
    body: `--XyZ\r\nContent-Disposition: form-data; name="title"\r\n\r\n${SECRETS.customer}\r\n--XyZ\r\nContent-Disposition: form-data; name="file"; filename="${SECRETS.customer}.pdf"\r\n\r\nPDFDATA\r\n--XyZ\r\nContent-Disposition: form-data; name="authenticity_token"\r\n\r\n${SECRETS.csrf}\r\n--XyZ--\r\n`,
  })
  // A token field whose name masks to {x} (judged on its raw name, before masking), in a form and in a multipart body.
  r.observe({ kind: 'request', id: 'f', method: 'POST', url: `https://${DOMAIN}/form`, resourceType: 'Document', contentType: 'application/x-www-form-urlencoded', body: 'csrf9f8e7d6c5b4a3210=x&qty=2', hasBody: true })
  r.observe({
    kind: 'request', id: 'g', method: 'POST', url: `https://${DOMAIN}/multi`, resourceType: 'XHR', hasBody: true, contentType: 'multipart/form-data; boundary=B',
    body: '--B\r\nContent-Disposition: form-data; name="session9f8e7d6c5b4a3210"\r\n\r\nv\r\n--B--\r\n',
  })
  const content = r.content()
  const sends = content.steps.filter((s): s is BrowserRecordedSend => s.kind === 'send')
  assert.deepEqual(sends.map(s => [s.address, s.fields?.map(f => `${f.name}=${f.value}`) ?? null, s.count]), [
    ['/upload', null, 1], ['/raw', null, 1], ['/api/list?page', [], 2], ['/files', ['title=値1', 'file=file'], 1],
    ['/form', ['qty=値2'], 1], ['/multi', [], 1],
  ])
  const json = JSON.stringify(content)
  for (const secret of [SECRETS.password, SECRETS.customer, SECRETS.csrf, 'PDFDATA', 'authenticity']) assert.equal(json.includes(secret), false, secret)
  assert.equal(browserRecordingProblem(content, DOMAIN), null)
})

test('deleting lines clears what pointed at them, and the result still passes the server\'s check', () => {
  const content = record()
  const clicks = content.steps.filter(s => s.kind === 'click' && s.target === 'button').map(s => s.id)
  const answer = content.steps.find(s => s.kind === 'send' && s.method === 'GET')!.id
  const left = browserRecordingWithout(content, [...clicks, answer])
  assert.equal(left.steps.some(s => [...clicks, answer].includes(s.id)), false)
  for (const s of left.steps) {
    if (s.kind === 'send') { assert.equal(s.after, null); for (const f of s.fields ?? []) assert.equal(f.from, null) }
    if (s.kind === 'input') assert.equal(s.from, null)
  }
  assert.equal(browserRecordingProblem(left, DOMAIN), null)
})

test('the window\'s DevTools connection: the AI\'s gate and a recording never hold it together', () => {
  const owner = createPageDebuggerOwner()
  assert.equal(owner.claim('recording'), true)
  assert.equal(owner.claim('ai'), false, 'the AI cannot take the window while it records')
  owner.release('ai')
  assert.equal(owner.holder(), 'recording', 'the AI letting go does not end a recording')
  owner.release('recording')
  assert.equal(owner.claim('ai'), true)
  assert.equal(owner.claim('recording'), false, 'no recording while the AI operates')
  assert.equal(owner.claim('ai'), true, 'the holder may ask again')
})
