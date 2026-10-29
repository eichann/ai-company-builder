// A stand-in for the `electron` module, so client/electron/main.ts (and
// preload.ts) can be loaded under plain Node by the IPC characterization tests
// (tests/ipc-*.test.ts). `electron-loader.mjs` resolves every `import ... from
// 'electron'` to this file; the tests import it too and get the same instance,
// so they see exactly what main.ts registered.
//
// Only what main.ts, voice-input.ts and preload.ts touch is implemented. It
// records instead of acting: handlers, sends to the window, dialogs, shell
// calls. Nothing here opens a window or a real dialog.

import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

type Handler = (event: FakeIpcEvent, ...args: unknown[]) => unknown
type Listener = (event: FakeIpcEvent, ...args: unknown[]) => void

export interface FakeIpcEvent {
  sender: FakeWebContents
  returnValue?: unknown
}

export interface SentMessage { channel: string; args: unknown[] }

let nextWebContentsId = 1

export class FakeWebContents extends EventEmitter {
  readonly id = nextWebContentsId++
  readonly sent: SentMessage[] = []
  readonly drags: unknown[] = []
  destroyed = false
  readonly headerHooks: Array<{ filter: unknown; fn: unknown }> = []
  readonly session = {
    setSpellCheckerLanguages: () => {},
    webRequest: {
      onBeforeSendHeaders: (filter: unknown, fn: unknown) => { this.headerHooks.push({ filter, fn }) },
    },
  }
  loaded: string | null = null
  send(channel: string, ...args: unknown[]): void { this.sent.push({ channel, args }) }
  isDestroyed(): boolean { return this.destroyed }
  startDrag(item: unknown): void { this.drags.push(item) }
  loadURL(url: string): Promise<void> { this.loaded = url; return Promise.resolve() }
  loadFile(file: string): Promise<void> { this.loaded = file; return Promise.resolve() }
  /** Messages sent on one channel since the last `clearSent()`. */
  sentOn(channel: string): unknown[][] { return this.sent.filter(m => m.channel === channel).map(m => m.args) }
  clearSent(): void { this.sent.length = 0 }
}

export class BrowserWindow extends EventEmitter {
  static readonly all: BrowserWindow[] = []
  static getAllWindows(): BrowserWindow[] { return BrowserWindow.all.filter(w => !w.destroyed) }
  readonly webContents = new FakeWebContents()
  destroyed = false
  constructor(readonly options: unknown) {
    super()
    BrowserWindow.all.push(this)
  }
  isDestroyed(): boolean { return this.destroyed }
  isMinimized(): boolean { return false }
  restore(): void {}
  show(): void {}
  focus(): void {}
  loadURL(url: string): Promise<void> { return this.webContents.loadURL(url) }
  loadFile(file: string): Promise<void> { return this.webContents.loadFile(file) }
}

/** Everything main.ts registered or did through Electron. */
export const fake = {
  handlers: new Map<string, Handler>(),
  listeners: new Map<string, Listener[]>(),
  protocolHandlers: new Map<string, (request: Request) => Promise<Response> | Response>(),
  privilegedSchemes: [] as unknown[],
  openDialogResults: [] as Array<{ canceled: boolean; filePaths: string[] }>,
  messageBoxes: [] as unknown[],
  openedPaths: [] as string[],
  openedExternal: [] as string[],
  paths: {} as Record<string, string>,
  /** safeStorage.isEncryptionAvailable(); tests switch it off to see the refusal. */
  encryptionAvailable: true,
  /** Resolves app.whenReady(); see the harness's `startApp`. */
  ready: null as null | (() => void),
}

/** The renderer when no window exists yet (before app.whenReady). */
export const detachedSender = new FakeWebContents()

export const ipcMain = {
  handle(channel: string, handler: Handler): void {
    if (fake.handlers.has(channel)) throw new Error(`Attempted to register a second handler for '${channel}'`)
    fake.handlers.set(channel, handler)
  },
  removeHandler(channel: string): void { fake.handlers.delete(channel) },
  on(channel: string, listener: Listener): void {
    const list = fake.listeners.get(channel) ?? []
    list.push(listener)
    fake.listeners.set(channel, list)
  },
}

const appEvents = new EventEmitter()
const readyPromise = new Promise<void>(resolve => { fake.ready = resolve })

export const app = {
  isPackaged: false,
  requestSingleInstanceLock: () => true,
  quit: () => { throw new Error('app.quit() called under test') },
  on: (event: string, fn: (...args: unknown[]) => void) => { appEvents.on(event, fn); return app },
  emit: (event: string, ...args: unknown[]) => appEvents.emit(event, ...args),
  whenReady: () => readyPromise,
  getPath: (name: string) => {
    const p = fake.paths[name]
    if (!p) throw new Error(`fake electron: app.getPath('${name}') has no test path`)
    return p
  },
  getAppPath: () => fake.paths.appPath ?? process.cwd(),
}

export const dialog = {
  showOpenDialog: async () => fake.openDialogResults.shift() ?? { canceled: true, filePaths: [] },
  showMessageBox: async (...args: unknown[]) => { fake.messageBoxes.push(args); return { response: 0, checkboxChecked: false } },
}

export const shell = {
  openPath: async (p: string) => { fake.openedPaths.push(p); return '' },
  openExternal: async (url: string) => { fake.openedExternal.push(url) },
}

export const protocol = {
  registerSchemesAsPrivileged: (schemes: unknown[]) => { fake.privilegedSchemes.push(...schemes) },
  handle: (scheme: string, handler: (request: Request) => Promise<Response> | Response) => { fake.protocolHandlers.set(scheme, handler) },
}

/** electron.net.fetch for the file:// URLs the local-file protocol fetches. */
export const net = {
  fetch: async (url: string) => {
    if (!url.startsWith('file:')) throw new Error(`fake net.fetch only serves file:// (got ${url})`)
    try {
      const body = await fs.promises.readFile(fileURLToPath(url))
      return new Response(body, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } })
    } catch {
      return new Response('not found', { status: 404 })
    }
  },
}

export const nativeImage = {
  createFromDataURL: (url: string) => ({ dataURL: url }),
}

/** A reversible stand-in for the OS keychain: never the plain text on disk. */
const FAKE_SEALED = 'fake-sealed:'
export const safeStorage = {
  isEncryptionAvailable: () => fake.encryptionAvailable,
  getSelectedStorageBackend: () => 'gnome_libsecret',
  encryptString: (text: string) => Buffer.from(FAKE_SEALED + Buffer.from(text).reverse().toString('hex')),
  decryptString: (data: Buffer) => {
    const sealed = data.toString()
    if (!sealed.startsWith(FAKE_SEALED)) throw new Error('fake safeStorage: cannot decrypt')
    return Buffer.from(sealed.slice(FAKE_SEALED.length), 'hex').reverse().toString()
  },
}

export const systemPreferences = {
  getMediaAccessStatus: () => 'granted',
  askForMediaAccess: async () => true,
}

// ---------------------------------------------------------------------------
// Renderer side (preload.ts): contextBridge + ipcRenderer, recording calls.
// ---------------------------------------------------------------------------

export interface RendererCall { method: string; channel: string; args: unknown[] }

export const renderer = {
  exposed: {} as Record<string, unknown>,
  calls: [] as RendererCall[],
}

export const contextBridge = {
  exposeInMainWorld: (key: string, api: unknown) => { renderer.exposed[key] = api },
}

export const ipcRenderer = {
  invoke: (channel: string, ...args: unknown[]) => { renderer.calls.push({ method: 'invoke', channel, args }); return Promise.resolve(undefined) },
  send: (channel: string, ...args: unknown[]) => { renderer.calls.push({ method: 'send', channel, args }) },
  sendSync: (channel: string, ...args: unknown[]) => { renderer.calls.push({ method: 'sendSync', channel, args }); return { result: '<result>' } },
  on: (channel: string, ...args: unknown[]) => { renderer.calls.push({ method: 'on', channel, args }); return ipcRenderer },
  off: (channel: string, ...args: unknown[]) => { renderer.calls.push({ method: 'off', channel, args }); return ipcRenderer },
  removeListener: (channel: string, ...args: unknown[]) => { renderer.calls.push({ method: 'removeListener', channel, args }); return ipcRenderer },
}

export default {
  app, BrowserWindow, ipcMain, dialog, shell, net, protocol, nativeImage, systemPreferences, contextBridge, ipcRenderer,
}
