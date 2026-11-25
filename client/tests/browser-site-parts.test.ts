/**
 * A registered domain's 「詳しい設定」 in the app (redesign step ②, agent-browser.md "A domain's parts and login
 * helpers"): the parts hosts and login helpers the window applies come from the company's setting of that domain in
 * the policy (`browserParts`), the bundled declaration only for a domain the company set nothing for, never both;
 * a parts host is read-only (GET / HEAD of parts, never a page, a frame, a fetch or a write, in either mode); a
 * domain the company operates is never lent to another as a part or a helper; another company's settings never
 * reach this company's window; the `browser` part released apps validate is untouched. A fictional site only.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import type { BrowserSiteSetting } from '../../shared/core/browser-operation'
import type { BrowserSiteParts } from '../../shared/core/browser-site-parts'
import type { BrowserLoginHelper } from '../../shared/core/plugin-browser-declaration'
import type { AgentPolicy } from '../../shared/types/agent-sandbox'
import { decideWindowRequest, windowNavigationAllowed, type BrowserWindowSite, type BrowserWindowState } from '../shared/browser-operation'
import { parseAgentPolicy } from '../electron/services/agent-policy-store'
import { createBrowserController, type BrowserShell, type BrowserWindowSpec } from '../electron/features/browser/controller'

const SHOP = 'shop.example.com'
const DESK = 'desk.example.com'
const HELPER: BrowserLoginHelper = { host: 'check.example.org', pathPrefix: '/challenge/', frame: true, post: true }
const OWN: BrowserSiteParts = { host: SHOP, assetHosts: ['img.example.net'], loginHelpers: [HELPER] }
const BUNDLED = { assets: ['bundled-img.example.net'], helpers: [{ host: 'bundled-check.example.org', pathPrefix: '/c/', frame: true, post: false }] as BrowserLoginHelper[] }

const site = (host: string): BrowserSiteSetting => ({ host, level: 'write', assetHosts: [] })
const wire = (sites: BrowserSiteSetting[], browserParts?: unknown) => ({
  version: 'v1',
  sandbox: { mode: 'off', allowedDomains: [], deniedReadPaths: [], onUnavailable: 'record-only', source: 'company' },
  browser: { mode: 'on', sites, source: 'company' },
  ...(browserParts !== undefined ? { browserParts } : {}),
})

test('the policy keeps only valid domain settings, beside a browser part whose shape does not change', () => {
  const withParts = parseAgentPolicy(wire([site(SHOP), site(DESK)], [OWN]))
  const without = parseAgentPolicy(wire([site(SHOP), site(DESK)]))
  assert.deepEqual(withParts?.browserParts, [OWN])
  assert.deepEqual(withParts?.browser, without?.browser, 'the browser part released apps read is the same')
  // A registered domain lent as a part or a helper, a domain not registered, a wildcard: left out, never the policy.
  const bad = parseAgentPolicy(wire([site(SHOP), site(DESK)], [
    { ...OWN, assetHosts: [DESK] },
    { ...OWN, host: 'other.example.com' },
    { ...OWN, host: DESK, assetHosts: ['*.example.net'], loginHelpers: [] },
    { ...OWN, loginHelpers: [{ ...HELPER, host: DESK }] },
  ]))
  assert.ok(bad?.browser)
  assert.equal(bad?.browserParts, undefined)
  // Without a valid browser part nothing is taken.
  assert.equal(parseAgentPolicy({ ...wire([site(SHOP)], [OWN]), browser: { mode: 'on' } })?.browserParts, undefined)
})

function world() {
  const opened: Array<BrowserWindowSpec & { site: BrowserWindowSite }> = []
  const shell: BrowserShell = {
    open(spec) {
      const entry = { ...spec, site: spec.site as BrowserWindowSite }
      opened.push(entry)
      return { focus() {}, close() {}, updateSite(next) { entry.site = next as BrowserWindowSite } }
    },
    clearPartition: async () => {},
  }
  const logged: string[] = []
  const browser = createBrowserController({
    shell, userId: () => 'user-1', log: { warn: (line: string) => { logged.push(line) } },
    assetHostsOf: host => (host === SHOP ? BUNDLED.assets : []),
    loginHelpersOf: host => (host === SHOP ? BUNDLED.helpers : []),
  })
  return { browser, opened, logged }
}
const policy = (sites: BrowserSiteSetting[], browserParts?: BrowserSiteParts[]) => parseAgentPolicy(wire(sites, browserParts)) as AgentPolicy

test('the window takes the company\'s setting of its domain, else the bundled fallback (logged), never both', () => {
  const w = world()
  w.browser.policyAnswered('c1', policy([site(SHOP)]))
  w.browser.open('c1', SHOP)
  assert.deepEqual(w.opened[0].site.assetHosts, BUNDLED.assets)
  assert.deepEqual(w.opened[0].site.loginHelpers, BUNDLED.helpers)
  assert.equal(w.logged.filter(l => l.includes('bundled')).length, 1, 'the fallback is said')

  w.browser.policyAnswered('c1', policy([site(SHOP)], [OWN]))
  assert.deepEqual(w.opened[0].site.assetHosts, OWN.assetHosts, 'an open window gets the company\'s at once')
  assert.deepEqual(w.opened[0].site.loginHelpers, OWN.loginHelpers, 'no bundled helper beside the company\'s')
  assert.deepEqual(w.browser.siteNow('c1', SHOP)?.assetHosts, OWN.assetHosts)
})

test('another company\'s domain settings never reach this company\'s window', () => {
  const w = world()
  w.browser.policyAnswered('c1', policy([site(SHOP)], [OWN]))
  w.browser.policyAnswered('c2', policy([site(SHOP)]))
  w.browser.open('c2', SHOP)
  assert.deepEqual(w.opened[0].site.assetHosts, BUNDLED.assets)
  assert.ok(!w.opened[0].site.assetHosts.includes('img.example.net'))
  assert.ok(!w.opened[0].site.loginHelpers.some(h => h.host === HELPER.host))
})

test('a domain the company operates is never another domain\'s part or helper, whichever source names it', () => {
  const w = world()
  // The fallback names a registered domain: it is dropped all the same.
  const operatedFallback = createBrowserController({
    shell: { open: spec => { w.opened.push({ ...spec, site: spec.site as BrowserWindowSite }); return { focus() {}, close() {}, updateSite() {} } }, clearPartition: async () => {} },
    userId: () => 'user-1', log: { warn() {} },
    assetHostsOf: () => [DESK, 'img.example.net'],
    loginHelpersOf: () => [{ ...HELPER, host: DESK }],
  })
  operatedFallback.policyAnswered('c1', policy([site(SHOP), site(DESK)]))
  operatedFallback.open('c1', SHOP)
  assert.deepEqual(w.opened[0].site.assetHosts, ['img.example.net'])
  assert.deepEqual(w.opened[0].site.loginHelpers, [])
})

test('a parts host from the company\'s setting is read-only: parts only, never a page, a frame, a fetch or a write; unregistered hosts never pass', () => {
  const w = world()
  w.browser.policyAnswered('c1', policy([site(SHOP)], [OWN]))
  const s = w.browser.siteNow('c1', SHOP) as BrowserWindowSite
  for (const mode of ['human', 'ai'] as const) {
    const state: BrowserWindowState = { site: s, mode, aiGateReady: mode === 'ai', helpers: s.loginHelpers }
    const req = (url: string, resourceType: string, method = 'GET') => decideWindowRequest(state, { url, method, resourceType, fromWindow: true, pageFrame: true }).allow
    assert.equal(req('https://img.example.net/a.png', 'image'), true, mode)
    assert.equal(req('https://img.example.net/a.css', 'stylesheet', 'HEAD'), true, mode)
    assert.equal(req('https://img.example.net/a', 'xhr'), false, `${mode}: a fetch`)
    assert.equal(req('https://img.example.net/a', 'xhr', 'POST'), false, `${mode}: a write`)
    assert.equal(req('https://img.example.net/a.png', 'image', 'POST'), false, `${mode}: a write`)
    assert.equal(req('https://img.example.net/', 'mainFrame'), false, `${mode}: a page`)
    assert.equal(req('https://img.example.net/', 'subFrame'), false, `${mode}: a frame`)
    assert.equal(windowNavigationAllowed(state, 'https://img.example.net/', true), false, `${mode}: navigated as a page`)
    assert.equal(windowNavigationAllowed(state, 'https://img.example.net/', false), false, `${mode}: framed`)
    assert.equal(req('wss://img.example.net/', 'webSocket'), false, mode)
    assert.equal(req('https://unlisted.example.net/a.png', 'image'), false, `${mode}: an unregistered host`)
    // The login helper: only while a person logs in, under its path.
    assert.equal(req('https://check.example.org/challenge/x.js', 'script'), mode === 'human', `${mode}: the helper`)
    assert.equal(req('https://check.example.org/other/x.js', 'script'), false, `${mode}: outside the helper's path`)
  }
})
