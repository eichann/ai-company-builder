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
// (which asks the member first); Escape in a document shown full screen leaves full screen; the
// app's shortcuts (the command catalog's, `docViewShortcutOf`) pressed in a document go to the app.
//
// Blocked internet parts (A3): what a document's page wanted and did not get — refused by its CSP
// (Chromium's own report: DevTools `Audits` issues, read in main through the view's debugger; the
// page can neither send nor see them) or cancelled by the session's request hook — is handed to the
// registry (`onBlocked`), which keeps only the host for the band. Nothing is loaded because of it.
//
// Review (doc-frame.md "Review in the document view"): the registry runs the app's small review piece
// in the page's isolated world `REVIEW_WORLD` (it brings its marks' colours itself); after the member's real mouse or Shift-key release in the shown view it is told
// (`onReviewInput`) and pulls the selection. The page gets no channel to the app: nothing it does
// sends anything, and its synthetic events never reach `input-event`.
import { BrowserWindow, session, WebContentsView, webContents as allWebContents, type Session, type WebContents } from 'electron'
import { DOC_SCHEME, docSessionRequestAllowed, docViewNavigationAllowed, docViewOnScreen, docViewShortcutOf, parseDocFrameUrl } from '../shared/doc-frame'
import { startRefusingProxy } from './browser-window'
import type { DocViewBounds } from '../shared/doc-frame'
import type { DocViewHandle, DocViewHooks, DocViewPort } from './features/doc-frames/views'
import { REVIEW_WORLD } from './features/doc-frames/review-world'
import { DRIVE_PLAYER_SCHEME, parseDrivePlayerUrl } from '../shared/doc-drive-player'
import type { DrivePlayerHandle, DrivePlayerHooks, DrivePlayerPort } from './features/doc-frames/players'
import { stageCode } from './features/doc-frames/player-page'

/** A focus of the view counts as the member's when a click (or touch) in it came this close to it. */
export const FOCUS_CLICK_WINDOW_MS = 600
/** How long after the view took the focus it is judged (the click's input may arrive just after). */
const FOCUS_CHECK_DELAY_MS = 150
/** A navigation to the web counts as the member pressing a link this soon after a click or key in the view. */
const LINK_INPUT_WINDOW_MS = 1000
/** The isolated world the app reads and restores a document's scroll position in (the page's own scripts cannot see or replace it). */
const SCROLL_WORLD = 1001
/**
 * A shown view's reload waits at most this long for the scroll position (a page spinning its CPU
 * never answers). A hidden view waits until it answers or is shown: a hidden (background-throttled)
 * view on a busy computer did not answer within 2 s, and the member was put back at the top
 * (measured, 2026-11-22).
 */
const SCROLL_READ_MS = 1000

/** A scroll position read from a document: two finite numbers, else none. */
function scrollPosition(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length !== 2 || !value.every(v => typeof v === 'number' && Number.isFinite(v))) return null
  return [Math.max(0, Math.round(value[0])), Math.max(0, Math.round(value[1]))]
}

/**
 * What a document's CSP refused to load, as Chromium reports it: the `Audits` domain's
 * `ContentSecurityPolicyIssue` (its `blockedURL`), read through the view's own debugger in main.
 * The page cannot send or see these (its `console` and `securitypolicyviolation` events are its
 * own and are not read). Without a debugger (one already attached) there is simply no report.
 */
function watchCspRefusals(contents: WebContents, report: (url: string) => void, log: Pick<Console, 'warn'>): boolean {
  try {
    contents.debugger.attach('1.3')
  } catch {
    log.warn('[doc-frame] cannot read what a document\'s CSP refused')
    return false
  }
  contents.debugger.on('message', (_event, method, params) => {
    if (method !== 'Audits.issueAdded') return
    const issue = (params as { issue?: { code?: unknown; details?: { contentSecurityPolicyIssueDetails?: { blockedURL?: unknown } } } }).issue
    const url = issue?.code === 'ContentSecurityPolicyIssue' ? issue.details?.contentSecurityPolicyIssueDetails?.blockedURL : undefined
    if (typeof url === 'string') report(url)
  })
  contents.debugger.sendCommand('Audits.enable').catch(() => {})
  return true
}

/** Per id, at most this many elements naming it are tried for a box (the first laid out one counts). */
const EMBED_TRIES_PER_ID = 3
/** An id as main holds it (Drive's characters only): safe inside a CSS string. */
const SAFE_ID = /^[A-Za-z0-9_-]{10,128}$/

/**
 * The selector of the elements embedding Drive file `id` (an id main read from the document): an
 * `<iframe>` or `<video>` whose `src` names Drive and the id, or a `<video>` with such a `<source>`.
 * Positions only: what an element names is never read back from the page.
 */
export function embedSelector(id: string): string {
  const named = `[src*="drive.google.com" i][src*="${id}"]`
  return `iframe${named}, video${named}, video:has(> source${named})`
}

/**
 * Where a document lays out its first element embedding each of `ids` (ids main read from the served
 * bytes) — its border box in the view's own DIP — read with the view's debugger in main
 * (DOM.querySelectorAll with `embedSelector`, DOM.getBoxModel): nothing runs in the page's context, the
 * page cannot call or see it, and **no attribute of the page is read** (a page can make an attribute of
 * any size). An element with no box (hidden) is left out.
 */
async function readEmbedBoxes(contents: WebContents, ids: readonly string[]): Promise<Array<{ id: string; box: DocViewBounds }>> {
  type Send = (method: string, params?: Record<string, unknown>) => Promise<any> // eslint-disable-line @typescript-eslint/no-explicit-any
  const send: Send = (method, params) => contents.debugger.sendCommand(method, params)
  const { root } = await send('DOM.getDocument', { depth: 0 })
  // CSS px of the page → the view's DIP (the document's own zoom).
  const scale = contents.getZoomFactor()
  const out: Array<{ id: string; box: DocViewBounds }> = []
  for (const id of ids) {
    if (!SAFE_ID.test(id)) continue
    const { nodeIds } = await send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: embedSelector(id) }) as { nodeIds: number[] }
    for (const nodeId of nodeIds.slice(0, EMBED_TRIES_PER_ID)) {
      let quad: number[]
      try {
        quad = (await send('DOM.getBoxModel', { nodeId })).model.border as number[]
      } catch {
        continue
      }
      if (!Array.isArray(quad) || quad.length !== 8 || !quad.every(Number.isFinite)) continue
      const xs = [quad[0], quad[2], quad[4], quad[6]]
      const ys = [quad[1], quad[3], quad[5], quad[7]]
      // The box model is relative to the viewport (scrolled), in the page's CSS px.
      out.push({ id, box: { x: Math.min(...xs) * scale, y: Math.min(...ys) * scale, width: (Math.max(...xs) - Math.min(...xs)) * scale, height: (Math.max(...ys) - Math.min(...ys)) * scale } })
      break
    }
  }
  return out
}

/** In memory (no `persist:`): nothing a document stores outlives the app run. */
export const DOC_PARTITION = 'acb-doc'

export interface DocViewShellOptions {
  /** The `acb-doc://` server (features/doc-frames/protocol.ts `serve`). */
  serve: (request: { url: string; method: string }) => Promise<Response>
  /** The refusing proxy's port (default: the shell's one, shared with 「ブラウザ操作」). */
  refusingProxy?: () => Promise<number>
  /** Whether Ctrl+letter is a text field's editing key rather than a shortcut (default: on macOS). */
  mac?: boolean
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
  const mac = options.mac ?? process.platform === 'darwin'
  let prepared: Promise<Session> | null = null
  const watchedWindows = new Set<number>()
  /** Windows whose page is full screen through the HTML API (the viewer's 「全画面」). */
  const htmlFullScreen = new Set<number>()
  let schemesServed = false
  const resetListeners: Array<(windowId: number) => void> = []
  /** View page id → where a request the session's hook cancelled for it is reported. */
  const blockedReporters = new Map<number, (url: string) => void>()
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
      if (!allowed) {
        log.warn('[doc-frame] refused a request of a document')
        if (typeof details.webContentsId === 'number') blockedReporters.get(details.webContentsId)?.(details.url)
      }
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
      /**
       * Where the document was scrolled when it was reloaded, until it has been put back (a hidden
       * view draws no frame, so this may wait until it is shown).
       */
      let keepScroll: [number, number] | null = null
      /** A reload waiting for the scroll position: starts its time limit (once the view is shown). */
      let reloadWaiting: { limit: () => void } | null = null
      /** When the member last clicked / touched (pointer) or pressed a key (any) in the view. */
      let lastPointerAt = -Infinity
      let lastInputAt = -Infinity
      /** The keyboard back to the app's page (its own focused element keeps its place). */
      const focusApp = () => {
        if (!win.isDestroyed() && owner && !owner.isDestroyed()) owner.focus()
      }
      const finish = () => {
        if (gone) return
        gone = true
        // Closed while it had the keyboard (中身 by ⌘⇧V, the tab closed): the keyboard goes back to the app.
        const hadKeyboard = !contents.isDestroyed() && contents.isFocused()
        if (!win.isDestroyed()) win.contentView.removeChildView(view)
        if (hadKeyboard) focusApp()
        blockedReporters.delete(id)
        if (!contents.isDestroyed()) contents.close()
        hooks.onGone(id)
      }
      guard(contents, () => token)
      // What its page wanted from the internet and did not get, for the band (hosts only leave main).
      blockedReporters.set(id, url => hooks.onBlocked(id, url))
      const debuggerOn = watchCspRefusals(contents, url => hooks.onBlocked(id, url), log)
      /** Where the view is on screen now (window DIP), or null while hidden. */
      let area: DocViewBounds | null = null
      contents.on('did-navigate', (_event, url) => hooks.onPageStart(id, url))
      contents.on('did-finish-load', () => hooks.onPageLoaded(id))
      contents.on('input-event', (_event, input) => {
        const at = Date.now()
        if (input.type === 'mouseDown' || input.type === 'touchStart' || input.type === 'gestureTap') lastPointerAt = at
        if (input.type === 'mouseDown' || input.type === 'touchStart' || input.type === 'gestureTap' || input.type === 'keyDown' || input.type === 'rawKeyDown') lastInputAt = at
        // A selection may have been made (drag, double-click, Shift + arrows): the registry may read it.
        if (shown && (input.type === 'mouseUp' || (input.type === 'keyUp' && (input.modifiers?.includes('shift') || (input as { keyCode?: string }).keyCode === 'Shift')))) hooks.onReviewInput(id)
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
      // Keys the app takes from a document that has the keyboard. Only the member's real key presses
      // come here (a page's synthetic KeyboardEvent never does), so a document cannot run app commands.
      contents.on('before-input-event', (event, input) => {
        if (input.type !== 'keyDown' || win.isDestroyed()) return
        // Escape while the viewer is full screen leaves it.
        if (input.key === 'Escape' && htmlFullScreen.has(windowId)) {
          event.preventDefault()
          focusApp()
          win.setFullScreen(false)
          return
        }
        // The app's shortcuts (⌘K, ⌘B, ⌘J, ⌘⇧V…): not the document's; the window runs them as if
        // pressed in the document's tab. A held key repeats nothing.
        const key = { key: input.key, metaKey: input.meta, ctrlKey: input.control, shiftKey: input.shift, altKey: input.alt }
        if (!docViewShortcutOf(key, mac)) return
        event.preventDefault()
        if (!input.isAutoRepeat) hooks.onShortcut(id, key)
      })
      // The document's zoom stays across its own reloads and pages.
      contents.on('did-navigate', () => { if (!contents.isDestroyed()) contents.setZoomFactor(zoomFactor) })
      // Put back in the page's next frame, not at once: Chromium focuses an `autofocus` field (scrolling
      // to it) in the page's first frame, which under load comes after the load (measured: the member
      // was back at the top). A frame flushes autofocus before its animation-frame callbacks.
      contents.on('did-finish-load', () => {
        const position = keepScroll
        if (!position || contents.isDestroyed()) return
        const code = `new Promise(resolve => requestAnimationFrame(() => { window.scrollTo(${position[0]}, ${position[1]}); resolve(0) }))`
        contents.executeJavaScriptInIsolatedWorld(SCROLL_WORLD, [{ code }])
          .then(() => { if (keepScroll === position) keepScroll = null }, () => {})
      })
      contents.once('destroyed', finish)
      contents.on('render-process-gone', finish)
      // Placed and shown by the viewer (A2); until then hidden (throttled as a background page),
      // taking no room and silent: its scripts run from the moment it loads.
      contents.setAudioMuted(true)
      view.setVisible(false)
      win.contentView.addChildView(view)
      view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
      /** The view out of sight: 0×0, hidden, muted; the keyboard it had goes back to the app. */
      const hide = () => {
        const hadKeyboard = contents.isFocused()
        shown = false
        view.setVisible(false)
        view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
        contents.setAudioMuted(true)
        area = null
        if (hadKeyboard) focusApp()
      }
      return {
        id,
        show(url, at = null) {
          token = parseDocFrameUrl(url)?.token ?? null
          // Where the member was reading when they left for 中身: put back after the load, as for a reload.
          keepScroll = at && scrollPosition(at)
          contents.loadURL(url).catch(() => {})
        },
        destroy: finish,
        closeKeepingPlace() {
          if (gone || contents.isDestroyed()) return Promise.resolve(null)
          // Asked before the view is hidden (a hidden, throttled page may answer late), then out of
          // sight at once: the tab shows 中身 now. At most SCROLL_READ_MS, then closed either way.
          const read = contents.executeJavaScriptInIsolatedWorld(SCROLL_WORLD, [{ code: '[window.scrollX, window.scrollY]' }])
            .then(scrollPosition, () => null)
          hide()
          let timer: ReturnType<typeof setTimeout> | undefined
          const limit = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), SCROLL_READ_MS) })
          return Promise.race([read, limit]).then(position => {
            clearTimeout(timer)
            finish()
            return position
          })
        },
        place(bounds: DocViewBounds | null) {
          if (gone || win.isDestroyed()) return
          const placed = bounds && docViewOnScreen(bounds, owner?.getZoomFactor() ?? 1, win.getContentSize())
          if (!placed) {
            hide()
            return
          }
          view.setBounds(placed)
          area = placed
          view.setVisible(true)
          contents.setAudioMuted(false)
          shown = true
          reloadWaiting?.limit()
        },
        zoom(factor) {
          zoomFactor = factor
          if (!gone) contents.setZoomFactor(factor)
        },
        inReviewWorld(code) {
          if (gone || contents.isDestroyed()) return Promise.resolve(null)
          return contents.executeJavaScriptInIsolatedWorld(REVIEW_WORLD, [{ code }]).catch(() => null)
        },
        releaseKeyboard() {
          if (!gone && !contents.isDestroyed() && contents.isFocused()) focusApp()
        },
        placedArea: () => (gone ? null : area),
        // No time limit: the registry sends no other read until this one settled (a busy page answers late;
        // nothing piles up behind it). A view closed meanwhile rejects it (its debugger goes).
        readEmbeds(ids) {
          if (gone || !debuggerOn || contents.isDestroyed()) return Promise.resolve([])
          return readEmbedBoxes(contents, ids)
        },
        reload() {
          if (gone || !token) return
          // An earlier reload's position not put back yet (hidden, no frame drawn): the page is at its top,
          // keep that one — as a copy, so the replaced page putting it back late does not clear it.
          if (keepScroll) {
            keepScroll = [keepScroll[0], keepScroll[1]]
            contents.reload()
            return
          }
          // A reload already waiting for the position loads the file as it is by then.
          if (reloadWaiting) return
          // The file changed: load it again where the member was (Chromium does not keep it on reload here).
          let timer: ReturnType<typeof setTimeout> | undefined
          let settled = false
          const done = (position: unknown) => {
            if (settled) return
            settled = true
            reloadWaiting = null
            clearTimeout(timer)
            if (gone || contents.isDestroyed()) return
            keepScroll = scrollPosition(position)
            contents.reload()
          }
          reloadWaiting = { limit: () => { timer ??= setTimeout(() => done(null), SCROLL_READ_MS) } }
          contents.executeJavaScriptInIsolatedWorld(SCROLL_WORLD, [{ code: '[window.scrollX, window.scrollY]' }]).then(done, () => done(null))
          if (shown) reloadWaiting.limit()
        },
      }
    },
  }
}


/** Pause a player's video and answer where it was (seconds): ACB's own page, no document in it. */
const SUSPEND_CODE = `(() => { const v = document.querySelector('video'); if (!v) return null; v.pause(); return v.currentTime })()`

/** In memory (no `persist:`): ACB's players over a document's Drive videos have a session of their own. */
export const PLAYER_PARTITION = 'acb-player'

export interface DrivePlayerShellOptions {
  /** The `acb-drive-video://` server (features/doc-frames/players.ts `serve`). */
  serve: (request: { url: string; method: string; range: string | null }) => Promise<Response>
  /** Whether a request of the page `pageId` may reach `url` (its own player's token only). */
  owns: (pageId: number, url: string) => boolean
  /** The refusing proxy's port (default: the shell's one, as for documents). */
  refusingProxy?: () => Promise<number>
  mac?: boolean
  log?: Pick<Console, 'warn'>
}

/**
 * ACB's player over a Google Drive video of a document (doc-frame.md "ACB's player over Drive embeds
 * (plan 4)"): a view of its own, above the document's view in the same window, showing ACB's page for
 * that player (`players.ts`) from `acb-drive-video://<token>/`. Not the document's: its own in-memory
 * session (`acb-player`), which serves only that scheme — every other request is cancelled, and a page
 * reaches only its own player's token (`owns`, by the requesting page's id) —; no preload, sandboxed, no
 * Node; every permission and download refused. Its page's links and script ask for actions by going to
 * `acb-drive-video://<token>/<action>`: the navigation is refused and the action handed to the registry;
 * it goes nowhere else. Like the document's view it never takes the keyboard by itself, and the app's
 * shortcuts pressed in it go to the app.
 */
export function createDrivePlayerShell(options: DrivePlayerShellOptions): DrivePlayerPort {
  const log = options.log ?? console
  const mac = options.mac ?? process.platform === 'darwin'
  let prepared: Promise<Session> | null = null
  let schemeServed = false
  /** Windows whose page is full screen through the HTML API (the viewer's 「全画面」): Escape in a player leaves it. */
  const htmlFullScreen = new Set<number>()
  const watched = new Set<number>()
  const watchFullScreen = (windowId: number, owner: WebContents) => {
    if (watched.has(windowId)) return
    watched.add(windowId)
    owner.on('enter-html-full-screen', () => htmlFullScreen.add(windowId))
    owner.on('leave-html-full-screen', () => htmlFullScreen.delete(windowId))
    owner.once('destroyed', () => { watched.delete(windowId); htmlFullScreen.delete(windowId) })
  }
  /** The players' session with its guards, once (again after a failure): the proxy first, the scheme last. */
  const prepare = async (): Promise<Session> => {
    const ses = session.fromPartition(PLAYER_PARTITION)
    // Every connection to the refusing proxy, as for documents (a player's page asks the network for nothing).
    const port = await (options.refusingProxy ?? startRefusingProxy)()
    await ses.setProxy({ mode: 'pac_script', pacScript: `data:application/x-ns-proxy-autoconfig;base64,${Buffer.from(docProxyScript(port)).toString('base64')}` })
    // The session's one request hook: only a player page's own address (its page, its video).
    ses.webRequest.onBeforeRequest((details, callback) => {
      const allowed = typeof details.webContentsId === 'number' && options.owns(details.webContentsId, details.url)
      if (!allowed) log.warn('[doc-player] refused a request')
      callback({ cancel: !allowed })
    })
    ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    ses.setPermissionCheckHandler(() => false)
    ses.setDevicePermissionHandler(() => false)
    ses.on('will-download', event => event.preventDefault())
    ses.setSpellCheckerEnabled(false)
    if (!schemeServed) {
      ses.protocol.handle('file', NOT_FOUND)
      ses.protocol.handle(DRIVE_PLAYER_SCHEME, request => options.serve({ url: request.url, method: request.method, range: request.headers.get('range') }))
      schemeServed = true
    }
    return ses
  }

  return {
    async create(windowId, hooks: DrivePlayerHooks): Promise<DrivePlayerHandle | null> {
      const owner = allWebContents.fromId(windowId)
      const win = owner ? BrowserWindow.fromWebContents(owner) : null
      if (!win || win.isDestroyed() || !owner) return null
      prepared ??= prepare()
      try {
        await prepared
      } catch {
        prepared = null
        return null
      }
      if (win.isDestroyed()) return null
      watchFullScreen(windowId, owner)
      const view = new WebContentsView({
        webPreferences: {
          partition: PLAYER_PARTITION,
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
      let gone = false
      let shown = false
      let lastPointerAt = -Infinity
      let token: string | null = null
      const focusApp = () => {
        if (!win.isDestroyed() && owner && !owner.isDestroyed()) owner.focus()
      }
      const finish = () => {
        if (gone) return
        gone = true
        const hadKeyboard = !contents.isDestroyed() && contents.isFocused()
        if (!win.isDestroyed()) win.contentView.removeChildView(view)
        if (hadKeyboard) focusApp()
        if (!contents.isDestroyed()) contents.close()
        hooks.onGone(id)
      }
      contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
      contents.setWindowOpenHandler(() => ({ action: 'deny' }))
      // Only its own page loads; its own actions are asked for by going to them (refused, then acted on).
      const navigate = (event: { url: string; isMainFrame: boolean; preventDefault: () => void }) => {
        const target = parseDrivePlayerUrl(event.url)
        if (event.isMainFrame && target && target.token === token && target.kind === 'page') return
        event.preventDefault()
        if (event.isMainFrame && target && target.token === token && target.kind === 'action') hooks.onAction(id, target.action)
      }
      contents.on('will-frame-navigate', navigate)
      contents.on('will-redirect', event => event.preventDefault())
      contents.on('will-attach-webview', event => event.preventDefault())
      contents.on('certificate-error', (event, _url, _error, _certificate, callback) => { event.preventDefault(); callback(false) })
      contents.on('select-client-certificate', (event, _url, _list, callback) => {
        event.preventDefault()
        ;(callback as (certificate?: unknown) => void)()
      })
      contents.on('login', (event, _details, _authInfo, callback) => { event.preventDefault(); callback() })
      contents.on('input-event', (_event, input) => {
        if (input.type === 'mouseDown' || input.type === 'touchStart' || input.type === 'gestureTap') lastPointerAt = Date.now()
      })
      contents.on('blur', () => { lastPointerAt = -Infinity })
      // Loading a page focuses its view (measured for the document's): the keyboard stays the app's unless clicked.
      contents.on('focus', () => {
        if (!shown) { focusApp(); return }
        setTimeout(() => {
          if (gone || contents.isDestroyed() || !contents.isFocused()) return
          if (!shown || Date.now() - lastPointerAt > FOCUS_CLICK_WINDOW_MS) focusApp()
        }, FOCUS_CHECK_DELAY_MS)
      })
      contents.on('before-input-event', (event, input) => {
        if (input.type !== 'keyDown' || win.isDestroyed()) return
        // Escape while the viewer is full screen leaves it (as in the document's view).
        if (input.key === 'Escape' && htmlFullScreen.has(windowId)) {
          event.preventDefault()
          focusApp()
          win.setFullScreen(false)
          return
        }
        const key = { key: input.key, metaKey: input.meta, ctrlKey: input.control, shiftKey: input.shift, altKey: input.alt }
        if (!docViewShortcutOf(key, mac)) return
        event.preventDefault()
        if (!input.isAutoRepeat) hooks.onShortcut(id, key)
      })
      contents.once('destroyed', finish)
      contents.on('render-process-gone', finish)
      contents.setAudioMuted(true)
      view.setVisible(false)
      win.contentView.addChildView(view)
      view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
      let stage = ''
      const putStage = () => {
        if (!gone && !contents.isDestroyed() && stage) contents.executeJavaScript(stage).catch(() => {})
      }
      contents.on('did-finish-load', putStage)
      return {
        id,
        load(url) {
          if (gone) return
          token = parseDrivePlayerUrl(url)?.token ?? null
          contents.loadURL(url).catch(() => {})
        },
        place(placement) {
          if (gone || win.isDestroyed()) return
          if (!placement) {
            const hadKeyboard = contents.isFocused()
            shown = false
            view.setVisible(false)
            view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
            contents.setAudioMuted(true)
            if (hadKeyboard) focusApp()
            return
          }
          view.setBounds(placement.bounds)
          view.setVisible(true)
          contents.setAudioMuted(false)
          shown = true
          stage = stageCode(placement.stage)
          putStage()
        },
        raise() {
          if (!gone && !win.isDestroyed()) win.contentView.addChildView(view)
        },
        suspend() {
          if (gone || contents.isDestroyed()) return Promise.resolve(null)
          let timer: ReturnType<typeof setTimeout> | undefined
          const limit = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), SCROLL_READ_MS) })
          const read = contents.executeJavaScript(SUSPEND_CODE).then(v => (typeof v === 'number' && Number.isFinite(v) ? v : null), () => null)
          return Promise.race([read, limit]).finally(() => clearTimeout(timer))
        },
        destroy: finish,
      }
    },
  }
}
