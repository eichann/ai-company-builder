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
// its page. A site's declared login helpers (a CAPTCHA) work only in `human` mode: entering `ai` mode
// shuts them (the request rule, the frames' navigation and the proxy) and refuses to start while a
// frame of another origin is still in the page (agent-browser.md "Login helpers").
// The window's DevTools connection has one holder at a time (`createPageDebugger`): the `ai`-mode gate, or a recording
// the person makes (agent-browser.md "Recording": observe only, the person's requests go out as in `human` mode).
import net from 'node:net'
import { BrowserWindow, net as electronNet, session, type Session, type WebContents, type WebFrameMain } from 'electron'
import type { BrowserSiteSetting } from '../../shared/core/browser-operation'
import { exploreAddressProblem, type BrowserLoginHelper } from '../../shared/core/plugin-browser-declaration'
import {
  BROWSER_WORDS, browserProxyScript, browserReadPartition, browserWritePartition, browserResponseHeaders, createRefusalTally, decideAiRead, decideAiWrite, decideWindowRequest,
  foreignFrameCount, frameSeenByPageGate, hostForLog, isReadMethod, proxyHelperHosts, windowNavigationAllowed,
  type BrowserReadDecider, type BrowserWindowMode, type BrowserWindowState, type BrowserWriteAttempt, type BrowserWriteDecider,
} from '../shared/browser-operation'
import type { BrowserGateDecision, BrowserPreviewSurface, BrowserRunSurface, BrowserSessionRequest } from '../shared/browser-runner'
import type { BrowserShell, BrowserWindowHandle, BrowserWindowSpec } from './features/browser/controller'
import {
  BROWSER_RECORDING_BINDING, BROWSER_RECORDING_SCRIPT, BROWSER_RECORDING_WINDOW_TITLE, BROWSER_RECORDING_WORLD, createPageDebuggerOwner,
  type BrowserRecordingObservation, type BrowserRecordingObserver, type BrowserRecordSurface,
} from '../shared/browser-recorder'
import { readBrowserPageSnapshot, sameDomainPath, BROWSER_BROWSE_LIMITS, type BrowserBrowseSurface } from '../shared/browser-browse'
import { BROWSER_BROWSE_WORLD, BROWSER_SNAPSHOT_SCRIPT, browseFocusScript, browsePointScript, browseSelectScript } from '../shared/browser-browse-script'
import { BrowserNotSentError, createSessionLanes, exactRead, throughSession, writeThroughSession, type PagelessSession, type SessionAnswer, type SessionRequest } from './features/browser/read-session'
import type { BrowserWorkHooks, HeldBody, HeldPageWriteAnswer } from '../shared/browser-frame-writes'
import type { BrowserWriteOutcome, BrowserWriteSteps } from '../shared/browser-runner'

/** What `ai` mode needs: the approved step's decider (none = no write) and the emergency stop. */
export interface BrowserAiGate {
  decide?: BrowserWriteDecider
  /** A run's read rule for the page's reads of the operated host (none: reads pass). */
  decideRead?: BrowserReadDecider
  stopped: () => boolean
  /**
   * The operator's window tools (agent-browser.md "The operator's window tools"): every JavaScript dialog the page opens
   * (alert / confirm / prompt / beforeunload) is dismissed — never accepted — so a page cannot hold the window and a
   * confirm never says yes.
   */
  dismissDialogs?: boolean
  /**
   * A write run (step ⑤b; agent-browser.md "Writes within frames, in the app"): every write the page makes is held — never
   * continued — and handed to `hooks.holdWrite` with `send`, the window's one way to send exactly that request once through
   * its write session. The page then gets the site's answer (without `Set-Cookie`) or a failure.
   */
  hold?: { hooks: BrowserWorkHooks; send(request: SessionRequest, steps: BrowserWriteSteps): Promise<BrowserWriteOutcome> }
}

/** Request headers a held write's copy never carries (the session sets them, or they belong to the connection). */
const HELD_DROPPED_HEADERS = new Set(['host', 'content-length', 'content-type', 'cookie', 'cookie2', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'expect', 'accept-encoding'])
const heldHeaders = (headers: Record<string, string>): Array<[string, string]> =>
  Object.entries(headers).filter(([k]) => { const n = k.toLowerCase(); return !HELD_DROPPED_HEADERS.has(n) && !n.startsWith('proxy-') && !n.startsWith('sec-') })
/** A held write's body read at most (larger: not readable, refused). */
const HELD_BODY_MAX = 1024 * 1024
/** Answer headers a fulfilled page request never gets: cookies (the site's are never handed back), and what no longer fits the decoded body. */
const FULFILL_DROPPED_HEADERS = new Set(['set-cookie', 'set-cookie2', 'content-encoding', 'content-length', 'transfer-encoding'])

export interface BrowserShellWindow extends BrowserWindowHandle {
  readonly webContents: WebContents
  /** `human` (default) or `ai` with its gate; the gate attaches after the first page load. */
  setMode(mode: BrowserWindowMode, gate?: BrowserAiGate): Promise<void>
  run: BrowserRunSurface
  preview: BrowserPreviewSurface
  record: BrowserRecordSurface
  browse: BrowserBrowseSurface
}

const RUN_REQUEST_MS = 30_000
const RUN_ANSWER_MAX = 5 * 1024 * 1024
/** A recording reads an answer's JSON key shape only up to this size, and a request body's field names up to the next. */
const RECORDING_ANSWER_MAX = 1024 * 1024
const RECORDING_BODY_MAX = 64 * 1024
/** How long a recording waits for the window's first page before it gives up (and is discarded). */
const RECORDING_START_MS = 20_000
/** How long a run waits for the first page of a window it opened again (then it goes on, and the run's own checks decide). */
const RUN_WINDOW_LOAD_MS = 20_000

/**
 * One request through a session, its answer or a rejection (no answer). A redirect is an answer: its
 * status is returned and it is not followed (a redirect after a save points back at a page; reading
 * it is the runner's own, declared read). With `beforeSend` (a run's write, 6b-2c), it is asked
 * synchronously right before `request.end` — no await between them —: false, a throw, or anything
 * failing before the request is ended rejects with `BrowserNotSentError` (the request never left);
 * every failure after `request.end` is an ordinary rejection (it may have left).
 */
/** The answer's headers as pairs, `Set-Cookie` left out (what the site sets is never handed back to a page or a window). */
function answerHeaders(headers: Record<string, string | string[]>): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === 'set-cookie' || name.toLowerCase() === 'set-cookie2') continue
    for (const v of Array.isArray(value) ? value : [value]) out.push([name, v])
  }
  return out
}

function sendOnce(ses: Session, r: SessionRequest, signal?: AbortSignal, beforeSend?: () => boolean): Promise<SessionAnswer> {
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
      made.on('redirect', (status, _method, _url, headers) => finish(() => { made.abort(); resolve({ status, body: '', headers: answerHeaders(headers ?? {}), bytes: new Uint8Array() }) }))
      made.on('response', response => {
        const chunks: Buffer[] = []
        let size = 0
        // An answer larger than any page a checker reads is refused whole (never read cut short).
        response.on('data', chunk => {
          size += chunk.length
          if (size > RUN_ANSWER_MAX) finish(() => { made.abort(); reject(new Error('answer too large')) })
          else chunks.push(chunk)
        })
        response.on('end', () => finish(() => {
          const bytes = Buffer.concat(chunks)
          resolve({ status: response.statusCode, body: bytes.toString('utf8'), headers: answerHeaders(response.headers), bytes: new Uint8Array(bytes) })
        }))
        response.on('error', () => finish(() => reject(new Error('answer cut off'))))
      })
      made.on('error', () => finish(() => reject(new Error('no answer'))))
      made.on('abort', () => finish(() => reject(new Error('aborted'))))
      if (r.contentType) made.setHeader('content-type', r.contentType)
      // A page's held write (step ⑤b): the headers its script set, as it set them (a refused one: never sent).
      for (const [name, value] of r.headers ?? []) made.setHeader(name, value)
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
    made.end(typeof r.body === 'string' || r.body === undefined ? r.body : Buffer.from(r.body))
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
 * Did this request come from a frame of the window's page that the page's write gate sees (the operated
 * origin, the main frame's process)? A frame that is gone, another window's or not known: no.
 */
function fromPageFrame(state: SessionState, contents: WebContents | undefined, frame: WebFrameMain | null | undefined): boolean {
  try {
    if (!state.site || !contents || contents.isDestroyed() || contents.id !== state.contentsId || !frame) return false
    return frameSeenByPageGate(state.site, contents.mainFrame.processId, { origin: frame.origin, processId: frame.processId })
  } catch {
    return false
  }
}

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

export function createBrowserWindowShell(options: {
  log?: Pick<Console, 'warn'>
  show?: boolean
  /** Login helpers for a site that does not carry its own (`BrowserWindowSite.loginHelpers`); none = none. */
  loginHelpers?: (host: string) => readonly BrowserLoginHelper[]
} = {}): BrowserShell & { open(spec: BrowserWindowSpec): BrowserShellWindow } {
  const log = options.log ?? console
  // A domain's login helpers come with its site (the controller composes them: the company's 「詳しい設定」, else the
  // bundled fallback; agent-browser.md "A domain's parts and login helpers"); `loginHelpers` only for a site without.
  const helpersOf = (site: BrowserSiteSetting & { loginHelpers?: readonly BrowserLoginHelper[] }) => site.loginHelpers ?? options.loginHelpers?.(site.host) ?? []
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

  /**
   * Points the session's proxy at the site's hosts (DIRECT) and the refusing proxy (the rest). The
   * window's own session (`state` given) also sends its login helpers DIRECT, in `human` mode only, as
   * the mode is when the script is made (after the wait for the port); a page-less session never.
   */
  async function routeOnly(ses: Session, site: BrowserSiteSetting, state?: SessionState) {
    refusingProxy ??= startRefusingProxy()
    const port = await refusingProxy
    const script = browserProxyScript(site, port, state ? proxyHelperHosts(state) : [])
    await ses.setProxy({ mode: 'pac_script', pacScript: `data:application/x-ns-proxy-autoconfig;base64,${Buffer.from(script).toString('base64')}` })
  }

  /** The partition's session with its guards, installed once per session (also one only cleared). */
  function guarded(partition: string): { ses: Session; state: SessionState } {
    const ses = session.fromPartition(partition)
    let state = states.get(partition)
    if (state) return { ses, state }
    const created: SessionState = { site: null, mode: 'human', aiGateReady: false, helpers: [], contentsId: null, tally: createRefusalTally(), flushTimer: null }
    states.set(partition, created)
    state = created
    // The one request hook of this session. With no window (site null) it refuses everything:
    // a service worker left running must not reach anywhere.
    ses.webRequest.onBeforeRequest((details, callback) => {
      const decision = decideWindowRequest(created, {
        url: details.url, method: details.method, resourceType: details.resourceType,
        fromWindow: details.webContentsId !== undefined && details.webContentsId === created.contentsId,
        // Only `ai` mode asks it (another frame's request is not the gate's to see then).
        pageFrame: created.mode === 'ai' ? fromPageFrame(created, details.webContents, details.frame) : true,
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
    // The mode at the moment of the navigation: a login helper's frame only in `human` mode.
    const allowed = (url: string, mainFrame: boolean) => windowNavigationAllowed(state, url, mainFrame)
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

  /**
   * The window's ONE DevTools connection (`webContents.debugger`) and who holds it (`createPageDebuggerOwner`): the
   * `ai`-mode write gate (DevTools Fetch interception of every request) or a recording (agent-browser.md "Recording":
   * Network, Page and an isolated world's binding, observe only) — never both. Only this function attaches and detaches;
   * the recording only receives what it observes.
   */
  function createPageDebugger(contents: WebContents, state: SessionState) {
    const owner = createPageDebuggerOwner()
    let gate: BrowserAiGate | null = null
    let loaded = false
    let pendingAttach = false
    const firstLoad: Array<() => void> = []
    contents.once('did-finish-load', () => {
      loaded = true
      if (pendingAttach) void attach()
      for (const go of firstLoad.splice(0)) go()
    })
    let recorder: BrowserRecordingObserver | null = null
    /** The recording's own isolated worlds (only their binding calls count). */
    const recordingContexts = new Set<number>()
    /** Requests whose answer is JSON (its key shape is read once it finished). */
    const jsonAnswers = new Set<string>()
    let mainFrameId: string | null = null
    const endRecording = (reason: 'closed' | 'lost') => {
      const r = recorder
      if (!r) return
      recorder = null
      recordingContexts.clear()
      jsonAnswers.clear()
      owner.release('recording')
      try { r.ended(reason) } catch { /* the listener's own failure */ }
    }
    const onRecording = (method: string, params: Record<string, unknown>) => {
      const r = recorder
      if (!r) return
      const observe = (o: BrowserRecordingObservation) => { try { r.observe(o) } catch { /* left out */ } }
      switch (method) {
        case 'Runtime.executionContextCreated': {
          const ctx = params.context as { id?: number; name?: string } | undefined
          if (ctx && ctx.name === BROWSER_RECORDING_WORLD && typeof ctx.id === 'number') recordingContexts.add(ctx.id)
          return
        }
        case 'Runtime.executionContextDestroyed':
          recordingContexts.delete(params.executionContextId as number)
          return
        case 'Runtime.executionContextsCleared':
          recordingContexts.clear()
          return
        case 'Runtime.bindingCalled':
          // The binding lives only in the recording's isolated world; a call from any other context is not the script's.
          if (params.name === BROWSER_RECORDING_BINDING && recordingContexts.has(params.executionContextId as number) && typeof params.payload === 'string') {
            observe({ kind: 'action', payload: params.payload.slice(0, 4000) })
          }
          return
        case 'Page.frameNavigated': {
          const frame = params.frame as { id?: string; parentId?: string; url?: string } | undefined
          if (frame && !frame.parentId && typeof frame.url === 'string') {
            mainFrameId = frame.id ?? null
            observe({ kind: 'page', url: frame.url })
          }
          return
        }
        case 'Page.navigatedWithinDocument':
          if (params.frameId === mainFrameId && typeof params.url === 'string') observe({ kind: 'page', url: params.url })
          return
        case 'Network.requestWillBeSent': {
          const request = params.request as { url: string; method: string; headers?: Record<string, string>; postData?: string; hasPostData?: boolean; postDataEntries?: Array<{ bytes?: string }> }
          const contentType = Object.entries(request.headers ?? {}).find(([k]) => k.toLowerCase() === 'content-type')?.[1]
          const body = request.postData ?? (request.postDataEntries ? request.postDataEntries.map(e => Buffer.from(e.bytes ?? '', 'base64').toString('utf8')).join('') : undefined)
          observe({ kind: 'request', id: String(params.requestId), method: request.method, url: request.url, resourceType: String(params.type ?? ''), contentType, body, hasBody: request.hasPostData === true || body !== undefined })
          return
        }
        case 'Network.responseReceived': {
          const response = params.response as { status: number; mimeType?: string }
          const id = String(params.requestId)
          if (/json/i.test(response.mimeType ?? '')) jsonAnswers.add(id)
          observe({ kind: 'response', id, status: response.status })
          return
        }
        case 'Network.loadingFinished': {
          const id = String(params.requestId)
          observe({ kind: 'finished', id })
          if (!jsonAnswers.delete(id) || Number(params.encodedDataLength ?? 0) > RECORDING_ANSWER_MAX) return
          // The answer's text is read here only to take its key shape; the recorder drops it at once.
          contents.debugger.sendCommand('Network.getResponseBody', { requestId: id }).then((answer: { body?: string; base64Encoded?: boolean }) => {
            if (recorder !== r || typeof answer.body !== 'string') return
            const text = answer.base64Encoded ? Buffer.from(answer.body, 'base64').toString('utf8') : answer.body
            if (text.length <= RECORDING_ANSWER_MAX) observe({ kind: 'response', id, status: 0, json: text })
          }, () => { /* gone with its page */ })
          return
        }
      }
    }
    const onMessage = async (_event: unknown, method: string, params: Record<string, unknown>) => {
      // The operator's window tools: a page's dialog is dismissed at once (never accepted), so nothing waits on it.
      if (method === 'Page.javascriptDialogOpening') {
        if (owner.holder() === 'ai' && gate?.dismissDialogs) {
          // Never a yes to the page (alert / confirm / prompt dismissed), except a beforeunload: the page is always let go
          // (a page cannot keep its document — and the timers in it — alive by asking to stay; independent review M).
          try { await contents.debugger.sendCommand('Page.handleJavaScriptDialog', { accept: params.type === 'beforeunload' }) } catch { /* gone */ }
          return
        }
      }
      // The operator's window tools: a file chooser never opens a dialog of this computer (intercepted, refused).
      if (method === 'Page.fileChooserOpened') {
        if (owner.holder() === 'ai' && gate?.dismissDialogs) refuse(state, hostForLog(contents.getURL()), 'file-chooser')
        return
      }
      if (method !== 'Fetch.requestPaused') { onRecording(method, params); return }
      const requestId = params.requestId as string
      const request = params.request as { url: string; method: string; headers?: Record<string, string>; postData?: string; postDataEntries?: Array<{ bytes?: string }>; hasPostData?: boolean }
      // A write run (step ⑤b): the page's write is held, never continued; the run decides, main sends it once or not at all.
      const hold = state.site && state.mode === 'ai' && gate?.hold
      if (hold && !isReadMethod(request.method)) {
        await holdPageWrite(requestId, request, hold)
        return
      }
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
    /** The page's writes held now (failed before the gate lets go: Chromium would send a paused request on its own). */
    const heldIds = new Set<string>()
    async function holdPageWrite(
      requestId: string,
      request: { url: string; method: string; headers?: Record<string, string>; postData?: string; postDataEntries?: Array<{ bytes?: string }>; hasPostData?: boolean },
      hold: NonNullable<BrowserAiGate['hold']>,
    ) {
      heldIds.add(requestId)
      const fail = async () => { try { await contents.debugger.sendCommand('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }) } catch { /* gone */ } }
      try {
        const headers = request.headers ?? {}
        // The basic rule first: https on the operated host, the AI not stopped, no method-override header.
        const pre = state.site ? await decideAiWrite(state.site, { method: request.method, url: request.url, headers }, () => true, gate?.stopped() ?? true) : { allow: false as const, reason: 'host' as const }
        if (!pre.allow) { refuse(state, hostForLog(request.url), `ai-write:${pre.reason}`); await fail(); return }
        // The exact bytes the page made (a form's, a JSON's, a multipart's text parts); a file, a stream or a large body: not readable.
        let bytes: Buffer | null = null
        let readable = true
        if (request.postDataEntries && request.postDataEntries.length > 0) {
          if (request.postDataEntries.some(e => typeof e.bytes !== 'string')) readable = false
          else bytes = Buffer.concat(request.postDataEntries.map(e => Buffer.from(e.bytes as string, 'base64')))
        } else if (typeof request.postData === 'string') bytes = Buffer.from(request.postData, 'utf8')
        else if (request.hasPostData === true) readable = false
        if (bytes && bytes.length > HELD_BODY_MAX) readable = false
        const body: HeldBody = !readable ? { kind: 'unreadable' } : bytes === null || bytes.length === 0 ? { kind: 'none' } : { kind: 'text', text: bytes.toString('utf8') }
        const contentType = Object.entries(headers).find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? ''
        const copy: SessionRequest = {
          method: request.method, url: request.url, ...(contentType ? { contentType } : {}), headers: heldHeaders(headers),
          ...(bytes && bytes.length > 0 ? { body: new Uint8Array(bytes) } : {}),
        }
        let answer: HeldPageWriteAnswer
        try {
          answer = await hold.hooks.holdWrite({ method: request.method, url: request.url, contentType, body, send: steps => hold.send(copy, steps) })
        } catch {
          answer = { kind: 'fail' }
        }
        if (answer.kind === 'fail' || !heldIds.has(requestId)) { await fail(); return }
        try {
          await contents.debugger.sendCommand('Fetch.fulfillRequest', {
            requestId, responseCode: answer.status,
            responseHeaders: answer.headers.filter(([k]) => !FULFILL_DROPPED_HEADERS.has(k.toLowerCase())).map(([name, value]) => ({ name, value })),
            body: Buffer.from(answer.body).toString('base64'),
          })
        } catch { /* the page went away meanwhile */ }
      } finally {
        heldIds.delete(requestId)
      }
    }
    /** Every write still held fails at once (the gate is about to let go, or the window goes). */
    const failHeld = async () => {
      for (const requestId of [...heldIds]) {
        heldIds.delete(requestId)
        try { await contents.debugger.sendCommand('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }) } catch { /* gone */ }
      }
    }
    const onDetach = () => {
      // A write held now may be let go by Chromium on its own once the connection is gone: the run is told, so its copy is
      // never sent and the write counts as unknown (independent review of #856).
      const hadHeld = heldIds.size > 0
      heldIds.clear()
      state.aiGateReady = false
      if (hadHeld) { try { gate?.hold?.hooks.detached?.() } catch { /* the run's own failure */ } }
      // Gone: the next attach adds the listeners again (never twice).
      try { contents.debugger.removeListener('message', onMessage); contents.debugger.removeListener('detach', onDetach) } catch { /* the window is gone */ }
      // The connection went away under a recording (the window is going, or another client took it): it is discarded.
      if (recorder) endRecording(contents.isDestroyed() ? 'closed' : 'lost')
    }
    const connect = () => {
      const dbg = contents.debugger
      if (!dbg.isAttached()) {
        dbg.attach('1.3')
        dbg.on('message', onMessage)
        dbg.on('detach', onDetach)
      }
      return dbg
    }
    const disconnect = () => {
      const dbg = contents.debugger
      if (contents.isDestroyed() || !dbg.isAttached()) return
      dbg.removeListener('message', onMessage)
      dbg.removeListener('detach', onDetach)
      dbg.detach()
    }
    async function attach() {
      pendingAttach = false
      if (contents.isDestroyed() || state.mode !== 'ai' || owner.holder() !== 'ai') return
      const dbg = connect()
      await dbg.sendCommand('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] })
      if (gate?.dismissDialogs) {
        await dbg.sendCommand('Page.enable')
        await dbg.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true })
      }
      state.aiGateReady = state.mode === 'ai'
    }
    const setMode = async (mode: BrowserWindowMode, next?: BrowserAiGate) => {
      if (mode === 'ai') {
        // Never while a recording holds the connection: the window stays in `human` mode (a run then refuses to start).
        if (!owner.claim('ai')) return
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
      // A recording's connection is the recording's: `human` mode never takes it away.
      if (owner.holder() !== 'ai') return
      owner.release('ai')
      if (!contents.isDestroyed() && contents.debugger.isAttached()) {
        // A held write is failed before Fetch lets go of the page's requests (step ⑤b: never sent on its own).
        await failHeld()
        try { await contents.debugger.sendCommand('Fetch.disable') } catch { /* detaching anyway */ }
      }
      disconnect()
    }
    const letGo = () => {
      recorder = null
      recordingContexts.clear()
      jsonAnswers.clear()
      owner.release('recording')
      disconnect()
    }
    const record: BrowserRecordSurface = {
      async start(observer) {
        // Never while the AI operates the window (or is about to): the AI's gate holds the connection.
        if (contents.isDestroyed() || !state.site || state.mode === 'ai' || recorder || !owner.claim('recording')) return false
        try {
          if (!loaded) {
            const ok = await new Promise<boolean>(resolve => {
              const timer = setTimeout(() => resolve(false), RECORDING_START_MS)
              firstLoad.push(() => { clearTimeout(timer); resolve(true) })
            })
            if (!ok || contents.isDestroyed() || owner.holder() !== 'recording') throw new Error('not loaded')
          }
          recorder = observer
          const dbg = connect()
          await dbg.sendCommand('Runtime.enable')
          await dbg.sendCommand('Runtime.addBinding', { name: BROWSER_RECORDING_BINDING, executionContextName: BROWSER_RECORDING_WORLD })
          await dbg.sendCommand('Page.enable')
          // The main frame's id now: a page already loaded navigates within itself (History API) before any new load.
          const tree = await dbg.sendCommand('Page.getFrameTree') as { frameTree?: { frame?: { id?: string } } }
          mainFrameId = tree.frameTree?.frame?.id ?? null
          await dbg.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: BROWSER_RECORDING_SCRIPT, worldName: BROWSER_RECORDING_WORLD, runImmediately: true })
          await dbg.sendCommand('Network.enable', { maxPostDataSize: RECORDING_BODY_MAX })
          if (recorder !== observer) return false
          // The page the window shows now is the first step.
          observer.observe({ kind: 'page', url: contents.getURL() })
          return true
        } catch {
          // Could not start: nothing is kept (the recording's owner discards it) and the connection is let go.
          if (recorder === observer || recorder === null) letGo()
          return false
        }
      },
      async stop() {
        if (recorder) letGo()
      },
      active: () => recorder !== null,
    }
    /** One DevTools command for the operator's window tools: only while the `ai` gate holds the connection and is ready. */
    const command = async (method: string, params: Record<string, unknown>): Promise<boolean> => {
      if (contents.isDestroyed() || owner.holder() !== 'ai' || state.mode !== 'ai' || !state.aiGateReady || !contents.debugger.isAttached()) return false
      try { await contents.debugger.sendCommand(method, params); return true } catch { return false }
    }
    /** The page's first load (the one an `ai` gate waits for before attaching): true once it happened, false at `ms` or the signal. */
    const firstLoaded = (signal: AbortSignal, ms: number): Promise<boolean> => new Promise(resolve => {
      if (loaded) { resolve(true); return }
      if (contents.isDestroyed() || signal.aborted) { resolve(false); return }
      let timer: ReturnType<typeof setTimeout> | undefined
      function done(ok: boolean) {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        if (!contents.isDestroyed()) contents.removeListener('destroyed', onAbort)
        resolve(ok)
      }
      function onAbort() { done(false) }
      timer = setTimeout(onAbort, ms)
      signal.addEventListener('abort', onAbort, { once: true })
      // A window closed before its first page answers at once (no wait to the end).
      contents.once('destroyed', onAbort)
      firstLoad.push(() => done(true))
    })
    return { setMode, record, command, firstLoaded, windowClosed: () => endRecording('closed') }
  }

  return {
    open(spec) {
      const { ses, state } = guarded(spec.partition)
      state.site = spec.site
      state.helpers = helpersOf(spec.site)
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
      const pageDebugger = createPageDebugger(contents, state)
      /**
       * The mode, and the proxy to match: entering `ai` the request rule and the frames' navigation
       * refuse the login helpers at once (`state.mode` is set before any await), then the proxy drops
       * them and the session's open connections are closed (a pooled one would keep the old route).
       * Back in `human` they work again.
       */
      const setMode = async (mode: BrowserWindowMode, gate?: BrowserAiGate) => {
        await pageDebugger.setMode(mode, gate)
        if (state.contentsId !== contentsId || !state.site) return
        await routeOnly(ses, state.site, state)
        if (mode === 'ai') await ses.closeAllConnections()
      }
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
      /** No frame but ones the page's write gate sees (`foreignFrameCount`); a closed window or a failed look: not clean. */
      const pageClean = (): boolean => {
        try {
          if (closed() || contents.isDestroyed()) return false
          const main = contents.mainFrame
          const subframes = main.framesInSubtree.filter(f => f !== main).map(f => ({ origin: f.origin, processId: f.processId }))
          return foreignFrameCount(state.site!, main.processId, subframes) === 0
        } catch {
          return false
        }
      }
      const run: BrowserRunSurface = {
        async enterAi(hooks) {
          if (closed()) return false
          // The run's gate on its own requests (through the read and write sessions), then the page's gate.
          runGate = hooks.sessionRequest
          await setMode('ai', { decide: () => false, decideRead: hooks.pageRead, stopped: hooks.stopped })
          // Frames the gate does not see are the runner's to ask (`pageClean`, at every check up to the send).
          return !closed() && state.mode === 'ai' && state.aiGateReady
        },
        pageClean,
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
          // Never while the person records (the AI reads nothing then: agent-browser.md "Recording").
          if (closed() || pageDebugger.record.active() || exploreAddressProblem(address)) throw new Error('window closed')
          const url = `https://${state.site!.host}${address}`
          return throughSession(lanes, readKey, reads, { method: 'GET', url }, exactRead(url), signal, () => !closed())
        },
        closed,
      }
      // The title always names the site, whatever the page calls itself.
      win.on('page-title-updated', event => event.preventDefault())
      // A window a run opened again is shown without the keyboard: the member's typing stays where it was.
      if (options.show !== false) win.once('ready-to-show', () => { if (spec.inactive) win.showInactive(); else win.show() })
      win.on('closed', () => {
        // A recording in progress is discarded with its window.
        pageDebugger.windowClosed()
        revoke()
        flush(state)
        spec.onClosed()
      })
      // Nothing loads before the session's connections are routed: the site's hosts or the refusing proxy.
      void routeOnly(ses, spec.site, state).then(
        () => { if (!win.isDestroyed() && state.contentsId === contentsId) return win.loadURL(`https://${spec.site.host}/`) },
        error => {
          log.warn(`[browser] the window's connections could not be limited; not opened (${error instanceof Error ? error.message : 'unknown'})`)
          revoke()
          if (!win.isDestroyed()) win.destroy()
        },
      ).catch(() => { /* refused or offline: the window says so */ })
      // The operator's window tools (agent-browser.md "The operator's window tools"): reading only — the `ai` gate with a
      // decider that refuses every write, dialogs dismissed; the page read and acted on from an isolated world (its script
      // cannot see or replace what is used), presses and typing as real input through the gate's DevTools connection.
      let browsing = false
      const browseReady = () => browsing && !closed() && !contents.isDestroyed() && state.mode === 'ai' && state.aiGateReady
      const inWorld = async (code: string): Promise<unknown> => {
        if (!browseReady()) return null
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          return await Promise.race([
            contents.executeJavaScriptInIsolatedWorld(BROWSER_BROWSE_WORLD, [{ code }]),
            new Promise(resolve => { timer = setTimeout(() => resolve(null), 5_000) }),
          ])
        } catch {
          return null
        } finally {
          clearTimeout(timer)
        }
      }
      const pause = (ms: number, signal: AbortSignal) => new Promise<void>(resolve => {
        if (signal.aborted) { resolve(); return }
        const timer = setTimeout(done, ms)
        function done() { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
        signal.addEventListener('abort', done, { once: true })
      })
      /**
       * A navigation main starts, bounded: it ends at the signal or after `settleMs`, the load then stopped (a page that never
       * finishes loading cannot keep a stopped run waiting). False when it did not load.
       */
      const navigate = async (start: () => Promise<void>, signal: AbortSignal): Promise<boolean> => {
        const cut = new AbortController()
        const onStop = () => cut.abort()
        signal.addEventListener('abort', onStop, { once: true })
        const timer = setTimeout(onStop, BROWSER_BROWSE_LIMITS.settleMs)
        try {
          const ended = await Promise.race([
            start().then(() => true, () => false),
            new Promise<false>(resolve => { if (cut.signal.aborted) resolve(false); else cut.signal.addEventListener('abort', () => resolve(false), { once: true }) }),
          ])
          if (!ended && !contents.isDestroyed()) contents.stop()
          return ended
        } finally {
          clearTimeout(timer)
          signal.removeEventListener('abort', onStop)
        }
      }
      /** Whether the operator did anything in this run (then the page is loaded afresh before the member gets it back). */
      let actedOnPage = false
      // While the operator has the window (and while it is given back), a page's beforeunload never keeps its document.
      contents.on('will-prevent-unload', event => { if (browsing || actedOnPage) event.preventDefault() })
      /** After an action: a moment, then until the page stops loading (at most `settleMs`). */
      const settle = async (signal: AbortSignal, mayNavigate: boolean) => {
        // A press may start a navigation a little later: give it up to a second to start before reading "done".
        let started = false
        const onStart = () => { started = true }
        contents.once('did-start-loading', onStart)
        await pause(300, signal)
        for (let i = 0; mayNavigate && i < 7 && !started && !contents.isLoading() && !signal.aborted; i++) await pause(100, signal)
        contents.removeListener('did-start-loading', onStart)
        const until = Date.now() + BROWSER_BROWSE_LIMITS.settleMs
        while (!signal.aborted && !contents.isDestroyed() && contents.isLoading() && Date.now() < until) await pause(100, signal)
      }
      /** A write run's held write, sent once through the window's write session (exactly the page's request: step ⑤b). */
      const sendHeld = (request: SessionRequest, steps: BrowserWriteSteps): Promise<BrowserWriteOutcome> => {
        if (closed()) return Promise.resolve({ sent: false, stage: 'prepare' })
        // Only while the gate still holds the page (a detached DevTools connection may have let the original go).
        const asks = (r: BrowserSessionRequest) => state.contentsId === contentsId && state.mode === 'ai' && state.aiGateReady && r.url === request.url && r.method === request.method
        return writeThroughSession(lanes, writeKey, writes, request, asks, steps, () => !closed())
      }
      const browse: BrowserBrowseSurface = {
        async enter(stopped, work) {
          if (closed() || pageDebugger.record.active()) return false
          // The operator works in a window the member may have behind others or minimized: a hidden page takes no
          // presses, so it is kept as a shown one while the operator has it (restored when it is given back).
          contents.setBackgroundThrottling(false)
          if (!win.isDestroyed() && !win.isVisible()) win.showInactive()
          await setMode('ai', {
            decide: () => false, stopped, dismissDialogs: true,
            // A write run: the page's writes are held for the run, and a Skill's never-read addresses are refused.
            ...(work ? {
              hold: { hooks: work, send: sendHeld },
              decideRead: read => { try { const u = new URL(read.url); return !work.neverRead(`${u.pathname}${u.search}`) } catch { return false } },
            } : {}),
          })
          browsing = !closed() && state.mode === 'ai' && state.aiGateReady
          if (!browsing || !state.site) return false
          // The page is loaded afresh under the gate before the operator sees it (independent review): what the page held
          // open from the member's time — a WebSocket, a stream, a timer — is gone, so no press of the operator's can write
          // through it. A GET of the address it shows (else the site's start page); a load that does not end refuses the run.
          const host = state.site.host
          const shown = contents.getURL()
          browsing = await navigate(() => contents.loadURL(sameDomainPath(shown, host) !== null ? shown : `https://${host}/`), new AbortController().signal)
          browsing &&= browseReady()
          return browsing
        },
        async leave() {
          // What the operator's presses started on the page (a timer that sends later, an autosave, a retry) must not go out
          // once the member has the window back: while the write gate still holds, the page is loaded afresh (a GET of the
          // address it shows, else the site's start page) — that document and its timers are gone. A load that does not end
          // in time is stopped, and the window is then emptied rather than handed back with that document.
          // The page cannot refuse to go (a beforeunload is let go: `will-prevent-unload` and the dialog handler). When the
          // fresh load cannot be made under the gate — the gate gone, the load refused or not ending — the window is closed
          // instead of handed back with that document (its login stays: the next run opens it again, agent-browser.md "The window a run needs"; review M, L1).
          if (actedOnPage) {
            let fresh = false
            if (browseReady() && state.site) {
              const host = state.site.host
              const now = contents.getURL()
              const url = sameDomainPath(now, host) !== null ? now : `https://${host}/`
              fresh = await navigate(() => contents.loadURL(url), new AbortController().signal)
            }
            if (!fresh) {
              log.warn('[browser] the page could not be loaded afresh after the operator; the window is closed')
              actedOnPage = false
              browsing = false
              revoke()
              if (!win.isDestroyed()) win.destroy()
              return
            }
          }
          actedOnPage = false
          browsing = false
          if (!contents.isDestroyed()) contents.setBackgroundThrottling(true)
          if (state.contentsId === contentsId) await setMode('human')
        },
        async snapshot() {
          const text = await inWorld(BROWSER_SNAPSHOT_SCRIPT)
          return state.site ? readBrowserPageSnapshot(text, state.site.host) : null
        },
        async act(action, signal) {
          if (!browseReady() || signal.aborted) return 'failed'
          if (action.do !== 'wait') actedOnPage = true
          switch (action.do) {
            case 'click': {
              const at = await inWorld(browsePointScript(action.ref))
              let point: { x: number; y: number } | null = null
              try { point = typeof at === 'string' ? JSON.parse(at) as { x: number; y: number } : null } catch { point = null }
              if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return 'failed'
              // A real press of the window's own input (trusted, as a person's), only while the gate holds the window.
              const x = Math.round(point.x)
              const y = Math.round(point.y)
              if (!browseReady()) return 'failed'
              contents.sendInputEvent({ type: 'mouseMove', x, y })
              contents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
              contents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
              break
            }
            case 'type':
              if ((await inWorld(browseFocusScript(action.ref))) !== true) return 'failed'
              if (!(await pageDebugger.command('Input.insertText', { text: action.text }))) return 'failed'
              break
            case 'select':
              if ((await inWorld(browseSelectScript(action.ref, action.option))) !== true) return 'failed'
              break
            case 'go': {
              // Only an address of the operated domain (the window's navigation rule refuses any other as well).
              const host = state.site?.host
              const url = host ? `https://${host}${action.path}` : ''
              if (!host || sameDomainPath(url, host) === null) return 'failed'
              if (!(await navigate(() => contents.loadURL(url), signal))) return 'failed'
              break
            }
            case 'back':
              if (!contents.navigationHistory.canGoBack()) return 'failed'
              contents.navigationHistory.goBack()
              break
            case 'wait':
              await pause(Math.min(action.seconds, BROWSER_BROWSE_LIMITS.waitSeconds) * 1000, signal)
              return browseReady() ? 'ok' : 'failed'
          }
          await settle(signal, action.do === 'click' || action.do === 'back')
          return browseReady() ? 'ok' : 'failed'
        },
        pageClean,
        closed,
      }
      const title = `${BROWSER_WORDS.section} — ${spec.site.host}`
      // The title says while the window records (the page cannot change it: page-title-updated is refused).
      const record: BrowserRecordSurface = {
        async start(observer) {
          if (closed()) return false
          const ok = await pageDebugger.record.start(observer)
          if (ok && !win.isDestroyed()) win.setTitle(`${title}${BROWSER_RECORDING_WINDOW_TITLE}`)
          return ok
        },
        async stop() {
          await pageDebugger.record.stop()
          if (!win.isDestroyed()) win.setTitle(title)
        },
        active: () => pageDebugger.record.active(),
      }
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
          state.helpers = helpersOf(site)
          void routeOnly(ses, site, state).catch(() => {
            log.warn('[browser] the window\'s connections could not be limited to the changed site; closed')
            revoke()
            if (!win.isDestroyed()) win.destroy()
          })
        },
        setMode,
        run,
        preview,
        record,
        browse,
        // A run that opened the window again waits for its page before entering it (agent-browser.md "The window a run needs").
        whenLoaded: signal => pageDebugger.firstLoaded(signal, RUN_WINDOW_LOAD_MS),
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
