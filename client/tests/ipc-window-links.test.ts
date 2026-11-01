// Links in the app's windows (electron-adapter.ts `keepAppPageInWindow`, wired
// for the main window and the consultation windows): a `target="_blank"` link
// in a chat answer or a markdown preview, or a navigation away from the app,
// opens the member's own browser for web pages only and never another app
// window; file:, javascript:, mailto: and custom schemes are only refused.
import { test, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { loadMain, type MainHarness } from './ipc-harness/main-harness.ts'
import { BrowserWindow, fake } from './ipc-harness/fake-electron.ts'

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
