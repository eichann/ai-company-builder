// IPC characterization of 「別ウィンドウで開く」 (electron/features/chat-windows
// wired in main.ts): a consultation window is as hardened as the main window,
// the handlers that check their sender accept exactly the windows they are
// for, conversation events reach the consultation windows, and sign-out
// closes them. The window registry's rules: chat-windows.test.ts.
import { test, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { loadMain, type MainHarness } from './ipc-harness/main-harness.ts'
import { BrowserWindow, type FakeWebContents } from './ipc-harness/fake-electron.ts'
import type { ChatSession } from '../shared/chat-history'

let h: MainHarness
let root: string

before(async () => {
  h = await loadMain()
  await h.startApp()
  root = h.companyDir('acme')
  await h.invoke('fs:registerAllowedRoot', root)
})
after(() => h.shutdown())

const request = (title = 'A社の見積') => ({ companyId: 'acme', companyName: 'Acme', rootPath: root, title })
const windowsNow = () => BrowserWindow.getAllWindows()
type Prefs = { webPreferences: Record<string, unknown> }

async function openWindow(sessionId: string): Promise<BrowserWindow> {
  const before = windowsNow().length
  assert.deepEqual(await h.invoke('chatWindow:open', sessionId, request()), { ok: true, focused: false })
  assert.equal(windowsNow().length, before + 1)
  return windowsNow().at(-1)!
}

test('a consultation window gets the main window\'s hardened web preferences, loads only the chat page and opens no popups', async () => {
  const win = await openWindow('session-prefs')
  const main = BrowserWindow.all[0].options as Prefs
  const prefs = (win.options as Prefs).webPreferences
  assert.deepEqual(prefs, main.webPreferences)
  assert.equal(prefs.contextIsolation, true)
  assert.equal(prefs.nodeIntegration, false)
  assert.equal(prefs.sandbox, true)
  assert.match(String(prefs.preload), /preload\.js$/)
  // Same page as the main window (its CSP), told to show only the chat.
  assert.equal(win.webContents.loaded, BrowserWindow.all[0].webContents.loaded)
  assert.deepEqual(win.webContents.loadOptions, { query: { window: 'chat' } })
  assert.deepEqual(win.webContents.windowOpenHandler?.(), { action: 'deny' })
  win.close()
})

test('the sender checks accept exactly the windows they are for: the main window manages, a consultation window reads only its own', async () => {
  const win = await openWindow('session-senders')
  const page: FakeWebContents = win.webContents
  assert.deepEqual(await h.invokeAs(page, 'chatWindow:getContext'), { ...request(), sessionId: 'session-senders' })
  assert.equal(await h.invoke('chatWindow:getContext'), null)
  assert.equal(await h.invokeAs(page, 'chatWindow:reportStatus', { state: 'working', line: '調べています' }), true)
  assert.equal(await h.invoke('chatWindow:reportStatus', { state: 'working', line: '' }), false)
  // The main window's list hears the other window's status.
  assert.deepEqual(h.renderer().sentOn('chatWindow:changed').at(-1)?.[0], {
    windows: [{ companyId: 'acme', sessionId: 'session-senders', status: { state: 'working', line: '調べています' } }],
  })
  const opened = windowsNow().length
  assert.equal((await h.invokeAs<{ ok: boolean }>(page, 'chatWindow:open', 'other', request())).ok, false)
  assert.equal(windowsNow().length, opened)
  // Opening it again from the main window focuses the window that has it.
  assert.deepEqual(await h.invoke('chatWindow:open', 'session-senders', request()), { ok: true, focused: true })
  assert.equal(win.focused, 1)
  assert.equal(windowsNow().length, opened)
  h.fake.messageBoxResponses.push(1) // キャンセル
  win.close()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(win.isDestroyed(), false, 'closing mid-turn asks first; キャンセル keeps the window')
  assert.match(JSON.stringify(h.fake.messageBoxes.at(-1)), /AIが作業中です。閉じると止まります/)
  h.fake.messageBoxResponses.push(0) // 閉じる
  win.close()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(win.isDestroyed(), true)
  assert.deepEqual(h.renderer().sentOn('chatWindow:changed').at(-1)?.[0], { windows: [], closed: { companyId: 'acme', sessionId: 'session-senders' } })
})

test('a window opens only in a registered company folder', async () => {
  const before = windowsNow().length
  const answer = await h.invoke<{ ok: boolean }>('chatWindow:open', 'session-outside', { ...request(), rootPath: h.companyDir('not-registered') })
  assert.equal(answer.ok, false)
  assert.equal(windowsNow().length, before)
})

test('conversation changes reach the consultation windows too (a deleted conversation closes its window)', async () => {
  const win = await openWindow('session-events')
  const session: ChatSession = { id: 'session-events', companyId: 'acme', title: 't', messages: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
  await h.invoke('chatHistory:saveSession', 'acme', session)
  await h.invoke('chatHistory:deleteSession', 'acme', 'session-events')
  assert.ok(win.webContents.sentOn('chatHistory:changed').some(([change]) => (change as { deletedSessionId?: string }).deletedSessionId === 'session-events'))
  win.close()
})

test('signing out closes every consultation window without asking', async () => {
  const win = await openWindow('session-signout')
  await h.invokeAs(win.webContents, 'chatWindow:reportStatus', { state: 'working', line: '' })
  const boxes = h.fake.messageBoxes.length
  await h.invoke('auth:signOut')
  assert.equal(win.isDestroyed(), true)
  assert.equal(h.fake.messageBoxes.length, boxes)
  assert.deepEqual(await h.invoke('chatWindow:list'), [])
})
