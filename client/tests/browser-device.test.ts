/**
 * This PC's registration, the app's half (agent-browser.md "This PC's registration"; design memo 「ブラウザ操作を担当者の PC で
 * 使う」 v2 §3-2, §8-2): the PC's key is made once, kept only encrypted by the OS keychain and sent only in
 * `X-ACB-Browser-Device` — by the PC routes and by the plan clients on the steps the server's gate asks, never on any
 * other request; the screen gets a state, a name and the combinations, never the key; without a keychain nothing is
 * registered; the switch is on for an enabled PC, and the hand-placed opt-in still turns the owner's PC on (transition).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BROWSER_DEVICE_HEADER, BROWSER_DEVICE_WORDS, parseBrowserDeviceKey } from '../../shared/core/browser-device'
import { BROWSER_PC_WORDS } from '../shared/browser-device'
import { browserDeviceKeyFile, createBrowserDevice, createBrowserDeviceKey, newBrowserDeviceKey } from '../electron/features/browser/device'
import { createRegisteredPcSwitch } from '../electron/features/browser/ai-switch'
import { createBrowserPlansHttp } from '../electron/features/browser/plans-api'
import { createBrowserLinesHttp } from '../electron/features/browser/lines-api'
import type { SecretBox } from '../electron/services/api-key-store'

const SERVER = 'https://acb.example'
const CO = 'co-1'

/** A keychain stand-in: sealed bytes never hold the text as written. */
function box(over: Partial<SecretBox> = {}): SecretBox & { sealed: number } {
  const b = {
    sealed: 0,
    available: () => true,
    encrypt(text: string) { b.sealed++; return Buffer.from(`sealed:${Buffer.from(text).reverse().toString('hex')}`) },
    decrypt(data: Buffer) {
      const s = data.toString()
      if (!s.startsWith('sealed:')) throw new Error('cannot decrypt')
      return Buffer.from(s.slice(7), 'hex').reverse().toString()
    },
    ...over,
  }
  return b
}

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acb-pc-key-'))
  return { dir, file: browserDeviceKeyFile(dir, SERVER) }
}

type Seen = { method: string; path: string; headers: Headers; body: string | null }

/** The server as the device client and the plan clients reach it; records every request. */
function fakeServer(answer: (req: Seen) => { status?: number; json: unknown } = () => ({ json: { success: true, data: {} } })) {
  const seen: Seen[] = []
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const req: Seen = { method: init?.method ?? 'GET', path: url.pathname, headers: new Headers(init?.headers), body: init?.body == null ? null : String(init.body) }
    seen.push(req)
    const a = answer(req)
    return new Response(JSON.stringify(a.json), { status: a.status ?? 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  return { seen, fetch: fetchFn }
}

test('the key: exactly the server\'s one spelling, every time', () => {
  for (let i = 0; i < 500; i++) assert.ok(parseBrowserDeviceKey(newBrowserDeviceKey()), 'a key the server would refuse as malformed')
  // The last character's two unused bits are zero by construction (all 0xff → "…_w", not "…__").
  assert.ok(parseBrowserDeviceKey(newBrowserDeviceKey(n => Buffer.alloc(n, 0xff))))
})

test('the key is made once and kept only encrypted: no plain key on disk, read back after a restart, a link never followed', () => {
  const { dir, file } = tempFile()
  try {
    const b = box()
    const k = createBrowserDeviceKey({ box: b, dir: () => dir, server: () => SERVER })
    assert.equal(k.header(), null, 'no key until the member registers')
    assert.equal(fs.existsSync(file), false)
    const key = k.ensure()!
    assert.ok(parseBrowserDeviceKey(key))
    assert.equal(k.ensure(), key, 'made once')
    const onDisk = fs.readFileSync(file)
    assert.ok(!onDisk.toString().includes(key.slice(3)), 'the key is never written in the clear')
    assert.equal(fs.statSync(file).mode & 0o077, 0, 'only the member can read the sealed file')
    assert.equal(b.sealed, 1)
    // A restart: the same key back from the keychain.
    assert.equal(createBrowserDeviceKey({ box: box(), dir: () => dir, server: () => SERVER }).header(), key)
    // A link in the key's place (pointing at a sealed key elsewhere) is not followed.
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'acb-pc-key-link-'))
    try {
      fs.renameSync(file, path.join(elsewhere, 'sealed'))
      fs.symlinkSync(path.join(elsewhere, 'sealed'), file)
      assert.equal(createBrowserDeviceKey({ box: box(), dir: () => dir, server: () => SERVER }).header(), null)
    } finally { fs.rmSync(elsewhere, { recursive: true, force: true }) }
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('one key per server: another server the app is pointed at never gets this one, and a file sealed for another server is not a key', () => {
  const { dir, file } = tempFile()
  try {
    let server = SERVER
    const k = createBrowserDeviceKey({ box: box(), dir: () => dir, server: () => server })
    const a = k.ensure()!
    server = 'https://other.example'
    assert.equal(k.header(), null, 'nothing to send to another server')
    const b = k.ensure()!
    assert.notEqual(a, b)
    server = `${SERVER}/api/`
    assert.equal(k.header(), a, 'the same origin written with a path is the same server')
    // The first server's sealed file copied into the second's place reads as no key there.
    fs.copyFileSync(file, browserDeviceKeyFile(dir, 'https://third.example'))
    server = 'https://third.example'
    assert.equal(createBrowserDeviceKey({ box: box(), dir: () => dir, server: () => server }).header(), null)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('a key the keychain will not open (denied, reset) is never overwritten: registering again keeps it aside and makes a new one', () => {
  const { dir, file } = tempFile()
  try {
    const first = createBrowserDeviceKey({ box: box(), dir: () => dir, server: () => SERVER }).ensure()!
    const sealed = fs.readFileSync(file)
    const denied = createBrowserDeviceKey({ box: box({ decrypt: () => { throw new Error('denied') } }), dir: () => dir, server: () => SERVER })
    assert.equal(denied.header(), null)
    const fresh = denied.ensure()!
    assert.notEqual(fresh, first)
    const aside = fs.readdirSync(dir).filter(n => n.includes('.unreadable-'))
    assert.equal(aside.length, 1)
    assert.deepEqual(fs.readFileSync(path.join(dir, aside[0])), sealed, 'the old sealed key is kept, byte for byte')
    assert.equal(fs.readdirSync(dir).filter(n => n.endsWith('.tmp')).length, 0)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('without a keychain nothing is made or sent: the screen says this PC cannot be used, registering is refused in plain words', async () => {
  const { dir, file } = tempFile()
  try {
    const server = fakeServer()
    const key = createBrowserDeviceKey({ box: box({ available: () => false }), dir: () => dir, server: () => SERVER })
    const device = createBrowserDevice({ key, baseUrl: () => SERVER, cookies: () => ['s=1'], userId: () => 'u1', computerName: () => 'pc', fetch: server.fetch })
    assert.equal((await device.view(CO)).state, 'unavailable')
    assert.deepEqual(await device.register(CO, 'my PC'), { ok: false, message: BROWSER_PC_WORDS.unavailable })
    assert.equal(fs.existsSync(file), false)
    assert.equal(server.seen.filter(r => r.path.includes('browser-devices')).length, 0, 'no PC route asked')
    assert.equal(key.ensure(), null)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('registering sends the key in its header only, the name in the body; the screen\'s answers never hold the key', async () => {
  const { dir } = tempFile()
  try {
    let state: 'none' | 'pending' | 'enabled' | 'revoked' = 'none'
    const server = fakeServer(req => {
      if (req.path.endsWith('/browser-lines-mine')) return { json: { success: true, data: { lines: [{ site: 'lstep', line: 'landing_inspect', label: '流入経路を点検する', writes: false, meaningHash: 'x' }] } } }
      if (req.method === 'POST' && req.path.endsWith('/browser-devices')) { state = 'pending'; return { status: 201, json: { success: true, data: { id: 'bd_1', label: 'my PC', state } } } }
      if (req.method === 'DELETE') { state = 'revoked'; return { json: { success: true, data: { id: 'bd_1', label: 'my PC', state } } } }
      return { json: { success: true, data: state === 'none' ? { state } : { id: 'bd_1', label: 'my PC', state, userId: 'u1' } } }
    })
    const key = createBrowserDeviceKey({ box: box(), dir: () => dir, server: () => SERVER })
    let user: string | null = 'u1'
    const device = createBrowserDevice({ key, baseUrl: () => SERVER, cookies: () => ['s=1'], userId: () => user, computerName: () => 'Taros-MacBook.local', fetch: server.fetch })
    const first = await device.view(CO)
    assert.deepEqual(first, { state: 'none', label: null, suggestedLabel: 'Taros-MacBook', lines: [{ label: '流入経路を点検する', writes: false }] })
    assert.equal(server.seen.filter(r => r.path.endsWith('/browser-devices-me')).length, 0, 'no key yet: nothing to ask about')
    assert.deepEqual(await device.register(CO, '  '), { ok: false, message: BROWSER_DEVICE_WORDS.badLabel })

    const answers: unknown[] = []
    const reg = await device.register(CO, 'my PC')
    answers.push(reg)
    assert.equal(reg.ok && reg.view.state, 'pending')
    const sent = server.seen.find(r => r.method === 'POST' && r.path === `/api/companies/${CO}/browser-devices`)!
    const k = key.header()!
    assert.equal(sent.headers.get(BROWSER_DEVICE_HEADER), k)
    assert.deepEqual(JSON.parse(sent.body!), { label: 'my PC' }, 'the body holds the name only')
    assert.equal(device.enabledHere(), false, 'pending is not on')

    state = 'enabled'
    answers.push(await device.view(CO))
    assert.equal(device.enabledHere(), true)
    user = 'someone_else'
    assert.equal(device.enabledHere(), false, 'another member signed in on this PC')
    user = 'u1'
    answers.push(await device.withdraw(CO))
    assert.equal(device.enabledHere(), false, 'stopped: off at once')
    for (const a of answers) {
      const text = JSON.stringify(a)
      assert.ok(!text.includes(k.slice(3)) && !text.includes('bd_1'), 'the screen never gets the key or the registration id')
    }
    // The key goes only to the PC routes; the usable list is asked without it.
    for (const r of server.seen) {
      const has = r.headers.has(BROWSER_DEVICE_HEADER)
      assert.equal(has, /\/browser-devices(-me)?$/.test(r.path), `${r.method} ${r.path}`)
      assert.ok(!r.path.includes(k.slice(3)) && !(r.body ?? '').includes(k.slice(3)), 'never in an address or a body')
    }
    state = 'enabled'
    device.clear()
    assert.equal(device.enabledHere(), false, 'signed out: nothing remembered')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('a refused registration says the server\'s plain sentence; no answer says so without guessing a state', async () => {
  const { dir } = tempFile()
  try {
    const server = fakeServer(req => req.method === 'POST' && req.path.endsWith('/browser-devices')
      ? { status: 409, json: { success: false, code: 'BROWSER_DEVICE_LIMIT', error: BROWSER_DEVICE_WORDS.tooMany } }
      : { status: 500, json: {} })
    const device = createBrowserDevice({ key: createBrowserDeviceKey({ box: box(), dir: () => dir, server: () => SERVER }), baseUrl: () => SERVER, cookies: () => ['s=1'], userId: () => 'u1', computerName: () => 'pc', fetch: server.fetch })
    assert.deepEqual(await device.register(CO, 'pc'), { ok: false, message: BROWSER_DEVICE_WORDS.tooMany })
    assert.equal((await device.view(CO)).state, 'unknown')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('the refresh asks at most once a minute per company, and only once this PC has a key', async () => {
  const { dir } = tempFile()
  try {
    const server = fakeServer(() => ({ json: { success: true, data: { id: 'bd_1', label: 'pc', state: 'enabled' } } }))
    let now = 0
    const key = createBrowserDeviceKey({ box: box(), dir: () => dir, server: () => SERVER })
    const device = createBrowserDevice({ key, baseUrl: () => SERVER, cookies: () => ['s=1'], userId: () => 'u1', computerName: () => 'pc', fetch: server.fetch, now: () => now })
    device.refresh(CO)
    assert.equal(server.seen.length, 0, 'no key: never asked')
    key.ensure()
    device.refresh(CO); device.refresh(CO)
    await new Promise(r => setTimeout(r, 10))
    assert.equal(server.seen.length, 1)
    assert.equal(device.enabledHere(), true)
    now = 61_000
    device.refresh(CO)
    await new Promise(r => setTimeout(r, 10))
    assert.equal(server.seen.length, 2)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('an answer that arrives after a sign-out or another member\'s sign-in never turns the switch on for them', async () => {
  const { dir } = tempFile()
  try {
    let release: () => void = () => {}
    const server = fakeServer(() => ({ json: { success: true, data: { id: 'bd_1', label: 'pc', state: 'enabled' } } }))
    const slow = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/browser-devices-me')) await new Promise<void>(r => { release = r })
      return server.fetch(input, init)
    }) as typeof fetch
    const key = createBrowserDeviceKey({ box: box(), dir: () => dir, server: () => SERVER })
    key.ensure()
    let user = 'u1'
    const device = createBrowserDevice({ key, baseUrl: () => SERVER, cookies: () => ['s=1'], userId: () => user, computerName: () => 'pc', fetch: slow })
    const pending = device.view(CO)
    await new Promise(r => setTimeout(r, 5))
    user = 'u2'
    release()
    await pending
    assert.equal(device.enabledHere(), false, 'u1\'s answer is not u2\'s')
    user = 'u1'
    assert.equal(device.enabledHere(), false, 'nor kept for u1 under another sign-in')
    const again = device.view(CO)
    await new Promise(r => setTimeout(r, 5))
    device.clear()
    release()
    await again
    assert.equal(device.enabledHere(), false, 'signed out meanwhile: forgotten')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('a refusal (left the company, no access) forgets a remembered 使える; no answer keeps it', async () => {
  const { dir } = tempFile()
  try {
    let answer: { status?: number; json: unknown } = { json: { success: true, data: { id: 'bd_1', label: 'pc', state: 'enabled' } } }
    const server = fakeServer(req => req.path.endsWith('/browser-devices-me') ? answer : { json: { success: true, data: { lines: [] } } })
    const key = createBrowserDeviceKey({ box: box(), dir: () => dir, server: () => SERVER })
    key.ensure()
    const device = createBrowserDevice({ key, baseUrl: () => SERVER, cookies: () => ['s=1'], userId: () => 'u1', computerName: () => 'pc', fetch: server.fetch })
    await device.view(CO)
    assert.equal(device.enabledHere(), true)
    answer = { status: 502, json: {} }
    await device.view(CO)
    assert.equal(device.enabledHere(), true, 'no answer: kept (the server still refuses a stopped PC)')
    answer = { status: 403, json: { success: false, code: 'FORBIDDEN' } }
    await device.view(CO)
    assert.equal(device.enabledHere(), false)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('only the PC module and the plan clients name the header, and only main.ts and the plan wirings hand the key on', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const files: string[] = []
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p) } else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) files.push(p)
    }
  }
  for (const d of ['electron', 'src', 'shared', 'connectors', 'connector-maps']) if (fs.existsSync(path.join(root, d))) walk(path.join(root, d))
  const rel = (p: string) => path.relative(root, p).split(path.sep).join('/')
  const naming = (re: RegExp) => files.filter(f => re.test(fs.readFileSync(f, 'utf8'))).map(rel).sort()
  assert.deepEqual(naming(/BROWSER_DEVICE_HEADER|X-ACB-Browser-Device/i), [
    'electron/features/browser/device.ts', 'electron/features/browser/lines-api.ts', 'electron/features/browser/plans-api.ts',
  ])
  assert.deepEqual(naming(/\bdeviceKey\b|\bbrowserDeviceKey\b/), [
    'electron/features/browser/inspect.ts', 'electron/features/browser/lines-api.ts', 'electron/features/browser/plans-api.ts',
    'electron/features/browser/wire.ts', 'electron/features/browser/write-lines.ts', 'electron/main.ts',
  ])
})

const KEY = newBrowserDeviceKey()
const PLAN = `bp_${'a'.repeat(32)}`
const EXEC = `bx_${'b'.repeat(32)}`
const LPLAN = `bl_${'c'.repeat(32)}`
const LEXEC = `bw_${'d'.repeat(32)}`
const SECRET = 's'.repeat(40)
const HASH = `sha256:${'e'.repeat(64)}`

test('the old path: the key rides only on register, approve, claim and permit — never on get, the lists, cancel, confirm or the report', async () => {
  const server = fakeServer()
  const http = createBrowserPlansHttp({ baseUrl: () => SERVER, cookies: () => ['s=1'], deviceKey: () => KEY, fetch: server.fetch })
  await http.register(CO, {} as never)
  await http.approve(CO, PLAN, HASH)
  await http.claim(CO, PLAN)
  await http.permit(CO, EXEC, SECRET)
  await http.get(CO, PLAN)
  await http.open(CO)
  await http.waiting(CO)
  await http.cancel(CO, PLAN)
  await http.confirm(CO, EXEC, 'done')
  await http.report(EXEC, SECRET, { result: 'succeeded' } as never)
  const carried = server.seen.filter(r => r.headers.get(BROWSER_DEVICE_HEADER) === KEY).map(r => `${r.method} ${r.path}`)
  assert.deepEqual(carried, [
    `POST /api/companies/${CO}/browser-plans`,
    `POST /api/companies/${CO}/browser-plans/${PLAN}/approve`,
    `POST /api/companies/${CO}/browser-plans/${PLAN}/claim`,
    `POST /api/companies/${CO}/browser-executions/${EXEC}/send-permit`,
  ])
  assert.equal(server.seen.length, 10)
  assert.ok(server.seen.every(r => !(r.body ?? '').includes(KEY.slice(3))))
})

test('the new path: the key rides only on a plan\'s creation, approve, claim and every permit', async () => {
  const server = fakeServer()
  const http = createBrowserLinesHttp({ baseUrl: () => SERVER, cookies: () => ['s=1'], deviceKey: () => KEY, fetch: server.fetch })
  const line = { site: 'lstep', line: 'x', version: '1', mapVersion: '1', meaningHash: HASH, mechanicsHash: HASH }
  await http.createInspection(CO, { line, values: {} })
  await http.createWrites(CO, { line, values: {}, account: '1' })
  await http.approve(CO, LPLAN, HASH)
  await http.claim(CO, LPLAN)
  await http.permit(CO, LEXEC, SECRET, 1, new AbortController().signal)
  await http.get(CO, LPLAN)
  await http.cancel(CO, LPLAN)
  await http.confirm(CO, LEXEC, 1, 'done')
  await http.report(SECRET, { index: 1, result: 'done' })
  await http.result(CO, LPLAN, { reads: {}, checks: [] } as never)
  await http.notice(CO, { site: 'lstep', mapVersion: '1', thing: 't', change: 'unreadable', count: 1 })
  const carried = server.seen.filter(r => r.headers.get(BROWSER_DEVICE_HEADER) === KEY).map(r => `${r.method} ${r.path}`)
  assert.deepEqual(carried, [
    `POST /api/companies/${CO}/browser-line-plans`,
    `POST /api/companies/${CO}/browser-line-plans`,
    `POST /api/companies/${CO}/browser-line-plans/${LPLAN}/approve`,
    `POST /api/companies/${CO}/browser-line-plans/${LPLAN}/claim`,
    `POST /api/companies/${CO}/browser-line-executions/${LEXEC}/permit`,
  ])
  assert.equal(server.seen.length, 11)
})

test('the transition: a PC without a key sends no header (the owner\'s opt-in still works through the server\'s exception), and the opt-in alone turns the switch on', async () => {
  const server = fakeServer()
  const http = createBrowserPlansHttp({ baseUrl: () => SERVER, cookies: () => ['s=1'], deviceKey: () => null, fetch: server.fetch })
  await http.claim(CO, PLAN)
  assert.equal(server.seen[0].headers.has(BROWSER_DEVICE_HEADER), false)
  let optIn = true
  let registered = false
  const sw = createRegisteredPcSwitch({ optIn: () => optIn, registered: () => registered })
  assert.equal(sw(), true, 'the hand-placed opt-in (owner\'s PC) still turns it on')
  optIn = false
  assert.equal(sw(), false, 'neither: off')
  registered = true
  assert.equal(sw(), true, 'an enabled registration turns it on')
})
