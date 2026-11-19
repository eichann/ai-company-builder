/**
 * 「ブラウザ操作」 in the app (agent-browser.md "The app's window"), the parts that need no browser:
 * the window's request and navigation rules, the `ai`-mode write gate's decision, which policy
 * answers open, close and clear what, where a login is kept, and who may ask over IPC. The same
 * guards inside a real Electron: browser-window-electron.test.ts.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { BrowserSiteSetting } from '../../shared/core/browser-operation'
import type { AgentPolicy } from '../../shared/types/agent-sandbox'
import {
  browserAiStopped, decideAiWrite, decideWindowRequest, hostForLog, navigationAllowed,
  type BrowserWindowState,
} from '../shared/browser-operation'
import {
  browserPartition, createBrowserController, loginStorageFor,
  type BrowserShell, type BrowserWindowSpec, type LoginStorage,
} from '../electron/features/browser/controller'
import { createKeptLogins } from '../electron/features/browser/logins'
import { registerBrowserIpc } from '../electron/features/browser/ipc'
import { createAgentPolicyStore } from '../electron/services/agent-policy-store'
import type { IpcInvokeEvent, IpcRegistrar } from '../electron/ipc/registrar'

const site: BrowserSiteSetting = { host: 'manager.example.net', level: 'write', assetHosts: ['cdn.example.net'] }
const state = (over: Partial<BrowserWindowState> = {}): BrowserWindowState => ({ site, mode: 'human', aiGateReady: false, ...over })
const req = (url: string, method = 'GET', resourceType = 'xhr', fromWindow = true) => ({ url, method, resourceType, fromWindow })

// ---------------------------------------------------------------------------
// The request rule, navigations, the write gate
// ---------------------------------------------------------------------------

test('a window\'s session with no window open refuses every request (a service worker left running reaches nowhere)', () => {
  assert.deepEqual(decideWindowRequest(state({ site: null }), req('https://manager.example.net/x')), { allow: false, reason: 'closed' })
})

test('the window applies the site\'s rule: another host, http or an asset host\'s fetch are refused', () => {
  assert.equal(decideWindowRequest(state(), req('https://evil.example.org/x')).allow, false)
  assert.equal(decideWindowRequest(state(), req('http://manager.example.net/x')).allow, false)
  assert.equal(decideWindowRequest(state(), req('https://cdn.example.net/data.json', 'GET', 'xhr')).allow, false)
  assert.equal(decideWindowRequest(state(), req('https://cdn.example.net/a.js', 'GET', 'script')).allow, true)
  // The member's own write in human mode goes out, as in any browser.
  assert.equal(decideWindowRequest(state(), req('https://manager.example.net/save', 'POST')).allow, true)
})

test('in ai mode no WebSocket to the operated host, and no write the gate cannot see', () => {
  const ai = state({ mode: 'ai', aiGateReady: true })
  assert.deepEqual(decideWindowRequest(ai, req('wss://manager.example.net/ws', 'GET', 'webSocket')), { allow: false, reason: 'ai-websocket' })
  // Before the gate is attached (the first page is still loading) a write is refused.
  assert.deepEqual(decideWindowRequest(state({ mode: 'ai' }), req('https://manager.example.net/save', 'POST')), { allow: false, reason: 'ai-unchecked-write' })
  // A write from outside the window's page (a service worker) never passes the gate.
  assert.deepEqual(decideWindowRequest(ai, req('https://manager.example.net/save', 'POST', 'xhr', false)), { allow: false, reason: 'ai-unchecked-write' })
  assert.equal(decideWindowRequest(ai, req('https://manager.example.net/save', 'POST')).allow, true, 'the gate decides this one')
  assert.equal(decideWindowRequest(ai, req('https://manager.example.net/list', 'GET', 'xhr', false)).allow, true, 'reads pass')
})

test('a frame navigates only to https on the operated host; nothing else is handed anywhere', () => {
  assert.equal(navigationAllowed(site, 'https://manager.example.net/a?b=1', true), true)
  for (const url of ['https://evil.example.org/', 'http://manager.example.net/', 'https://manager.example.net:8443/',
    'https://user@manager.example.net/', 'javascript:alert(1)', 'file:///etc/passwd', 'mailto:a@b.c', 'zoommtg://x', 'about:blank']) {
    assert.equal(navigationAllowed(site, url, true), false, url)
  }
  assert.equal(navigationAllowed(site, 'about:blank', false), true, 'an empty subframe fetches nothing')
  assert.equal(navigationAllowed(site, 'https://cdn.example.net/frame', false), false, 'an asset host is never a frame')
})

test('the write gate lets a write out only with an approving step, never while stopped or with a method override', async () => {
  const write = { method: 'POST', url: 'https://manager.example.net/save', headers: {}, body: 'a=1' }
  assert.deepEqual(await decideAiWrite(site, write, undefined, false), { allow: false, reason: 'no-step' })
  assert.deepEqual(await decideAiWrite(site, write, () => true, true), { allow: false, reason: 'stopped' })
  assert.deepEqual(await decideAiWrite(site, { ...write, headers: { 'X-HTTP-Method-Override': 'DELETE' } }, () => true, false), { allow: false, reason: 'method-override' })
  assert.deepEqual(await decideAiWrite(site, { ...write, url: 'https://evil.example.org/save' }, () => true, false), { allow: false, reason: 'host' })
  assert.deepEqual(await decideAiWrite(site, write, () => { throw new Error('x') }, false), { allow: false, reason: 'decider-failed' })
  assert.deepEqual(await decideAiWrite(site, write, () => false, false), { allow: false, reason: 'decider-refused' })
  assert.deepEqual(await decideAiWrite(site, write, w => w.body === 'a=1', false), { allow: true })
  assert.deepEqual(await decideAiWrite(site, { ...write, method: 'GET' }, undefined, true), { allow: true }, 'a read changes nothing')
})

test('the AI\'s operation stops with a whole-AI stop and a web or outside-service stop; never received stops nothing', () => {
  assert.equal(browserAiStopped(undefined), false)
  assert.equal(browserAiStopped({ all: false, tools: [] }), false)
  assert.equal(browserAiStopped({ all: false, tools: ['command'] }), false)
  assert.equal(browserAiStopped({ all: true, tools: [] }), true)
  assert.equal(browserAiStopped({ all: false, tools: ['web'] }), true)
  assert.equal(browserAiStopped({ all: false, tools: ['mcp-external'] }), true)
})

test('a refusal is logged by host only, never with its path or query', () => {
  assert.equal(hostForLog('https://evil.example.org/collect?token=secret#x'), 'evil.example.org')
  assert.equal(hostForLog('not a url ?secret'), '(unreadable)')
})

// ---------------------------------------------------------------------------
// Where a login is kept
// ---------------------------------------------------------------------------

test('the login is kept on disk only when the sandbox is 「囲う」 and really runs here', () => {
  const here = { platformSandbox: true, agentSandbox: true }
  assert.equal(loginStorageFor('enforce', here), 'disk')
  assert.equal(loginStorageFor('observe', here), 'memory')
  assert.equal(loginStorageFor('off', here), 'memory')
  assert.equal(loginStorageFor('enforce', { ...here, platformSandbox: false }), 'memory', 'Windows records only')
  assert.equal(loginStorageFor('enforce', { ...here, agentSandbox: false }), 'memory', 'the API-key agent runs enforce as observe')
  assert.match(browserPartition('u', 'c', 'a.example.net', 'disk'), /^persist:acb-browser-[0-9a-f]{32}$/)
  assert.doesNotMatch(browserPartition('u', 'c', 'a.example.net', 'memory'), /^persist:/)
  assert.notEqual(browserPartition('u', 'c', 'a.example.net', 'disk'), browserPartition('u2', 'c', 'a.example.net', 'disk'), 'one session per account')
  assert.notEqual(browserPartition('u', 'c', 'a.example.net', 'disk'), browserPartition('u', 'c2', 'a.example.net', 'disk'), 'one session per company')
})

// ---------------------------------------------------------------------------
// The controller: policy → open / close / clear
// ---------------------------------------------------------------------------

const policy = (browser: unknown, sandboxMode: 'off' | 'observe' | 'enforce' = 'enforce'): AgentPolicy =>
  ({ version: 'v', sandbox: { mode: sandboxMode, allowedDomains: [], deniedReadPaths: [], onUnavailable: 'record-only', source: 'company' }, ...(browser ? { browser } : {}) }) as AgentPolicy
const on = (sites: BrowserSiteSetting[] = [site]) => ({ mode: 'on', sites, source: 'company' })

function world() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acb-browser-'))
  const opened: Array<BrowserWindowSpec & { closed: boolean; site: BrowserSiteSetting }> = []
  const cleared: string[] = []
  const shell: BrowserShell = {
    open(spec) {
      const entry = { ...spec, closed: false }
      opened.push(entry)
      return {
        focus() {},
        close() { entry.closed = true; spec.onClosed() },
        updateSite(next) { entry.site = next },
      }
    },
    async clearPartition(partition) { cleared.push(partition) },
  }
  let user: string | null = 'user-1'
  const logins = createKeptLogins(() => path.join(dir, 'browser-logins.json'), { warn() {} })
  const changed: string[] = []
  const browser = createBrowserController({
    shell, logins, userId: () => user,
    storageFor: mode => loginStorageFor(mode, { platformSandbox: true, agentSandbox: true }) as LoginStorage,
    onChanged: c => changed.push(c),
    log: { warn() {} },
  })
  return { browser, opened, cleared, logins, changed, setUser: (u: string | null) => { user = u }, dir }
}

test('nothing opens before a valid answer, for an older server without `browser`, or when it is off', () => {
  const w = world()
  assert.equal(w.browser.open('c1', site.host).ok, false, 'no answer yet')
  w.browser.policyAnswered('c1', policy(undefined))
  assert.deepEqual(w.browser.sites('c1'), { sites: [] })
  assert.equal(w.browser.open('c1', site.host).ok, false)
  w.browser.policyAnswered('c1', policy({ mode: 'off', sites: [site], source: 'company' }))
  assert.equal(w.browser.open('c1', site.host).ok, false, 'sites listed but the mode is off')
  assert.equal(w.opened.length, 0)
})

test('an invalid `browser` in the answer reads as off (the store drops it)', async () => {
  let body: unknown = { data: { version: 'v1', sandbox: { mode: 'off', allowedDomains: [], deniedReadPaths: [], onUnavailable: 'record-only' }, browser: { mode: 'on', sites: [{ host: '*.example.net', level: 'write', assetHosts: [] }] } } }
  const store = createAgentPolicyStore({ baseUrl: () => 'https://acb.example.com', cookies: () => [], log: { warn() {} }, fetch: (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch })
  assert.equal((await store.refresh('c1'))?.browser, undefined)
  body = { data: { version: 'v2', sandbox: { mode: 'off', allowedDomains: [], deniedReadPaths: [], onUnavailable: 'record-only' }, browser: { ...on(), source: 'member' } } }
  assert.deepEqual((await store.refresh('c1'))?.browser, { mode: 'on', sites: [site], source: 'member' })
})

test('the host the renderer names opens only when the current policy lists it exactly', () => {
  const w = world()
  w.browser.policyAnswered('c1', policy(on()))
  for (const host of ['evil.example.org', 'MANAGER.example.net', 'manager.example.net.', 'cdn.example.net']) {
    assert.equal(w.browser.open('c1', host).ok, false, host)
  }
  assert.equal(w.browser.open('c2', site.host).ok, false, 'another company\'s policy is not this one')
  assert.equal(w.browser.open('c1', site.host).ok, true)
  assert.equal(w.opened.length, 1)
  assert.equal(w.browser.open('c1', site.host).ok, true, 'a second press focuses the same window')
  assert.equal(w.opened.length, 1)
})

test('a failed refresh closes the windows and opens nothing until a valid answer; the login stays', () => {
  const w = world()
  w.browser.policyAnswered('c1', policy(on()))
  w.browser.open('c1', site.host)
  w.browser.policyFailed('c1')
  assert.equal(w.opened[0].closed, true)
  assert.deepEqual(w.browser.sites('c1'), { sites: [] })
  assert.equal(w.browser.open('c1', site.host).ok, false)
  assert.deepEqual(w.cleared, [], 'unknown is not "removed": the login is cleared only by a valid answer')
  assert.equal(w.logins.all().length, 1)
})

test('a site removed or the mode turned off closes its window and clears its login', () => {
  const w = world()
  const other: BrowserSiteSetting = { host: 'other.example.net', level: 'read', assetHosts: [] }
  w.browser.policyAnswered('c1', policy(on([site, other])))
  w.browser.open('c1', site.host)
  w.browser.open('c1', other.host)
  w.browser.policyAnswered('c1', policy(on([other])))
  assert.equal(w.opened[0].closed, true)
  assert.equal(w.opened[1].closed, false)
  assert.ok(w.cleared.includes(w.opened[0].partition))
  w.browser.policyAnswered('c1', policy({ mode: 'off', sites: [other], source: 'company' }))
  assert.equal(w.opened[1].closed, true)
  assert.ok(w.cleared.includes(w.opened[1].partition))
  assert.deepEqual(w.logins.all(), [])
})

test('a changed site (its asset hosts) reaches the open window at once', () => {
  const w = world()
  w.browser.policyAnswered('c1', policy(on()))
  w.browser.open('c1', site.host)
  const next = { ...site, assetHosts: ['cdn2.example.net'] }
  w.browser.policyAnswered('c1', policy(on([next])))
  assert.deepEqual(w.opened[0].site, next)
  assert.equal(w.opened[0].closed, false)
})

test('the sandbox leaving 「囲う」 closes a window keeping its login on disk and clears every kept login of the company', () => {
  const w = world()
  const other: BrowserSiteSetting = { host: 'other.example.net', level: 'read', assetHosts: [] }
  w.browser.policyAnswered('c1', policy(on([site, other])))
  w.browser.open('c1', site.host)
  assert.match(w.opened[0].partition, /^persist:/)
  // A login kept from an earlier run, no window this run.
  w.logins.record({ partition: browserPartition('user-1', 'c1', other.host, 'disk'), userId: 'user-1', companyId: 'c1', host: other.host })
  w.browser.policyAnswered('c1', policy(on([site, other]), 'observe'))
  assert.equal(w.opened[0].closed, true)
  assert.ok(w.cleared.includes(w.opened[0].partition))
  assert.ok(w.cleared.includes(browserPartition('user-1', 'c1', other.host, 'disk')))
  assert.deepEqual(w.logins.all(), [])
  w.browser.open('c1', site.host)
  assert.doesNotMatch(w.opened[1].partition, /^persist:/, 'now in memory')
})

test('signing out closes every window and clears every login; another account clears the others\' kept logins', () => {
  const w = world()
  w.browser.policyAnswered('c1', policy(on()))
  w.browser.open('c1', site.host)
  // The sandbox went off: the disk window closed; the next one keeps its login in memory.
  w.browser.policyAnswered('c1', policy(on(), 'off'))
  w.browser.open('c1', site.host)
  assert.doesNotMatch(w.opened[1].partition, /^persist:/)
  w.cleared.length = 0
  w.browser.signedOut()
  assert.ok(w.opened.every(o => o.closed))
  assert.deepEqual(w.logins.all(), [])
  assert.deepEqual(w.cleared, [w.opened[1].partition], 'the login kept in memory is cleared too')
  assert.equal(w.browser.open('c1', site.host).ok, false, 'the old policy is gone with the account')

  // A kept login of user-1 from an earlier run; user-2 signs in.
  const kept = browserPartition('user-1', 'c1', site.host, 'disk')
  w.logins.record({ partition: kept, userId: 'user-1', companyId: 'c1', host: site.host })
  w.setUser('user-2')
  w.cleared.length = 0
  w.browser.signedIn('user-2')
  assert.deepEqual(w.cleared, [kept])
  assert.deepEqual(w.logins.all(), [])
})

test('「ログインを消す」 closes the window and clears both kinds of login of that site only', () => {
  const w = world()
  w.browser.policyAnswered('c1', policy(on()))
  w.browser.open('c1', site.host)
  assert.equal(w.browser.clearLogin('c1', 'evil.example.org').ok, false)
  assert.equal(w.browser.clearLogin('c1', site.host).ok, true)
  assert.equal(w.opened[0].closed, true)
  assert.deepEqual(w.cleared.sort(), [browserPartition('user-1', 'c1', site.host, 'disk'), browserPartition('user-1', 'c1', site.host, 'memory')].sort())
})

test('an edited list of kept logins never names another session to clear', () => {
  const w = world()
  fs.writeFileSync(path.join(w.dir, 'browser-logins.json'), JSON.stringify({ logins: [
    { partition: '', userId: 'user-1', companyId: 'c1', host: 'a' },
    { partition: 'persist:main', userId: 'user-1', companyId: 'c1', host: 'a' },
    { partition: 'persist:acb-browser-zz', userId: 'user-1', companyId: 'c1', host: 'a' },
  ] }))
  w.browser.signedOut()
  assert.deepEqual(w.cleared, [])
})

// ---------------------------------------------------------------------------
// The policy store: a failed refresh is heard
// ---------------------------------------------------------------------------

test('every refresh that brings no valid answer is reported as failed (never a stale "on")', async () => {
  const valid = { data: { version: 'v1', sandbox: { mode: 'off', allowedDomains: [], deniedReadPaths: [], onUnavailable: 'record-only' }, browser: on() } }
  let answer: () => Promise<Response> = async () => new Response(JSON.stringify(valid), { status: 200 })
  let base = 'https://acb.example.com'
  const store = createAgentPolicyStore({ baseUrl: () => base, cookies: () => [], log: { warn() {} }, fetch: (() => answer()) as typeof fetch })
  const failed: string[] = []
  const answered: string[] = []
  store.onRefreshFailed(c => failed.push(c))
  store.onPolicy(c => answered.push(c))
  await store.refresh('c1')
  answer = async () => new Response(null, { status: 304 })
  await store.refresh('c1')
  assert.deepEqual([failed.length, answered.length], [0, 2])
  for (const bad of [
    async () => new Response('{}', { status: 500 }),
    async () => { throw new Error('offline') },
    async () => new Response(JSON.stringify({ data: { version: 'v2' } }), { status: 200 }),
  ]) {
    answer = bad
    await store.refresh('c1')
  }
  base = ''
  await store.refresh('c1')
  assert.equal(failed.length, 4)
  assert.equal(answered.length, 2)
})

// ---------------------------------------------------------------------------
// IPC: who may ask
// ---------------------------------------------------------------------------

test('only the main window\'s own page may list, open or clear; the host is checked by the controller', async () => {
  const handlers = new Map<string, (event: IpcInvokeEvent, ...args: unknown[]) => unknown>()
  const ipc = { handle: (channel: string, handler: (event: IpcInvokeEvent, ...args: unknown[]) => unknown) => { handlers.set(channel, handler) }, on() {} } as unknown as IpcRegistrar
  const asked: string[] = []
  const browser = {
    sites: () => ({ sites: [{ host: site.host, loginKept: true }] }),
    open: (_c: string, host: string) => { asked.push(`open ${host}`); return { ok: true as const } },
    clearLogin: (_c: string, host: string) => { asked.push(`clear ${host}`); return { ok: true as const } },
  }
  registerBrowserIpc(ipc, { browser, fromMainWindow: event => event.sender.id === 1, refresh: async () => undefined, watch: () => {} })
  const from = (id: number) => ({ sender: { id, isDestroyed: () => false, send() {} } })
  assert.deepEqual(await handlers.get('browser:sites')!(from(2), 'c1'), { sites: [] })
  assert.equal((await handlers.get('browser:open')!(from(2), 'c1', site.host) as { ok: boolean }).ok, false)
  assert.equal((await handlers.get('browser:clearLogin')!(from(2), 'c1', site.host) as { ok: boolean }).ok, false)
  assert.equal((await handlers.get('browser:open')!(from(1), 'c1', 42) as { ok: boolean }).ok, false)
  assert.deepEqual(asked, [])
  assert.deepEqual(await handlers.get('browser:sites')!(from(1), 'c1'), { sites: [{ host: site.host, loginKept: true }] })
  await handlers.get('browser:open')!(from(1), 'c1', site.host)
  assert.deepEqual(asked, [`open ${site.host}`])
})
