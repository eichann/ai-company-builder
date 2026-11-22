/**
 * A site's login helpers (agent-browser.md "Login helpers"): the hosts its declaration lists for a
 * person's login (Lステップ: Google's reCAPTCHA) work only while the window is in `human` mode, only
 * under their path, only in the ways declared, and never while the AI operates; while the AI operates no
 * frame the page's write gate does not see may live or be heard. The same in a real Electron:
 * browser-window-electron.test.ts.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import type { BrowserSiteSetting } from '../../shared/core/browser-operation'
import type { BrowserLoginHelper } from '../../shared/core/plugin-browser-declaration'
import {
  browserProxyScript, decideWindowRequest, foreignFrameCount, frameSeenByPageGate, proxyHelperHosts, windowNavigationAllowed,
  type BrowserWindowMode, type BrowserWindowState,
} from '../shared/browser-operation'
import { browserLoginHelpers, createBrowserConnectors } from '../shared/browser-checkers'
import { LSTEP_DECLARATION } from '../connectors/lstep/declaration'
import { approvedBundledDeclarations } from '../electron/features/browser/combination'
import { bundledLoginHelpers } from '../electron/features/browser/wire'
import approvedFile from '../../shared/browser-connectors/approved.json'
import carriedFile from '../../shared/browser-connectors/carried.json'

const site: BrowserSiteSetting = { host: 'manager.example.net', level: 'write', assetHosts: ['cdn.example.net'] }
const FRAMED: BrowserLoginHelper = { host: 'captcha.example.com', pathPrefix: '/recaptcha/', frame: true, post: true }
const PARTS: BrowserLoginHelper = { host: 'parts.example.com', pathPrefix: '/recaptcha/', frame: false, post: false }
const helpers = [FRAMED, PARTS]
const state = (mode: BrowserWindowMode, over: Partial<BrowserWindowState> = {}): BrowserWindowState =>
  ({ site, mode, aiGateReady: mode === 'ai', helpers, ...over })
const allowed = (s: BrowserWindowState, url: string, method: string, resourceType: string, fromWindow = true) =>
  decideWindowRequest(s, { url, method, resourceType, fromWindow, pageFrame: true }).allow

const KINDS = [
  { type: 'subFrame', method: 'GET' }, { type: 'mainFrame', method: 'GET' }, { type: 'script', method: 'GET' },
  { type: 'stylesheet', method: 'GET' }, { type: 'image', method: 'GET' }, { type: 'font', method: 'GET' },
  { type: 'media', method: 'GET' }, { type: 'other', method: 'GET' }, { type: 'xhr', method: 'GET' },
  { type: 'xhr', method: 'HEAD' }, { type: 'xhr', method: 'POST' }, { type: 'script', method: 'POST' },
  { type: 'subFrame', method: 'POST' }, { type: 'xhr', method: 'PUT' }, { type: 'xhr', method: 'DELETE' },
  { type: 'ping', method: 'POST' }, { type: 'object', method: 'GET' }, { type: 'cspReport', method: 'POST' },
  { type: 'webSocket', method: 'GET' },
] as const

/** What the window lets through for a helper in `human` mode, in its prefix, from the page (the rule as written down). */
function expected(helper: BrowserLoginHelper, kind: typeof KINDS[number]): boolean {
  if (kind.type === 'subFrame') return helper.frame && kind.method === 'GET'
  if (kind.method === 'POST') return helper.post && kind.type === 'xhr'
  return ['GET', 'HEAD'].includes(kind.method) && ['script', 'stylesheet', 'image', 'font', 'xhr', 'media', 'other'].includes(kind.type)
}

test('a login helper works only in human mode, only from the page, only under its path, a frame only where declared and a POST only by fetch / XHR where declared — every case', () => {
  for (const helper of helpers) {
    for (const mode of ['human', 'ai'] as const) {
      for (const kind of KINDS) {
        for (const [inPrefix, url] of [[true, `https://${helper.host}/recaptcha/api2/anchor?k=1`], [false, `https://${helper.host}/search?q=1`]] as const) {
          for (const fromWindow of [true, false]) {
            const want = mode === 'human' && inPrefix && fromWindow && expected(helper, kind)
            assert.equal(allowed(state(mode), url, kind.method, kind.type, fromWindow), want, `${helper.host} ${mode} ${kind.method} ${kind.type} prefix=${inPrefix} page=${fromWindow}`)
          }
        }
      }
    }
  }
  // The reCAPTCHA shapes seen on the login page: the frame, its script, its check by XHR POST.
  assert.equal(allowed(state('human'), 'https://captcha.example.com/recaptcha/api2/anchor?ar=1&k=x', 'GET', 'subFrame'), true)
  assert.equal(allowed(state('human'), 'https://parts.example.com/recaptcha/releases/abc/recaptcha__ja.js', 'GET', 'script'), true)
  assert.equal(allowed(state('human'), 'https://captcha.example.com/recaptcha/api2/reload?k=x', 'POST', 'xhr'), true)
})

test('while the AI operates every helper request is refused, and says so in the log', () => {
  for (const kind of KINDS) {
    assert.deepEqual(decideWindowRequest(state('ai'), { url: 'https://captcha.example.com/recaptcha/api.js', method: kind.method, resourceType: kind.type, fromWindow: true, pageFrame: true }),
      { allow: false, reason: 'ai-login-helper' }, `${kind.method} ${kind.type}`)
  }
  // Out of its path the log names that, not "host": what to add to the declaration is then visible.
  assert.deepEqual(decideWindowRequest(state('human'), { url: 'https://captcha.example.com/js/bg/x.js', method: 'GET', resourceType: 'script', fromWindow: true, pageFrame: true }),
    { allow: false, reason: 'login-helper-path' })
})

test('only the helper\'s exact host, https on its default port, without a user, under its prefix taken literally', () => {
  const human = state('human')
  for (const url of [
    'http://captcha.example.com/recaptcha/api.js', 'https://captcha.example.com:8443/recaptcha/api.js',
    'https://user@captcha.example.com/recaptcha/api.js', 'https://www.captcha.example.com/recaptcha/api.js',
    'https://example.com/recaptcha/api.js', 'https://captcha.example.com.evil.net/recaptcha/api.js',
    'https://captcha.example.com/recaptcha', 'https://captcha.example.com/recaptchas/api.js',
    'https://captcha.example.com/recaptcha/..%2fsearch', 'https://captcha.example.com/recaptcha/%2e%2e/search',
    'https://captcha.example.com/recaptcha/%2E./search', 'https://captcha.example.com/recaptcha/a%5c..%5csearch',
    'wss://captcha.example.com/recaptcha/ws',
  ]) assert.equal(allowed(human, url, 'GET', 'script'), false, url)
  // A dot segment is resolved by the address parser before the prefix is compared.
  assert.equal(allowed(human, 'https://captcha.example.com/recaptcha/../search', 'GET', 'script'), false)
  assert.equal(allowed(human, 'https://CAPTCHA.example.com/recaptcha/api.js', 'GET', 'script'), true, 'host names compare without case, as the browser sends them')
  // No helpers declared: the host is just another host.
  assert.equal(allowed(state('human', { helpers: [] }), 'https://captcha.example.com/recaptcha/api.js', 'GET', 'script'), false)
  // A closed window refuses everything.
  assert.equal(allowed(state('human', { site: null }), 'https://captcha.example.com/recaptcha/api.js', 'GET', 'script'), false)
})

test('the site\'s own rules are unchanged by helpers: an asset host is still parts only, another host still refused', () => {
  const human = state('human')
  assert.equal(allowed(human, 'https://cdn.example.net/x.js', 'GET', 'script'), true)
  assert.equal(allowed(human, 'https://cdn.example.net/frame', 'GET', 'subFrame'), false)
  assert.equal(allowed(human, 'https://evil.example.org/recaptcha/api.js', 'GET', 'script'), false)
  assert.equal(allowed(human, 'https://manager.example.net/save', 'POST', 'xhr'), true)
})

test('a frame may navigate to a helper only in human mode, only a subframe, only a helper that may be framed, only under its prefix', () => {
  const url = 'https://captcha.example.com/recaptcha/api2/anchor?k=1'
  assert.equal(windowNavigationAllowed(state('human'), url, false), true)
  assert.equal(windowNavigationAllowed(state('ai'), url, false), false, 'never while the AI operates')
  assert.equal(windowNavigationAllowed(state('human'), url, true), false, 'never the main frame')
  assert.equal(windowNavigationAllowed(state('human'), 'https://parts.example.com/recaptcha/x', false), false, 'not framed unless declared')
  assert.equal(windowNavigationAllowed(state('human'), 'https://captcha.example.com/other', false), false)
  assert.equal(windowNavigationAllowed(state('human'), 'http://captcha.example.com/recaptcha/x', false), false)
  assert.equal(windowNavigationAllowed(state('human', { site: null }), url, false), false)
  // The site's own rule still holds in both modes.
  assert.equal(windowNavigationAllowed(state('ai'), 'https://manager.example.net/a', true), true)
  assert.equal(windowNavigationAllowed(state('ai'), 'about:blank', false), true)
})

test('the proxy sends the helpers DIRECT in human mode only; in ai mode they go to the refusing proxy like any other host', () => {
  const find = (mode: BrowserWindowMode) => new Function(`${browserProxyScript(site, 4321, proxyHelperHosts(state(mode)))}; return FindProxyForURL`)() as (url: string, host: string) => string
  assert.equal(find('human')('https://captcha.example.com/', 'captcha.example.com'), 'DIRECT')
  assert.equal(find('human')('https://parts.example.com/', 'parts.example.com'), 'DIRECT')
  assert.equal(find('ai')('https://captcha.example.com/', 'captcha.example.com'), 'PROXY 127.0.0.1:4321')
  assert.equal(find('ai')('https://manager.example.net/', 'manager.example.net'), 'DIRECT')
  assert.equal(find('human')('https://evil.example.org/', 'evil.example.org'), 'PROXY 127.0.0.1:4321')
})

test('a frame is one the page\'s write gate sees only by origin and process, never by its address: the operated origin in the main frame\'s process', () => {
  const ORIGIN = 'https://manager.example.net'
  assert.equal(frameSeenByPageGate(site, 7, { origin: ORIGIN, processId: 7 }), true, 'the site\'s own frame, or an empty document it made')
  assert.equal(frameSeenByPageGate(site, 7, { origin: ORIGIN, processId: 8 }), false, 'the same origin in another process is its own target')
  assert.equal(frameSeenByPageGate(site, 7, { origin: 'null', processId: 7 }), false, 'an opaque frame (sandboxed srcdoc, data:) even in the same process')
  assert.equal(frameSeenByPageGate(site, 7, { origin: 'null', processId: 9 }), false)
  assert.equal(frameSeenByPageGate(site, 7, { origin: 'https://captcha.example.com', processId: 7 }), false, 'a helper\'s frame')
  assert.equal(frameSeenByPageGate(site, 7, { origin: 'http://manager.example.net', processId: 7 }), false)
  assert.equal(frameSeenByPageGate(site, 7, { origin: 'https://manager.example.net:8443', processId: 7 }), false)
  assert.equal(frameSeenByPageGate(site, 7, null), false, 'a frame not known (gone) is never one')
  assert.equal(foreignFrameCount(site, 7, []), 0)
  assert.equal(foreignFrameCount(site, 7, [{ origin: ORIGIN, processId: 7 }, { origin: ORIGIN, processId: 7 }]), 0)
  assert.equal(foreignFrameCount(site, 7, [{ origin: ORIGIN, processId: 7 }, { origin: 'null', processId: 7 }, { origin: 'https://captcha.example.com', processId: 12 }]), 2)
})

test('while the AI operates the window refuses every request of a frame its write gate does not see, reads included; the main frame\'s own navigation and the member\'s browsing are not asked', () => {
  const ai = state('ai')
  const req = (method: string, resourceType: string, pageFrame: boolean) =>
    decideWindowRequest(ai, { url: 'https://manager.example.net/line/x', method, resourceType, fromWindow: true, pageFrame })
  assert.deepEqual(req('POST', 'xhr', false), { allow: false, reason: 'ai-other-frame' })
  assert.deepEqual(req('GET', 'xhr', false), { allow: false, reason: 'ai-other-frame' })
  assert.deepEqual(req('GET', 'subFrame', false), { allow: false, reason: 'ai-other-frame' })
  assert.deepEqual(req('GET', 'mainFrame', false), { allow: true })
  assert.deepEqual(req('POST', 'xhr', true), { allow: true }, 'the page\'s own: the gate decides it')
  assert.equal(decideWindowRequest(state('human'), { url: 'https://manager.example.net/line/x', method: 'POST', resourceType: 'xhr', fromWindow: true, pageFrame: false }).allow, true)
})

test('Lステップ\'s declaration lists Google\'s reCAPTCHA as its only login helpers, under /recaptcha/, framed and posted to on www.google.com only', () => {
  const browser = createBrowserConnectors([LSTEP_DECLARATION])('lstep', '0.6.2')
  assert.ok(browser)
  assert.deepEqual(browser.loginHelpers, [
    { host: 'www.google.com', pathPrefix: '/recaptcha/', frame: true, post: true },
    { host: 'www.gstatic.com', pathPrefix: '/recaptcha/', frame: false, post: false },
  ])
  const of = browserLoginHelpers([LSTEP_DECLARATION])
  assert.deepEqual(of('manager.linestep.net'), browser.loginHelpers)
  assert.deepEqual(of('www.google.com'), [], 'a helper is no site of its own')
  // Two declarations for one host: which one is meant cannot be told, so none.
  const other = LSTEP_DECLARATION.replace('id: lstep', 'id: lstepcopy')
  assert.deepEqual(browserLoginHelpers([LSTEP_DECLARATION, other])('manager.linestep.net'), [])
  assert.deepEqual(browserLoginHelpers(['not a declaration'])('manager.linestep.net'), [])
})

test('helpers come only from a declaration this build carries and the approved list approves, the same text and checker: pending, retired, another text or two rows lend none', () => {
  const rows = (approvedFile as { combinations: Array<Record<string, unknown>> }).combinations
  const own = { ...rows.find(r => r.connector === 'lstep' && r.version === '0.6.2')!, status: 'approved' }
  const withRow = (row: Record<string, unknown> | null, extra: Array<Record<string, unknown>> = []) =>
    approvedBundledDeclarations({ format: 1, combinations: [...(row ? [row] : []), ...extra] }, carriedFile, [LSTEP_DECLARATION])
  assert.deepEqual(withRow(own), [LSTEP_DECLARATION])
  // As the app composes it, with this build's own list: helpers exactly when its row is approved.
  const shipped = rows.find(r => r.connector === 'lstep' && r.version === '0.6.2')!.status
  assert.equal(bundledLoginHelpers([LSTEP_DECLARATION])('manager.linestep.net').length, shipped === 'approved' ? 2 : 0)
  assert.deepEqual(withRow({ ...own, status: 'pending' }), [])
  assert.deepEqual(withRow({ ...own, status: 'retired' }), [])
  assert.deepEqual(withRow({ ...own, declaration: `${own.declaration}# edited\n` }), [])
  assert.deepEqual(withRow({ ...own, checkerHash: `sha256:${'0'.repeat(64)}` }), [])
  assert.deepEqual(withRow(own, [own]), [], 'two rows for one combination: none')
  assert.deepEqual(withRow(null), [])
  assert.deepEqual(approvedBundledDeclarations(approvedFile, { format: 1, combinations: [] }, [LSTEP_DECLARATION]), [], 'not carried by this build')
  // A bundled text other than the approved one (a modified folder) gets none.
  const changed = LSTEP_DECLARATION.replace('path_prefix: "/recaptcha/", frame: true', 'path_prefix: "/recaptcha/api2/", frame: true')
  assert.deepEqual(approvedBundledDeclarations(approvedFile, carriedFile, [changed]), [])
})
