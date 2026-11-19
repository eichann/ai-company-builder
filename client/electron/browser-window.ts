// The in-app browser window of 「ブラウザ操作」 (agent-browser.md "The app's window"). Shell layer:
// with main.ts, preload.ts, electron-adapter.ts and voice-input.ts, the only code that imports
// Electron. Kept apart from electron-adapter.ts because it is one security surface of its own,
// tested in a real Electron (tests/browser-window-electron.test.ts loads exactly this file).
//
// A window shows one admin-approved site, in a session of its own, with nothing of the app in
// reach: no preload, no IPC, sandboxed. Its session has ONE request hook (Electron keeps only the
// last `onBeforeRequest` listener, so it is installed here and nowhere else) deciding every
// request with the site's rule; popups, downloads, permissions, navigations off the operated host
// and certificate errors are refused, and nothing is handed to the system browser or another app.
// In `ai` mode (PR 5's runner) every write to the operated host is paused through DevTools Fetch
// and goes out only when the injected decider says yes.
import { BrowserWindow, session, type Session, type WebContents } from 'electron'
import type { BrowserSiteSetting } from '../../shared/core/browser-operation'
import {
  BROWSER_WORDS, createRefusalTally, decideAiWrite, decideWindowRequest, hostForLog, isReadMethod, navigationAllowed,
  type BrowserWindowMode, type BrowserWindowState, type BrowserWriteAttempt, type BrowserWriteDecider,
} from '../shared/browser-operation'
import type { BrowserShell, BrowserWindowHandle, BrowserWindowSpec } from './features/browser/controller'

/** What `ai` mode needs: the approved step's decider (none = no write) and the emergency stop. */
export interface BrowserAiGate {
  decide?: BrowserWriteDecider
  stopped: () => boolean
}

export interface BrowserShellWindow extends BrowserWindowHandle {
  readonly webContents: WebContents
  /** `human` (default) or `ai` with its gate; the gate attaches after the first page load. */
  setMode(mode: BrowserWindowMode, gate?: BrowserAiGate): Promise<void>
}

interface SessionState extends BrowserWindowState {
  /** The webContents of the window showing this session now (null: none). */
  contentsId: number | null
  tally: ReturnType<typeof createRefusalTally>
  flushTimer: ReturnType<typeof setTimeout> | null
}

const REFUSAL_LOG_MS = 10_000

export function createBrowserWindowShell(options: { log?: Pick<Console, 'warn'>; show?: boolean } = {}): BrowserShell & { open(spec: BrowserWindowSpec): BrowserShellWindow } {
  const log = options.log ?? console
  const states = new Map<string, SessionState>()

  const flush = (state: SessionState) => {
    if (state.flushTimer) { clearTimeout(state.flushTimer); state.flushTimer = null }
    for (const line of state.tally.drain()) log.warn(`[browser] ${line}`)
  }
  const refuse = (state: SessionState, host: string, reason: string) => {
    state.tally.add(host, reason)
    state.flushTimer ??= setTimeout(() => flush(state), REFUSAL_LOG_MS)
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
      })
      if (!decision.allow) refuse(created, hostForLog(details.url), decision.reason)
      callback({ cancel: !decision.allow })
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
      if (!isReadMethod(request.method)) {
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
      const title = `${BROWSER_WORDS.section} — ${spec.site.host}`
      const win = new BrowserWindow({
        width: 1200,
        height: 860,
        minWidth: 480,
        minHeight: 400,
        title,
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
      // The title always names the site, whatever the page calls itself.
      win.on('page-title-updated', event => event.preventDefault())
      if (options.show !== false) win.once('ready-to-show', () => win.show())
      win.on('closed', () => {
        if (state.contentsId === contentsId) {
          state.site = null
          state.mode = 'human'
          state.aiGateReady = false
          state.contentsId = null
        }
        flush(state)
        spec.onClosed()
      })
      void win.loadURL(`https://${spec.site.host}/`).catch(() => { /* refused or offline: the window says so */ })
      return {
        webContents: contents,
        focus() {
          if (win.isDestroyed()) return
          if (win.isMinimized()) win.restore()
          win.show()
          win.focus()
        },
        close() { if (!win.isDestroyed()) win.close() },
        updateSite(site: BrowserSiteSetting) { if (state.contentsId === contentsId) state.site = site },
        setMode,
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
