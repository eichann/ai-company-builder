// Web permissions (electron/permission-policy.ts, installed by
// electron-adapter.ts `guardEverySession` from main.ts): every session refuses
// what the app does not use and every page that is not the app's own. Electron
// grants everything when no handler is set, so removing the wiring or the
// policy fails these.
import { test, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { loadMain, type MainHarness } from './ipc-harness/main-harness.ts'
import { app, BrowserWindow, FakeSession, session } from './ipc-harness/fake-electron.ts'
import { isAppPage } from '../electron/permission-policy.ts'

let h: MainHarness
let appPage: string

before(async () => {
  h = await loadMain()
  await h.startApp()
  // The page main loaded into its window (dist/index.html).
  appPage = pathToFileURL(String(BrowserWindow.all[0].webContents.loaded)).href
})
after(() => h.shutdown())

async function assertGuarded(ses: FakeSession) {
  // What the app uses, asked by its own page (the main window, a consultation window).
  assert.equal(await ses.request('clipboard-sanitized-write', appPage), true)
  assert.equal(await ses.request('clipboard-sanitized-write', `${appPage}?window=chat`), true)
  assert.equal(ses.check('clipboard-sanitized-write', appPage), true)
  // Anything else, even from the app's page: voice input does not use getUserMedia.
  for (const permission of ['media', 'display-capture', 'notifications', 'geolocation', 'clipboard-read', 'openExternal', 'usb', 'unknown']) {
    assert.equal(await ses.request(permission, appPage), false, `${permission} from the app's page`)
    assert.equal(ses.check(permission, appPage), false, `${permission} check from the app's page`)
  }
  // What the app uses, asked by any other page.
  for (const page of ['https://example.com/', 'file:///Users/me/Downloads/dropped.html', 'blob:file:///0b6c', 'data:text/html,x']) {
    assert.equal(await ses.request('clipboard-sanitized-write', page), false, page)
    assert.equal(ses.check('fullscreen', page), false, page)
  }
}

test('the default session refuses every permission request the app does not use, and every page that is not the app', async () => {
  await assertGuarded(session.defaultSession)
})

test('a session created later is guarded the same way', async () => {
  const later = new FakeSession()
  app.emit('session-created', later)
  await assertGuarded(later)
})

test('in development only the Vite dev server\'s origin is the app', () => {
  const page = { file: 'file:///Applications/AICompanyBuilder.app/Contents/Resources/app.asar/dist/index.html', devServerUrl: 'http://localhost:5173/' }
  assert.equal(isAppPage('http://localhost:5173/?window=chat', page), true)
  assert.equal(isAppPage('http://localhost:5174/', page), false)
  assert.equal(isAppPage(page.file, page), false)
  assert.equal(isAppPage(page.file, { file: page.file }), true)
  assert.equal(isAppPage(undefined, { file: page.file }), false)
})
