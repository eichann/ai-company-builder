/**
 * The browser-operation setting (shared/core/browser-operation.ts): what an
 * admin may store, which requests the browser window lets through, and where
 * the site's login is kept.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  browserLoginStorage, decideBrowserRequest, levelAllows, normalizeBrowserHost, parseBrowserOperationSettings,
  type BrowserSiteSetting,
} from '../../shared/core/browser-operation'

const site: BrowserSiteSetting = { host: 'manager.example.net', level: 'write', assetHosts: ['cdn.example.net'] }
const req = (url: string, method = 'GET', resourceType = 'xhr') => decideBrowserRequest(site, { url, method, resourceType })

test('settings: hosts are exact, one entry per operated host, and the operated host is never an asset host', () => {
  const ok = parseBrowserOperationSettings({ mode: 'on', sites: [{ host: ' Manager.Example.NET. ', level: 'write', assetHosts: ['CDN.example.net', 'cdn.example.net'] }] })
  assert.deepEqual(ok, { value: { mode: 'on', sites: [{ host: 'manager.example.net', level: 'write', assetHosts: ['cdn.example.net'] }] } })

  // A wildcard would cover hosts nobody looked at.
  assert.equal(normalizeBrowserHost('*.example.net'), undefined)
  assert.ok('error' in parseBrowserOperationSettings({ mode: 'on', sites: [{ host: '*.example.net', level: 'read', assetHosts: [] }] }))
  assert.ok('error' in parseBrowserOperationSettings({ mode: 'on', sites: [{ host: 'a.example.net', level: 'read', assetHosts: ['*.cloudfront.net'] }] }))
  for (const bad of ['127.0.0.1', 'localhost', 'https://a.example.net', 'a.example.net:8443', 'example']) {
    assert.equal(normalizeBrowserHost(bad), undefined, bad)
  }
  assert.ok('error' in parseBrowserOperationSettings({ mode: 'on', sites: [site, { ...site, level: 'read' }] }))
  assert.ok('error' in parseBrowserOperationSettings({ mode: 'on', sites: [{ ...site, assetHosts: [site.host] }] }))
  assert.ok('error' in parseBrowserOperationSettings({ mode: 'on', sites: [{ ...site, level: 'admin' }] }))
  assert.ok('error' in parseBrowserOperationSettings({ mode: 'enforce', sites: [] }))
})

test('levels: a site\'s level caps what an operation type may do there', () => {
  assert.equal(levelAllows('read', 'read'), true)
  assert.equal(levelAllows('read', 'write'), false)
  assert.equal(levelAllows('write', 'write'), true)
  assert.equal(levelAllows('write', 'delete'), false)
  assert.equal(levelAllows('delete', 'delete'), true)
})

test('requests: the operated host over HTTPS on the default port, any method', () => {
  assert.deepEqual(req('https://manager.example.net/line/episode/show/1'), { allow: true, use: 'operate' })
  assert.deepEqual(req('https://manager.example.net/api/save', 'POST'), { allow: true, use: 'operate' })
  assert.deepEqual(req('wss://manager.example.net/socket', 'GET', 'webSocket'), { allow: true, use: 'operate' })
})

test('requests: an asset host only for GET of scripts, styles, fonts and images', () => {
  assert.deepEqual(req('https://cdn.example.net/app.js', 'GET', 'script'), { allow: true, use: 'asset' })
  assert.deepEqual(req('https://cdn.example.net/logo.png', 'HEAD', 'image'), { allow: true, use: 'asset' })
  // An asset host is not a way out: no writes, no fetches, no pages, no frames, no sockets.
  assert.deepEqual(req('https://cdn.example.net/x', 'POST', 'script'), { allow: false, reason: 'asset-use' })
  assert.deepEqual(req('https://cdn.example.net/x?d=secret', 'GET', 'xhr'), { allow: false, reason: 'asset-use' })
  assert.deepEqual(req('https://cdn.example.net/', 'GET', 'mainFrame'), { allow: false, reason: 'asset-use' })
  assert.deepEqual(req('https://cdn.example.net/', 'GET', 'subFrame'), { allow: false, reason: 'asset-use' })
  assert.deepEqual(req('wss://cdn.example.net/', 'GET', 'webSocket'), { allow: false, reason: 'host' })
})

test('requests: everything else is refused', () => {
  assert.deepEqual(req('https://evil.example.org/fetch?d=secret'), { allow: false, reason: 'host' })
  assert.deepEqual(req('https://sub.manager.example.net/'), { allow: false, reason: 'host' })
  assert.deepEqual(req('http://manager.example.net/'), { allow: false, reason: 'scheme' })
  assert.deepEqual(req('ws://manager.example.net/'), { allow: false, reason: 'scheme' })
  assert.deepEqual(req('javascript:alert(1)'), { allow: false, reason: 'scheme' })
  assert.deepEqual(req('file:///etc/passwd'), { allow: false, reason: 'scheme' })
  assert.deepEqual(req('https://manager.example.net:8443/'), { allow: false, reason: 'port' })
  assert.deepEqual(req('https://127.0.0.1/'), { allow: false, reason: 'host' })
  assert.deepEqual(req('https://[::1]/'), { allow: false, reason: 'host' })
  assert.deepEqual(req('https://user:pw@manager.example.net/'), { allow: false, reason: 'bad-url' })
  assert.deepEqual(req('not a url'), { allow: false, reason: 'bad-url' })
})

test('login: kept on disk only when the member\'s AI sandbox encloses the AI', () => {
  assert.equal(browserLoginStorage('enforce'), 'disk')
  assert.equal(browserLoginStorage('observe'), 'memory')
  assert.equal(browserLoginStorage('off'), 'memory')
})
