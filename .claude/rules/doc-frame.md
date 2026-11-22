---
paths:
  - "client/shared/doc-frame.ts"
  - "client/electron/doc-view.ts"
  - "client/electron/features/doc-frames/**"
  - "client/tests/doc-frame-*"
  - "client/tests/doc-frame-harness/**"
---

# The HTML viewer's document view (`acb-doc://`)

An `.html` file in the company folder is someone else's program (an AI that read a planted
instruction, a teammate): the app shows it, but it must reach **no network, no app, no other
file and no storage**. Owner decisions (2026-11-22, the proposal 「HTML ビューワーと下のパネル」):
internet parts (CDN scripts, web fonts, any network) are **blocked**; scripts inside the document
**run**, in an opaque-origin sandbox; the viewer does **not** open by itself. This file is PR A1:
the address, the view and their guards in main, no screen. The middle panel (A2) and the chat's
［見る］ (A3) build on it.

## The view and its session (`client/electron/doc-view.ts`, shell layer)

**A document never runs in the app's page or the app's session** (review of A1, 2026-11-22: an
iframe in the main window shared the default session, where the request hook cannot see a
preconnect or WebRTC — measured on Electron 45: STUN datagrams and a TURN-over-TCP connection
carrying a secret in its user name reached a local listener). Each document is shown in a
`WebContentsView` of its own, added to the main window (A2 places it; until then it is 0×0), with:

- **Web preferences**: no preload, `sandbox`, `contextIsolation`, no Node (also in subframes),
  `webviewTag: false`, `navigateOnDragDrop: false`, `partition: 'acb-doc'` — **in memory** (no
  `persist:`): nothing a document stores outlives the app run, no folder on disk.
- **The document session** (`acb-doc`, prepared once on the first view): the only session that
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
  Links to the web asking the member first (domain shown large, then the browser) is A2's.
- **The CSP's `sandbox allow-scripts`** gives the page an opaque origin although it is the view's
  top-level document: `localStorage` / `document.cookie` / `indexedDB` throw, no popups, modals,
  forms or top navigation. The app's own page stays the app's: its CSP needs no `frame-src`.
- **What the harness showed for each network path** (`doc-frame-electron.test.ts`, names mapped to
  local listeners with `host-rules`, since Chromium never proxies a loopback address): with the
  view as built, nothing reaches anything — fetch, XHR, WebSocket, beacon, web image / script /
  stylesheet, the page's own navigation to the web, `<link rel=preconnect|preload|prefetch|
  dns-prefetch>`, a meta-CSP `report-uri`, STUN and TURN over TCP: 0 requests, 0 connections, 0
  datagrams. One guard removed at a time: without the refusing proxy TURN over TCP connected (2);
  without the WebRTC policy STUN sent 5 datagrams; without the navigation lock the page moved to
  another token, its own `.css` and the web (the web then stopped by the proxy, or by the request
  hook with the proxy also off); with the proxy, the request hook and `connect-src` all opened, a
  prefetch connected (the CSP's `default-src` held it). `data:`, `file:`, `local-file:` and
  `acb-plugin:` navigations stayed refused even without the lock (Chromium / unhandled schemes).

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
  `src/features/editor/api.ts` `DocViewControls`. A2 adds placing (`docView:setBounds`) and showing.
- **Revocation goes with the view** (`views.ts`): `docView:close(viewId)` by its own window; the
  view destroyed or its page crashed (`onGone`); the window's page reloading, crashing or closing
  (`onWindowReset`: every view of that window closes); at most `MAX_VIEWS_PER_WINDOW` (32) per
  window, the oldest closed. A grant revoked while its file is being read answers 404.
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
  with `host-rules`, as for 「ブラウザ操作」 (`agent-browser.md`).
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
  only, destroyed, crashed, the window reset, the cap, no view = no grant), the IPC (main window
  only, before any file is read; only a view id goes back).
- `client/tests/doc-frame-electron.test.ts` (real Electron with the real `doc-view.ts`, through
  `tests/doc-frame-harness/main.ts`; on the macOS half of CI) — the network paths above; inline and
  module scripts run; an image of its folder loads, `..`, `%2e%2e`, a link, a hidden folder,
  `local-file:` and `file:` do not; no `electronAPI` / `require` / `process`, opaque origin,
  storage throws, no popup; the session in memory, serving `acb-doc` alone (not `local-file`,
  `acb-plugin`), the app's session not serving `acb-doc`; navigations refused (`data:`,
  `local-file:`, `file:`, `acb-plugin:`, another token, the web, its own `.css`) and its own page
  allowed; the app's reload closes the view and revokes its grant.
- `ipc-window-links.test.ts` (privileges; the app's session does not serve `acb-doc`),
  `ipc-path-guard.test.ts` (`docView:open` from the main frame reaches the allowed roots),
  `ipc-contract.test.ts`.
- Kept on purpose (second layers no test can tell apart, like 「ブラウザ操作」's): the session's
  request hook (the refusing proxy and the CSP hold the same requests; with the proxy and the
  navigation lock off it alone stopped the page's navigation to the web), `file://` answering 404
  on the session (the CSP and the navigation lock hold `file:`), `setWindowOpenHandler` (the CSP's
  sandbox already refuses popups).
