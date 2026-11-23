/**
 * A site's asset hosts (agent-browser.md "Asset hosts"; owner decision 2026-11-23, plan B): the hosts a
 * site's pages load parts from (fonts, images, scripts, styles) are its reviewed declaration's alone —
 * from a bundled declaration this build carries and the approved list approves —, never the company's
 * free-text list, which is a developer setting a development build adds only when it asks for it.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import type { BrowserSiteSetting } from '../../shared/core/browser-operation'
import type { AgentPolicy } from '../../shared/types/agent-sandbox'
import { browserWindowSite, decideWindowRequest, type BrowserWindowState } from '../shared/browser-operation'
import { browserAssetHosts, createBrowserConnectors } from '../shared/browser-checkers'
import { LSTEP_DECLARATION } from '../connectors/lstep/declaration'
import { createBrowserController, type BrowserShell, type BrowserWindowSpec } from '../electron/features/browser/controller'
import { approvedBundledDeclarations } from '../electron/features/browser/combination'
import { bundledAssetHosts } from '../electron/features/browser/wire'
import approvedFile from '../../shared/browser-connectors/approved.json'
import carriedFile from '../../shared/browser-connectors/carried.json'

const HOST = 'manager.linestep.net'
const LSTEP_PARTS = ['d1nhtjid4lgi9y.cloudfront.net', 'profile.line-scdn.net', 'fonts.googleapis.com', 'fonts.gstatic.com']

test('the window\'s asset hosts are the declaration\'s; the company\'s free-text list counts only for a development build that asks', () => {
  const site: BrowserSiteSetting = { host: HOST, level: 'write', assetHosts: ['www.google.com', 'cdn.example.net'] }
  assert.deepEqual(browserWindowSite(site, LSTEP_PARTS, false), { host: HOST, level: 'write', assetHosts: LSTEP_PARTS })
  assert.deepEqual(browserWindowSite(site, [], false).assetHosts, [], 'no declaration: no asset host, whatever the company typed')
  assert.deepEqual(browserWindowSite(site, LSTEP_PARTS, true).assetHosts, [...LSTEP_PARTS, 'www.google.com', 'cdn.example.net'])
  // Only exact hosts, never the operated host, each once — also from a declaration handed in carelessly.
  assert.deepEqual(browserWindowSite(site, [HOST, 'Fonts.Gstatic.com', '*.gstatic.com', 'fonts.gstatic.com', 'fonts.gstatic.com', 'localhost'], false).assetHosts, ['fonts.gstatic.com'])
  assert.deepEqual(browserWindowSite({ ...site, assetHosts: [HOST, 'cdn.example.net'] }, [], true).assetHosts, ['cdn.example.net'])
})

function world(options: { assetHostsOf?: (host: string) => readonly string[]; developerAssetHosts?: boolean } = {}) {
  const opened: Array<BrowserWindowSpec & { site: BrowserSiteSetting }> = []
  const shell: BrowserShell = {
    open(spec) {
      const entry = { ...spec }
      opened.push(entry)
      return {
        focus() {}, close() {}, updateSite(next) { entry.site = next },
        run: { enterAi: async () => true, leaveAi: async () => {}, pageClean: () => true, request: async () => ({ status: 200, body: '' }), closed: () => false },
      }
    },
    clearPartition: async () => {},
  }
  const browser = createBrowserController({ shell, userId: () => 'user-1', log: { warn() {} }, ...options })
  return { browser, opened }
}
const policy = (sites: BrowserSiteSetting[]): AgentPolicy =>
  ({ version: 'v', sandbox: { mode: 'enforce', allowedDomains: [], deniedReadPaths: [], onUnavailable: 'record-only', source: 'company' }, browser: { mode: 'on', sites, source: 'company' } }) as AgentPolicy

test('the controller hands the window and the runner the declaration\'s asset hosts, never the policy\'s list (stored by an admin before plan B)', () => {
  const stored: BrowserSiteSetting = { host: HOST, level: 'write', assetHosts: ['www.google.com', 'cdn.example.net'] }
  const w = world({ assetHostsOf: host => (host === HOST ? LSTEP_PARTS : []) })
  w.browser.policyAnswered('c1', policy([stored]))
  assert.equal(w.browser.open('c1', HOST).ok, true)
  assert.deepEqual(w.opened[0].site.assetHosts, LSTEP_PARTS)
  assert.deepEqual(w.browser.siteNow('c1', HOST)?.assetHosts, LSTEP_PARTS)
  // A changed policy (the admin edits the hidden list) changes nothing the window loads from.
  w.browser.policyAnswered('c1', policy([{ ...stored, assetHosts: ['evil.example.org'] }]))
  assert.deepEqual(w.opened[0].site.assetHosts, LSTEP_PARTS)

  const dev = world({ assetHostsOf: () => LSTEP_PARTS, developerAssetHosts: true })
  dev.browser.policyAnswered('c1', policy([stored]))
  dev.browser.open('c1', HOST)
  assert.deepEqual(dev.opened[0].site.assetHosts, [...LSTEP_PARTS, 'www.google.com', 'cdn.example.net'], 'a development build that asks adds the list')

  const none = world()
  none.browser.policyAnswered('c1', policy([stored]))
  none.browser.open('c1', HOST)
  assert.deepEqual(none.opened[0].site.assetHosts, [], 'nothing composed: nothing loads from elsewhere')
})

test('Lステップ 0.6.3 loads its images and icon fonts, and its trackers stay refused (the real run, 6c)', () => {
  const browser = createBrowserConnectors([LSTEP_DECLARATION])('lstep', '0.6.3')
  assert.ok(browser)
  assert.deepEqual(browser.assetHosts, LSTEP_PARTS)
  assert.deepEqual(browserAssetHosts([LSTEP_DECLARATION])(HOST), LSTEP_PARTS)
  assert.deepEqual(browserAssetHosts([LSTEP_DECLARATION])('fonts.gstatic.com'), [], 'an asset host is no site of its own')
  // Two declarations for one host: which one is meant cannot be told, so none.
  assert.deepEqual(browserAssetHosts([LSTEP_DECLARATION, LSTEP_DECLARATION.replace('id: lstep', 'id: lstepcopy')])(HOST), [])

  const site = browserWindowSite({ host: HOST, level: 'write', assetHosts: [] }, browser.assetHosts, false)
  for (const mode of ['human', 'ai'] as const) {
    const state: BrowserWindowState = { site, mode, aiGateReady: mode === 'ai', helpers: browser.loginHelpers }
    const req = (url: string, resourceType: string, method = 'GET') => decideWindowRequest(state, { url, method, resourceType, fromWindow: true, pageFrame: true }).allow
    assert.equal(req('https://fonts.googleapis.com/icon?family=Material+Icons', 'stylesheet'), true, mode)
    assert.equal(req('https://fonts.gstatic.com/s/materialicons/v1/a.woff2', 'font'), true, mode)
    assert.equal(req('https://profile.line-scdn.net/x.png', 'image'), true, mode)
    // Parts only: never a frame, a fetch or a write on them.
    assert.equal(req('https://fonts.googleapis.com/x', 'subFrame'), false, mode)
    assert.equal(req('https://fonts.gstatic.com/x', 'xhr'), false, mode)
    assert.equal(req('https://fonts.gstatic.com/x', 'xhr', 'POST'), false, mode)
    for (const tracker of ['https://www.googletagmanager.com/gtm.js', 'https://sessions.bugsnag.com/', 'https://browser-intake-datadoghq.com/api/v2/rum', 'https://app.chatplus.jp/cp.js']) {
      assert.equal(req(tracker, 'script'), false, `${mode} ${tracker}`)
    }
  }
})

test('asset hosts come only from a declaration this build carries and the approved list approves: pending, retired or another text lend none', () => {
  const rows = (approvedFile as { combinations: Array<Record<string, unknown>> }).combinations
  const own = { ...rows.find(r => r.connector === 'lstep' && r.version === '0.6.3')!, status: 'approved' }
  const hostsWith = (row: Record<string, unknown>) =>
    browserAssetHosts(approvedBundledDeclarations({ format: 1, combinations: [row] }, carriedFile, [LSTEP_DECLARATION]))(HOST)
  assert.deepEqual(hostsWith(own), LSTEP_PARTS)
  assert.deepEqual(hostsWith({ ...own, status: 'pending' }), [])
  assert.deepEqual(hostsWith({ ...own, status: 'retired' }), [])
  assert.deepEqual(hostsWith({ ...own, declaration: `${own.declaration}# edited\n` }), [])
  // As the app composes it, with this build's own list: the hosts exactly when its row is approved.
  const shipped = rows.find(r => r.connector === 'lstep' && r.version === '0.6.3')!.status
  assert.deepEqual(bundledAssetHosts([LSTEP_DECLARATION])(HOST), shipped === 'approved' ? LSTEP_PARTS : [])
})
