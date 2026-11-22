// The HTML viewer's document views (doc-frame.md "The view and its session"). Shell layer: with
// main.ts, preload.ts, electron-adapter.ts, voice-input.ts and browser-window.ts, the only code that
// imports Electron. Kept apart because it is one security surface of its own, tested in a real
// Electron (tests/doc-frame-electron.test.ts loads exactly this file).
//
// A document is someone else's program, so it never runs in the app's page or the app's session:
// each one gets a WebContentsView of its own (no preload, sandboxed, no Node) on the in-memory
// partition `acb-doc`. Only that session serves `acb-doc://`; `local-file://` and `acb-plugin://`
// are not handled there and `file://` answers 404. The session's proxy sends every connection to a
// local refusing proxy (what the request hook cannot see: preconnect, WebRTC's TCP), WebRTC sends no
// UDP of its own, its one request hook cancels everything but the document's scheme, every
// permission and download is refused. A view navigates only to an .html page of its own grant;
// popups, webviews, redirects elsewhere, logins and client certificates are refused.
import { BrowserWindow, session, WebContentsView, webContents as allWebContents, type Session, type WebContents } from 'electron'
import { DOC_SCHEME, docSessionRequestAllowed, docViewNavigationAllowed, parseDocFrameUrl } from '../shared/doc-frame'
import { startRefusingProxy } from './browser-window'
import type { DocViewHandle, DocViewPort } from './features/doc-frames/views'

/** In memory (no `persist:`): nothing a document stores outlives the app run. */
export const DOC_PARTITION = 'acb-doc'

export interface DocViewShellOptions {
  /** The `acb-doc://` server (features/doc-frames/protocol.ts `serve`). */
  serve: (request: { url: string; method: string }) => Promise<Response>
  /** The refusing proxy's port (default: the shell's one, shared with 「ブラウザ操作」). */
  refusingProxy?: () => Promise<number>
  log?: Pick<Console, 'warn'>
}

const NOT_FOUND = () => new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })

/** The PAC script of the document session: every connection to the refusing proxy, no fallback. */
export function docProxyScript(refusePort: number): string {
  if (!Number.isInteger(refusePort) || refusePort <= 0 || refusePort > 65535) throw new Error('bad refusing proxy port')
  return `function FindProxyForURL(url, host) { return 'PROXY 127.0.0.1:${refusePort}'; }`
}

export function createDocViewShell(options: DocViewShellOptions): DocViewPort {
  const log = options.log ?? console
  let prepared: Promise<Session> | null = null
  const watchedWindows = new Set<number>()
  let schemesServed = false
  const resetListeners: Array<(windowId: number) => void> = []
  const windowReset = (windowId: number) => { for (const listener of resetListeners) listener(windowId) }

  /**
   * The document session with its guards, once; again after a failure. The proxy comes first and
   * the scheme is served last, so a session whose proxy could not be set serves no document (and
   * a later try does not meet a scheme already handled).
   */
  async function prepare(): Promise<Session> {
    const ses = session.fromPartition(DOC_PARTITION)
    const port = await (options.refusingProxy ?? startRefusingProxy)()
    await ses.setProxy({ mode: 'pac_script', pacScript: `data:application/x-ns-proxy-autoconfig;base64,${Buffer.from(docProxyScript(port)).toString('base64')}` })
    // The session's one request hook (Electron keeps the last listener: set here and nowhere else).
    ses.webRequest.onBeforeRequest((details, callback) => {
      const allowed = docSessionRequestAllowed(details.url)
      if (!allowed) log.warn('[doc-frame] refused a request of a document')
      callback({ cancel: !allowed })
    })
    // Set after the app's own `guardEverySession` handler (session-created): these replace it.
    ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    ses.setPermissionCheckHandler(() => false)
    ses.setDevicePermissionHandler(() => false)
    ses.on('will-download', event => event.preventDefault())
    ses.setSpellCheckerEnabled(false)
    // A file of this computer is never a document's: no file:// on this session.
    if (!schemesServed) {
      ses.protocol.handle('file', NOT_FOUND)
      ses.protocol.handle(DOC_SCHEME, request => options.serve({ url: request.url, method: request.method }))
      schemesServed = true
    }
    return ses
  }

  /** A view's page may go only to its own grant's pages; nothing else leaves it. */
  function guard(contents: WebContents, token: () => string | null) {
    // WebRTC never sends UDP itself; its TCP goes through the session's refusing proxy.
    contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    // Every frame's navigation, the main frame's included (it also covers what `will-navigate` sees).
    contents.on('will-frame-navigate', event => {
      if (!docViewNavigationAllowed(token(), event.url, event.isMainFrame)) event.preventDefault()
    })
    contents.on('will-redirect', event => {
      if (!docViewNavigationAllowed(token(), event.url, event.isMainFrame)) event.preventDefault()
    })
    contents.on('will-attach-webview', event => event.preventDefault())
    contents.on('certificate-error', (event, _url, _error, _certificate, callback) => { event.preventDefault(); callback(false) })
    contents.on('select-client-certificate', (event, _url, _list, callback) => {
      event.preventDefault()
      ;(callback as (certificate?: unknown) => void)()
    })
    contents.on('login', (event, _details, _authInfo, callback) => { event.preventDefault(); callback() })
  }

  /** A window's page reloading, crashing or closing closes its views (their grants with them). */
  function watchWindow(windowId: number) {
    if (watchedWindows.has(windowId)) return
    const owner = allWebContents.fromId(windowId)
    if (!owner) return
    watchedWindows.add(windowId)
    owner.on('did-start-navigation', event => {
      if (event.isMainFrame && !event.isSameDocument) windowReset(windowId)
    })
    owner.on('render-process-gone', () => windowReset(windowId))
    owner.once('destroyed', () => {
      watchedWindows.delete(windowId)
      windowReset(windowId)
    })
  }

  return {
    onWindowReset(listener) {
      resetListeners.push(listener)
    },
    watch: watchWindow,
    async create(windowId, onGone): Promise<DocViewHandle | null> {
      const owner = allWebContents.fromId(windowId)
      const win = owner ? BrowserWindow.fromWebContents(owner) : null
      if (!win || win.isDestroyed()) return null
      prepared ??= prepare()
      try {
        await prepared
      } catch {
        prepared = null
        return null
      }
      if (win.isDestroyed()) return null
      const view = new WebContentsView({
        webPreferences: {
          partition: DOC_PARTITION,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          nodeIntegrationInSubFrames: false,
          webviewTag: false,
          spellcheck: false,
          navigateOnDragDrop: false,
          backgroundThrottling: true,
        },
      })
      const contents = view.webContents
      const id = contents.id
      let token: string | null = null
      let gone = false
      const finish = () => {
        if (gone) return
        gone = true
        if (!win.isDestroyed()) win.contentView.removeChildView(view)
        if (!contents.isDestroyed()) contents.close()
        onGone(id)
      }
      guard(contents, () => token)
      contents.once('destroyed', finish)
      contents.on('render-process-gone', finish)
      // Placed and shown by the viewer (A2); until then hidden (throttled as a background page),
      // taking no room and silent: its scripts run from the moment it loads.
      contents.setAudioMuted(true)
      view.setVisible(false)
      win.contentView.addChildView(view)
      view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
      return {
        id,
        show(url) {
          token = parseDocFrameUrl(url)?.token ?? null
          contents.loadURL(url).catch(() => {})
        },
        destroy: finish,
      }
    },
  }
}
