// The in-app browser window of 「ブラウザ操作」 (agent-browser.md "The app's window"). Shell layer:
// with main.ts, preload.ts, electron-adapter.ts and voice-input.ts, the only code that imports
// Electron. Kept apart from electron-adapter.ts because it is one security surface of its own,
// tested in a real Electron (tests/browser-window-electron.test.ts loads exactly this file).
//
// A window shows one admin-approved site, in an in-memory session of its own, with nothing of the
// app in reach: no preload, no IPC, sandboxed. Its session has ONE request hook and ONE response
// header hook (Electron keeps only the last listener of each, so they are installed here and
// nowhere else) and a proxy that sends every connection not to the site's hosts to a local
// refusing proxy (what the request hook cannot see: preconnect, reporting, WebRTC's TCP). Popups,
// downloads, permissions, client certificates, navigations off the operated host and certificate
// errors are refused, and nothing is handed to the system browser or another app. In `ai` mode
// every request of the page is paused through DevTools Fetch: a write goes out only when the
// injected decider says yes (a run's never does), a read of the operated host only when the run's
// read rule says so. A run's own requests go through the session (`run.request`), never the page,
// and pass the request hook only when the run's gate says yes (agent-browser.md "The runner").
import net from 'node:net'
import { BrowserWindow, net as electronNet, session, type Session, type WebContents } from 'electron'
import type { BrowserSiteSetting } from '../../shared/core/browser-operation'
import {
  BROWSER_WORDS, browserProxyScript, browserWritePartition, browserResponseHeaders, createRefusalTally, decideAiRead, decideAiWrite, decideWindowRequest,
  hostForLog, isReadMethod, navigationAllowed,
  type BrowserReadDecider, type BrowserWindowMode, type BrowserWindowState, type BrowserWriteAttempt, type BrowserWriteDecider,
} from '../shared/browser-operation'
import type { BrowserRunSurface } from '../shared/browser-runner'
import type { BrowserShell, BrowserWindowHandle, BrowserWindowSpec } from './features/browser/controller'

/** What `ai` mode needs: the approved step's decider (none = no write) and the emergency stop. */
export interface BrowserAiGate {
  decide?: BrowserWriteDecider
  /** A run's read rule for the page's reads of the operated host (none: reads pass). */
  decideRead?: BrowserReadDecider
  stopped: () => boolean
}

export interface BrowserShellWindow extends BrowserWindowHandle {
  readonly webContents: WebContents
  /** `human` (default) or `ai` with its gate; the gate attaches after the first page load. */
  setMode(mode: BrowserWindowMode, gate?: BrowserAiGate): Promise<void>
  run: BrowserRunSurface
}

const RUN_REQUEST_MS = 30_000
const RUN_ANSWER_MAX = 5 * 1024 * 1024

/**
 * One request through a session, its answer or a rejection (no answer). A redirect is an answer: its
 * status is returned and it is not followed (a redirect after a save points back at a page; reading
 * it is the runner's own, declared read).
 */
function sendOnce(ses: Session, r: { method: string; url: string; contentType?: string; body?: string }): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = electronNet.request({ method: r.method, url: r.url, session: ses, credentials: 'include', redirect: 'manual', cache: 'no-store' })
    let done = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (fn: () => void) => { if (!done) { done = true; clearTimeout(timer); fn() } }
    timer = setTimeout(() => finish(() => { request.abort(); reject(new Error('no answer in time')) }), RUN_REQUEST_MS)
    request.on('redirect', status => finish(() => { request.abort(); resolve({ status, body: '' }) }))
    request.on('response', response => {
      const chunks: Buffer[] = []
      let size = 0
      // An answer larger than any page a checker reads is refused whole (never read cut short).
      response.on('data', chunk => {
        size += chunk.length
        if (size > RUN_ANSWER_MAX) finish(() => { request.abort(); reject(new Error('answer too large')) })
        else chunks.push(chunk)
      })
      response.on('end', () => finish(() => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') })))
      response.on('error', () => finish(() => reject(new Error('answer cut off'))))
    })
    request.on('error', () => finish(() => reject(new Error('no answer'))))
    request.on('abort', () => finish(() => reject(new Error('aborted'))))
    if (r.contentType) request.setHeader('content-type', r.contentType)
    request.end(r.body)
  })
}

/** The body Chromium hands the request hook: plain bytes only (a file or a blob = unknown). */
function uploadBody(data: Electron.UploadData[] | undefined): string | undefined {
  if (!data || data.length === 0) return undefined
  if (data.some(d => d.file !== undefined || d.blobUUID !== undefined || !d.bytes)) return undefined
  return Buffer.concat(data.map(d => d.bytes)).toString('utf8')
}

interface SessionState extends BrowserWindowState {
  /** The webContents of the window showing this session now (null: none). */
  contentsId: number | null
  tally: ReturnType<typeof createRefusalTally>
  flushTimer: ReturnType<typeof setTimeout> | null
}

const REFUSAL_LOG_MS = 10_000

/**
 * The proxy every connection to a host the site does not list is sent to: on 127.0.0.1, it answers
 * 403 to whatever it is asked and closes, so nothing goes further (a closed port could let a client
 * try another way).
 */
function startRefusingProxy(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer(socket => {
      socket.on('error', () => {})
      socket.once('data', () => socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'))
      socket.setTimeout(5_000, () => socket.destroy())
    })
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.unref()
      resolve((server.address() as net.AddressInfo).port)
    })
  })
}

export function createBrowserWindowShell(options: { log?: Pick<Console, 'warn'>; show?: boolean } = {}): BrowserShell & { open(spec: BrowserWindowSpec): BrowserShellWindow } {
  const log = options.log ?? console
  const states = new Map<string, SessionState>()
  let refusingProxy: Promise<number> | null = null

  const flush = (state: SessionState) => {
    if (state.flushTimer) { clearTimeout(state.flushTimer); state.flushTimer = null }
    for (const line of state.tally.drain()) log.warn(`[browser] ${line}`)
  }
  const refuse = (state: SessionState, host: string, reason: string) => {
    state.tally.add(host, reason)
    state.flushTimer ??= setTimeout(() => flush(state), REFUSAL_LOG_MS)
  }

  /** Points the session's proxy at the site's hosts (DIRECT) and the refusing proxy (the rest). */
  async function routeOnly(ses: Session, site: BrowserSiteSetting) {
    refusingProxy ??= startRefusingProxy()
    const port = await refusingProxy
    const script = browserProxyScript(site, port)
    await ses.setProxy({ mode: 'pac_script', pacScript: `data:application/x-ns-proxy-autoconfig;base64,${Buffer.from(script).toString('base64')}` })
  }

  /** The partition's session with its guards, installed once per session (also one only cleared). */
  function guarded(partition: string): { ses: Session; state: SessionState } {
    const ses = session.fromPartition(partition)
    let state = states.get(partition)
    if (state) return { ses, state }
    const created: SessionState = { site: null, mode: 'human', aiGateReady: false, outside: null, contentsId: null, tally: createRefusalTally(), flushTimer: null }
    states.set(partition, created)
    state = created
    // The one request hook of this session. With no window (site null) it refuses everything:
    // a service worker left running must not reach anywhere.
    ses.webRequest.onBeforeRequest((details, callback) => {
      const decision = decideWindowRequest(created, {
        url: details.url, method: details.method, resourceType: details.resourceType,
        fromWindow: details.webContentsId !== undefined && details.webContentsId === created.contentsId,
        body: uploadBody(details.uploadData),
      })
      if (!decision.allow) refuse(created, hostForLog(details.url), decision.reason)
      callback({ cancel: !decision.allow })
    })
    // The one response header hook: no reporting endpoints, no DNS prefetch of a page's links.
    ses.webRequest.onHeadersReceived((details, callback) => {
      callback({ responseHeaders: browserResponseHeaders(details.responseHeaders ?? {}, details.resourceType) })
    })
    ses.on('will-download', (event, item) => {
      event.preventDefault()
      refuse(created, hostForLog(item.getURL()), 'download')
    })
    // Set after the app's own `guardEverySession` handler (session-created): these replace it.
    ses.setPermissionRequestHandler((_contents, permission, callback) => {
      refuse(created, 'permission', permission)
      callback(false)
    })
    ses.setPermissionCheckHandler(() => false)
    ses.setDevicePermissionHandler(() => false)
    return { ses, state }
  }

  function guardContents(contents: WebContents, state: SessionState) {
    const allowed = (url: string, mainFrame: boolean) => !!state.site && navigationAllowed(state.site, url, mainFrame)
    // WebRTC never sends UDP itself; its TCP goes through the session's proxy (refused off the site).
    contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
    contents.setWindowOpenHandler(({ url }) => {
      refuse(state, hostForLog(url), 'popup')
      return { action: 'deny' }
    })
    // Every frame's navigation, the main frame's included (it also covers what `will-navigate` sees).
    contents.on('will-frame-navigate', event => {
      if (allowed(event.url, event.isMainFrame)) return
      event.preventDefault()
      refuse(state, hostForLog(event.url), event.isMainFrame ? 'navigation' : 'frame-navigation')
    })
    contents.on('will-redirect', event => {
      if (allowed(event.url, event.isMainFrame)) return
      event.preventDefault()
      refuse(state, hostForLog(event.url), 'redirect')
    })
    // No bypass of a certificate the system does not trust.
    contents.on('certificate-error', (event, url, _error, _certificate, callback) => {
      event.preventDefault()
      callback(false)
      refuse(state, hostForLog(url), 'certificate')
    })
    // Never a client certificate of this computer.
    contents.on('select-client-certificate', (event, url, _list, callback) => {
      event.preventDefault()
      // No certificate = the request goes on without one (the app-level event types it optional).
      ;(callback as (certificate?: unknown) => void)()
      refuse(state, hostForLog(url), 'client-certificate')
    })
    // HTTP authentication prompts and webviews are not offered.
    contents.on('login', (event, _details, _authInfo, callback) => { event.preventDefault(); callback() })
    contents.on('will-attach-webview', event => event.preventDefault())
  }

  /** The `ai`-mode write gate on one window: DevTools Fetch interception of every request. */
  function createAiGate(contents: WebContents, state: SessionState) {
    let gate: BrowserAiGate | null = null
    let loaded = false
    let pendingAttach = false
    contents.once('did-finish-load', () => {
      loaded = true
      if (pendingAttach) void attach()
    })
    const onDetach = () => { state.aiGateReady = false }
    const onMessage = async (_event: unknown, method: string, params: Record<string, unknown>) => {
      if (method !== 'Fetch.requestPaused') return
      const requestId = params.requestId as string
      const request = params.request as { url: string; method: string; headers?: Record<string, string>; postData?: string; postDataEntries?: Array<{ bytes?: string }> }
      let allow = true
      if (isReadMethod(request.method)) {
        // A run's read rule: the page's parts, else only a declared read path.
        if (state.site && state.mode === 'ai' && gate?.decideRead) {
          allow = decideAiRead(state.site, { url: request.url, resourceType: String(params.resourceType ?? '') }, gate.decideRead)
          if (!allow) refuse(state, hostForLog(request.url), 'ai-read')
        }
      } else {
        // An upload or a large body has no postData here: `body` is then undefined and the decider must refuse it.
        const write: BrowserWriteAttempt = {
          method: request.method, url: request.url, headers: request.headers ?? {},
          body: request.postData ?? (request.postDataEntries ? request.postDataEntries.map(e => Buffer.from(e.bytes ?? '', 'base64').toString('utf8')).join('') : undefined),
        }
        const decision = state.site && state.mode === 'ai' && gate
          ? await decideAiWrite(state.site, write, gate.decide, gate.stopped())
          : { allow: state.mode !== 'ai', reason: 'closed' as const }
        allow = decision.allow
        if (!decision.allow) refuse(state, hostForLog(request.url), `ai-write:${decision.reason}`)
      }
      try {
        if (allow) await contents.debugger.sendCommand('Fetch.continueRequest', { requestId })
        else await contents.debugger.sendCommand('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' })
      } catch { /* the request or the window is gone */ }
    }
    async function attach() {
      pendingAttach = false
      if (contents.isDestroyed() || state.mode !== 'ai') return
      const dbg = contents.debugger
      if (!dbg.isAttached()) {
        dbg.attach('1.3')
        dbg.on('message', onMessage)
        dbg.on('detach', onDetach)
      }
      await dbg.sendCommand('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] })
      state.aiGateReady = state.mode === 'ai'
    }
    return async (mode: BrowserWindowMode, next?: BrowserAiGate) => {
      if (mode === 'ai') {
        gate = next ?? { stopped: () => true }
        state.mode = 'ai'
        if (state.aiGateReady) return
        // Attaching to a window that has loaded nothing yet hangs: wait for the first page.
        if (loaded) await attach()
        else pendingAttach = true
        return
      }
      state.mode = 'human'
      state.aiGateReady = false
      state.outside = null
      gate = null
      pendingAttach = false
      const dbg = contents.debugger
      if (!contents.isDestroyed() && dbg.isAttached()) {
        try { await dbg.sendCommand('Fetch.disable') } catch { /* detaching anyway */ }
        dbg.removeListener('message', onMessage)
        dbg.removeListener('detach', onDetach)
        dbg.detach()
      }
    }
  }

  return {
    open(spec) {
      const { ses, state } = guarded(spec.partition)
      state.site = spec.site
      state.mode = 'human'
      state.aiGateReady = false
      state.outside = null
      const win = new BrowserWindow({
        width: 1200,
        height: 860,
        minWidth: 480,
        minHeight: 400,
        title: `${BROWSER_WORDS.section} — ${spec.site.host}`,
        show: false,
        // Never the app pages' preferences (they carry the app's preload): nothing of the app here.
        webPreferences: {
          session: ses,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          nodeIntegrationInWorker: false,
          nodeIntegrationInSubFrames: false,
          webviewTag: false,
          webSecurity: true,
          allowRunningInsecureContent: false,
          plugins: false,
          navigateOnDragDrop: false,
          safeDialogs: true,
          spellcheck: false,
        },
      })
      const contents = win.webContents
      const contentsId = contents.id
      state.contentsId = contentsId
      guardContents(contents, state)
      const setMode = createAiGate(contents, state)
      const revoke = () => {
        if (state.contentsId !== contentsId) return
        state.site = null
        state.mode = 'human'
        state.aiGateReady = false
        state.outside = null
        state.contentsId = null
      }
      const closed = () => state.contentsId !== contentsId || win.isDestroyed() || !state.site
      const run: BrowserRunSurface = {
        async enterAi(hooks) {
          if (closed()) return false
          // The run's gate on requests from outside the page (its own), then the page's gate.
          state.outside = hooks.sessionRequest
          await setMode('ai', { decide: () => false, decideRead: hooks.pageRead, stopped: hooks.stopped })
          return !closed() && state.mode === 'ai' && state.aiGateReady
        },
        async leaveAi() {
          state.outside = null
          if (state.contentsId === contentsId) await setMode('human')
        },
        // Through the window's session (its login), never the page: no script of the page sees or changes it.
        async request({ method, path, contentType, body }) {
          if (closed() || !path.startsWith('/')) throw new Error('window closed')
          const site = state.site!
          const url = `https://${site.host}${path}`
          if (isReadMethod(method)) return sendOnce(ses, { method, url, contentType, body })
          // A write goes on a connection of its own (agent-browser.md "The runner"): Chromium resends a
          // request whose reused keep-alive connection dropped before the answer — below the request
          // hook, so the gate's "once" never sees it (verified on Electron 45: one lost answer reached
          // the site 12 times). The window's write session (one per window session, in memory: it does
          // not pile up) has its connections closed and its storage cleared before and after each
          // write, so it never holds an idle connection to reuse; it carries the window's login (the
          // cookies for the write's own address, path-scoped ones included), the site's proxy rule and
          // ONE request hook, the run's gate (Electron keeps the last one: replaced each write). What
          // the site sets in its answer (Set-Cookie) is not carried back to the window (decision: the
          // runner re-reads with the window's own login; a rotated cookie stays the window's).
          const outside = state.outside
          if (!outside) throw new Error('no run')
          const once = session.fromPartition(browserWritePartition(spec.partition))
          const wipe = async () => {
            await once.closeAllConnections().catch(() => {})
            await once.clearStorageData().catch(() => {})
            await once.clearCache().catch(() => {})
          }
          await wipe()
          try {
            once.webRequest.onBeforeRequest((details, callback) => {
              let allow = false
              try { allow = state.mode === 'ai' && details.url === url && outside({ method: details.method, url: details.url, body: uploadBody(details.uploadData) }).allow } catch { allow = false }
              if (!allow) refuse(state, hostForLog(details.url), 'ai-write-session')
              callback({ cancel: !allow })
            })
            once.setPermissionRequestHandler((_c, _p, callback) => callback(false))
            once.setPermissionCheckHandler(() => false)
            await routeOnly(once, site)
            for (const c of await ses.cookies.get({ url })) {
              await once.cookies.set({
                url: `https://${site.host}${c.path ?? '/'}`, name: c.name, value: c.value, path: c.path,
                ...(c.hostOnly ? {} : { domain: c.domain }), secure: c.secure, httpOnly: c.httpOnly,
                ...(c.expirationDate ? { expirationDate: c.expirationDate } : {}), sameSite: c.sameSite,
              })
            }
            return await sendOnce(once, { method, url, contentType, body })
          } finally {
            await wipe()
          }
        },
        closed,
      }
      // The title always names the site, whatever the page calls itself.
      win.on('page-title-updated', event => event.preventDefault())
      if (options.show !== false) win.once('ready-to-show', () => win.show())
      win.on('closed', () => {
        revoke()
        flush(state)
        spec.onClosed()
      })
      // Nothing loads before the session's connections are routed: the site's hosts or the refusing proxy.
      void routeOnly(ses, spec.site).then(
        () => { if (!win.isDestroyed() && state.contentsId === contentsId) return win.loadURL(`https://${spec.site.host}/`) },
        error => {
          log.warn(`[browser] the window's connections could not be limited; not opened (${error instanceof Error ? error.message : 'unknown'})`)
          revoke()
          if (!win.isDestroyed()) win.destroy()
        },
      ).catch(() => { /* refused or offline: the window says so */ })
      return {
        webContents: contents,
        focus() {
          if (win.isDestroyed()) return
          if (win.isMinimized()) win.restore()
          win.show()
          win.focus()
        },
        // The app closes it: the session refuses everything at once, and no page handler
        // (beforeunload) can keep the window open.
        close() {
          revoke()
          if (!win.isDestroyed()) win.destroy()
        },
        updateSite(site: BrowserSiteSetting) {
          if (state.contentsId !== contentsId) return
          state.site = site
          void routeOnly(ses, site).catch(() => {
            log.warn('[browser] the window\'s connections could not be limited to the changed site; closed')
            revoke()
            if (!win.isDestroyed()) win.destroy()
          })
        },
        setMode,
        run,
      }
    },

    async clearPartition(partition) {
      const { ses } = guarded(partition)
      await ses.clearStorageData()
      await ses.clearCache()
      await ses.clearAuthCache()
      await ses.clearData()
    },
  }
}
