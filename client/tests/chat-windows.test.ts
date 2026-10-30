// 「別ウィンドウで開く」 in the main process: which window shows which
// consultation (electron/features/chat-windows) and what a window's page may
// report. The Electron side (web preferences, who may call) is pinned in
// ipc-chat-windows.test.ts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerChatWindowsIpc, type ChatWindowHost } from '../electron/features/chat-windows/ipc'
import { createChatWindowRegistry } from '../electron/features/chat-windows/registry'
import { closeStopsTheAI, parseOpenRequest, parseWindowStatus, type ChatWindowContext, type ChatWindowsChange } from '../shared/chat-windows'
import type { IpcRegistrar } from '../electron/ipc/registrar'

const MAIN = 1
const ROOT = '/companies/acme'
const OTHER_ROOT = '/companies/other'
const FILES = new Set([`${ROOT}/営業部/企画/骨子.md`, `${ROOT}/未取得/a.md`, '/companies/other/a.md'])

function context(sessionId: string): ChatWindowContext {
  return { sessionId, companyId: 'acme', companyName: 'Acme', rootPath: ROOT }
}

function world() {
  const handlers = new Map<string, (event: { sender: { id: number } }, ...args: unknown[]) => unknown>()
  const ipc = { handle: (channel: string, handler: never) => handlers.set(channel, handler), on: () => {} } as unknown as IpcRegistrar
  let nextId = 100
  const open = new Map<number, Parameters<ChatWindowHost['open']>[0]>()
  const focused: number[] = []
  const closed: number[] = []
  const host: ChatWindowHost = {
    open(options) { const id = nextId++; open.set(id, options); return id },
    focus: id => { focused.push(id) },
    close: id => { closed.push(id); const options = open.get(id); open.delete(id); options?.onClosed() },
  }
  const changes: ChatWindowsChange[] = []
  const fileRequests: string[] = []
  let mainFocused = 0
  const mainOpen = { value: true }
  const windows = registerChatWindowsIpc(ipc, {
    host,
    paths: {
      // Two registered companies: a window may still open files of its own only.
      validate: p => { if (!p.startsWith(ROOT) && !p.startsWith(OTHER_ROOT)) throw new Error('outside'); return p },
      rootOf: p => p.startsWith(ROOT) ? ROOT : p.startsWith(OTHER_ROOT) ? OTHER_ROOT : null,
    },
    isMainWindow: id => id === MAIN,
    mainWindow: {
      send: (channel, ...payload) => {
        if (channel === 'chatWindow:changed') changes.push(payload[0] as ChatWindowsChange)
        else if (channel === 'chatWindow:fileRequested') fileRequests.push((payload[0] as { path: string }).path)
      },
    },
    focusMainWindow: () => { mainFocused++; return mainOpen.value },
    files: {
      notDownloadedFolder: p => p.startsWith(`${ROOT}/未取得/`) ? '未取得' : null,
      isFile: p => FILES.has(p),
    },
    log: { warn: () => {} },
  })
  const call = (sender: number, channel: string, ...args: unknown[]) => handlers.get(channel)!({ sender: { id: sender } }, ...args)
  /** The member closes a window: what the window asks, then (if nothing) it closes. */
  const memberCloses = (id: number) => {
    const options = open.get(id)!
    const question = options.confirmClose()
    if (question) return question
    open.delete(id)
    options.onClosed()
    return null
  }
  return { windows, call, open, focused, closed, changes, memberCloses, fileRequests, mainOpen, mainFocused: () => mainFocused }
}

test('one consultation is never shown in two windows: opening it again focuses the window that has it', async () => {
  const w = world()
  assert.deepEqual(await w.call(MAIN, 'chatWindow:open', 's-1', context('s-1')), { ok: true, focused: false })
  assert.deepEqual(await w.call(MAIN, 'chatWindow:open', 's-1', context('s-1')), { ok: true, focused: true })
  assert.equal(w.open.size, 1)
  assert.deepEqual(w.focused, [100])
  // Another consultation gets a window of its own.
  await w.call(MAIN, 'chatWindow:open', 's-2', context('s-2'))
  assert.equal(w.open.size, 2)
})

test('the registry refuses a second window for a consultation another window shows', () => {
  const registry = createChatWindowRegistry()
  assert.deepEqual(registry.claim(7, context('s-1')), { ok: true })
  const second = registry.claim(8, context('s-1'))
  assert.equal(second.ok, false)
  assert.equal(!second.ok && second.existing.windowId, 7)
  assert.equal(registry.find('s-1')?.windowId, 7)
  // Once that window closes, the consultation may open again.
  registry.release(7)
  assert.deepEqual(registry.claim(8, context('s-1')), { ok: true })
})

test('a closed window frees its consultation: questions go back to the main window and the list hears it returned', async () => {
  const w = world()
  await w.call(MAIN, 'chatWindow:open', 's-1', context('s-1'))
  assert.equal(w.windows.windowForSession('s-1'), 100)
  assert.equal(w.memberCloses(100), null)
  assert.equal(w.windows.windowForSession('s-1'), undefined)
  assert.deepEqual(w.changes.at(-1), { windows: [], closed: { companyId: 'acme', sessionId: 's-1' } })
  assert.deepEqual(await w.call(MAIN, 'chatWindow:list'), [])
})

test('closing a window while its AI works asks first (the turn runs in that window\'s page and would stop)', async () => {
  const w = world()
  await w.call(MAIN, 'chatWindow:open', 's-1', context('s-1'))
  assert.equal(await w.call(100, 'chatWindow:reportStatus', { state: 'working', line: 'ファイルを読んでいます' }), true)
  assert.match(String(w.memberCloses(100)?.message), /AIが作業中です。閉じると止まります/)
  assert.equal(w.windows.windowForSession('s-1'), 100)
  // A finished turn waiting for review closes at once.
  await w.call(100, 'chatWindow:reportStatus', { state: 'needs-you', kind: 'review', line: '確認をお願いします' })
  assert.equal(w.memberCloses(100), null)
})

test('the main window\'s list hears every status change of another window (あなたの番, 作業中)', async () => {
  const w = world()
  await w.call(MAIN, 'chatWindow:open', 's-1', context('s-1'))
  await w.call(100, 'chatWindow:reportStatus', { state: 'needs-you', kind: 'question', line: '形式を選んでください' })
  assert.deepEqual(w.changes.at(-1)?.windows, [{ companyId: 'acme', sessionId: 's-1', status: { state: 'needs-you', kind: 'question', line: '形式を選んでください' } }])
})

test('only the main window opens, focuses and lists windows; a window reads and reports only its own consultation', async () => {
  const w = world()
  await w.call(MAIN, 'chatWindow:open', 's-1', context('s-1'))
  // A consultation window cannot open another one or close the others.
  assert.equal((await w.call(100, 'chatWindow:open', 's-2', context('s-2')) as { ok: boolean }).ok, false)
  await w.call(100, 'chatWindow:closeAll')
  assert.deepEqual(w.closed, [])
  assert.deepEqual(await w.call(100, 'chatWindow:list'), [])
  // The context goes to its own window only.
  assert.deepEqual(await w.call(100, 'chatWindow:getContext'), context('s-1'))
  assert.equal(await w.call(MAIN, 'chatWindow:getContext'), null)
  assert.equal(await w.call(55, 'chatWindow:getContext'), null)
  // Only a consultation window reports a status.
  assert.equal(await w.call(MAIN, 'chatWindow:reportStatus', { state: 'working', line: '' }), false)
  assert.equal(await w.call(55, 'chatWindow:reportStatus', { state: 'working', line: '' }), false)
})

test('a window opens only in a registered company folder, for a well-formed conversation id', async () => {
  const w = world()
  assert.equal((await w.call(MAIN, 'chatWindow:open', 's-1', { ...context('s-1'), rootPath: '/etc' }) as { ok: boolean }).ok, false)
  assert.equal((await w.call(MAIN, 'chatWindow:open', '../x', context('s-1')) as { ok: boolean }).ok, false)
  assert.equal(w.open.size, 0)
})

test('sign-out / company switch closes every window without asking, even mid-turn', async () => {
  const w = world()
  await w.call(MAIN, 'chatWindow:open', 's-1', context('s-1'))
  await w.call(MAIN, 'chatWindow:open', 's-2', context('s-2'))
  await w.call(100, 'chatWindow:reportStatus', { state: 'working', line: '' })
  await w.call(MAIN, 'chatWindow:closeAll')
  assert.deepEqual(w.closed, [100, 101])
  assert.deepEqual(await w.call(MAIN, 'chatWindow:list'), [])
})

test('what a page hands over is checked field by field', () => {
  assert.equal(parseOpenRequest({ companyId: 'a', companyName: 'A' }), null)
  const parsed = parseOpenRequest({ companyId: 'a', companyName: 'A', rootPath: '/r', extra: 'x', slashCommands: [{ command: 'c', name: 'C', script: 'x' }, 5] })
  assert.deepEqual(parsed, { companyId: 'a', companyName: 'A', rootPath: '/r', slashCommands: [{ command: 'c', name: 'C' }] })
  assert.equal(parseWindowStatus({ state: 'busy', line: '' }), null)
  assert.equal(parseWindowStatus({ state: 'working', line: 'x'.repeat(500) })?.line.length, 200)
  assert.equal(closeStopsTheAI({ state: 'needs-you', kind: 'approve', line: '' }), true)
  assert.equal(closeStopsTheAI({ state: 'idle', line: '' }), false)
})

test('a file link in a consultation\'s window opens in the main window\'s editor: main checks the path, then brings the main window up', async () => {
  const w = world()
  await w.call(MAIN, 'chatWindow:open', 's-1', context('s-1'))
  const file = `${ROOT}/営業部/企画/骨子.md`
  assert.deepEqual(await w.call(100, 'chatWindow:openFile', file), { ok: true })
  assert.deepEqual(w.fileRequests, [file])
  assert.equal(w.mainFocused(), 1)
  // The main window comes up only when there is one to open it in.
  w.mainOpen.value = false
  assert.equal((await w.call(100, 'chatWindow:openFile', file) as { ok: boolean }).ok, false)
  assert.deepEqual(w.fileRequests, [file])
})

test('only a consultation window asks, and only for a present file of its own company folder that is downloaded here', async () => {
  const w = world()
  await w.call(MAIN, 'chatWindow:open', 's-1', context('s-1'))
  const refused = async (sender: number, filePath: unknown) => {
    const answer = await w.call(sender, 'chatWindow:openFile', filePath) as { ok: boolean; error?: string }
    assert.equal(answer.ok, false, String(filePath))
    return answer.error ?? ''
  }
  const file = `${ROOT}/営業部/企画/骨子.md`
  // The main window and unknown senders do not use this channel.
  await refused(MAIN, file)
  await refused(55, file)
  // Outside every root, another company's folder (another registered root), '..' and junk.
  await refused(100, '/etc/passwd')
  await refused(100, '/companies/other/a.md')
  await refused(100, `${ROOT}/営業部/../../other/a.md`)
  await refused(100, ROOT)
  await refused(100, 42)
  await refused(100, `${ROOT}/${'a'.repeat(5000)}`)
  // A folder not downloaded on this computer says so; a missing file (an unreadable private folder too) names nothing.
  assert.match(await refused(100, `${ROOT}/未取得/a.md`), /ダウンロードしていない/)
  const missing = await refused(100, `${ROOT}/秘密の企画/a.md`)
  assert.doesNotMatch(missing, /秘密の企画/)
  assert.deepEqual(w.fileRequests, [])
  assert.equal(w.mainFocused(), 0)
})
