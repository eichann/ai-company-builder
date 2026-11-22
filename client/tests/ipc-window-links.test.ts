// Links in the app's windows (electron-adapter.ts `keepAppPageInWindow`, wired
// for the main window and the consultation windows): a `target="_blank"` link
// in a chat answer or a markdown preview, or a navigation away from the app,
// opens the member's own browser for web pages only and never another app
// window; file:, javascript:, mailto: and custom schemes are only refused.
import { test, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { loadMain, type MainHarness } from './ipc-harness/main-harness.ts'
import { BrowserWindow, fake, session } from './ipc-harness/fake-electron.ts'

let h: MainHarness

before(async () => {
  h = await loadMain()
  await h.startApp()
})
after(() => h.shutdown())

const notWeb = ['file:///Users/me/.zshrc', 'javascript:alert(1)', 'mailto:a@example.com', 'vscode://file/etc/passwd', 'local-file:///x', 'not a url']

test('the main window opens web links in the member\'s browser, never in a new app window, and refuses every other scheme', () => {
  const main = BrowserWindow.all[0].webContents
  const windowsBefore = BrowserWindow.getAllWindows().length
  fake.openedExternal.length = 0

  assert.deepEqual(main.windowOpenHandler?.({ url: 'https://example.com/a?b=1' }), { action: 'deny' })
  assert.deepEqual(main.windowOpenHandler?.({ url: 'http://localhost:3000/' }), { action: 'deny' })
  for (const url of notWeb) assert.deepEqual(main.windowOpenHandler?.({ url }), { action: 'deny' }, url)
  assert.deepEqual(fake.openedExternal, ['https://example.com/a?b=1', 'http://localhost:3000/'])
  assert.equal(BrowserWindow.getAllWindows().length, windowsBefore)
})

test('the main window never navigates away from the app\'s page; a web link goes to the browser', () => {
  const main = BrowserWindow.all[0].webContents
  fake.openedExternal.length = 0
  // The app's own page (a reload, a query) stays.
  const appPage = pathToFileURL(String(main.loaded)).href
  assert.equal(main.navigate(`${appPage}?window=chat`), false)

  assert.equal(main.navigate('https://example.com/'), true)
  for (const url of notWeb) assert.equal(main.navigate(url), true, url)
  assert.equal(main.navigate('file:///Users/me/Downloads/dropped.html'), true)
  assert.deepEqual(fake.openedExternal, ['https://example.com/'])
})

// A plugin's screen (plugin-frame.md): the acb-plugin scheme never bypasses the frame's CSP and is
// served by the package protocol; a frame showing a plugin's page navigates nowhere, and nothing it
// asks to open reaches the browser.
test('acb-plugin:// is registered without CSP bypass or fetch, and served once the app is ready', () => {
  assert.deepEqual(fake.privilegedSchemes.find(s => (s as { scheme: string }).scheme === 'acb-plugin'),
    { scheme: 'acb-plugin', privileges: { standard: true, secure: true, corsEnabled: true } })
  assert.ok(fake.protocolHandlers.get('acb-plugin'))
})

// The HTML viewer (doc-frame.md): acb-doc gets the plugin scheme's privileges and nothing more, its
// answers are served once the app is ready, and the default session cancels every web request a
// document frame (or a frame inside one) makes — the wall behind the CSP.
test('acb-doc:// is registered without CSP bypass or fetch; the session cancels a document\'s web requests', async () => {
  assert.deepEqual(fake.privilegedSchemes.find(s => (s as { scheme: string }).scheme === 'acb-doc'),
    { scheme: 'acb-doc', privileges: { standard: true, secure: true, corsEnabled: true } })
  const served = await fake.protocolHandlers.get('acb-doc')!(new Request(`acb-doc://${'0'.repeat(32)}/a.html`))
  assert.equal(served.status, 404)
  assert.equal(served.headers.get('x-content-type-options'), 'nosniff')

  const guard = session.defaultSession.beforeRequest
  assert.ok(guard, 'the default session has the document guard')
  assert.deepEqual(guard.filter.urls, ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'])
  const decide = (frame: unknown) => new Promise<boolean>(resolve => guard.listener({ url: 'https://example.com/x', frame }, answer => resolve(answer.cancel === true)))
  const doc = { url: `acb-doc://${'0'.repeat(32)}/a.html`, parent: { url: 'file:///app/index.html', parent: null } }
  assert.equal(await decide(doc), true, 'the document itself (fetch, image, its own navigation)')
  assert.equal(await decide({ url: 'about:srcdoc', parent: doc }), true, 'a frame inside the document')
  assert.equal(await decide({ url: 'file:///app/index.html', parent: null }), false, 'the app\'s own page')
  assert.equal(await decide(undefined), false, 'a request of no frame (main process)')
})

test('a plugin\'s frame cannot navigate, and its window.open never reaches the browser', () => {
  const main = BrowserWindow.all[0].webContents
  const frameNavigate = (frameUrl: string, url: string) => {
    let prevented = false
    main.emit('will-frame-navigate', { url, isMainFrame: false, frame: { url: frameUrl }, preventDefault: () => { prevented = true } })
    return prevented
  }
  const page = 'acb-plugin://planning/0.1.0/ui/index.html'
  assert.equal(frameNavigate('', page), false)
  for (const url of ['acb-plugin://planning/0.1.0/ui/b.html', 'acb-plugin://other/1.0.0/ui/index.html', 'https://example.com/', 'file:///etc/passwd']) {
    assert.equal(frameNavigate(page, url), true, url)
  }
  assert.equal(frameNavigate('', 'acb-plugin://planning/0.1.0/plugin.yaml'), true)

  fake.openedExternal.length = 0
  assert.deepEqual(main.windowOpenHandler?.({ url: 'https://example.com/', referrer: { url: page } } as { url: string }), { action: 'deny' })
  assert.deepEqual(main.windowOpenHandler?.({ url: page } as { url: string }), { action: 'deny' })
  assert.equal(main.navigate(page), true)
  assert.deepEqual(fake.openedExternal, [])
})
