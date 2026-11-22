---
paths:
  - "client/shared/doc-frame.ts"
  - "client/electron/features/doc-frames/**"
  - "client/tests/doc-frame-*"
  - "client/tests/doc-frame-harness/**"
---

# The HTML viewer's document frame (`acb-doc://`)

An `.html` file in the company folder is someone else's program (an AI that read a planted
instruction, a teammate): the app shows it, but it must reach **no network, no app, no other
file and no storage**. Owner decisions (2026-11-22, the proposal 「HTML ビューワーと下のパネル」):
internet parts (CDN scripts, web fonts, any network) are **blocked**; scripts inside the document
**run**, in an opaque-origin sandbox; the viewer does **not** open by itself. This file is PR A1:
the address and its guards in main, no screen. The middle-panel view (A2) and the chat's ［見る］
(A3) build on it.

## The frame (what A2 must keep)

`<iframe sandbox="allow-scripts" allow="" referrerpolicy="no-referrer" src="acb-doc://…">` in the
main window, like a plugin's screen (`plugin-frame.md`): never `allow-same-origin` (with
`allow-scripts` the page could lift its own sandbox), `allow-popups`, `allow-forms`,
`allow-modals`, `allow-downloads`, `allow-top-navigation*`. The preload runs only in the main
frame (no `nodeIntegrationInSubFrames`). Measured in Electron 45 (`doc-frame-electron.test.ts`):
the document's origin is `null`, `localStorage` / `document.cookie` / `indexedDB` /
`parent.document` / `parent.electronAPI` throw `SecurityError`, `window.electronAPI` is
undefined, and the frame runs in a renderer process of its own (the token is the host of a
`standard` scheme, so each document is its own site). Still for A2: the app's CSP `frame-src
acb-doc:`, `will-frame-navigate` (a document moves only to an `.html` of its own grant; `http(s)`
asks the member, the domain shown large, then the browser), `setWindowOpenHandler`, fullscreen by
the app's button only.

## `acb-doc://<token>/<path>` (`client/shared/doc-frame.ts`, `electron/features/doc-frames/`)

- **Grants.** `docFrames:open(filePath)` (main window's main frame only, `isMainFrameSender`)
  runs `check` — the path through the allowed roots (`AllowedRoots.validate`), an `.html` /
  `.htm` name not starting with `.`, no `.git` segment, no link anywhere from the company folder
  down (each step `lstat`ed), not in a folder this computer did not download, ≤ 20 MB — and only
  then `grant`: 16 random bytes as the token, mapped to that document's folder. The renderer gets
  the address `acb-doc://<token>/<encoded file name>`; the address never carries an absolute path.
  Each open is a new grant (two views of one file: two tokens). Refusals are plain Japanese
  (`DOC_FRAME_WORDS`). Renderer port: `src/features/editor/api.ts` `DocFrameGrants`.
- **Revocation.** `docFrames:close(url)` by the window that holds it (the view closed); every
  grant of a window that is no longer the main window (`ownerAlive`) is dead on its next request;
  at most `MAX_GRANTS_PER_OWNER` (32) per window, the oldest forgotten. A grant closed while its
  file is being read answers 404.
- **What a request reaches** (`serve`, registered by the shell's `serveDocFrames`): only `GET`;
  the address read on the raw string (`parseDocFrameUrl`: query and fragment dropped, each
  segment percent-decoded once and then a plain name — no empty segment, nothing starting with
  `.` (so `.`, `..`, `%2e%2e`, `.git`, `.claude`, `.backups`, dotfiles), no `/` or `\` inside a
  name (also encoded), no control character; the host exactly a token, no user-info or port); a
  served type (`DOC_FILE_TYPES`: html, css, js/mjs, images, svg, fonts — never `.md`, `.csv`,
  `.json`, media or anything else); not in a not-downloaded folder (`excludedFolderOf`, so
  compared by `pathKey`: case and NFC/NFD); every folder below the grant's folder a real directory
  (`lstat`: a link, even one pointing inside, is refused) **holding no `.git`** (another
  repository: a private folder's clone — refused for its readers too, because the document's
  author may not be able to read it); the file opened with `O_NOFOLLOW | O_NONBLOCK`, a regular
  file, one hard link, ≤ `DOC_MAX_FILE_BYTES` (20 MB); and last its real location inside the
  grant folder's real path as opened (a folder swapped for a link meanwhile serves nothing).
- **One refusal.** Every refusal is the same 404 `Not found` with the same headers: an answer
  never names a folder (private folder names never leak, CLAUDE.md). The log says
  `[doc-frame] refused a request` without a path.
- **Headers on every answer**: the document CSP, `X-Content-Type-Options: nosniff`,
  `Cache-Control: no-store`, `Referrer-Policy: no-referrer`. No `Access-Control-Allow-Origin`:
  measured, a module script of the folder runs without it (fonts were not measured; A2 adds
  `null` with a test only if one fails to load).
- **Scheme privileges** (`registerLocalFileScheme`, one list with `local-file` and `acb-plugin`):
  `standard`, `secure`, `corsEnabled` (without it a module script of the folder does not run:
  measured). Never `bypassCSP`, `supportFetchAPI`, `stream`,
  `allowServiceWorkers`. Registered on the default session only: the 「ブラウザ操作」 window's
  sessions cannot reach it.

## The CSP: one policy object (`docFramePolicy` → `docFrameCsp`)

`default-src 'none'`; `script-src` the grant's origin + `'unsafe-inline'` (the owner's decision;
no `'unsafe-eval'`); `style-src` origin + inline; `img-src` origin, `data:`, `blob:`; `font-src`
origin, `data:`; `media-src`, `frame-src`, `connect-src`, `child-src`, `worker-src`,
`object-src`, `manifest-src`, `form-action`, `base-uri` `'none'`; `sandbox allow-scripts` (opened
at the top level, outside the frame, the page still gets an opaque origin). No `frame-ancestors`:
the app's page is `file://` when packaged and the Vite origin in development, and the token is
unguessable and lives only in main and the main window. The policy has **no network source**
(test: 「the default policy names no network source…」).

**Later (owner, 2026-11-22; planned, not built).** Each adds sources to the policy object only,
never loosens another directive:
1. Pictures the HTML file itself names (`<img src="https://…">`, read statically when opened):
   after the member's 「表示する」, main fetches exactly those and serves copies through the grant's
   own origin. Images a script asks for are never fetched. `img-src` stays the origin.
2. YouTube / Vimeo embeds, loaded on click: `frameSources` with the exact privacy-enhanced embed
   hosts. Not verified yet: the embed is a nested frame of an opaque-origin, sandboxed document
   (it inherits the sandbox, without `allow-same-origin` its player may refuse to run) — measure
   before promising it.
3. A company's own storage hosts set by an admin (exact hosts such as `assets.example.co.jp`,
   `<bucket>.s3.<region>.amazonaws.com`; never shared domains like `drive.google.com`,
   `s3.amazonaws.com`, `*.googleusercontent.com`): `imgSources` / `mediaSources`.

## The session's second wall (`electron-adapter.ts` `guardDocFrameNetwork`)

On the default session (where the main window and its frames live), `webRequest.onBeforeRequest`
for `http`, `https`, `ws`, `wss` cancels a request whose frame or any parent frame shows an
`acb-doc:` page (`isFromDocFrame`). It catches what the CSP does not: a document navigating
itself (`location.href = 'https://…'`, a link, `<meta refresh>`). Electron keeps **one**
`onBeforeRequest` per session: nothing else sets one on the default session; a later one must fold
this check in. A future viewer window with its own partition (A4) installs it there too.

## Not protected (honestly)

- **What the document says**: wrong numbers, lies, an old copy. The app cannot judge content.
- **Deception**: the document can draw a fake login or a fake confirmation card. What is typed
  there cannot leave (no network), but the member may type it elsewhere. Approving, sending and
  confirmations stay on the app's own cards, never in the frame.
- **A link the member agrees to open**: a document can put text into a link's address; once the
  member presses 「ブラウザで開く」 on the confirmation (A2) it leaves with the link. A document
  holds only its own content and what the member typed into it.
- **Load**: a document can spin the CPU while shown (its own process; A2 unloads hidden tabs and
  has ［止める］). There is no per-frame memory limit in Electron.
- **Chromium's own holes** (kept small by updating Electron), and **the file opened outside the
  app** (Finder, a browser): none of this applies there; the app offers no 「ブラウザで開く」.
- **The document's own folder is readable by its scripts**: anything of a served type in that
  folder and below (not hidden, not another repository) — that is what lets its images and styles
  show. Data files are not served.
- **Windows**: without `O_NOFOLLOW` a link as the last name is followed when it stays inside the
  folder (the real-location check still refuses one that leaves); git for Windows checks links
  out as plain files by default.
- **A reloaded renderer** keeps its grants until closed, the window goes or the cap forgets them.

## Tests (each guard mutation-checked: remove it and a test fails)

- `client/tests/doc-frame-protocol.test.ts` — the address grammar (traversal, encoding, hidden,
  token), the policy with no network source and the CSP's closed directives, served types, the
  folder and below served with the headers, links (outside and inside, folder and file), hidden,
  data files, a named pipe, a hard link, another repository, not downloaded by case / NFC-NFD,
  20 MB, wrong token / closed / gone window / closed mid-read, two views, the cap, a folder
  swapped for a link, one identical refusal, `check`'s refusals, the IPC's main-window gate.
- `client/tests/doc-frame-electron.test.ts` (real Electron, `tests/doc-frame-harness/main.ts`; on
  the macOS half of CI) — with the real registration, service and session guard: fetch / XHR /
  WebSocket / beacon / web image / web script / web stylesheet / the frame's own navigation reach
  nothing; inline and module scripts run; an image of its folder loads, `..`, `%2e%2e`, a link and
  a hidden folder do not; no `electronAPI`, opaque origin, storage throws, its own process; a
  closed grant answers 404; at the top level still sandboxed. The two walls were checked one at a
  time: without the session guard only the frame's own navigation reached the server (the CSP
  held the rest); with the CSP opened (`connect-src *`, web `img-src` / `script-src`) the guard
  alone still let nothing through.
- `ipc-window-links.test.ts` (privileges, served after ready, the session guard's decision),
  `ipc-path-guard.test.ts` (`docFrames:open` reaches the allowed roots), `ipc-contract.test.ts`.
