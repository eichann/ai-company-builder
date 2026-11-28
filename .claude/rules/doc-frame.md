---
paths:
  - "client/shared/doc-frame.ts"
  - "client/shared/doc-drive-videos.ts"
  - "client/electron/doc-view.ts"
  - "client/electron/features/doc-frames/**"
  - "client/tests/doc-frame-*"
  - "client/tests/doc-frame-harness/**"
  - "client/shared/doc-review-frame.ts"
  - "client/tests/doc-review-frame.test.ts"
  - "client/src/features/editor/htmlReview*.ts"
  - "client/tests/html-review-*"
  - "client/tests/html-review-demo/**"
  - "client/src/features/editor/htmlViewer*.ts"
  - "client/src/features/editor/docViewSession.ts"
  - "client/src/features/editor/components/HtmlDocumentPane.tsx"
  - "client/tests/ui/editor-html-viewer.spec.ts"
  - "client/src/features/editor/components/BlockedPartsBand.tsx"
  - "client/src/features/editor/components/HtmlViewToggle.tsx"
  - "client/src/features/chat/documentLink*.ts"
  - "client/shared/doc-drive-player.ts"
  - "client/tests/doc-player*"
---

# The HTML viewer's document view (`acb-doc://`)

An `.html` file in the company folder is someone else's program (an AI that read a planted
instruction, a teammate): the app shows it, but it must reach **no network, no app, no other
file and no storage**. Owner decisions (2026-11-22, the proposal 「HTML ビューワーと下のパネル」):
internet parts (CDN scripts, web fonts, any network) are **blocked**; scripts inside the document
**run**, in an opaque-origin sandbox; the viewer does **not** open by itself. PR A1 made the address, the view and their guards in
main; A2 the viewer in the middle panel ("The viewer (A2)" below); A3 the chat's ［見る］ and the
band of blocked internet parts (below).

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
  (`owner.focus()`); hiding a view that has the keyboard gives it back too. **Only a click made
  since the view last lost the keyboard counts** (the view's `blur` forgets the click; review of
  A2: clicking the document and then the chat within 600 ms let a page that reloads on blur, or
  calls `focus()`, take the keyboard back while the member typed). Measured with the guard:
  a page's `focus()` every 100 ms and `autofocus` take nothing, hidden or shown. A click into the
  document gives it the keyboard on purpose (a slide's ← →); the app's shortcuts still reach the
  app ("App shortcuts in a document" below). A view closed while it has the keyboard (中身, the tab
  closed) gives it back to the app too (measured: otherwise it was nowhere).
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
  document's folder; the view loads `acb-doc://<token>/<encoded name>`. A second argument names the
  member's current company (a plain id shape, else none): its session plays the document's Drive videos
  in ACB's player ("ACB's player over Drive embeds (plan 4)"); it opens nothing by itself. **The renderer gets only
  `{ ok: true, viewId }`**: the address never leaves main (and never carries an absolute path).
  Refusals are plain Japanese (`DOC_FRAME_WORDS`; `unavailable` when no view could be made). Each
  view is its own grant: two views of one file, two tokens. Renderer port:
  `src/features/editor/api.ts` `DocViewControls`.
- **The user manual** (`manual:open`, `files-and-editor.md` "The user manual") opens a view the same
  way, through `views.open` with an `OpenableDocument` main built for its own copy of the server's
  manual (grant folder = that copy; never a company folder, so `check` does not apply) and an optional
  `fragment` (`#` + the encoded heading, main's own) added to the loaded address, and `noScripts`:
  its grant's answers carry `docFramePolicy(token, { scripts: false })` (`script-src 'none'`).
- **`docView:setBounds(viewId, bounds | null)`, `docView:setZoom(viewId, factor)`,
  `docView:reload(viewId)`** (A2; main window's main frame only, and only for a view of that
  window — anything else is ignored): a placement that is not four finite numbers of at least
  1 px (`docViewBounds`) hides the view rather than placing it anywhere; main multiplies by the
  app page's zoom and cuts to the window (`docViewOnScreen`); the zoom is kept within
  `DOC_ZOOM_STEPS` (50–300 %) and set again after every navigation of the view; a reload first
  reads the window's scroll position in an isolated world (two finite numbers or nothing) and
  scrolls there once loaded (Chromium kept no position on reload here: measured 0). The read waits
  at most 1 s **while the view is shown** (a page spinning its CPU is reloaded anyway); a hidden
  view's read has no limit until it is shown (a background-throttled page on a busy computer did
  not answer within 2 s: the member was back at the top), and a reload asked meanwhile adds
  nothing (the waiting one loads the file as it is by then). The position is put back **in the
  page's first animation frame after the load**, not at once: Chromium focuses an `autofocus`
  field (scrolling to it) in the page's first frame, which under CPU load came after the load (CI,
  2026-11-22). A hidden view draws no frame, so the position waits until it is shown; a reload
  meanwhile keeps that position (a copy: the replaced page putting it back late must not clear
  it) instead of reading the top.
- **`docView:event`** (main → the main window, sent by `main.ts`): `{ kind: 'link', url }` — only
  an `http(s)` address (`webLinkForBrowser`), at most one per view per second (`LINK_INTERVAL_MS`:
  a page cannot queue confirmations), only for a registered view; `{ kind: 'gone' }` — a view went
  without its window asking (its page crashed, the cap closed it); `{ kind: 'shortcut', key }` — the
  member pressed one of the app's shortcuts in it (below), only for a registered view;
  `{ kind: 'blocked', count, hosts, hostCount }` — what its page wanted from the internet and did not get
  ("The band of blocked internet parts (A3)"), hosts only, only for a registered view;
  `{ kind: 'driveVideos', count, total, seen }` — the Google Drive videos its document embeds, counts
  only ("Google Drive videos (plan A)" below). A `link` to a Drive file also carries `videoLink` (main's
  number for it: "ACB's player over Drive embeds (plan 4)").
- **`docView:openDriveVideo(viewId, index)`** (main window's main frame only, only a view of that
  window, an integer index of the list main holds for it — anything else opens nothing): main opens
  Drive's page for that id in the member's browser (the shell's `openExternal`).
- **Revocation goes with the view** (`views.ts`): `docView:close(viewId, keepPlace?)` by its own window; the
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
- **Scheme privileges** (`registerLocalFileScheme`, one list with `local-file`, `acb-media` and `acb-plugin`):
  `standard`, `secure`, `corsEnabled` (without it a module script of the folder does not run:
  measured). Never `bypassCSP`, `supportFetchAPI`, `stream`, `allowServiceWorkers`.

## The viewer (A2): the middle panel (`src/features/editor/`)

- An `.html` / `.htm` tab opens as **見る** (`HtmlDocumentPane`): a toolbar (［見る｜中身］, －
  100 % ＋, 元の大きさ, 「変わったら自動で更新」 / 「ファイルが変わったので、表示を新しくしました」, the
  「資料の中だけで動いています」 label, 全画面, ［止める］ / ［もう一度表示する］) over an area the document's
  own view is placed over. 中身 is the code editor (autosave as for any file) under a band with the
  same ［見る｜中身］ at the same top-left place (`HtmlViewToggle.tsx` `HtmlSourceBar`, toolbar
  「資料の中身」; before 2026-11-23 the way back was two faint icons at the text's top right and the
  owner could not find it); ⌘⇧V switches; 見る is the default and the choice is per tab for the app's
  run (not saved). Markdown keeps its own floating preview toggle.
- **Back from 中身, where the member was reading** (owner, 2026-11-23): the view left for 中身 is
  closed with `docView:close(viewId, true)` (`DocViewSource.keepsPlace`, asked as the area goes;
  `TabbedEditorPanel` knows the tab was switched to 中身). Main (`views.ts` `close` → the shell's
  `closeKeepingPlace`) revokes the grant at once, hides the view, reads its scroll position in the
  isolated world (at most `SCROLL_READ_MS`; no answer → none), then closes it; the position is kept
  per window and document (newest 32, gone with the window's page) and given to the **next open of
  that document in that window, once** — put back after the load as on a reload (above). The
  position never leaves main (the renderer only says "keep"; `keepPlace` other than `true` is a
  plain close), so the document has no new way to the app. Another tab, the tab closed, ［止める］
  keep nothing (from the top). Tests: `doc-frame-protocol.test.ts` 「left for 中身…」,
  `doc-frame-electron.test.ts` 「left for 中身 and back to 見る…」, `editor-html-viewer.spec.ts`
  「中身 keeps the labelled…」.
- **One owner of the view**: `docViewSession.ts` (`DocViewSession`, read with
  `useSyncExternalStore`, the area attached by a callback ref — no effect). The view is opened when
  the area appears and **closed when it goes**: another tab, 中身, the tab closed (a wide left tab
  such as Skill over the middle only hides it, as an overlay does). Hidden tabs keep no document running (中身 included);
  coming back opens it afresh (from the top; from 中身, where the member was: above). An open answered after the area went closes its view.
- **Placing**: every animation frame something may have changed (the area's size —
  `ResizeObserver`: window, B1 dividers, the bottom panel —, any DOM change — `MutationObserver` on
  the body: menus, dialogs, tabs; checked at once for the first change, then at most every
  100 ms while the DOM keeps changing, e.g. a streaming answer —, scroll, visibility, full screen)
  the area's rectangle is compared and sent when it differs. Window moves need nothing (bounds are window-relative).
- **Overlays** (a native view is drawn above the app's page, so a menu, dialog, ⌘K or toast the app
  draws there would be hidden behind it): **the view is hidden while anything of the app covers
  its area** (`htmlViewer.ts` `placementOf` / `areaCovered`): any menu, listbox or dialog
  or toast (`OVERLAY_SELECTOR`: `menu`, `listbox`, `dialog`, `alertdialog`, `aria-modal`,
  `status`, `alert`, `data-overlay`; however small) whose box overlaps the area, or
  anything at a grid of points ~48 px apart over the area (at most 640 points; on a 4K area at
  most 3 steps apart; `document.elementsFromPoint`: the first element at a point must be the area
  or inside it). Tooltips do not count, so the document does not blink under the toolbar's
  tooltips. Nor does an element marked `data-under-document` — that element only, not what it
  holds: a divider's (`ResizeHandle`) grab strip reaches 4 px over its neighbours, over the points
  2 px inside the area, and hid the document whenever the left column, the chat or the bottom panel
  was beside it (2026-11-23; `editor-html-viewer.spec.ts`, `htmlViewer.test.ts`). The document
  is drawn over that part of the strip; the divider is still grabbed by its own line and the other
  side. Mark only what is not an overlay. An overlay with no role smaller than the grid both ways may slip between the points
  (`htmlViewer.test.ts`), and an element with `pointer-events: none` is invisible to
  `elementsFromPoint` — such an overlay needs a role or `data-overlay`. **Main does not check
  where a placement lies** beyond the window's content area (it does not know the layout): a
  renderer bug could place a document over the chat column. The renderer is trusted; the document
  cannot move its own view. The area then says 「メニューやダイアログを閉じると、
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
- **App shortcuts in a document** (owner, 2026-11-22): while the document has the keyboard, the
  app's shortcuts still reach the app. **One list**: the command catalog's keybindings of the areas
  around the view, `DOC_VIEW_SHORTCUT_AREAS` = its tab (`editor`) and the `app`
  (`docViewShortcutOf`, `client/shared/doc-frame.ts`, through `shortcutOf` in
  `shared/commands/define.ts`), except a binding marked `notInHtmlDocument` (its command does
  nothing on an HTML tab) — today ⌘K, ⌘P, ⌘B, ⌘J, ⌘⇧C, ⌘⇧F, ⌘⇧T, ⌘⇧V, ⌘S (Ctrl on Windows /
  Linux); ⌘F (`editor.find`, marked) stays the document's (its own find, or nothing: owner,
  「UI/UX が損なわれなければ良い」). A binding added to the catalog joins by itself. Main's `before-input-event`
  takes a matching key-down from the document (`preventDefault`: the page never sees it) and sends
  `{ kind: 'shortcut', key }`; a held key's repeats are taken but not sent. The window
  (`docViewSession.ts`) runs it **as if pressed in the document's tab** (`handleKeyAt`: the area's
  focus chain, so `acceptsKey` and the editor's target apply as for a key pressed in the page). An
  overlay it opens (⌘K) hides the view, and hiding gives the keyboard back (above). Everything else
  stays the document's: arrows, letters, Space, Enter, Tab, ⌘C / ⌘V / ⌘A, and **on a Mac Ctrl+letter**
  (a text field's own editing key: Ctrl+K, Ctrl+B; `isMacControlKey`). Not caught: the voice key
  (member-configurable, not a catalog binding) and keys the app has no command for. **A document
  cannot run app commands**: only the member's real input reaches `before-input-event` (a page's
  synthetic `KeyboardEvent` does not: measured), and what main sends is a key, never a command
  the page chose. Known: ⌘S is taken from the document (it saves the tab's file, harmless).
- **［止める］** closes the view (its scripts stop, its grant goes); ［もう一度表示する］ opens it again.
- **Links** (proposal item 5, A2): main hands a web link the member pressed (above) to the window;
  `ConfirmDialog` 「外のサイトを開きますか？」 with the **host large** (`URL.host`: a look-alike
  name shows as punycode `xn--…`), the whole address small, 「この資料は AI やほかの人が作ったもの
  です。知らないサイトなら開かないでください。」, ［やめる］ / ［ブラウザで開く］, `confirmOnEnter={false}`
  (focus on the dialog, a stray Enter answers nothing). Only ［ブラウザで開く］ calls `openExternal`
  (`shell:openExternal`, http / https / mailto only). One confirmation at a time per tab; links
  arriving meanwhile are dropped.
- Not in A2 or A3 (proposal): a separate window,
  printing, ⌘F in the document (A4).

## The chat's ［見る］ (A3)

- The owner's decision ③: **the viewer never opens by itself** when the AI makes or changes an HTML
  file. A finished, successful 「ファイルに書きました／直しました」 row (`Write`, `Edit`, `MultiEdit`,
  `writeFile`; Codex's `Write` with `changes`) naming an `.html` / `.htm` file as an absolute path
  inside the company folder, with no `.` / `..` / empty segment (`src/features/chat/documentLink.ts`
  `documentToViewOf`), carries ［見る］ beside it (`ToolRows.tsx`). Not on a read, a running or failed
  call, another file type, a file outside the company folder, a restored row (history keeps no
  path; B3 adds it), and not in a consultation's own window (no editor: `useCommandAvailable`).
  Inside a same-tool group the button is on the expanded rows. Kept as it is (review of A3): a
  write the agent refused without a `failure` marker may still carry ［見る］ — harmless, the file is
  opened only if it is there and main's checks pass.
- It runs `editor.viewDocument { path }` (`commands.md`), handled by the editor
  (`TabbedEditorPanel`): a tab shown as 中身 goes back to 見る, then `file.open` opens / shows the tab.
  Main checks everything again on `docView:open` (top level, links, not downloaded…): the chat only
  decides where the button is.
- **Page cards** (step ② of 「図とページで返す」, `chat-ui-and-history.md` "Page cards in a reply"): a link in the AI's
  reply to an HTML file of the company folder is a card that runs the same `editor.viewDocument`; nothing else changes
  here (the same `docView:open`, check, grant, CSP and session). A rich reply's pages go to the member's 今日のフォルダ's
  `ページ/` folder; `doc-frame-electron.test.ts` 「a page the AI made in the 今日のフォルダ…」 shows such a page reaching
  only its own folder.

## The band of blocked internet parts (A3)

- **What main reports** (`doc-view.ts`): Chromium's own report of each CSP refusal — the DevTools
  `Audits` domain's `ContentSecurityPolicyIssue` (`blockedURL`), read through the view's
  `webContents.debugger` in main (attached when the view is made; already attached elsewhere →
  no report, nothing else changes; attached before the page loads, so the refusals of its first
  parse are reported too — measured on Electron 45 for the stylesheet and script in the HTML;
  measure again on an Electron upgrade, as the harness does) — and the requests the session's hook cancelled for that view
  (`details.webContentsId`). The page can neither send nor see either (its `console` and
  `securitypolicyviolation` events are its own and are not read); a page can of course *cause*
  refusals for any host by asking for it — the band says what it wanted. **Measured (harness,
  Electron 45)**: every web part the CSP holds (stylesheet, script, preload, prefetch, fetch, XHR,
  WebSocket, beacon, image) arrives through `Audits`; the hook reported nothing (the CSP stops each
  request first) and stays as a second source for a request that gets past the CSP. Not reported:
  preconnect, DNS prefetch, WebRTC, a popup, a link (the navigation lock; a link the member pressed
  is the A2 confirmation).
- **A Drive embed ACB plays is not a missing part** (owner FB 2026-11-27: the band still warned about the
  document's own Drive video): a blocked address on exactly `drive.google.com` whose file id (`driveFileIdFromLink`)
  is one of the document's own videos (`seen`, from main's read of the served bytes) is not counted — ACB's player
  shows it. **Chromium reports a refused frame by its origin alone** (measured, Electron 45: Drive's 「埋め込む」
  iframe arrives as `https://drive.google.com`, no path — the first fix, matching ids only, left the owner's band
  warning): a bare Drive origin counts as the document's own when the document embeds any Drive video, and as a
  missing part when it embeds none (a script's iframe of another id is then not told apart). The report comes while
  the page's answer is parsed, **before** main has read the document (and again while an edited one is re-read):
  such an address is held and decided when the read ends; every other host is counted as before. Tests:
  `doc-frame-drive-videos.test.ts` 「a blocked Drive embed of one of the document's own videos…」 and 「Chromium reports a
  refused Drive frame by its origin alone…」 (the skip, the bare origin and the hold before the read each fail one
  when removed); `doc-player-electron.test.ts` 「the band counts none of the document's Drive embeds…」 (real Electron).
- **Hosts only** (`views.ts` `onBlocked`, `blockedWebHost` in `client/shared/doc-frame.ts`): only
  `http` / `https` / `ws` / `wss`; the host lower case, punycode, no port, user name, path or query
  (an address can carry what the page holds); `file:` / `data:` / other schemes are not internet
  parts. Main counts **different addresses** (kept in main only, at most `DOC_BLOCKED_PARTS_MAX`
  999; each kept as its SHA-256, so a long address costs no memory; a full tally takes nothing more,
  checked before an address is even read) and keeps distinct hosts in the order first seen (at most `DOC_BLOCKED_HOSTS_MAX` 20), and
  sends `{ kind: 'blocked', count, hosts, hostCount }` (`hostCount`: different hosts in all, past the
  named 20 too) — the first at once, then at most every
  `BLOCKED_INTERVAL_MS` (500 ms: a page asking in a loop sends no flood), nothing when nothing
  changed. A main-frame navigation of the view (`did-navigate`: its reload, its own other page)
  starts a new tally; the window hears `count: 0` once if it had heard something. A closed view
  sends nothing more (its waiting send is cancelled).
- **The band** (`components/BlockedPartsBand.tsx`, between the toolbar and the area: the view is
  placed under it; `role="region"`, never `status` / `alert`, which the viewer treats as an overlay):
  「この資料はインターネットから部品を N 件読み込もうとしています。会社の情報が外に出ないよう、読み込まずに
  表示しています（見た目が少し違うことがあります）。」 ［止めたもの］ (the hosts; 「ほかにもあります」 at the
  cap; the tip: ask the AI 「インターネットの部品を使わずに作り直して」, or write 「HTML は 1 つのファイル
  にまとめ、インターネットの部品を使わない」 into the company's AI instructions), ［AI に直してもらう］
  (`chat.insertText` with 「「<company path>」を、インターネットの部品（…）を使わずに作り直してください。HTML は
  1 つのファイルにまとめてください。」 — nothing is sent; only where a chat pane is there,
  `htmlViewer.ts` `rebuildRequestOf`) and ［×］. **Nothing is loaded from the band** (the owner's
  later decisions — images the file names after 「表示する」, YouTube / Vimeo on click, company
  storage hosts — are "Later" below).
- ［×］ remembers the hosts shown and `hostCount` (`DocViewSession.dismissBand`, for this showing of
  the tab): the same hosts again (an auto refresh while the AI edits) keep it closed; a host not
  seen before — named, or past the cap (`hostCount` grew; Codex review) — brings it back
  (`blockedBandShown`). ［止める］ and a view gone hide the band; a new view (another tab and back,
  ［もう一度表示する］ after ［止める］ or a crash) starts with no dismissal (Codex review): ［×］ holds for
  that view's reloads only. ［×］ also remembers the Drive videos' `seen` (below): a video the view had not
  had brings the band back, the same ones (or fewer) do not.

### Google Drive videos (plan A, owner decision 2026-11-26)

A document may embed a Drive video (`<video src="https://drive.google.com/file/d/<id>/…">`,
`<source src=…>`, Drive's 「埋め込む」 `<iframe src=".../preview">`). The view loads nothing from the
internet and keeps doing so — **the CSP and the session's request hook are unchanged; nothing new is
loaded into the view; no server endpoint, no Google API, no Picker**. The band lists the videos and
the member opens each in their own browser (Drive's own player and login).

- **When main reads**: `protocol.ts` hands the exact bytes of **every answer for the grant's own
  document** — the file its view was opened on (`segments` = its `name`), never another page of the
  folder, a style or a script — to `DocFrames.onDocumentServed` (one listener, set by `views.ts`; one
  that throws never stops the answer), with the file's identity as opened (`version`: device, inode,
  size, modified and changed times). Whoever asked counts the same — the main frame's load, or the page
  (or another page of the folder) asking for the document as an image or a frame: such requests cost
  nothing more, because **a version already read (or being read) is not read again**. The read runs
  **after the answer went** (`later`, never on the request's path), **one at a time per view**; bytes
  served meanwhile wait, only the newest kept, and are read next if their version differs.
- **What it reads** (`client/shared/doc-drive-videos.ts` `driveVideoIdsOf`, pure). One linear pass (a
  20 MB page in well under a second, `<` looked at once, attributes read forward, a quoted `>` does not
  end a tag): the **first** `src` of `video` / `source` / `iframe` start tags (names in any case, quoted
  or not), only `&amp;`-style entities decoded (ASCII numeric, `amp` `quot` `apos` `lt` `gt`);
  comments (`<!-->` and `<!--->` end at once, as in HTML), `script`, `style`, `textarea`, `title`,
  `noscript`, `template`, `xmp`, `iframe`, `noembed`, `noframes` contents and everything after
  `plaintext` are not the page's markup. **Static only**: what a script builds is not
  seen, on purpose. `<a href>` is not collected (a link goes through the link confirmation, A2). An
  address counts only if it starts exactly `https://drive.google.com` then `/`, `?` or `#` (also the
  cheap filter) **and** the core's one Drive link rule accepts it as a file link
  (`shared/core/google-drive.ts` `driveFileIdFromLink`: no user-info or port, `/file/d/<id>/…` incl.
  `/preview`, `open?id=`, `uc?id=`; `isDriveId`) — `docs.google.com`, look-alike hosts, `http`,
  folders are not. Distinct ids in the order written, at most `DOC_DRIVE_VIDEOS_MAX` (10); `total` the
  distinct count.
- **Kept in main only** (`views.ts` `videos`, per view; gone with the view): the ids and, for
  `seen`, every different id the view has had (at most `DRIVE_VIDEOS_SEEN_MAX` 1000). The window hears
  `{ kind: 'driveVideos', count, total, seen }` when what is offered changed (the same file served
  again says nothing); **never an id or an address**. **The list read is kept apart from whether it is
  offered**: it is offered — counts in the event, `docView:openDriveVideo` answering — only while the
  view's main frame shows the document (`views.ts` `pages` / `onOwnPage`, from `did-navigate`'s
  address, which in Electron comes *after* the serve). On another page of the folder the window hears
  `count: 0, total: 0` and no row opens, even if that page asks for the document (read, not offered);
  back on the document (`did-navigate`) the list as last read is offered again. A closed view is told
  nothing. **The window's side**: a view's first band state may come before its id reaches the page
  (`docView:open`'s answer), so while opening `DocViewSession` keeps the newest `blocked` /
  `driveVideos` of a few view ids and applies the opened view's own once its id is known.
- **Opening** (`docView:openDriveVideo(viewId, index)`, above): the address is **built by main from
  the id** — `https://drive.google.com/file/d/<id>/view` (`driveVideoViewUrl`) — never the page's own
  address text (its query, `resourcekey`, fragment). No confirmation dialog: the address is Drive's
  own page for a file id the member's browser then asks Drive about with the member's own login; the
  document chooses only which Drive file (as a link the member presses would).
- **The band** shows a Drive part when `count > 0`, with or without the internet parts' sentence
  (which keeps its own rule, `count > 0` of `blocked`; `drive.google.com` among the hosts there is
  normal — the CSP refused the video): 「この資料には Google Drive の動画が N 本あります。」 (N = `total`) and,
  since plan 4, 「［ACB で再生］で、アプリの中のプレイヤーで見られます（はじめての動画は、ブラウザで選んでから再生
  します）。」 (without a player: 「資料の中では再生できないので、ブラウザで開いて見てください。」), one row per listed
  video 「動画 1」「動画 2」… with ［ACB で再生］ (below) and ［ブラウザで開く］ (`aria-label` 「動画 n をブラウザで開く」),
  and 「ほかにもあります」 when `total > count`. The button sends only the view id and the row's index. The band's region is named
  「インターネットの部品」 when that sentence shows, else 「資料の中の動画」.

### ACB's player over Drive embeds (plan 4, owner decisions 2026-11-26/27)

The member plays a document's Drive videos **in ACB's own player, placed over the spot where the document
embeds them** (Drive's 「埋め込む」 `<iframe src=".../file/d/<id>/preview">`, a `<video>` / `<source>`), or over
the document's area for a link the member pressed or a row of the band. The video stays in Drive; the viewer
presses ［選択］ once per video in Google's Picker (`purpose: 'view'`, `google-drive.md` "Viewing a video");
the bytes come from the server's stream route ("Streaming a picked video"). **The document is unchanged**: its
CSP still names no network source, nothing is streamed into its origin or its session, its bytes are not
rewritten — the player is ACB's UI, a view of its own drawn above the document's.

- **Where the embeds are** (`doc-view.ts` `readEmbedBoxes`, through the handle's `readEmbeds(ids)`): asked
  with the view's own DevTools protocol, the debugger main already attached for the band, **by the ids main
  read** — `DOM.querySelectorAll` with `embedSelector(id)` (an `<iframe>` / `<video>` whose `src` names
  `drive.google.com` and the id, or a `<video>` with such a `<source>`; an id is Drive's characters only)
  and `DOM.getBoxModel`'s border quad of the first of at most 3 such elements that has a box. **No attribute
  of the page is read in main** (review 2026-11-27: a page can make a `src` of 50 MB; the harness's page has
  one and the players land exactly). Nothing runs in the page's context and the page cannot call or see it.
  **Measured (harness, Electron 45)**: the box model is relative to the scrolled viewport in the page's CSS
  px; times the document's zoom it is the view's own DIP — the players landed exactly over the embeds at
  zoom 1, scrolled by 100 px and at 150 %. While the view is shown and offers videos, the read repeats every
  `EMBED_POLL_MS` (80 ms; at once after a placement, an offer or a reload), **one at a time with no time
  limit**: a read a busy page has not answered yet is never followed by another (no pile of DevTools
  commands; `doc-player.test.ts` 「…a read the page does not answer…」); it stops while the view is hidden.
- **Which file plays is main's alone** (`players.ts`): main asks only about the ids it read from the
  document's served bytes ("Google Drive videos (plan A)": the list offered for the view), so an element its
  script makes with another id gets no player; the page can move, hide or duplicate an element (positions
  are cosmetic) but never change which file a player plays. One player per offered id, at most
  `DRIVE_PLAYERS_MAX` (10, the band's list), its view made only when its embed is first on screen.
- **Placement** (`client/shared/doc-drive-player.ts`, pure): the player covers the part of the embed's box
  inside the document's area (`embedPlacement`; a box under 24 px either way, or not finite, places
  nothing) and its video keeps the whole box's size, shifted inside the player (`stageCode`, numbers only,
  run in the player's own page): an embed half scrolled out is cut, not squeezed. A player over the area
  (`overlayPlacement`): centred, 16:9 plus its bar, a 24 px margin, **kept above the embeds' players** (a
  view added later is drawn above: the player over the area is raised whenever an embed's view is made;
  Codex review). **Hidden** whenever the document's view is (an overlay of the app, another tab, the link
  confirmation: `views.place` hands the view's on-screen area, or null, to the players) or its embed is
  scrolled out.
- **Hidden while it plays** (review 2026-11-27): the video is **paused** (the shell reads where it was), its
  streams are aborted (the server releases their slots), and the player shows 「プレイヤーが隠れたので、一時
  停止しました。」 ［続きから再生］ — it never plays unseen or muted. The press plays on from there (`#t=<s>`, a media
  fragment; measured: 0.5 s).
- **Clickjacking** (review 2026-11-27): a press (`play`, `browser`, `close`) is taken only on a shown player
  and not within `ACTION_GUARD_MS` (500 ms) of it appearing, moving (the page's layout) or being raised — a
  document cannot slide a player under the member's pointer as they click.
- **The player's view** (`doc-view.ts` `createDrivePlayerShell`, shell layer): a `WebContentsView` added
  above the document's view in the same window; no preload, `sandbox`, `contextIsolation`, no Node; its own
  in-memory session **`acb-player`**: its proxy is the shell's refusing proxy (as the document session's),
  it serves only `acb-drive-video://` (and `file://` 404), its one request hook lets a request through only
  when it names **the requesting page's own player's token** (`owns`, by `webContentsId`), every permission
  and download refused; popups denied, redirects refused, every navigation refused but its own page.
  Measured in the harness, each guard removed alone: another token's page, the web, `data:` and a local
  address stayed refused; `window.open` made no window; a redirect of its page was not followed;
  `Notification.requestPermission()` answered `denied`; the session's own request to a local listener
  reached nothing (the hook; Chromium never proxies loopback); the document session and the app's do not
  serve the scheme. Like the document's view it never takes the keyboard by itself (a focus without a click
  within `FOCUS_CLICK_WINDOW_MS` goes back to the app), the app's shortcuts pressed in it go to the app as if
  pressed in the document's tab, and Escape in it leaves the viewer's 全画面.
- **Its page is ACB's** (`electron/features/doc-frames/player-page.ts`, drawn by main from the player's
  state; never the document's content): the bar 「ACB のプレイヤー｜Google Drive の動画」 and a 2 px primary outline
  (a document cannot draw over another view, so the mark cannot be faked over the player — a document can
  of course draw a look-alike of it in itself); 「Google Drive の動画」［ここで再生］ (「はじめて再生するときは、
  ブラウザで動画を選びます。」), 「準備しています…」, 「ブラウザに Google Drive の画面を開きました。この動画で間違い
  なければ［選択］を押してください。」［やめる］, the `<video controls autoplay>` (`controlslist="nofullscreen
  nodownload noremoteplayback"`, `disablepictureinpicture`, `disableremoteplayback`: the video stays in ACB's
  view with its mark), the paused page, or the reason with ［もう一度］ / ［ブラウザで開く］; ［閉じる］ on a player
  over the area. Colours and sizes from the design tokens (`tokens.json`'s dark theme). CSP: `default-src
  'none'`, `media-src 'self'`, its one script by sha256 (the video's `error` → `unplayable` for codes 3 / 4,
  else `failed`), inline styles, nothing else. Its links and script ask for actions by going to
  `acb-drive-video://<token>/<action>` (`play`, `browser`, `cancel`, `close`, `unplayable`, `failed`): the
  navigation is refused and the registry acts; the page names nothing else.
- **Playing** (`players.ts` `start`): a probe `Range: bytes=0-0` of the server's route; 403
  `DRIVE_VIEW_NOT_PICKED` / 409 `GOOGLE_CONSENT_NEEDED` → the Picker flow for that one id (`main.ts`:
  `drivePicking.pick(…, { fileIds: [id], purpose: 'view' })`, consent first when needed) → probe again →
  play. The member's ［やめる］ aborts the pick. Words (`DRIVE_PLAYER_WORDS`): not picked and cancelled
  「動画が選ばれなかったため、再生していません。…」, timed out, nothing kept (+ `drivePickRefusedText`), offline,
  the server's own sentence for a refusal (a cap's 429, Google's refusal; `drivePlayerRefusal`), not a video
  (no ［もう一度］), a codec the app cannot play 「この動画はアプリの中では再生できない形式です。ブラウザで開いて
  見てください。」, a sign-in that lapsed. ［ブラウザで開く］ opens Drive's own page built from the id
  (`driveVideoViewUrl`).
- **The bytes** (`acb-drive-video://<token>/video`, GET only — a HEAD starts no server stream — and only
  while the player plays): main asks the server's route with the member's session cookies, forwarding the
  `<video>`'s `Range`, and passes the 200 / 206 / 416 on with `Content-Type` (a `video/*` only),
  `Content-Length`, `Content-Range`, `Accept-Ranges`, `no-store`, `nosniff`. **Chunks joined** (measured,
  Electron 45): the route answers at most one chunk per request (a shorter 206), and Chromium's player on
  this scheme does not take a shorter 206 than it asked — the clip was 「unplayable」 after its first 512 KB —
  so main answers the whole range asked as one 206 and fills it with the route's answers in order, each
  asked only once the one before was read (back pressure), each starting exactly where the last ended, the
  bytes counted per part (a longer answer is cut to its range). **An answer cut in the middle** — the
  route's own deadline per answer (`answerMs`, 120 s, which runs while a paused or slow player is not
  reading), a lost connection, or an answer ending short — **is asked again from the byte not yet passed
  on**, at most `REASK_MAX` (3) times in a row (`doc-player.test.ts`). Measured with a 1.5 s deadline on a
  paced answer (harness): the video went on with no error — and it also did with main's re-ask turned off
  (Chromium's player asked the rest again itself), so the re-ask is a second layer, not the only one.
  A refusal on the way shows its reason in the player. A player's streams are aborted when it closes or is
  hidden, and when the `<video>` stops reading (a seek): the server then releases their slots.
- **Scheme privileges**: `standard` + `secure` only (`registerLocalFileScheme`). Measured: without
  `standard` the video never got past its first range (the harness's second run); without `stream` it
  played and sought the same, so `stream` is not given (fewer privileges is the rule); never
  `supportFetchAPI`, `corsEnabled`, `bypassCSP`.
- **The token is one player's**: 16 random bytes, the address's host; refused for another player's page (its
  CSP's `media-src 'self'` and the session's hook), and **revoked with its player** (404). The renderer
  never sees a token, an id or an address.
- **Links** ("Links" above): a Drive file link the member pressed (`driveAddressVideoId`) reaches the window
  as `{ kind: 'link', url, videoLink }` — `videoLink` is main's number for it (the newest 4 kept per view;
  only for a view opened for a company), never the id; the confirmation then also says 「Google Drive の動画
  なら、アプリの中の ACB のプレイヤーでも見られます。」 with ［ACB で再生］ → `docView:playLinkedVideo(viewId,
  videoLink)` (once per number; main window's main frame, the view's own window); nothing goes to the
  browser. Other links are unchanged.
- **The band** ("The band" above) says 「［ACB で再生］で、アプリの中のプレイヤーで見られます（はじめての動画は、
  ブラウザで選んでから再生します）。」 and each row has ［ACB で再生］ (`aria-label` 「動画 n を ACB で再生」) beside
  ［ブラウザで開く］ → `docView:playDriveVideo(viewId, index)` (the same checks as `openDriveVideo`): a player over
  the area plays that row's id. One player over the area per view; another replaces it. No ［ACB で再生］
  without a current company.
- **Lifecycle**: every player of a view closes (tokens revoked, streams aborted) when the view closes — 中身,
  another tab, the tab closed, ［止める］, its page crashed, the window's page reloaded —, on another page of
  the folder (as the band's list; the player over the area too), when the offered list changes (an auto
  refresh with other videos; the same list keeps them, playing), on sign-out (`main.ts` `onSignedOut`) and
  on quit. The company: the renderer opens the view with its current company's id
  (`docView:open(filePath, companyId)`, a plain id shape or none — then no player is made, e.g. the user
  manual) and the editor's pane is keyed by company and file, so another company is another view.
- **Not protected (honestly)**: the document decides where its players appear (it can place one anywhere
  inside its own area, or next to its own fake controls), and which of the ids it statically names gets
  which spot — never another file. **A Drive link the member presses can name any Drive file** (a link's
  target is the document's, as for any link): ［ACB で再生］ on it only starts the Picker for that one id
  (video types only, the member's ［選択］) — nothing plays without the member's press and pick. A player over
  an embed shows ACB's mark, but the member decides by the Picker's own screen (the one bound video, video
  types only) what is granted. The positions follow the page within one poll (80 ms): a fast scroll shows
  the player a moment behind (and pauses a playing one scrolled out).
- Tests: `tests/doc-player.test.ts` (no Electron: the address grammar, the page's CSP and escaping, placement,
  ranges, refusals' words; through the real protocol, registry and players with fake shells — main asks the
  page only about its own ids and an element of another id gets no player, one read in flight however long
  it takes, the band's index and the link's number from their own window only (another window, a frame,
  another view, an index not held, an id, a number used once), not picked → the Picker → plays, a cancel's
  words, ［ブラウザで開く］, presses not taken while hidden or right after appearing / moving / being raised,
  the player over the area raised above a later embed's, hidden while playing → paused, streams aborted,
  ［続きから再生］ from there, the range forwarded and the chunks joined exactly, a cut answer asked again from
  there and a longer one cut, too many cuts an error, HEAD starting nothing, the token refused for another
  page / after close / while not playing, closing and sign-out abort streams, hidden with the document,
  closed on another page and back, no company no player); `tests/doc-player-electron.test.ts` (real
  Electron, `tests/doc-player-harness/main.ts`, a fake stream route serving a real clip in 512 KB chunks,
  B's answers paced and cut at a 1.5 s deadline: placement at zoom 1 / scrolled / 150 % / cut beside a
  50 MB `src`, no player for a script's element, hidden with the document, the keyboard kept (a skip only
  off CI when the window cannot hold the focus), not picked → pick → plays and seeks with 206s and the
  member's cookie, hidden → paused → ［続きから再生］ at 0.5 s, the shell's guards above, the player over the
  area on top, a cut answer asked again with the video going on, another player's page refused with no
  request to the server, closing aborts a paced stream; a second run without `standard` does not play);
  `ipc-window-links.test.ts` (privileges, not on the app's session); `editor-html-viewer.spec.ts` (the
  band's ［ACB で再生］ asks by view and row; a Drive link's ［ACB で再生］ asks by view and number, other links
  have none, the view opened for the company). Mutation-checked: the ids asked, the first element per id,
  the link narrowing and its number used once, the index's shape, the own-window / main-window checks of both
  channels, the company id's shape, `owns` by page id, the token revoked on close, bytes only while
  playing, HEAD, streams aborted on close, the range forwarded, the chunks joined and each starting where
  the last ended, the re-ask after a cut, hidden with the document, paused when hidden, the press guard,
  the overlay raised, closed on another page (the player over the area too), closed with the view, the pick
  when not picked, the `view` purpose sent (`google-drive-ux.test.ts`); in Electron: the chunks joined,
  `standard`, the embed's box times the document's zoom, the navigation lock, the redirect guard, the
  popup handler, the permission handlers, the session hook, the overlay raised, the pause on hide. Not shown
  on a developer's Mac (the test window could not hold the system's focus there): the player's focus guard —
  the keyboard test fails rather than skips on CI. Kept on
  purpose (layers no single removal shows): the id check of the boxes read (main asks only its own ids),
  `serve`'s closed check (the token is gone), the poll's no-company check (no player is made without one).

## Review in the document view (owner, 2026-11-26)

The same document review as Markdown's (`files-and-editor.md` "Document review"): comments on
selected text, replies, resolved marks, レビュー履歴 and 「変更を確認」, the AI reading the sidecars —
**the same sidecar files and JSON shapes, unchanged** (`<doc>.html.review.<uuid>.json`,
`<doc>.html.reply.<key>.json`; `selectedText` is the page's words, `startOffset` / `endOffset` where
they are in the `.html` file). **The `snapshot` of a completed review is the page's readable text**
(`htmlReadableText`, owner decision 2026-11-26), not the HTML — the same string field; it keeps
sidecars small (a page with embedded images would put megabytes into the company folder), and it is
what 「変更を確認」 compares with the file's text now. The sidecars are `.json`: not a served type, so a
document's scripts can never read its review.

- **Where trust ends.** The renderer and main are trusted; **everything inside the view is not**
  (the document's scripts own its DOM, its selection and its timing). The app's piece runs in the
  view page's isolated world `REVIEW_WORLD` (1002; `electron/features/doc-frames/review-world.ts`):
  its own JavaScript globals, put there by main only (`executeJavaScriptInIsolatedWorld`), never by
  the document, which shares the DOM with it and nothing else. **The document gets no channel to
  the app**: no preload, no message, no event the app listens to. Main *pulls*: the shell tells the
  registry of a real `mouseUp` (or a key release with Shift) in the shown view (`input-event`: a page's
  synthetic events never arrive there — `onReviewInput`); if that view's own window asked for
  selections (`docView:review` with `selecting: true`, only while the member reviews), main reads the
  selection 40 ms later (`READ_SELECTION_CODE`), from that view's main frame only (no other frame
  exists: `frame-src 'none'`). What comes back is checked (`docReviewSelectionOf`,
  `client/shared/doc-review-frame.ts`): exactly `{ text, prefix, suffix }`, strings of at most 4,000
  characters (the piece cuts there), the text cut to 1,000 and the context to 32 characters,
  whitespace collapsed, control characters, bidi marks and overrides, zero-width characters
  (U+200B–200D, U+2060, U+FEFF) and tag characters (U+E0000–E007F) dropped; anything else is ignored.
  Only then is `{ kind: 'selection', quote }` sent to that view's window, and the keyboard is given
  back to the app's page (the comment box takes it, and shows the **whole** quote, scrolling when long,
  before anything is saved). One read at a time per view, at most `SELECTION_READ_LIMIT_MS` (1 s: a
  page that never answers does not stop the next read; a late answer is dropped); a review ended, or a
  page loaded, meanwhile sends nothing.
- **The reviewed document only.** The view may go to another `.html` page of the same folder (a link,
  the page's script: the navigation lock allows its own grant). Main keeps which page the view opened
  (`views.ts` `pages`) and, on every main-frame navigation (`did-navigate`, the address), whether it
  still shows it (path under the grant's folder; a query or fragment is the same page): while it does
  not, no selection is read, no marks are drawn, `findQuote` finds nothing, and the window hears
  `{ kind: 'page', own: false }` (and `own: true` when the document is back) — the pane says
  「いまは資料の中の別のページを表示しているため、レビューを止めています。元の資料に戻ると再開します。」 and drops a
  selection it held. So nothing of page B lands in document A's review, nor A's marks in B.
- **What goes into the view**: only each shown comment's quoted text, which occurrence of it, and
  whether it is resolved (`docViewReviewOf`: the first 500 looked at, each checked alone — a bad one is
  dropped, the others kept with their index in the list sent, which `findQuote(index)` names) — never a comment's
  body, a name, an email or an id. Marks are the CSS Custom Highlight API (`CSS.highlights`; the DOM
  is not changed, so a page that re-renders itself is not broken), coloured by a constructed
  stylesheet the piece adopts while it draws (`REVIEW_HIGHLIGHT_CSS`, kept in the isolated world's own
  global; only while a review is shown). Not `webContents.insertCSS` (measured, Electron 45): Chromium
  paints no `::highlight` from a user sheet, and a view closed while an `insertCSS` was pending made
  `close()` throw (「Render frame was disposed before the request completed」; the harness's whole run
  failed about every other time). The page can see and remove the marks — its own words, on itself.
- **Pages that rewrite themselves** (tabs, charts): marks are drawn again after every load and after
  every member click in the view. A click on a comment (`docView:findQuote(viewId, index)`, an index of
  the marks main holds) finds the quote again in the page as it is now, scrolls it to the middle and
  makes it flash (`shown`), or the pane says 「この部分はいま隠れています…」 (`hidden`: in a closed tab, a
  folded part) / 「この部分はいまの表示では見つかりません…」 (`missing`); anything else the page answers
  counts as `missing`.
- **Finding a quote** (`src/features/editor/htmlReview.ts`, pure): the page's words read from the file
  without running anything (tags and comments out, entities read; the title, styles, scripts,
  templates, `noscript`, text areas not words of the page — the piece's walk skips the same, so
  "the n-th occurrence" means the same on both sides), compared **without whitespace** (`<td>前年比</td>
  <td>120%</td>` shows as 「前年比 120%」). At comment time the occurrence whose surrounding words match the
  selection's prefix / suffix is stored as `startOffset` / `endOffset`; the view draws the occurrence
  nearest that offset (`htmlQuoteNth`). 「位置不明」: doc-review's `markOrphanedComments` with the HTML
  finder (`htmlQuoteFinder`, a `QuoteFinder` port handed in by the editor's `useEditorReview`; scripts'
  words count there — a chart's labels are written in its script). 「変更を確認」 compares the page's
  words a line per block (`htmlReadableText`), not the HTML. **Once per file text**: the words are
  read in one linear walk (end tags found case-insensitively from where they start, never by
  lower-casing the file: that was quadratic, and 「İ」 lower-cases to two characters) and kept for that
  text (`wordsOf`), shared by every comment, the finder and 「位置不明」: a 3.5 MB page with 50 comments
  in about 0.3 s on a developer Mac (`htmlReview.test.ts`, budget 3 s: CI runners are slower; 576 KB took 4.6 s before).
- **On screen** (`HtmlDocumentPane`): the review's banners above the toolbar, ［レビュー履歴］ and
  ［レビューする］ in it, the side panel beside the document, the comment box **over the side panel,
  never over the document** (the view is drawn above the page), 「変更を確認」 in place of the document
  (its view closes meanwhile). doc-review's components and hook as they are; doc-review imports
  nothing of the viewer.
- **Not protected (honestly)**: the document can change what is selected at the moment the member
  releases the mouse (its scripts can set the selection), so the quote in the comment box may be words
  the member did not select — the box shows the quote before anything is saved, and a quote is at most
  1,000 characters of the document's own text. It can also hide or move its marks on itself.
- **A manual check** (not run in CI): `cd client && node tests/html-review-demo/run.mjs` opens the
  real app's editor (`tests/html-review-ui.html`) in a real Electron with the real document views, on a
  fictional company folder, to try reviewing by hand; `--shots <dir>` plays the whole review (select,
  comment, a hidden tab, reply, resolve, complete, the HTML changed → 位置不明, 「変更を確認」) and writes
  screenshots — the quickest way to see a change to this area on screen. If it breaks and nobody
  needs it, delete the folder rather than leave it broken.

## The CSP: one policy object (`docFramePolicy` → `docFrameCsp`)

`default-src 'none'`; `script-src` the grant's origin + `'unsafe-inline'` (the owner's decision;
no `'unsafe-eval'`); `style-src` origin + inline; `img-src` origin, `data:`, `blob:`; `font-src`
origin, `data:`; `media-src`, `frame-src`, `connect-src`, `child-src`, `worker-src`,
`object-src`, `manifest-src`, `form-action`, `base-uri` `'none'`; `sandbox allow-scripts`. The
policy has **no network source** (test: 「the default policy names no network source…」). A grant
made with `noScripts` (the user manual) gets `script-src 'none'` instead (`client/tests/manual.test.ts`).

**Later (owner, 2026-11-22; planned, not built).** Google Drive videos are listed for the member's
browser (plan A, built 2026-11-26) and play in ACB's own player over the document (plan 4, "ACB's player
over Drive embeds", built 2026-11-27) — never inside the view, whose policy is unchanged. Each of these adds sources to the policy object only,
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
  there cannot leave (no network), but the member may type it elsewhere. **全画面 makes this far
  more convincing**: the menu bar and the app around the document are gone, so a fake system
  prompt or login fills the screen (the member entered it with the app's button; Esc leaves). Approving, sending and
  confirmations stay on the app's own cards, never in the view.
- **A link the member agrees to open**: a document can put text into a link's address; once the
  member presses 「ブラウザで開く」 on the confirmation (A2) it leaves with the link. A document
  holds only its own content and what the member typed into it.
- **A Drive video the member opens** (plan A): the document chooses which Drive file id its row opens
  (any file it names, not only a video), and the row's 「動画 n」 says nothing of what it is. The address
  carries only that id (main builds it), and Drive answers with the member's own login and the file's
  own sharing — the same as a Drive link the member presses. Only the file's bytes as written are read,
  so the document's scripts cannot put what they can read (its folder's files) into an id. A link
  that needed Drive's `resourcekey` (some files shared before 2021) may then ask the member for access.
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
  `tests/doc-frame-harness/main.ts`, which writes `result.json` whole — temporary name, then
  rename — read after the process closed, not a stdout line Electron's exit could cut; on the macOS
  half of CI) — the network paths above; inline and
  module scripts run; an image of its folder loads, `..`, `%2e%2e`, a link, a hidden folder,
  `local-file:` and `file:` do not; no `electronAPI` / `require` / `process`, opaque origin,
  storage throws, no popup; the session in memory, serving `acb-doc` alone (not `local-file`,
  `acb-plugin`), the app's session not serving `acb-doc`; navigations refused (`data:`,
  `local-file:`, `file:`, `acb-plugin:`, another token, the web, its own `.css`) and its own page
  allowed; the app's reload closes the view and revokes its grant.
- A2 in `doc-frame-electron.test.ts` (the window shown and focused — the harness takes the system's focus
  (`app.focus({ steal: true })`) before the shown keyboard measurement and before the click + keys one, and takes
  either again, at most 3 times, when the window lost the system's focus during it: on the shared CI Macs
  something else took it now and then, leaving neither the app nor the document the keyboard, or handing it to
  the app on the way back (the "Known" above); a measurement the window kept the focus through is never taken
  again): the keyboard stays the app's
  while the document loads, calls `focus()` every 100 ms and has `autofocus`, hidden and shown, and
  is the document's after a click; a click no longer counts once the member went back to the app
  (a page reloading on blur takes nothing); placed at the app page's zoom (CSS px × 1.25), visible and
  unmuted, another window cannot move it; hidden again → hidden, muted, the keyboard back to the
  app; Escape in the document in full screen leaves it; a reload keeps zoom 2 and scroll 600, also
  for a page whose `autofocus` field comes after its load (put back after its first frame), and
  after two reloads while hidden; a
  navigation to the web is handed over only right after a click (not by itself) and the page
  stays; a crashed view is told as `gone`; with the document holding the keyboard, ⌘K / ⌘⇧V / ⌘B
  are handed over and the document sees none of them, a held ⌘B once, ⌘F stays the document's, while ←, a letter typed into
  its input and Space stay the document's, a Mac's Ctrl+K stays the document's, and the page's
  synthetic `KeyboardEvent`s hand over nothing; a view closed while it has the keyboard gives it
  back to the app. `doc-frame-protocol.test.ts`: placing / zooming /
  reloading only by the view's own window, bad placements hide, zoom clamped, `docViewOnScreen`,
  link events web-only and one a second, `gone` for a crash and the cap but not for the window's
  own close, a shortcut only to its own window and not once closed, every catalog binding of the
  editor and app areas handed over (⌘ on a Mac, Ctrl elsewhere) but those marked
  `notInHtmlDocument` (only ⌘F), and the document's own keys not,
  the three IPC channels main-window-only. `src/features/editor/htmlViewer.test.ts`:
  the grid catches every overlay of its spacing and stays fine on a 4K area, which changes reload. `tests/ui/editor-html-viewer.spec.ts`
  (`editor-tabs-ui.html?view=html`): 見る by default, placed exactly over the area, closed on
  another tab / 中身 / ［止める］, a view made after the member left closed at once, a menu over
  it hides it (also a menu or a toast smaller than the grid, by its role), the top-level refusal's words, reloads
  on the right changes, the zoom kept across another tab and 中身, a handed-over ⌘⇧V switching to 中身 (another view's ignored), the link dialog (host large, Enter answers nothing, only ［ブラウザで開く］
  opens, another view's link ignored), zoom steps, a gone view, full screen.
- A3: `doc-frame-electron.test.ts` — the page's web parts (in the HTML and asked by its script; one
  address with a secret path and query asked twice; 30 more hosts) reach the window as 40 parts
  and 20 distinct hosts, never a path, query or scheme, each event at least ~500 ms after the last (the throttle; how many depends on how long the page takes to ask), with 0 connections;
  its own page with no web parts brings `count: 0`. `doc-frame-protocol.test.ts` — `blockedWebHost`
  (host only; file, data, blob, acb-doc, ftp, javascript are none), the tally (distinct, an address
  counted once tells nothing, capped hosts and count, the first at once then every
  `BLOCKED_INTERVAL_MS`, each window its own views, a new page → 0 once, nothing after close and
  no timer left). `src/features/chat/documentLink.test.ts` — ［見る］ only on a finished write of an
  HTML file inside the company folder. `htmlViewer.test.ts` — the band's dismissal by host and the
  AI request's company path. `editor-html-viewer.spec.ts` — ［見る］ on the two HTML writes only (not a
  read, Markdown, outside, failed), opening as 見る also from 中身; the band (another view's ignored,
  count, hosts, the view placed under it, the AI request in the chat's input, ［×］ kept for the same
  hosts, a new host back, `count: 0` gone, a new view after ［止める］ says it again). Mutation-checked: the `Audits` reader, `did-navigate`'s
  new tally, the scheme / host rule, dedupe, both caps, the interval, the cancel on close, the
  editor's 中身 → 見る, the dismissed hosts, the chat row's state / failure / tool / folder / segment
  checks. Kept on purpose: the request hook's report (no request reaches it past the CSP today).
- Drive videos (plan A): `doc-frame-drive-videos.test.ts` — only the static `src` of video / source /
  iframe (not `<a href>`, `<img>`, other attributes or tags, comments, scripts, templates; the first
  `src`; entities), only https `drive.google.com` file links (look-alikes, http, a port, user-info,
  Docs, folders refused), dedupe and the cap with `total`, 20 MB pages of adversarial shapes each
  under 2 s, the canonical address, the policy still naming no network source, `<!-->`, `iframe` /
  `noembed` / `noframes` content and `plaintext`; through the real protocol and registry: the list
  from the bytes served for the view's own document only (not its style, not another page — none
  offered there, also when that page asks for the document; offered again back on it), counts only to
  the window, read after the answer (none on the request's path), once per file version (the page
  asking for itself as an image / frame reads nothing more), one at a time with only the newest next,
  re-read on a changed file with `seen` growing, nothing after close, a throwing listener still served; `docView:openDriveVideo` refused for
  a frame inside the page / another window / an unknown view / an index not held (also `'0'`, 1.5),
  and opening exactly Drive's `/view` page of the id. `htmlViewer.test.ts` — the band for videos alone,
  ［×］ by `seen`. `editor-html-viewer.spec.ts` 「the band lists the document's Google Drive videos…」 —
  another view's ignored, the part alone and beside the blocked sentence, N rows, the button asks with
  view id and index, ［×］ kept for the same videos and back for a new one, 「ほかにもあります」, `count: 0`
  gone; 「a view's first band state that arrives before its id does…」 — the early state applied, another
  view's not, the neutral label. Mutation-checked: the own-document condition in `serve`, its
  try / catch, the deferred read, the version skip, one read at a time, the sender / window / index /
  own-page checks, offering only on the document and again on return, the early state, the host narrowing, the tag list, skipped content, the first `src`,
  dedupe, the cap, the id check of the canonical address, comments (also `<!-->`), the added skipped
  elements, entities.
- Review (above): `doc-review-frame.test.ts` also — another page of the folder pauses the review (no
  read, no marks, no find; told to the window; resumed on the document), a read across a page load hands
  nothing over, the read's time limit, quotes dropped one by one with their index kept, the hidden
  characters; `htmlReview.test.ts` — the large page's budget, 「İ」, templates, a two-unit entity;
  `doc-frame-electron.test.ts` 「review: …」 — a page that replaces the built-ins the piece
  uses (`getSelection`, `Selection.toString`, `Range`, `createTreeWalker`, `CSS.highlights.set`) and keeps
  making a selection and firing synthetic mouse-up / pointer-up / Shift key-up events gets no selection read;
  the member's real drag reads the real words and none of the page's replaced built-ins is called (the
  piece's own world); the mark is drawn and found (mutation-checked: the piece in the main world, a read
  by timer); `editor-html-viewer.spec.ts` 「review: …」 — selections only while reviewing and only from
  its view, the comment box beside the document, the sidecar's shape and offsets, the quote to the view,
  a hidden place said, nothing reported after completion or when viewing it from the history;
  `tests/doc-review-frame.test.ts` — the selection's and the marks' shapes and caps, a
  selection only to its own window, only while selecting, only in shape, not after the review ended,
  the page not even asked when not selecting, nothing but quotes into the page, marks again after a
  load, `docView:review` / `findQuote` main-window-only and only an index set; `htmlReview.test.ts` —
  across tags / spaces / entities, the occurrence by its context, the n-th as the view counts it, 位置不明,
  the readable text; `doc-review/model.test.ts` — the finder port. Mutation-checked.
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
