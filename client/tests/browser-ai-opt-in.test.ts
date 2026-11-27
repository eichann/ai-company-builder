/**
 * 「ブラウザ操作」 switched on for one PC only (agent-browser.md "This PC's opt-in", 6c, owner decision
 * 2026-11-22): the build constant stays off; the switch is on only while this PC's opt-in file names this
 * server and the signed-in member and has not run out — so the same build stays off for everyone else,
 * and removing the file turns it off at once, also in the middle of a run.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { lstepConnector } from '../connectors/lstep'
import { BROWSER_AI_BUILD_SWITCH, BROWSER_AI_OPT_IN_FILE, browserAiOptInOn } from '../shared/browser-ai'
import { createThisPcSwitch } from '../electron/features/browser/ai-switch'
import { wireBrowserPlans } from '../electron/features/browser/wire'
import type { IpcInvokeEvent, IpcRegistrar } from '../electron/ipc/registrar'
import { makeTempDir } from '../../shared/testing/temp-dirs'

const SERVER = 'https://acb.example'
const USER = 'user_owner_1'
const AT = Date.parse('2026-11-22T12:00:00+09:00')
const UNTIL = '2026-11-29T23:59:00+09:00'
const COMPANY = 'company-1'
const PLAN = `bp_${'a'.repeat(32)}`
const HASH = `sha256:${'c'.repeat(64)}`
const SITE = { host: 'manager.linestep.net', level: 'write' as const, assetHosts: [] }
const lstep = lstepConnector()

const optIn = (over: Record<string, unknown> = {}) => JSON.stringify({ browserAi: 'this-pc', server: SERVER, userId: USER, until: UNTIL, ...over })
const on = (text: string, o: { server?: string; userId?: string | null; at?: number } = {}) =>
  browserAiOptInOn(text, { server: o.server ?? SERVER, userId: o.userId === undefined ? USER : o.userId, at: o.at ?? AT })

test('an opt-in turns it on only for its server, its signed-in member and until its end — anything else is off', () => {
  assert.equal(BROWSER_AI_BUILD_SWITCH, false, 'no build is on for everyone')
  assert.equal(on(optIn()), true)
  // The same server written with a path or a trailing slash is the same origin.
  assert.equal(on(optIn({ server: `${SERVER}/` }), { server: `${SERVER}/api` }), true)
  // Another member signed in on this PC, or nobody signed in.
  assert.equal(on(optIn(), { userId: 'someone_else' }), false)
  assert.equal(on(optIn(), { userId: null }), false)
  // Another server (another company's ACB, the staging server), or a server that is no http(s) origin.
  assert.equal(on(optIn(), { server: 'https://other.example' }), false)
  assert.equal(on(optIn(), { server: 'http://acb.example' }), false)
  assert.equal(on(optIn({ server: 'file:///etc' }), { server: 'file:///etc' }), false)
  assert.equal(on(optIn({ server: 'https://u:p@acb.example' })), false)
  // Its end: passed, exactly now, more than 14 days ahead, without a zone, not a time.
  assert.equal(on(optIn({ until: '2026-11-22T11:59:00+09:00' })), false)
  assert.equal(on(optIn({ until: '2026-11-22T12:00:00+09:00' })), false)
  assert.equal(on(optIn({ until: '2026-12-06T12:00:00+09:00' })), true, '14 days exactly')
  assert.equal(on(optIn({ until: '2026-12-06T12:01:00+09:00' })), false)
  assert.equal(on(optIn({ until: '2026-11-29T23:59:00' })), false)
  assert.equal(on(optIn({ until: 'next week' })), false)
  // Its shape: exactly the four keys, the fixed word, a plain member id.
  assert.equal(on(optIn({ browserAi: 'on' })), false)
  assert.equal(on(optIn({ browserAi: true })), false)
  assert.equal(on(optIn({ extra: 1 })), false)
  assert.equal(on(JSON.stringify({ browserAi: 'this-pc', server: SERVER, userId: USER })), false)
  assert.equal(on(optIn({ userId: `${USER} ` }), { userId: `${USER} ` }), false)
  assert.equal(on('[]'), false)
  assert.equal(on('not json'), false)
  assert.equal(on(optIn() + ' '.repeat(5000)), false, 'too large')
})

function tempDir() { return makeTempDir('acb-optin-') }

test('the switch reads this PC\'s file on every ask: none = off, written = on, removed = off at once; a link, a folder or a pipe never counts', { timeout: 20_000 }, () => {
  const dir = tempDir()
  try {
    const file = path.join(dir, BROWSER_AI_OPT_IN_FILE)
    let user: string | null = USER
    const sw = createThisPcSwitch({ file: () => file, server: () => SERVER, userId: () => user, now: () => AT })
    assert.equal(sw(), false, 'no file: off')
    fs.writeFileSync(file, optIn())
    assert.equal(sw(), true)
    user = 'someone_else'
    assert.equal(sw(), false, 'another member signs in on this PC')
    user = USER
    fs.rmSync(file)
    assert.equal(sw(), false, 'removed: off at once (nothing kept in memory)')
    // A link to a valid opt-in elsewhere is not followed.
    const real = path.join(dir, 'real.json')
    fs.writeFileSync(real, optIn())
    fs.symlinkSync(real, file)
    assert.equal(sw(), false)
    fs.rmSync(file)
    fs.mkdirSync(file)
    assert.equal(sw(), false, 'a folder of that name')
    fs.rmdirSync(file)
    // A named pipe is never waited on (main's thread would freeze).
    execFileSync('mkfifo', [file])
    assert.equal(sw(), false, 'a pipe of that name')
    // A file name that cannot be worked out is off, never a throw into the caller.
    assert.equal(createThisPcSwitch({ file: () => { throw new Error('no userData') }, server: () => SERVER, userId: () => USER })(), false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

function wired(dir: string, o: { user?: () => string | null; fetch?: (url: string, init: RequestInit) => Promise<Response> } = {}) {
  const handlers = new Map<string, (event: IpcInvokeEvent, ...args: unknown[]) => Promise<unknown>>()
  const ipc = { handle: (c: string, h: (event: IpcInvokeEvent, ...args: unknown[]) => Promise<unknown>) => { handlers.set(c, h) }, on() {} } as unknown as IpcRegistrar
  const touched: string[] = []
  const userId = o.user ?? (() => USER)
  const wiring = wireBrowserPlans(ipc, {
    // Composed as main.ts does it.
    aiSwitch: createThisPcSwitch({ file: () => path.join(dir, BROWSER_AI_OPT_IN_FILE), server: () => SERVER, userId }),
    fromMainWindow: () => true, baseUrl: () => SERVER, cookies: () => ['s=1'], userId, userDataDir: () => dir,
    // The company's setting is on and lists the site; the AI is not stopped.
    windows: {
      siteNow: () => SITE,
      runWindow: () => { touched.push('run window'); return null },
      previewWindow: () => { touched.push('preview window'); return null },
    },
    stopped: () => false,
    connectors: { declarations: [lstep.declaration], checkers: lstep.checkers, readers: lstep.readers },
    operator: () => { touched.push('operator'); return null },
    cliPath: () => { touched.push('cli'); return '/bin/false' },
    parentEnv: () => ({}),
    fetch: (async (url: string, init: RequestInit) => {
      touched.push(`fetch ${new URL(url).pathname}`)
      if (o.fetch) return o.fetch(url, init)
      throw new Error('no server here')
    }) as unknown as typeof fetch,
    log: { warn() {} },
  })
  const event = { sender: { id: 1, isDestroyed: () => false, send() {} } } as unknown as IpcInvokeEvent
  const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!(event, ...args)
  return { wiring, call, touched }
}

test('the same build on a PC without the opt-in — the company\'s setting on, the site listed — reaches no site, operator or server', async () => {
  const dir = tempDir()
  try {
    // A file for another member (the owner's opt-in copied to a colleague's PC) is the same as none.
    fs.writeFileSync(path.join(dir, BROWSER_AI_OPT_IN_FILE), JSON.stringify({ browserAi: 'this-pc', server: SERVER, userId: 'owner_elsewhere', until: new Date(Date.now() + 86_400_000).toISOString() }))
    const { wiring, call, touched } = wired(dir)
    assert.deepEqual(await call('browserPlans:run', COMPANY, PLAN, HASH), { ok: true, result: { outcome: 'refused', reason: 'off' } })
    assert.deepEqual(await call('browserPlans:list', COMPANY), { ok: true, inbox: { plans: [], unsure: [] } })
    assert.equal(wiring.requestAvailable(), false, 'the consultation gets no request tool')
    assert.deepEqual(await wiring.request({ companyId: COMPANY, conversationId: null, site: 'lstep', operation: 'reminder_step_add_template', hints: { targetHints: {}, changeHints: {}, reason: '' }, signal: new AbortController().signal }),
      { outcome: 'not-made', why: 'off' })
    assert.deepEqual(touched, [])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('with the opt-in on this PC it is on (the tool exists, the inbox asks the server), and removing it mid-run stops the run before anything more is asked', async () => {
  const dir = tempDir()
  try {
    const file = path.join(dir, BROWSER_AI_OPT_IN_FILE)
    fs.writeFileSync(file, JSON.stringify({ browserAi: 'this-pc', server: SERVER, userId: USER, until: new Date(Date.now() + 86_400_000).toISOString() }))
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
    const { wiring, call, touched } = wired(dir, {
      fetch: async url => {
        const p = new URL(url).pathname
        // The person removes the opt-in while the approval is on its way.
        if (p.endsWith('/approve')) { fs.rmSync(file); return json(200, { data: { state: 'approved' } }) }
        if (p.endsWith('/browser-plans-open')) return json(200, { data: { items: [], more: false } })
        if (p.endsWith('/browser-executions-waiting')) return json(200, { data: { items: [], next: null } })
        return json(500, {})
      },
    })
    assert.equal(wiring.requestAvailable(), true)
    await call('browserPlans:list', COMPANY)
    assert.deepEqual(touched.splice(0).sort(), [`fetch /api/companies/${COMPANY}/browser-executions-waiting`, `fetch /api/companies/${COMPANY}/browser-plans-open`])
    // ［任せる］: the approval is asked; then the switch is off — no claim, no window, no permit, nothing sent.
    assert.deepEqual(await call('browserPlans:run', COMPANY, PLAN, HASH), { ok: true, result: { outcome: 'refused', reason: 'context-changed' } })
    assert.deepEqual(touched, [`fetch /api/companies/${COMPANY}/browser-plans/${PLAN}/approve`])
    assert.equal(wiring.requestAvailable(), false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
