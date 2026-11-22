---
paths:
  - "client/shared/doc-frame.ts"
  - "client/electron/doc-view.ts"
  - "client/electron/features/doc-frames/**"
  - "client/tests/doc-frame-*"
  - "client/tests/doc-frame-harness/**"
  - "client/src/features/editor/htmlViewer*.ts"
  - "client/src/features/editor/docViewSession.ts"
  - "client/src/features/editor/components/HtmlDocumentPane.tsx"
  - "client/tests/ui/editor-html-viewer.spec.ts"
---

# The HTML viewer's document view (`acb-doc://`)

An `.html` file in the company folder is someone else's program (an AI that read a planted
instruction, a teammate): the app shows it, but it must reach **no network, no app, no other
file and no storage**. Owner decisions (2026-11-22, the proposal 「HTML ビューワーと下のパネル」):
internet parts (CDN scripts, web fonts, any network) are **blocked**; scripts inside the document
**run**, in an opaque-origin sandbox; the viewer does **not** open by itself. PR A1 made the address, the view and their guards in
main; A2 the viewer in the middle panel ("The viewer (A2)" below). The chat's ［見る］ and the
band of blocked internet parts (A3) build on it.

## The view and its session (`client/electron/doc-view.ts`, shell layer)

**A document never runs in the app's page or the app's session** (review of A1, 2026-11-22: an
iframe in the main window shared the default session, where the request hook cannot see a
preconnect or WebRTC — measured on Electron 45: STUN datagrams and a TURN-over-TCP connection
carrying a secret in its user name reached a local listener). Each document is shown in a
`WebContentsView` of its own, added to the main window, with:

- **Web preferences**: no preload, `sandbox`, `contextIsolation`, no Node (also in subframes),
  `webviewTag: false`, `navigateOnDragDrop: false`, `backgroundThrottling`, `partition: 'acb-doc'`
  — **in memory** (no `persist:`): nothing a document stores outlives the app run, no folder on disk.
- **Hidden until shown**: the document's scripts run from the moment it loads, so until the viewer
  places and shows it the view is 0×0, `setVisible(false)` (the page is `hidden`, throttled as
  a background page) and muted (`setAudioMuted(true)`); it is unmuted only while placed and shown,
  and muted again when hidden. **Focus stealing (measured, A2)**: loading a page focuses its view —
  even hidden, even a page with no script — and the app's page lost the keyboard; a hidden view
  that had the keyboard left it nowhere. So: a focus of the view while hidden, or not within
  `FOCUS_CLICK_WINDOW_MS` (600 ms) of a click / touch in it (`input-event`, judged 150 ms after
  the focus, so the click's input may arrive after it), goes back to the app's page
  (`owner.focus()`); hiding a view that has the keyboard gives it back too. Measured with the guard:
  a page's `focus()` every 100 ms and `autofocus` take nothing, hidden or shown. A click into the
  document gives it the keyboard on purpose (a slide's ← →); the app's shortcuts then do not reach
  the app until the member clicks outside (the proposal: not intercepted in the first version).
  Known: when the member comes back to the app's window while the document had the keyboard,
  Chromium's `focus` event comes without a click, so the keyboard returns to the app.
- **The document session** (`acb-doc`, prepared on the first view; a failed preparation — its proxy
  could not be set — makes no view and is tried again on the next open: the proxy is set first and
  the schemes are handled last, once): the only session that
  serves `acb-doc://` (`ses.protocol.handle`); `local-file://` and `acb-plugin://` are not handled
  there and `file://` answers 404; its proxy is a PAC script sending **every** connection to the
  shell's refusing proxy (`startRefusingProxy`, shared with 「ブラウザ操作」: answers 403 and
  closes); its **one** `onBeforeRequest` cancels everything but `acb-doc:`, `data:`, `blob:`,
  `about:` (`docSessionRequestAllowed`; Electron keeps one listener per session — set there and
  nowhere else); every permission request and check and every device refused, downloads
  cancelled, no spell checker.
- **The view's page**: WebRTC `disable_non_proxied_udp` (no UDP; its TCP goes to the refusing
  proxy); `setWindowOpenHandler` denies; `will-frame-navigate` / `will-redirect` only the main
  frame, only to an `.html` page **of its own grant** (`docViewNavigationAllowed`: same token;
  never `data:`, `file:`, `local-file:`, `acb-plugin:`, another document's token, the web; a frame
  inside it nowhere); webviews, HTTP logins, client certificates and certificate errors refused.
  A refused main-frame navigation within 1 s of a click or key in a shown view is handed to the
  registry as a link the member pressed ("The viewer (A2)"); the navigation stays refused.
- **The CSP's `sandbox allow-scripts`** gives the page an opaque origin although it is the view's
  top-level document: `localStorage` / `document.cookie` / `indexedDB` throw, no popups, modals,
  forms or top navigation. The app's own page stays the app's: its CSP needs no `frame-src`.
- **What the harness showed for each network path** (`doc-frame-electron.test.ts`): every probe
  is `https://` / `wss://` (an `http://` probe from the secure `acb-doc` page is stopped by
  mixed-content blocking before any guard, so it proves nothing), to its own name mapped with
  `host-rules` to a raw TCP listener that counts accepted connections (a TLS handshake that then
  fails still counts; names, because Chromium never proxies a loopback address), plus a UDP
  socket for STUN. With the view as built: 0 connections and 0 datagrams for fetch, XHR,
  WebSocket, beacon, web image / script / stylesheet, the page's own navigation to the web,
  `<link rel=preconnect|preload|prefetch|dns-prefetch>`, STUN and TURN
  over TCP (with a secret in its user name). Guards removed (2026-11-22, Electron 45):

  | Removed | What connected |
  |---|---|
  | the refusing proxy | TURN over TCP (2) — nothing else holds it |
  | the WebRTC UDP policy | STUN (5 datagrams) — nothing else holds it |
  | the request hook, or `connect-src`, or the CSP's web sources, or `default-src`, each alone | nothing |
  | the whole CSP's network part (`connect-src`, `default-src`, web sources) | nothing: the proxy and the hook hold every request |
  | proxy + hook | TURN only: **the CSP alone holds every request** |
  | proxy + hook + `connect-src` | fetch, XHR, WebSocket, beacon, prefetch |
  | proxy + hook + web `img` / `script` / `style` sources | image, script, stylesheet, preload, prefetch |
  | proxy + hook + `default-src` | prefetch |
  | `connect-src` + hook (the proxy left) | nothing: **the proxy alone holds** fetch, XHR, WebSocket, beacon |
  | `connect-src` + proxy (the hook left) | TURN only: **the hook alone holds** those requests |
  | the navigation lock | nothing connected; the view moved to another token, its own `.css` and the web |
  | lock + proxy / lock + hook | the web navigation held by the hook / by the proxy |
  | lock + proxy + hook | the page's own navigation to the web (2) |

  `data:`, `file:`, `local-file:` and `acb-plugin:` navigations stayed refused even without the
  lock (Chromium / schemes the session does not handle). **The zeros for `preconnect` and
  `dns-prefetch` are unproven**: they connected in no run, not even with the proxy, the hook and
  the CSP's network directives all removed, the view visible and 800×600 and the CSP sandbox off
  (no positive control found; Chromium may skip them for this scheme or under `host-rules`). A
  document cannot send reporting headers (its answers are ours) and Chromium ignores `report-uri`
  in a meta CSP, so reports are not probed.

## Grants and views (`client/electron/features/doc-frames/`, no Electron)

- **`docView:open(filePath)`** (main window's main frame only, `isMainFrameSender`, **decided
  before anything is read from the disk**) runs `check` — the path through the allowed roots
  (`AllowedRoots.validate`), an `.html` / `.htm` name not starting with `.`, **not at the company
  folder's top level** (`top_level`: its scripts could read every served-type file of the
  company), no `.git` segment, no link anywhere from the company folder down (each step
  `lstat`ed), not in a folder this computer did not download, ≤ 20 MB — then `views.open` makes a
  view (`DocViewPort.create`) and `grant`s **that view** a token (16 random bytes) for the
  document's folder; the view loads `acb-doc://<token>/<encoded name>`. **The renderer gets only
  `{ ok: true, viewId }`**: the address never leaves main (and never carries an absolute path).
  Refusals are plain Japanese (`DOC_FRAME_WORDS`; `unavailable` when no view could be made). Each
  view is its own grant: two views of one file, two tokens. Renderer port:
  `src/features/editor/api.ts` `DocViewControls`.
- **`docView:setBounds(viewId, bounds | null)`, `docView:setZoom(viewId, factor)`,
  `docView:reload(viewId)`** (A2; main window's main frame only, and only for a view of that
  window — anything else is ignored): a placement that is not four finite numbers of at least
  1 px (`docViewBounds`) hides the view rather than placing it anywhere; main multiplies by the
  app page's zoom and cuts to the window (`docViewOnScreen`); the zoom is kept within
  `DOC_ZOOM_STEPS` (50–300 %) and set again after every navigation of the view; a reload first
  reads the window's scroll position in an isolated world (300 ms at most: a page spinning its CPU
  is reloaded anyway; two finite numbers or nothing) and scrolls there once loaded (Chromium kept
  no position on reload here: measured 0).
- **`docView:event`** (main → the main window, sent by `main.ts`): `{ kind: 'link', url }` — only
  an `http(s)` address (`webLinkForBrowser`), at most one per view per second (`LINK_INTERVAL_MS`:
  a page cannot queue confirmations), only for a registered view; `{ kind: 'gone' }` — a view went
  without its window asking (its page crashed, the cap closed it).
- **Revocation goes with the view** (`views.ts`): `docView:close(viewId)` by its own window; the
  view destroyed or its page crashed (`onGone`); the window's page reloading, crashing or closing
  (`onWindowReset`: every view of that window closes); at most `MAX_VIEWS_PER_WINDOW` (32) per
  window, the oldest closed — applied when a view is registered, so opens running at the same time
  cannot pass it. A grant revoked while its file is being read answers 404.
- **An open is tied to the page that asked** (`views.begin` → `DocViewTicket`): taken when the IPC
  call starts, before the file check, and the shell starts watching that window's page right then
  (`DocViewPort.watch`). If the page reloads, crashes or closes while the file is checked or the
  view is made, nothing is registered: a view finished meanwhile is destroyed with no grant
  (`unavailable`).
- **What a request reaches** (`protocol.ts` `serve`): only `GET`; the address read on the raw
  string (`parseDocFrameUrl`: query and fragment dropped, each segment percent-decoded once and
  then a plain name — no empty segment, nothing starting with `.` (so `.`, `..`, `%2e%2e`, `.git`,
  `.claude`, `.backups`, dotfiles), no `/` or `\` inside a name (also encoded), no control
  character; the host exactly a token, no user-info or port); a served type (`DOC_FILE_TYPES`:
  html, css, js/mjs, images, svg, fonts — never `.md`, `.csv`, `.json`, media or anything else);
  not in a not-downloaded folder (`excludedFolderOf`, compared by `pathKey`: case and NFC/NFD);
  every folder below the grant's folder a real directory (`lstat`: a link, even one pointing
  inside, is refused) **holding no `.git`** (another repository: a private folder's clone —
  refused for its readers too, because the document's author may not be able to read it); the
  file opened with `O_NOFOLLOW | O_NONBLOCK`, a regular file, one hard link, ≤ 20 MB; and **the
  opened handle is the file at the path's real location** inside the grant folder's real path as
  opened — the handle's device and inode against `stat(realpath(target))`, checked after opening
  and again after reading (a folder swapped for a link while the request runs serves nothing).
- **One refusal.** Every refusal is the same 404 `Not found` with the same headers: an answer
  never names a folder (private folder names never leak, CLAUDE.md). The log says
  `[doc-frame] refused a request` without a path.
- **Headers on every file served**: the document CSP, `X-Content-Type-Options: nosniff`,
  `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-DNS-Prefetch-Control: off`. No
  `Access-Control-Allow-Origin`: a module script of the folder runs without it (fonts not
  measured; A2 adds `null` with a test only if one fails to load).
- **Scheme privileges** (`registerLocalFileScheme`, one list with `local-file` and `acb-plugin`):
  `standard`, `secure`, `corsEnabled` (without it a module script of the folder does not run:
  measured). Never `bypassCSP`, `supportFetchAPI`, `stream`, `allowServiceWorkers`.

## The viewer (A2): the middle panel (`src/features/editor/`)

- An `.html` / `.htm` tab opens as **見る** (`HtmlDocumentPane`): a toolbar (［見る｜中身］, －
  100 % ＋, 元の大きさ, 「変わったら自動で更新」 / 「ファイルが変わったので、表示を新しくしました」, the
  「資料の中だけで動いています」 label, 全画面, ［止める］ / ［もう一度表示する］) over an area the document's
  own view is placed over. 中身 is the code editor (autosave as for any file); ⌘⇧V switches; 見る is
  the default and the choice is per tab for the app's run (not saved).
- **One owner of the view**: `docViewSession.ts` (`DocViewSession`, read with
  `useSyncExternalStore`, the area attached by a callback ref — no effect). The view is opened when
  the area appears and **closed when it goes**: another tab, 中身, the tab closed (a wide left tab
  such as スキル over the middle only hides it, as an overlay does). Hidden tabs keep no document running;
  coming back opens it afresh (from the top). An open answered after the area went closes its view.
- **Placing**: every animation frame something may have changed (the area's size —
  `ResizeObserver`: window, B1 dividers, the bottom panel —, any DOM change — `MutationObserver` on
  the body: menus, dialogs, tabs; checked at once for the first change, then at most every
  100 ms while the DOM keeps changing, e.g. a streaming answer —, scroll, visibility, full screen)
  the area's rectangle is compared and sent when it differs. Window moves need nothing (bounds are window-relative).
- **Overlays** (a native view is drawn above the app's page, so a menu, dialog, ⌘K or toast the app
  draws there would be hidden behind it): **the view is hidden while anything of the app covers
  its area** (`htmlViewer.ts` `placementOf` / `areaCovered`): any menu, listbox or dialog
  (`OVERLAY_SELECTOR`: by role or `aria-modal`, however small) whose box overlaps the area, or
  anything at a grid of points ~48 px apart over the area (at most 640 points; on a 4K area at
  most 3 steps apart; `document.elementsFromPoint`: the first element at a point must be the area
  or inside it). Tooltips do not count, so the document does not blink under the toolbar's
  tooltips; an overlay with no role smaller than the grid both ways may slip between the points
  (`htmlViewer.test.ts`). The area then says 「メニューやダイアログを閉じると、
  資料に戻ります。」. The link confirmation is such an overlay: the document is hidden while the
  member decides.
- **Refusals** in plain Japanese from `docView:open` (`DOC_FRAME_WORDS`, `role="alert"`); a view
  gone by itself: 「資料の表示が止まりました（重すぎたのかもしれません）。」 with ［もう一度表示する］.
- **Auto refresh**: a file event for the document or for a served-type file in its folder or below
  (`changeShowsIn`; not data files, not other folders), 250 ms after the last, reloads the view
  (scroll and zoom kept, above).
- **Zoom** of the document only (`DOC_ZOOM_STEPS`), per tab for the app's run: kept by
  `TabbedEditorPanel` while the viewer comes and goes (another tab, 中身) and applied to the
  reopened view (Codex review).
- **全画面** (the proposal: the app's button, never the document's Fullscreen API — refused by the
  session's permission handler): the pane covers the window (`fixed inset-0 z-overlay`) and the app
  page asks HTML full screen (`fullscreen` is an app-page permission). Esc leaves: on the app's page
  by Chromium; **in the document** main's `before-input-event` takes Escape while the window is in
  HTML full screen (`enter/leave-html-full-screen`), gives the keyboard back to the app and calls
  `setFullScreen(false)` (measured: leaves the page's full screen too). ← / → are the document's
  own (one click into it first).
- **［止める］** closes the view (its scripts stop, its grant goes); ［もう一度表示する］ opens it again.
- **Links** (proposal item 5, A2): main hands a web link the member pressed (above) to the window;
  `ConfirmDialog` 「外のサイトを開きますか？」 with the **host large** (`URL.host`: a look-alike
  name shows as punycode `xn--…`), the whole address small, 「この資料は AI やほかの人が作ったもの
  です。知らないサイトなら開かないでください。」, ［やめる］ / ［ブラウザで開く］, `confirmOnEnter={false}`
  (focus on the dialog, a stray Enter answers nothing). Only ［ブラウザで開く］ calls `openExternal`
  (`shell:openExternal`, http / https / mailto only). One confirmation at a time per tab; links
  arriving meanwhile are dropped.
- Not in A2 (proposal): the chat's ［見る］ and the internet-parts band (A3); a separate window,
  printing, ⌘F in the document (A4).

## The CSP: one policy object (`docFramePolicy` → `docFrameCsp`)

`default-src 'none'`; `script-src` the grant's origin + `'unsafe-inline'` (the owner's decision;
no `'unsafe-eval'`); `style-src` origin + inline; `img-src` origin, `data:`, `blob:`; `font-src`
origin, `data:`; `media-src`, `frame-src`, `connect-src`, `child-src`, `worker-src`,
`object-src`, `manifest-src`, `form-action`, `base-uri` `'none'`; `sandbox allow-scripts`. The
policy has **no network source** (test: 「the default policy names no network source…」).

**Later (owner, 2026-11-22; planned, not built).** Each adds sources to the policy object only,
never loosens another directive (the session's proxy and request hook then need the same exact
hosts, and nothing else):
1. Pictures the HTML file itself names (`<img src="https://…">`, read statically when opened):
   after the member's 「表示する」, main fetches exactly those and serves copies through the grant's
   own origin. Images a script asks for are never fetched. `img-src` stays the origin.
2. YouTube / Vimeo embeds, loaded on click: `frameSources` with the exact privacy-enhanced embed
   hosts. Not verified yet: the embed is a nested frame of an opaque-origin, sandboxed document
   (it inherits the sandbox; without `allow-same-origin` its player may refuse to run) — measure
   before promising it.
3. A company's own storage hosts set by an admin (exact hosts such as `assets.example.co.jp`,
   `<bucket>.s3.<region>.amazonaws.com`; never shared domains like `drive.google.com`,
   `s3.amazonaws.com`, `*.googleusercontent.com`): `imgSources` / `mediaSources`.

## Not protected (honestly)

- **What the document says**: wrong numbers, lies, an old copy. The app cannot judge content.
- **Deception**: the document can draw a fake login or a fake confirmation card. What is typed
  there cannot leave (no network), but the member may type it elsewhere. Approving, sending and
  confirmations stay on the app's own cards, never in the view.
- **A link the member agrees to open**: a document can put text into a link's address; once the
  member presses 「ブラウザで開く」 on the confirmation (A2) it leaves with the link. A document
  holds only its own content and what the member typed into it.
- **The document's own folder and below are readable by its scripts**: anything of a served type
  there (not hidden, not another repository) — that is what lets its images and styles show. A
  document in a department's folder can read that department's pictures, styles, scripts and
  other `.html` pages; data files are not served. Hence no document at the company folder's top.
- **A swap raced precisely by a local process**: Node has no `openat`, so the walk below the
  folder and the open are path-based; the handle-versus-real-path check (before and after the
  read) refuses what it can see, but a process on this computer timing renames between those
  checks is out of scope (it could read the files itself).
- **Load**: a document can spin the CPU while shown (its own process; A2 unloads hidden tabs and
  has ［止める］). There is no per-view memory limit in Electron.
- **DNS**: a name the page makes Chromium resolve may still reach the system's resolver (the
  proxy carries the connections; `X-DNS-Prefetch-Control: off` stops link prefetch). Not testable
  with `host-rules`, as for 「ブラウザ操作」 (`agent-browser.md`); whether STUN / TURN server names
  are resolved before the WebRTC policy and the proxy stop the connection is not measured either.
- **Loopback**: Chromium never sends a loopback address through a proxy (seen for 「ブラウザ操作」's
  TURN, `agent-browser.md`; the A1 iframe's TURN to `127.0.0.1` connected too), so a document's
  TURN over TCP — or a preconnect — to `127.0.0.1:<port>` may connect directly to a program
  listening on this computer, carrying what the document holds (a TURN user name). The CSP, the
  request hook and the navigation lock still hold requests. It reaches nothing outside this
  computer; the harness maps names so as to measure the proxy, and does not measure this.
- **Chromium's own holes** (kept small by updating Electron), and **the file opened outside the
  app** (Finder, a browser): none of this applies there; the app offers no 「ブラウザで開く」.
- **Windows**: without `O_NOFOLLOW` a link as the last name is followed when it stays inside the
  folder (the real-location check still refuses one that leaves); git for Windows checks links
  out as plain files by default.

## Tests (each guard mutation-checked: remove it and a test fails)

- `client/tests/doc-frame-protocol.test.ts` — the address grammar (traversal, encoding, hidden,
  token), the policy with no network source and the CSP's closed directives, served types and
  headers, links (outside and inside, folder and file), hidden, data files, a named pipe, a hard
  link, another repository, not downloaded by case / NFC-NFD, 20 MB, a wrong token / a revoked
  grant / revoked mid-read, a folder swapped for a link, a handle that is not the file at the real
  location (at opening, after the read), one identical refusal, `check`'s refusals (top level
  included), the session's request rule, the navigation rule, views (closed by their own window
  only, destroyed, crashed, the window reset, the cap — also 40 opens at once —, no view = no
  grant, a reload while the file is checked or the view is made), the IPC (main window
  only, before any file is read; only a view id goes back).
- `client/tests/doc-frame-electron.test.ts` (real Electron with the real `doc-view.ts`, through
  `tests/doc-frame-harness/main.ts`; on the macOS half of CI) — the network paths above; inline and
  module scripts run; an image of its folder loads, `..`, `%2e%2e`, a link, a hidden folder,
  `local-file:` and `file:` do not; no `electronAPI` / `require` / `process`, opaque origin,
  storage throws, no popup; the session in memory, serving `acb-doc` alone (not `local-file`,
  `acb-plugin`), the app's session not serving `acb-doc`; navigations refused (`data:`,
  `local-file:`, `file:`, `acb-plugin:`, another token, the web, its own `.css`) and its own page
  allowed; the app's reload closes the view and revokes its grant.
- A2 in `doc-frame-electron.test.ts` (the window shown and focused): the keyboard stays the app's
  while the document loads, calls `focus()` every 100 ms and has `autofocus`, hidden and shown, and
  is the document's after a click; placed at the app page's zoom (CSS px × 1.25), visible and
  unmuted, another window cannot move it; hidden again → hidden, muted, the keyboard back to the
  app; Escape in the document in full screen leaves it; a reload keeps zoom 2 and scroll 600; a
  navigation to the web is handed over only right after a click (not by itself) and the page
  stays; a crashed view is told as `gone`. `doc-frame-protocol.test.ts`: placing / zooming /
  reloading only by the view's own window, bad placements hide, zoom clamped, `docViewOnScreen`,
  link events web-only and one a second, `gone` for a crash and the cap but not for the window's
  own close, the three IPC channels main-window-only. `src/features/editor/htmlViewer.test.ts`:
  the grid catches every overlay of its spacing and stays fine on a 4K area, which changes reload. `tests/ui/editor-html-viewer.spec.ts`
  (`editor-tabs-ui.html?view=html`): 見る by default, placed exactly over the area, closed on
  another tab / 中身 / ［止める］, a view made after the member left closed at once, a menu over
  it hides it (also one smaller than the grid, by its role), the top-level refusal's words, reloads
  on the right changes, the zoom kept across another tab and 中身, the link dialog (host large, Enter answers nothing, only ［ブラウザで開く］
  opens, another view's link ignored), zoom steps, a gone view, full screen.
- `ipc-window-links.test.ts` (privileges; the app's session does not serve `acb-doc`),
  `ipc-path-guard.test.ts` (`docView:open` from the main frame reaches the allowed roots),
  `ipc-contract.test.ts`.
- Kept on purpose (layers no single removal can show, like 「ブラウザ操作」's): the request hook, each
  CSP network directive and the refusing proxy for requests (each shown holding alone in the runs
  above, removing the others), `file://` answering 404 on the session (the CSP and the navigation
  lock hold `file:`), `setWindowOpenHandler` (the CSP's sandbox already refuses popups). The
  harness also checks: until shown, the view is muted and its page `hidden`; a session whose proxy
  could not be set makes no view and the next open prepares it (with the scheme handled before the
  proxy, the old order, the next open failed: mutation-checked).
