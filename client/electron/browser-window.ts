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
// read rule says so. Main's own requests (a run's, the preview's) never go through the page nor this
// session: page-less sessions of their own, the read session and the write session, one request at
// a time each with the window's login (features/browser/read-session.ts; agent-browser.md "The
// operator and the preview"); in `ai` mode the window's session refuses every request from outside
// its page.
import net from 'node:net'
import { BrowserWindow, net as electronNet, session, type Session, type WebContents } from 'electron'
import type { BrowserSiteSetting } from '../../shared/core/browser-operation'
import { exploreAddressProblem } from '../../shared/core/plugin-browser-declaration'
import {
  BROWSER_WORDS, browserProxyScript, browserReadPartition, browserWritePartition, browserResponseHeaders, createRefusalTally, decideAiRead, decideAiWrite, decideWindowRequest,
  hostForLog, isReadMethod, navigationAllowed,
  type BrowserReadDecider, type BrowserWindowMode, type BrowserWindowState, type BrowserWriteAttempt, type BrowserWriteDecider,
} from '../shared/browser-operation'
import type { BrowserGateDecision, BrowserPreviewSurface, BrowserRunSurface, BrowserSessionRequest } from '../shared/browser-runner'
import type { BrowserShell, BrowserWindowHandle, BrowserWindowSpec } from './features/browser/controller'
import { BrowserNotSentError, createSessionLanes, exactRead, throughSession, writeThroughSession, type PagelessSession } from './features/browser/read-session'

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
  preview: BrowserPreviewSurface
}

const RUN_REQUEST_MS = 30_000
const RUN_ANSWER_MAX = 5 * 1024 * 1024

/**
 * One request through a session, its answer or a rejection (no answer). A redirect is an answer: its
 * status is returned and it is not followed (a redirect after a save points back at a page; reading
 * it is the runner's own, declared read). With `beforeSend` (a run's write, 6b-2c), it is asked
 * synchronously right before `request.end` — no await between them —: false, a throw, or anything
 * failing before the request is ended rejects with `BrowserNotSentError` (the request never left);
 * every failure after `request.end` is an ordinary rejection (it may have left).
 */
function sendOnce(ses: Session, r: { method: string; url: string; contentType?: string; body?: string }, signal?: AbortSignal, beforeSend?: () => boolean): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    let done = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let request: Electron.ClientRequest | null = null
    const finish = (fn: () => void) => { if (!done) { done = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort); fn() } }
    function onAbort() { finish(() => { request?.abort(); reject(new Error('aborted')) }) }
    let made: Electron.ClientRequest
    try {
      made = electronNet.request({ method: r.method, url: r.url, session: ses, credentials: 'include', redirect: 'manual', cache: 'no-store' })
      request = made
      signal?.addEventListener('abort', onAbort, { once: true })
      timer = setTimeout(() => finish(() => { made.abort(); reject(new Error('no answer in time')) }), RUN_REQUEST_MS)
      made.on('redirect', status => finish(() => { made.abort(); resolve({ status, body: '' }) }))
      made.on('response', response => {
        const chunks: Buffer[] = []
        let size = 0
        // An answer larger than any page a checker reads is refused whole (never read cut short).
        response.on('data', chunk => {
          size += chunk.length
          if (size > RUN_ANSWER_MAX) finish(() => { made.abort(); reject(new Error('answer too large')) })
          else chunks.push(chunk)
        })
        response.on('end', () => finish(() => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') })))
        response.on('error', () => finish(() => reject(new Error('answer cut off'))))
      })
      made.on('error', () => finish(() => reject(new Error('no answer'))))
      made.on('abort', () => finish(() => reject(new Error('aborted'))))
      if (r.contentType) made.setHeader('content-type', r.contentType)
    } catch {
      finish(() => { request?.abort(); reject(new BrowserNotSentError('the request could not be made')) })
      return
    }
    // The last check of a run's write: nothing awaits between it and the request leaving.
    let go = true
    if (beforeSend) { try { go = beforeSend() === true } catch { go = false } }
    if (!go) {
      finish(() => { made.abort(); reject(new BrowserNotSentError('stopped right before sending')) })
      return
    }
    made.end(r.body)
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
 * try another way). The HTML viewer's document session sends every connection there too (doc-view.ts).
 */
export function startRefusingProxy(): Promise<number> {
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
  /** One lane per page-less session name, for the whole app run (a reopened window's too). */
  const lanes = createSessionLanes()

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
    const created: SessionState = { site: null, mode: 'human', aiGateReady: false, contentsId: null, tally: createRefusalTally(), flushTimer: null }
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

  const wipeSession = async (ses: Session) => {
    await ses.closeAllConnections().catch(() => {})
    await ses.clearStorageData().catch(() => {})
    await ses.clearCache().catch(() => {})
  }

  /**
   * A page-less session of a window (its read or write session): its one request hook is set per
   * request (Electron keeps the last listener; the lane runs one request at a time), the site's proxy
   * rule, every permission refused, the window's cookies for exactly the request's address copied in.
   */
  function pageless(partition: string, windowSession: Session, state: SessionState, label: string): PagelessSession {
    const ses = session.fromPartition(partition)
    return {
      wipe: () => wipeSession(ses),
      async guard(allow: (request: BrowserSessionRequest) => boolean) {
        ses.webRequest.onBeforeRequest((details, callback) => {
          let ok = false
          try { ok = allow({ method: details.method, url: details.url, body: uploadBody(details.uploadData) }) === true } catch { ok = false }
          if (!ok) refuse(state, hostForLog(details.url), label)
          callback({ cancel: !ok })
        })
        ses.setPermissionRequestHandler((_c, _p, callback) => callback(false))
        ses.setPermissionCheckHandler(() => false)
        if (!state.site) throw new Error('window closed')
        await routeOnly(ses, state.site)
      },
      async copyCookies(url: string) {
        const host = new URL(url).hostname
        for (const c of await windowSession.cookies.get({ url })) {
          await ses.cookies.set({
            url: `https://${host}${c.path ?? '/'}`, name: c.name, value: c.value, path: c.path,
            ...(c.hostOnly ? {} : { domain: c.domain }), secure: c.secure, httpOnly: c.httpOnly,
            ...(c.expirationDate ? { expirationDate: c.expirationDate } : {}), sameSite: c.sameSite,
          })
        }
      },
      send: (request, signal, beforeSend) => sendOnce(ses, request, signal, beforeSend),
    }
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
      // The run's gate for its own requests (read and write sessions); none outside a run.
      let runGate: ((request: BrowserSessionRequest) => BrowserGateDecision) | null = null
      const readKey = browserReadPartition(spec.partition)
      const writeKey = browserWritePartition(spec.partition)
      const reads = pageless(readKey, ses, state, 'read-session')
      const writes = pageless(writeKey, ses, state, 'ai-write-session')
      const revoke = () => {
        if (state.contentsId !== contentsId) return
        state.site = null
        state.mode = 'human'
        state.aiGateReady = false
        state.contentsId = null
        runGate = null
      }
      const closed = () => state.contentsId !== contentsId || win.isDestroyed() || !state.site
      const run: BrowserRunSurface = {
        async enterAi(hooks) {
          if (closed()) return false
          // The run's gate on its own requests (through the read and write sessions), then the page's gate.
          runGate = hooks.sessionRequest
          await setMode('ai', { decide: () => false, decideRead: hooks.pageRead, stopped: hooks.stopped })
          return !closed() && state.mode === 'ai' && state.aiGateReady
        },
        async leaveAi() {
          runGate = null
          if (state.contentsId === contentsId) await setMode('human')
        },
        // Never through the page nor the window's session: no script of the page sees, changes or answers it.
        async request({ method, path }) {
          if (closed() || !path.startsWith('/')) throw new Error('window closed')
          const gate = runGate
          if (!gate) throw new Error('no run')
          if (!isReadMethod(method)) throw new Error('a write goes through write()')
          const url = `https://${state.site!.host}${path}`
          // This window's own run only: the session's window is still this one and in `ai` mode.
          const asks = (r: BrowserSessionRequest) => state.contentsId === contentsId && state.mode === 'ai' && r.url === url && gate(r).allow
          // A read through the read session (page-less: a worker of the page cannot ask the same path
          // and have its answer taken for main's, design memo §33 2-4).
          return throughSession(lanes, readKey, reads, { method, url }, asks, undefined, () => !closed())
        },
        async write({ method, path, contentType, body }, steps) {
          const gate = runGate
          if (closed() || !path.startsWith('/') || !gate || isReadMethod(method)) return { sent: false, stage: 'prepare' }
          const url = `https://${state.site!.host}${path}`
          const asks = (r: BrowserSessionRequest) => state.contentsId === contentsId && state.mode === 'ai' && r.url === url && gate(r).allow
          // A write goes on a connection of its own (agent-browser.md "The runner"): Chromium resends a
          // request whose reused keep-alive connection dropped before the answer — below the request
          // hook, so the gate's "once" never sees it (verified on Electron 45: one lost answer reached
          // the site 12 times). The window's write session (one per window session, in memory: it does
          // not pile up) has its connections closed and its storage cleared before and after each
          // write, so it never holds an idle connection to reuse; it carries the window's login (the
          // cookies for the write's own address, path-scoped ones included), the site's proxy rule and
          // ONE request hook, the run's gate (Electron keeps the last one: replaced each write). What
          // the site sets in its answer (Set-Cookie) is not carried back to the window (decision: the
          // runner re-reads with the window's own login; a rotated cookie stays the window's). The
          // session is prepared first; then `steps.ready` (the permit), then `steps.beforeSend`
          // synchronously right before the request leaves (6b-2c, `sendOnce`).
          return writeThroughSession(lanes, writeKey, writes, { method, url, contentType, body }, asks, steps, () => !closed())
        },
        closed,
      }
      // The preview reads through the read session only: the window keeps its mode, page and the
      // member's typing (design memo §33 2-4); only exactly that address, GET.
      const preview: BrowserPreviewSurface = {
        async read(address, signal) {
          // A fixed path, and a query only of plain `name=value` pairs: no fragment, `..`, `//` or
          // percent-encoding (the preview builds the address from the declaration, `explorePath`).
          if (closed() || exploreAddressProblem(address)) throw new Error('window closed')
          const url = `https://${state.site!.host}${address}`
          return throughSession(lanes, readKey, reads, { method: 'GET', url }, exactRead(url), signal, () => !closed())
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
        preview,
      }
    },

    async clearPartition(partition) {
      const { ses } = guarded(partition)
      await ses.clearStorageData()
      await ses.clearCache()
      await ses.clearAuthCache()
      await ses.clearData()
      // Its page-less sessions are empty between requests; cleared again after the one running, if any.
      for (const name of [browserReadPartition(partition), browserWritePartition(partition)]) {
        await lanes.run(name, () => wipeSession(session.fromPartition(name)))
      }
    },
  }
}
