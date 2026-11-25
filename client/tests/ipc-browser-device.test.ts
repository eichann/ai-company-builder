// This PC's registration through the real main.ts (agent-browser.md "This PC's registration", the app's half): the PC's
// key reaches the server only in its header and only on the PC routes; every other request main makes — the policy,
// the session, the sites — goes without it (`routes/broker-relay.ts` on the server forwards headers to outside services,
// so a key on every request would leave the company); the renderer, the logs and the disk never see it in the clear;
// only the main window may ask; without a keychain nothing is registered.
import { test, after, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { SERVER_URL, loadMain, type MainHarness } from './ipc-harness/main-harness.ts'
import { BrowserWindow } from './ipc-harness/fake-electron.ts'
import { BROWSER_DEVICE_HEADER, parseBrowserDeviceKey } from '../../shared/core/browser-device.ts'
import { BROWSER_PC_WORDS, type BrowserPcResult } from '../shared/browser-device.ts'
import { browserDeviceKeyFile } from '../electron/features/browser/device.ts'

const CO = 'co-pc'
let h: MainHarness
let state: 'none' | 'pending' | 'enabled' | 'revoked' = 'none'

before(async () => {
  h = await loadMain()
  await h.startApp()
  h.server.on('POST', '/api/auth/sign-in/email', { json: { user: { id: 'u1' } }, headers: { 'Set-Cookie': 'better-auth.session_token=t.s; Path=/' } })
  h.server.on('GET', '/api/me', { json: { success: true, data: { id: 'u1', email: 'me@example.com', name: 'me' } } })
  h.server.on('GET', `/api/companies/${CO}/browser-lines-mine`, { json: { success: true, data: { lines: [] } } })
  h.server.on('GET', `/api/companies/${CO}/browser-devices-me`, () => ({ json: { success: true, data: state === 'none' ? { state } : { id: 'bd_x', label: 'pc', state } } }))
  h.server.on('POST', `/api/companies/${CO}/browser-devices`, () => { state = 'pending'; return { status: 201, json: { success: true, data: { id: 'bd_x', label: 'pc', state } } } })
  h.server.on('DELETE', `/api/companies/${CO}/browser-devices-me`, () => { state = 'revoked'; return { json: { success: true, data: { id: 'bd_x', label: 'pc', state } } } })
  await h.invoke('auth:signIn', 'me@example.com', 'right')
  await h.invoke('auth:getSession')
})
after(() => h.shutdown())

/** An invoke from the main window's main frame (the harness's plain invoke carries no frame). */
function fromMain<T>(channel: string, ...args: unknown[]): Promise<T> {
  const handler = h.fake.handlers.get(channel)!
  const sender = h.renderer()
  return handler({ sender: Object.assign(sender, { mainFrame: { frameTreeNodeId: 1 } }), senderFrame: { frameTreeNodeId: 1 } } as never, ...args) as Promise<T>
}

test('registering through the app: the key only in the PC routes\' header, never in an answer, a log, an address, a body or on disk in the clear; no other request carries it', async () => {
  const answers: BrowserPcResult[] = []
  answers.push(await fromMain('browserDevice:get', CO))
  assert.equal(answers[0].ok && answers[0].view.state, 'none')
  answers.push(await fromMain('browserDevice:register', CO, '営業の Mac'))
  assert.equal(answers[1].ok && answers[1].view.state, 'pending')
  state = 'enabled'
  answers.push(await fromMain('browserDevice:get', CO))
  answers.push(await fromMain('browserDevice:withdraw', CO))

  const post = h.server.to(`/api/companies/${CO}/browser-devices`).find(r => r.method === 'POST')!
  const key = post.headers.get(BROWSER_DEVICE_HEADER)!
  assert.ok(parseBrowserDeviceKey(key))
  const secret = key.slice(3)
  for (const a of answers) assert.ok(!JSON.stringify(a).includes(secret) && !JSON.stringify(a).includes('bd_x'), 'the renderer never gets the key or the id')
  assert.ok(!h.logs.join('\n').includes(secret), 'never logged')
  const sealed = fs.readFileSync(browserDeviceKeyFile(h.userData, SERVER_URL))
  assert.ok(!sealed.toString().includes(secret), 'kept only through the keychain')

  // Other requests main makes meanwhile (the session, a company's policy and sites) — none carries the key.
  await h.invoke('auth:getSession')
  await fromMain('browser:sites', CO).catch(() => undefined)
  assert.ok(h.server.requests.length > 4)
  for (const r of h.server.requests) {
    assert.equal(r.headers.has(BROWSER_DEVICE_HEADER), /\/browser-devices(-me)?$/.test(r.path.split('?')[0]), `${r.method} ${r.path}`)
    assert.ok(!r.path.includes(secret) && !(r.body ?? '').includes(secret))
  }
})

test('only the main window\'s page may ask: another window gets a plain refusal and nothing is sent', async () => {
  const before = h.server.requests.length
  const other = new BrowserWindow({}).webContents
  assert.deepEqual(await h.invokeAs(other, 'browserDevice:register', CO, 'pc'), { ok: false, message: BROWSER_PC_WORDS.notMainWindow })
  assert.deepEqual(await h.invokeAs(other, 'browserDevice:get', CO), { ok: false, message: BROWSER_PC_WORDS.notMainWindow })
  assert.equal(h.server.requests.length, before)
})

test('without a keychain the screen says this PC cannot be used and registering is refused, nothing sent', async () => {
  h.fake.encryptionAvailable = false
  try {
    const before = h.server.requests.filter(r => r.path.includes('browser-devices')).length
    const got = await fromMain<BrowserPcResult>('browserDevice:get', CO)
    assert.equal(got.ok && got.view.state, 'unavailable')
    assert.deepEqual(await fromMain('browserDevice:register', CO, 'pc'), { ok: false, message: BROWSER_PC_WORDS.unavailable })
    assert.equal(h.server.requests.filter(r => r.path.includes('browser-devices')).length, before)
  } finally { h.fake.encryptionAvailable = true }
})
