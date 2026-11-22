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
//
// Placing and showing (A2): the viewer places the view over its tab (`place`), hidden and muted
// otherwise. The keyboard stays the app's unless the member clicked into the document: loading a
// page focuses its view (measured, Electron 45 — even hidden, even a page with no script), so a
// focus the member did not cause by a click goes back to the app's page, and hiding a focused view
// hands the keyboard back too. A link to the web the member pressed is handed to the registry
// (which asks the member first); Escape in a document shown full screen leaves full screen.
import { BrowserWindow, session, WebContentsView, webContents as allWebContents, type Session, type WebContents } from 'electron'
import { DOC_SCHEME, docSessionRequestAllowed, docViewNavigationAllowed, docViewOnScreen, parseDocFrameUrl } from '../shared/doc-frame'
import { startRefusingProxy } from './browser-window'
import type { DocViewBounds } from '../shared/doc-frame'
import type { DocViewHandle, DocViewHooks, DocViewPort } from './features/doc-frames/views'

/** A focus of the view counts as the member's when a click (or touch) in it came this close to it. */
export const FOCUS_CLICK_WINDOW_MS = 600
/** How long after the view took the focus it is judged (the click's input may arrive just after). */
const FOCUS_CHECK_DELAY_MS = 150
/** A navigation to the web counts as the member pressing a link this soon after a click or key in the view. */
const LINK_INPUT_WINDOW_MS = 1000
/** The isolated world the app reads and restores a document's scroll position in (the page's own scripts cannot see or replace it). */
const SCROLL_WORLD = 1001
/** A reload waits at most this long for the scroll position (a page spinning its CPU never answers). */
const SCROLL_READ_MS = 300

/** A scroll position read from a document: two finite numbers, else none. */
function scrollPosition(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length !== 2 || !value.every(v => typeof v === 'number' && Number.isFinite(v))) return null
  return [Math.max(0, Math.round(value[0])), Math.max(0, Math.round(value[1]))]
}

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
  /** Windows whose page is full screen through the HTML API (the viewer's 「全画面」). */
  const htmlFullScreen = new Set<number>()
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
    owner.on('enter-html-full-screen', () => htmlFullScreen.add(windowId))
    owner.on('leave-html-full-screen', () => htmlFullScreen.delete(windowId))
    owner.once('destroyed', () => {
      watchedWindows.delete(windowId)
      htmlFullScreen.delete(windowId)
      windowReset(windowId)
    })
  }

  return {
    onWindowReset(listener) {
      resetListeners.push(listener)
    },
    watch: watchWindow,
    async create(windowId, hooks: DocViewHooks): Promise<DocViewHandle | null> {
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
      let shown = false
      let zoomFactor = 1
      /** Where the document was scrolled when it was reloaded, put back once it has loaded again. */
      let keepScroll: [number, number] | null = null
      /** When the member last clicked / touched (pointer) or pressed a key (any) in the view. */
      let lastPointerAt = -Infinity
      let lastInputAt = -Infinity
      const finish = () => {
        if (gone) return
        gone = true
        if (!win.isDestroyed()) win.contentView.removeChildView(view)
        if (!contents.isDestroyed()) contents.close()
        hooks.onGone(id)
      }
      /** The keyboard back to the app's page (its own focused element keeps its place). */
      const focusApp = () => {
        if (!win.isDestroyed() && owner && !owner.isDestroyed()) owner.focus()
      }
      guard(contents, () => token)
      contents.on('input-event', (_event, input) => {
        const at = Date.now()
        if (input.type === 'mouseDown' || input.type === 'touchStart' || input.type === 'gestureTap') lastPointerAt = at
        if (input.type === 'mouseDown' || input.type === 'touchStart' || input.type === 'gestureTap' || input.type === 'keyDown' || input.type === 'rawKeyDown') lastInputAt = at
      })
      // Only a click made since the view last lost the keyboard counts: after the member went back to
      // the app (the chat, typing), a page reloading or calling focus() must not use an older click.
      contents.on('blur', () => { lastPointerAt = -Infinity })
      // Focus stealing: a page load, `focus()` or `autofocus` must not take the member's keyboard.
      contents.on('focus', () => {
        if (!shown) { focusApp(); return }
        setTimeout(() => {
          if (gone || contents.isDestroyed() || !contents.isFocused()) return
          if (!shown || Date.now() - lastPointerAt > FOCUS_CLICK_WINDOW_MS) focusApp()
        }, FOCUS_CHECK_DELAY_MS)
      })
      // A link to the web the member pressed: the navigation lock refused it (guard); the app asks
      // the member before the browser opens it. A page navigating by itself is not asked about.
      contents.on('will-frame-navigate', event => {
        if (!event.isMainFrame || !shown || Date.now() - lastInputAt > LINK_INPUT_WINDOW_MS) return
        if (docViewNavigationAllowed(token, event.url, true)) return
        hooks.onLink(id, event.url)
      })
      // Escape while the viewer is full screen leaves it, also when the document has the keyboard.
      contents.on('before-input-event', (event, input) => {
        if (input.type !== 'keyDown' || input.key !== 'Escape' || !htmlFullScreen.has(windowId) || win.isDestroyed()) return
        event.preventDefault()
        focusApp()
        win.setFullScreen(false)
      })
      // The document's zoom stays across its own reloads and pages.
      contents.on('did-navigate', () => { if (!contents.isDestroyed()) contents.setZoomFactor(zoomFactor) })
      contents.on('did-finish-load', () => {
        const position = keepScroll
        keepScroll = null
        if (position && !contents.isDestroyed()) {
          contents.executeJavaScriptInIsolatedWorld(SCROLL_WORLD, [{ code: `window.scrollTo(${position[0]}, ${position[1]})` }]).catch(() => {})
        }
      })
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
        place(bounds: DocViewBounds | null) {
          if (gone || win.isDestroyed()) return
          const area = bounds && docViewOnScreen(bounds, owner?.getZoomFactor() ?? 1, win.getContentSize())
          if (!area) {
            const hadKeyboard = contents.isFocused()
            shown = false
            view.setVisible(false)
            view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
            contents.setAudioMuted(true)
            if (hadKeyboard) focusApp()
            return
          }
          view.setBounds(area)
          view.setVisible(true)
          contents.setAudioMuted(false)
          shown = true
        },
        zoom(factor) {
          zoomFactor = factor
          if (!gone) contents.setZoomFactor(factor)
        },
        reload() {
          if (gone || !token) return
          // The file changed: load it again where the member was (Chromium does not keep it on reload here).
          const read = contents.executeJavaScriptInIsolatedWorld(SCROLL_WORLD, [{ code: '[window.scrollX, window.scrollY]' }]).catch(() => null)
          const late = new Promise(resolve => setTimeout(() => resolve(null), SCROLL_READ_MS))
          void Promise.race([read, late]).then(position => {
            if (gone || contents.isDestroyed()) return
            keepScroll = scrollPosition(position)
            contents.reload()
          })
        },
      }
    },
  }
}
