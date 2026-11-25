/**
 * 「ブラウザ操作」 in the app (agent-browser.md "The app's window"), the parts that need no browser:
 * the window's request, navigation, proxy and header rules, the `ai`-mode write gate's decision,
 * which policy answers open, close and clear what, the login in memory only, and who may ask over
 * IPC. The same guards inside a real Electron: browser-window-electron.test.ts.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { BrowserSiteSetting } from '../../shared/core/browser-operation'
import type { AgentPolicy } from '../../shared/types/agent-sandbox'
import {
  browserAiStopped, browserProxyScript, browserResponseHeaders, decideAiWrite, decideWindowRequest, hostForLog, navigationAllowed,
  type BrowserWindowState,
} from '../shared/browser-operation'
import {
  browserPartition, createBrowserController,
  type BrowserShell, type BrowserWindowSpec,
} from '../electron/features/browser/controller'
import { removeLeftoverBrowserPartitions } from '../electron/features/browser/leftovers'
import { isMainFrameSender, registerBrowserIpc } from '../electron/features/browser/ipc'
import { createAgentPolicyStore } from '../electron/services/agent-policy-store'
import type { IpcInvokeEvent, IpcRegistrar } from '../electron/ipc/registrar'

const site: BrowserSiteSetting = { host: 'manager.example.net', level: 'write', assetHosts: ['cdn.example.net'] }
const state = (over: Partial<BrowserWindowState> = {}): BrowserWindowState => ({ site, mode: 'human', aiGateReady: false, helpers: [], ...over })
const req = (url: string, method = 'GET', resourceType = 'xhr', fromWindow = true) => ({ url, method, resourceType, fromWindow, pageFrame: true })

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
  assert.equal(decideWindowRequest(ai, req('https://manager.example.net/list', 'GET', 'xhr')).allow, true, 'the page\'s reads pass the hook (the gate decides them)')
  // Nothing from outside the page, reads included, without a run's gate (browser-runner.test.ts).
  assert.deepEqual(decideWindowRequest(ai, req('https://manager.example.net/list', 'GET', 'xhr', false)), { allow: false, reason: 'ai-outside' })
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


test('every connection of the window not to the site\'s hosts goes to the refusing proxy', () => {
  const find = new Function(`${browserProxyScript(site, 4321)}; return FindProxyForURL`)() as (url: string, host: string) => string
  assert.equal(find('https://manager.example.net/x', 'manager.example.net'), 'DIRECT')
  assert.equal(find('https://manager.example.net./x', 'MANAGER.example.net.'), 'DIRECT')
  assert.equal(find('https://cdn.example.net/a.js', 'cdn.example.net'), 'DIRECT')
  for (const host of ['evil.example.org', 'example.net', 'x.manager.example.net', 'manager.example.net.evil.org', '127.0.0.1', '']) {
    assert.equal(find(`https://${host}/`, host), 'PROXY 127.0.0.1:4321', host)
  }
  assert.throws(() => browserProxyScript(site, 0))
})

test('a response never registers a reporting endpoint, and a page turns off DNS prefetching', () => {
  const headers = { 'Report-To': ['{"group":"g"}'], NEL: ['{}'], 'reporting-endpoints': ['e="https://evil.example.org"'], 'X-DNS-Prefetch-Control': ['on'], 'Content-Type': ['text/html'] }
  assert.deepEqual(browserResponseHeaders(headers, 'mainFrame'), { 'Content-Type': ['text/html'], 'X-DNS-Prefetch-Control': ['off'] })
  assert.deepEqual(browserResponseHeaders(headers, 'subFrame')['X-DNS-Prefetch-Control'], ['off'])
  assert.deepEqual(browserResponseHeaders(headers, 'xhr'), { 'Content-Type': ['text/html'] })
})

// ---------------------------------------------------------------------------
// The login lives in memory only
// ---------------------------------------------------------------------------

test('a window\'s session is always in memory, one per account, company and site', () => {
  assert.match(browserPartition('u', 'c', 'a.example.net'), /^acb-browser-[0-9a-f]{32}$/)
  assert.notEqual(browserPartition('u', 'c', 'a.example.net'), browserPartition('u2', 'c', 'a.example.net'))
  assert.notEqual(browserPartition('u', 'c', 'a.example.net'), browserPartition('u', 'c2', 'a.example.net'))
  assert.notEqual(browserPartition('u', 'c', 'a.example.net'), browserPartition('u', 'c', 'b.example.net'))
})

test('a browser session an earlier build kept on disk is removed at start; nothing else is touched', () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'acb-browser-start-'))
  const partitions = path.join(userData, 'Partitions')
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'acb-browser-outside-'))
  fs.mkdirSync(path.join(partitions, 'acb-browser-0123456789abcdef0123456789abcdef', 'Network'), { recursive: true })
  fs.writeFileSync(path.join(partitions, 'acb-browser-0123456789abcdef0123456789abcdef', 'Network', 'Cookies'), 'sid=1')
  fs.mkdirSync(path.join(partitions, 'ACB-Browser-old'))
  fs.mkdirSync(path.join(partitions, 'something-else'))
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'x')
  fs.symlinkSync(outside, path.join(partitions, 'acb-browser-link'))
  assert.equal(removeLeftoverBrowserPartitions(userData, { warn() {} }), 2)
  assert.deepEqual(fs.readdirSync(partitions).sort(), ['acb-browser-link', 'something-else'])
  assert.ok(fs.existsSync(path.join(outside, 'keep.txt')), 'a link is never followed')
  assert.equal(removeLeftoverBrowserPartitions(path.join(userData, 'none'), { warn() {} }), 0)
})

// ---------------------------------------------------------------------------
// The controller: policy → open / close / clear
// ---------------------------------------------------------------------------

const policy = (browser: unknown): AgentPolicy =>
  ({ version: 'v', sandbox: { mode: 'enforce', allowedDomains: [], deniedReadPaths: [], onUnavailable: 'record-only', source: 'company' }, ...(browser ? { browser } : {}) }) as AgentPolicy
const on = (sites: BrowserSiteSetting[] = [site]) => ({ mode: 'on', sites, source: 'company' })

function world(options: { clearFails?: boolean; slow?: boolean; developerAssetHosts?: boolean } = {}) {
  const opened: Array<BrowserWindowSpec & { closed: boolean; site: BrowserSiteSetting }> = []
  const cleared: string[] = []
  let releaseClear: () => void = () => {}
  const shell: BrowserShell = {
    open(spec) {
      const entry = { ...spec, closed: false }
      opened.push(entry)
      return {
        focus() {},
        close() { entry.closed = true; spec.onClosed() },
        updateSite(next) { entry.site = next },
        run: { enterAi: async () => true, leaveAi: async () => {}, pageClean: () => true, request: async () => ({ status: 200, body: '' }), closed: () => entry.closed },
      }
    },
    clearPartition(partition) {
      if (options.clearFails) return Promise.reject(new Error('busy'))
      if (options.slow) return new Promise<void>(resolve => { releaseClear = () => { cleared.push(partition); resolve() } })
      cleared.push(partition)
      return Promise.resolve()
    },
  }
  let user: string | null = 'user-1'
  const browser = createBrowserController({ shell, userId: () => user, developerAssetHosts: options.developerAssetHosts, log: { warn() {} } })
  return { browser, opened, cleared, setUser: (u: string | null) => { user = u }, release: () => releaseClear() }
}

test('a run finds only the signed-in member\'s open window of a site their current valid policy lists', () => {
  const w = world()
  w.browser.policyAnswered('c1', policy(on()))
  assert.equal(w.browser.runWindow('c1', site.host), null, 'not opened yet: the member opens it and logs in first')
  w.browser.open('c1', site.host)
  assert.ok(w.browser.runWindow('c1', site.host))
  // The company's free-text asset hosts are not the window's (agent-browser.md "Asset hosts").
  assert.deepEqual(w.browser.siteNow('c1', site.host), { ...site, assetHosts: [], loginHelpers: [] })
  w.browser.policyAnswered('c2', policy(on()))
  assert.equal(w.browser.runWindow('c2', site.host), null, 'another company\'s window of the same site')
  w.setUser('user-2')
  assert.equal(w.browser.runWindow('c1', site.host), null, 'another account')
  w.setUser('user-1')
  w.browser.policyFailed('c1')
  assert.equal(w.browser.runWindow('c1', site.host), null, 'no valid answer')
  assert.equal(w.browser.siteNow('c1', site.host), null)
})

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
  assert.doesNotMatch(w.opened[0].partition, /^persist:/, 'the login lives in memory only')
  assert.equal(w.browser.open('c1', site.host).ok, true, 'a second press focuses the same window')
  assert.equal(w.opened.length, 1)
})

test('a failed refresh closes the windows and opens nothing until a valid answer', () => {
  const w = world()
  w.browser.policyAnswered('c1', policy(on()))
  w.browser.open('c1', site.host)
  w.browser.policyFailed('c1')
  assert.equal(w.opened[0].closed, true)
  assert.deepEqual(w.browser.sites('c1'), { sites: [] })
  assert.equal(w.browser.open('c1', site.host).ok, false)
})

test('a site removed or the mode turned off closes its window and clears its login', async () => {
  const w = world()
  const other: BrowserSiteSetting = { host: 'other.example.net', level: 'read', assetHosts: [] }
  w.browser.policyAnswered('c1', policy(on([site, other])))
  w.browser.open('c1', site.host)
  w.browser.open('c1', other.host)
  w.browser.policyAnswered('c1', policy(on([other])))
  assert.equal(w.opened[0].closed, true)
  assert.equal(w.opened[1].closed, false)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(w.cleared, [w.opened[0].partition])
  w.browser.policyAnswered('c1', policy({ mode: 'off', sites: [other], source: 'company' }))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(w.opened[1].closed, true)
  assert.deepEqual(w.cleared, [w.opened[0].partition, w.opened[1].partition])
})

test('a changed site (its level, a development build\'s asset hosts) reaches the open window at once', () => {
  const w = world({ developerAssetHosts: true })
  w.browser.policyAnswered('c1', policy(on()))
  w.browser.open('c1', site.host)
  const next = { ...site, level: 'read' as const, assetHosts: ['cdn2.example.net'] }
  w.browser.policyAnswered('c1', policy(on([next])))
  assert.deepEqual(w.opened[0].site, { ...next, loginHelpers: [] })
  assert.equal(w.opened[0].closed, false)
})

test('signing out closes every window and clears every login; another account clears the others\'', async () => {
  const w = world()
  w.browser.policyAnswered('c1', policy(on()))
  w.browser.open('c1', site.host)
  w.browser.signedOut()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(w.opened[0].closed, true)
  assert.deepEqual(w.cleared, [w.opened[0].partition])
  assert.equal(w.browser.open('c1', site.host).ok, false, 'the old policy is gone with the account')

  w.browser.policyAnswered('c1', policy(on()))
  w.browser.open('c1', site.host)
  w.cleared.length = 0
  w.setUser('user-2')
  w.browser.signedIn('user-2')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(w.opened[1].closed, true)
  assert.deepEqual(w.cleared, [w.opened[1].partition])
})

test('「ログインを消す」 answers only once the login is cleared, and says so when it could not be', async () => {
  const w = world()
  w.browser.policyAnswered('c1', policy(on()))
  w.browser.open('c1', site.host)
  assert.equal((await w.browser.clearLogin('c1', 'evil.example.org')).ok, false)
  assert.deepEqual(await w.browser.clearLogin('c1', site.host), { ok: true })
  assert.equal(w.opened[0].closed, true)
  assert.deepEqual(w.cleared, [browserPartition('user-1', 'c1', site.host)])

  const slow = world({ slow: true })
  slow.browser.policyAnswered('c1', policy(on()))
  let settled = false
  const pending = slow.browser.clearLogin('c1', site.host).then(r => { settled = true; return r })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(settled, false, 'not before the session is cleared')
  slow.release()
  assert.deepEqual(await pending, { ok: true })

  const failing = world({ clearFails: true })
  failing.browser.policyAnswered('c1', policy(on()))
  const answer = await failing.browser.clearLogin('c1', site.host)
  assert.equal(answer.ok, false)
  assert.match(answer.ok ? '' : answer.message, /消せませんでした/)
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

test('the sender check accepts only the main window\'s main frame', () => {
  const isMain = (id: number) => id === 1
  const event = (id: number, frame: number | null, main: number | null) => ({
    sender: { id, mainFrame: main === null ? null : { frameTreeNodeId: main } },
    senderFrame: frame === null ? null : { frameTreeNodeId: frame },
  })
  assert.equal(isMainFrameSender(event(1, 7, 7), isMain), true)
  assert.equal(isMainFrameSender(event(1, 8, 7), isMain), false, 'a frame inside the page')
  assert.equal(isMainFrameSender(event(2, 7, 7), isMain), false, 'a consultation window')
  assert.equal(isMainFrameSender(event(1, null, 7), isMain), false, 'a frame already gone')
  assert.equal(isMainFrameSender(event(1, 7, null), isMain), false)
})

test('only the main window\'s own page may list, open or clear; an opened window follows the policy', async () => {
  const handlers = new Map<string, (event: IpcInvokeEvent, ...args: unknown[]) => unknown>()
  const ipc = { handle: (channel: string, handler: (event: IpcInvokeEvent, ...args: unknown[]) => unknown) => { handlers.set(channel, handler) }, on() {} } as unknown as IpcRegistrar
  const asked: string[] = []
  const watched: string[] = []
  const browser = {
    sites: () => ({ sites: [{ host: site.host }] }),
    open: (_c: string, host: string) => { asked.push(`open ${host}`); return { ok: true as const } },
    clearLogin: async (_c: string, host: string) => { asked.push(`clear ${host}`); return { ok: true as const } },
  }
  registerBrowserIpc(ipc, { browser, fromMainWindow: event => event.sender.id === 1, refresh: async () => undefined, watch: c => { watched.push(c) } })
  const from = (id: number) => ({ sender: { id, isDestroyed: () => false, send() {} } })
  assert.deepEqual(await handlers.get('browser:sites')!(from(2), 'c1'), { sites: [] })
  assert.equal((await handlers.get('browser:open')!(from(2), 'c1', site.host) as { ok: boolean }).ok, false)
  assert.equal((await handlers.get('browser:clearLogin')!(from(2), 'c1', site.host) as { ok: boolean }).ok, false)
  assert.equal((await handlers.get('browser:open')!(from(1), 'c1', 42) as { ok: boolean }).ok, false)
  assert.deepEqual([asked, watched], [[], []])
  await handlers.get('browser:open')!(from(1), 'c2', site.host)
  assert.deepEqual(asked, [`open ${site.host}`])
  assert.deepEqual(watched, ['c2'], 'a window opened without the settings page still hears policy changes')
})
