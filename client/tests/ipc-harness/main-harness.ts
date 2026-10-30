// Loads client/electron/main.ts under plain Node with a fake `electron`
// (./fake-electron.ts) and a fake server behind `fetch`, so the IPC handlers
// can be called with arguments and their results / side effects asserted.
//
// main.ts keeps its state in module variables, so it is loaded once per test
// file (node --test runs each file in its own process). Everything it writes
// goes under one temporary directory (userData, company folders), removed by
// `shutdown()`.
//
//   const h = await loadMain()
//   const root = h.companyDir('acme')            // a folder under the temp dir
//   await h.invoke('fs:registerAllowedRoot', root)
//   await h.invoke('fs:readFile', path.join(root, 'a.md'))
//   ...
//   after(() => h.shutdown())
//
// IPC_HARNESS_VERBOSE=1 prints main.ts's console output; IPC_HARNESS_KEEP=1
// keeps the temporary directory.

import { register } from 'node:module'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import { BrowserWindow, app, detachedSender, fake, type FakeIpcEvent, type FakeWebContents } from './fake-electron.ts'

export const SERVER_URL = 'http://acb-server.test'

export interface ServerRequest {
  method: string
  path: string
  headers: Headers
  body: string | null
}

type Reply = { status?: number; json?: unknown; text?: string; headers?: Record<string, string> }
type Route = { method: string; path: string | RegExp; reply: Reply | ((req: ServerRequest) => Reply) }

/** The ACB server as main.ts reaches it (global fetch). Unrouted requests answer 404. */
export class FakeServer {
  readonly requests: ServerRequest[] = []
  private routes: Route[] = []
  /** true: every request to the server fails like a lost connection. */
  offline = false

  on(method: string, routePath: string | RegExp, reply: Route['reply']): this {
    this.routes.unshift({ method, path: routePath, reply })
    return this
  }

  reset(): void {
    this.routes = []
    this.requests.length = 0
    this.offline = false
  }

  /** Requests to a path (exact or matching). */
  to(routePath: string | RegExp): ServerRequest[] {
    return this.requests.filter(r => typeof routePath === 'string' ? r.path === routePath : routePath.test(r.path))
  }

  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (url.origin !== SERVER_URL || this.offline) throw new TypeError('fetch failed')
    const body = init?.body == null ? null : String(init.body)
    const req: ServerRequest = { method: (init?.method ?? 'GET').toUpperCase(), path: url.pathname + url.search, headers: new Headers(init?.headers), body }
    this.requests.push(req)
    const route = this.routes.find(r => r.method === req.method && (typeof r.path === 'string' ? r.path === url.pathname : r.path.test(url.pathname)))
    const reply = route ? (typeof route.reply === 'function' ? route.reply(req) : route.reply) : { status: 404, json: { success: false, error: 'Not found' } }
    const headers = new Headers(reply.headers)
    if (reply.json !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
    return new Response(reply.json !== undefined ? JSON.stringify(reply.json) : (reply.text ?? ''), { status: reply.status ?? 200, headers })
  }
}

export interface MainHarness {
  /** The temporary directory everything lives in. */
  base: string
  userData: string
  server: FakeServer
  fake: typeof fake
  /** What main.ts printed (console.*), unless IPC_HARNESS_VERBOSE is set. */
  logs: string[]
  /** ipcRenderer.invoke: the handler's result (a rejection if it throws). */
  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>
  /** ipcRenderer.invoke from a given window's page (another window than the main one). */
  invokeAs<T = unknown>(sender: FakeWebContents, channel: string, ...args: unknown[]): Promise<T>
  /** ipcRenderer.sendSync: event.returnValue. */
  sendSync<T = unknown>(channel: string, ...args: unknown[]): T
  /** ipcRenderer.send: runs the ipcMain.on listeners (they may throw). */
  send(channel: string, ...args: unknown[]): void
  /** The renderer's webContents (the window's once app.whenReady ran). */
  renderer(): FakeWebContents
  /** Resolve app.whenReady() and wait until main.ts created its window. */
  startApp(): Promise<void>
  /** A new folder under the temp dir (not registered as an allowed root). */
  companyDir(name: string): string
  shutdown(): Promise<void>
}

let loaded: MainHarness | null = null

export async function loadMain(options: { config?: Record<string, unknown> } = {}): Promise<MainHarness> {
  if (loaded) return loaded
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acb-ipc-')))
  const userData = path.join(base, 'userData')
  const documents = path.join(base, 'Documents')
  fs.mkdirSync(userData, { recursive: true })
  fs.mkdirSync(documents, { recursive: true })
  fake.paths.userData = userData
  fake.paths.documents = documents
  fake.paths.appPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ serverUrl: SERVER_URL, ...options.config }, null, 2))

  // Installed before main.ts wraps fetch with the client-identity headers.
  const server = new FakeServer()
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => server.fetch(input, init)) as typeof fetch

  const logs: string[] = []
  const originalConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error }
  if (!process.env.IPC_HARNESS_VERBOSE) {
    for (const level of ['log', 'info', 'warn', 'error'] as const) {
      console[level] = (...args: unknown[]) => { logs.push(`[${level}] ${args.map(a => a instanceof Error ? a.message : String(a)).join(' ')}`) }
    }
  }

  register(new URL('./electron-loader.mjs', import.meta.url))
  await import('../../electron/main.ts')

  const renderer = () => BrowserWindow.all[0]?.webContents ?? detachedSender
  const eventFor = (): FakeIpcEvent => ({ sender: renderer() })

  loaded = {
    base,
    userData,
    server,
    fake,
    logs,
    async invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
      const handler = fake.handlers.get(channel)
      if (!handler) throw new Error(`No handler registered for '${channel}'`)
      return await handler(eventFor(), ...args) as T
    },
    async invokeAs<T>(sender: FakeWebContents, channel: string, ...args: unknown[]): Promise<T> {
      const handler = fake.handlers.get(channel)
      if (!handler) throw new Error(`No handler registered for '${channel}'`)
      return await handler({ sender }, ...args) as T
    },
    sendSync<T>(channel: string, ...args: unknown[]): T {
      const event = eventFor()
      for (const listener of fake.listeners.get(channel) ?? []) listener(event, ...args)
      return event.returnValue as T
    },
    send(channel: string, ...args: unknown[]): void {
      const event = eventFor()
      for (const listener of fake.listeners.get(channel) ?? []) listener(event, ...args)
    },
    renderer,
    async startApp() {
      fake.ready?.()
      const deadline = Date.now() + 30_000
      while (BrowserWindow.all.length === 0) {
        if (Date.now() > deadline) throw new Error('main.ts did not create its window after app.whenReady()')
        await new Promise(resolve => setTimeout(resolve, 10))
      }
    },
    companyDir(name: string) {
      const dir = path.join(base, 'companies', name)
      fs.mkdirSync(dir, { recursive: true })
      return dir
    },
    async shutdown() {
      app.emit('before-quit')
      app.emit('will-quit')
      // The chat server main.ts starts in app.whenReady (it keeps no handle to it).
      const handles = (process as unknown as { _getActiveHandles(): unknown[] })._getActiveHandles()
      for (const handle of handles) if (handle instanceof net.Server) handle.close()
      Object.assign(console, originalConsole)
      if (!process.env.IPC_HARNESS_KEEP) fs.rmSync(base, { recursive: true, force: true })
    },
  }
  return loaded
}

// ---------------------------------------------------------------------------
// Git fixtures (the system git, isolated from the user's configuration)
// ---------------------------------------------------------------------------

export function testGitEnv(base: string): NodeJS.ProcessEnv {
  const gitconfig = path.join(base, 'test-gitconfig')
  if (!fs.existsSync(gitconfig)) fs.writeFileSync(gitconfig, '[init]\n\tdefaultBranch = main\n[user]\n\tname = Test\n\temail = test@example.com\n')
  return { ...process.env, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1' }
}

export function git(base: string, cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, env: testGitEnv(base), stdio: 'pipe' }).toString()
}

/** Write files (relative path → content) under `dir`. */
export function writeFiles(dir: string, files: Record<string, string | Buffer>): void {
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(dir, ...rel.split('/'))
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
  }
}

/** A git repository at `dir` with `files` committed on main. */
export function commitRepo(base: string, dir: string, files: Record<string, string | Buffer>, message = 'initial'): void {
  fs.mkdirSync(dir, { recursive: true })
  if (!fs.existsSync(path.join(dir, '.git'))) git(base, dir, ['init', '-q', '-b', 'main'])
  writeFiles(dir, files)
  git(base, dir, ['add', '-A'])
  git(base, dir, ['commit', '-q', '-m', message])
}
