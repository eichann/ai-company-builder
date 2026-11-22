---
paths:
  - "shared/core/browser-operation.ts"
  - "shared/core/plugin-browser-declaration.ts"
  - "shared/core/browser-plans.ts"
  - "shared/types/browser-plans.ts"
  - "shared/browser-connectors/**"
  - "client/scripts/browser-connectors.ts"
  - "client/tests/browser-connectors-approved.test.ts"
  - "server/src/routes/browser-plans.ts"
  - "server/src/services/browser-plans.ts"
  - "server/src/ports/browser-plans.ts"
  - "server/src/adapters/sqlite/browser-plans.ts"
  - "server/src/adapters/browser-connector-catalog.ts"
  - "server/src/db/schema/browser-plans.ts"
  - "server/tests/unit/browser-plans.test.ts"
  - "server/tests/unit/browser-plan-rules.test.ts"
  - "server/tests/integration/browser-plans.test.ts"
  - "shared/types/agent-browser.ts"
  - "server/src/routes/agent-browser.ts"
  - "server/src/services/agent-browser.ts"
  - "server/src/ports/agent-browser.ts"
  - "server/src/adapters/sqlite/agent-browser.ts"
  - "server/tests/integration/agent-browser.test.ts"
  - "admin/src/app/companies/*/advanced/ai-safety/browser/**"
  - "admin/src/lib/agent-browser.ts"
  - "admin/tests/agent-browser.test.tsx"
  - "client/shared/browser-operation.ts"
  - "client/shared/browser-runner.ts"
  - "client/shared/browser-checkers.ts"
  - "client/connectors/**"
  - "client/tests/browser-runner.test.ts"
  - "client/electron/browser-window.ts"
  - "client/electron/features/browser/**"
  - "client/tests/ui/browser-settings.spec.ts"
  - "client/src/features/settings/components/BrowserSection.tsx"
  - "client/src/features/settings/hooks/useBrowserSites.ts"
  - "client/tests/browser-window.test.ts"
  - "client/tests/browser-window-electron.test.ts"
  - "client/tests/browser-window-harness/**"
  - "client/shared/browser-ai.ts"
  - "client/shared/browser-operator.ts"
  - "client/shared/browser-page.ts"
  - "client/shared/browser-json.ts"
  - "client/electron/agents/claude-browser-operator.ts"
  - "client/tests/browser-operator.test.ts"
  - "client/tests/browser-preview.test.ts"
  - "client/tests/browser-page.test.ts"
  - "client/tests/browser-read-session.test.ts"
  - "model/browser-plan/**"
  - "shared/browser-connectors/**"
  - "client/shared/browser-plans.ts"
  - "client/electron/browser-request/**"
  - "client/src/features/browser-plans/**"
  - "client/tests/browser-plans-app.test.ts"
  - "client/tests/browser-plan-card-ui.tsx"
  - "client/tests/ui/browser-plan-card.spec.ts"
---

# Browser operation (「ブラウザ操作」): sites the chat AI may operate

The chat AI may operate web sites the company approved, in a browser window of the desktop app,
only through per-site operation types (later PRs), never by free clicking. Owner decisions
(2026-11-20, internal design memo §2, §13, §17, §18):

- **Admin-approved sites only.** Each site has one host the AI operates (writes go only there)
  and the exact hosts its pages load parts from (GET of scripts, styles, fonts, images only);
  every other request is refused. No `*.` wildcards.
- **Per-site operation types, split in two (owner decision 2026-11-21, design memo §24).** An
  operation type is **data** (the connector's declaration: what is sent, `writes`, and what the
  target must show afterwards, `expect`); the only code per site is a **checker** ("The checker"):
  a small reviewed reader that confirms, right before and after the write, the facts the request
  itself does not carry — the target is exactly one existing item of the planned parent, the
  logged-in outside account, the state before / after — and reads the CSRF value. **Exploring the
  page and building a plan is the AI's** (nothing of that is code); **guarding is the checker's**,
  never the AI's (a page can tell the AI anything). A checker that cannot read stops the run before
  writing: a changed site costs availability, never a wrong write. A site's level (見るだけ /
  入力・保存まで / 削除も) caps what an operation type may do there (`levelAllows`; an effect it does
  not know is never allowed).
- **The login stays in memory** and is gone when the app quits (PR 4, safe side; "Not yet": the
  owner's rule `browserLoginStorage` — on disk only for a member whose AI sandbox is `enforce` — waits
  until it can be bound to every AI turn on the PC being enclosed).
- **Default off.** No row = `DEFAULT_BROWSER_OPERATION_SETTINGS` (off, no sites); an older server
  sends no `browser` in the policy and the app treats that as off.

## Pieces

- `shared/core/browser-operation.ts` (pure; `shared-core.md`): the setting's shape, validation
  (`parseBrowserOperationSettings`, `normalizeBrowserHost` = the sandbox's host rules without
  `*.`), `levelAllows`, `decideBrowserRequest` (the window's one request rule),
  `browserLoginStorage`.
- Tables `agent_browser_settings` (company → JSON setting), `agent_browser_overrides` (company,
  user → off / on), `agent_browser_history` (who, when, the change as JSON) in
  `server/src/db/schema/agents.ts`. A stored setting that no longer validates falls back to the
  defaults (logged).
- `routes/agent-browser.ts` → `services/agent-browser.ts` → `AgentBrowserRepository`
  (`ports/agent-browser.ts`, `adapters/sqlite/agent-browser.ts`): `GET|PUT /agent-browser`
  (owner/admin; PUT takes the whole setting; an unchanged save writes no history), `PUT
  /agent-browser/overrides/:userId { mode | null }` (owner/admin; the user must be a member;
  null = follow the company). Every change is announced on the push channel (`/me/events`), like
  a sandbox change.
- `GET /me/agent-policy` (`services/agent-policy.ts`) carries `browser`
  (`AgentBrowserPolicy`: the company setting with `mode` = the member's override or the
  company's, `source: 'company' | 'member'`), inside the same version / ETag.
- An override applies only when it was set while the person is a member this time (its
  `updatedAt` ≥ the membership's `created_at`): someone who left and was invited back starts
  from the company's mode, and the admin page does not list the old row. Setting a mode for them
  again replaces it (recorded); 「会社と同じ」 removes it without a history row (nothing changed for
  anyone). The join time is one row: `MembershipRepository.joinedAt`.
- Admin 「ブラウザ操作」 (`admin/src/app/companies/[id]/advanced/ai-safety/browser/page.tsx`,
  「詳しい設定 › AI の安全」, owner/admin): 会社全体 (使わない / 使う), サイトの一覧 (操作するサイト,
  段階, 画面の部品を取る先 one per line; add / remove; invalid lines, a duplicate site or the
  operated host as a parts host are shown and block saving), the login note (kept only for
  members whose 「AI の囲い」 is 「囲う」), 「メンバーごとの動作」 (会社と同じ / 使わない / 使う) and the
  change history. Words: `admin/src/lib/agent-browser.ts`. Types: `shared/types/agent-browser.ts`
  re-exported from `admin/src/lib/api.ts`, pinned by `admin-contract.test.ts`. 「詳しい設定」 shows
  「変えています」 when it is on, has a site or an override (`aiSafetyChanged`).

## The app's window (PR 4: the member opens and logs in; the AI is not connected)

A member whose policy is on with at least one site sees Settings → 「ブラウザ操作」 (group 「AI と連携」;
the item is not there otherwise): each site with 「開いてログイン」 and 「ログインを消す」, and
「AI はまだこの窓を操作しません。 アプリを開き直すと、もう一度ログインが必要です。」. Words: `BROWSER_WORDS`
(`client/shared/browser-operation.ts`).

- **Pieces.** `client/shared/browser-operation.ts` (pure: the IPC payloads, `decideWindowRequest`,
  `navigationAllowed`, `browserProxyScript`, `browserResponseHeaders`, `decideAiWrite`, `decideAiRead`,
  `browserAiStopped`, `hostForLog`, `createRefusalTally`); `client/electron/browser-window.ts` (shell
  layer, the only Electron code: the window, its session's guards, the refusing proxy, the `ai`-mode
  gate, `clearPartition`); `client/electron/features/browser/` (`controller.ts`: which policy answer
  opens, closes and clears what; `leftovers.ts`; `ipc.ts` with `isMainFrameSender`); wired in
  `main.ts` (lane C) on the policy store's `onPolicy` / `onRefreshFailed`, sign-out and sign-in.
  Renderer: `src/features/settings/components/BrowserSection.tsx`, `hooks/useBrowserSites.ts`, `api.ts`.
- **The login lives in memory only** (coordinator decision after review, safe side): every window's
  session is `acb-browser-<sha256(user, company, host)[0..32]>`, never `persist:`, gone when the app
  quits. At start, before any browser session exists, `removeLeftoverBrowserPartitions` deletes every
  `<userData>/Partitions/acb-browser-*` folder (an earlier build's, or a later one rolled back; real
  folders only, a link is never followed). Disk logins: "Not yet" below.
- **Only a valid answer opens anything.** `agent-policy-store.ts` validates `browser`
  (`parseBrowserPolicy`, shared rules; invalid = left out = off) and reports every refresh without a
  valid answer (`onRefreshFailed`: no server, an error status, an answer that does not validate, a
  network failure). Unlike the sandbox part, the browser never runs on the last answer: a failure =
  off until the next valid answer, the company's windows close (the memory login stays until the app
  quits). `browser:sites` asks the server first (≤ 5 s); `browser:sites` and `browser:open` watch the
  company's push channel, so a change reaches open windows (and the 60 s check runs).
- **Close and clear.** A valid answer that drops the site or turns the mode off closes its window and
  clears its login; sign-out closes every window and clears every login; a sign-in as another account
  clears the others'. 「ログインを消す」 closes the window and answers only once the session is cleared
  (`clearFailed` 「ログインを消せませんでした。…」 otherwise). Clearing = `clearStorageData` (cookies, local
  storage, IndexedDB, service workers, cache storage…), `clearCache`, `clearAuthCache`, `clearData`. A
  changed site (its asset hosts) reaches the open window at once (`updateSite`: the rules and the proxy).
  **The app's close cannot be cancelled by the page**: the session's permission is revoked first (the
  request hook then refuses everything) and the window is destroyed (no `beforeunload`).
- **The window** (`browser-window.ts`): never the app pages' web preferences — no preload, `sandbox`,
  `contextIsolation`, no Node (also in workers / subframes), `webviewTag: false`, no plugins,
  `navigateOnDragDrop: false`; the title always names the site. Its session has **one**
  `onBeforeRequest` and **one** `onHeadersReceived` (Electron keeps only the last listener of each:
  installed once per session in `guarded`, nowhere else). The request hook decides with
  `decideWindowRequest` (the site's `decideBrowserRequest`; with no window open — a service worker left
  running — it refuses everything); the header hook drops `Report-To` / `NEL` / `Reporting-Endpoints`
  and gives every document `X-DNS-Prefetch-Control: off`. Popups denied (`setWindowOpenHandler`),
  downloads cancelled (`will-download`), every permission request and check denied (also devices), no
  client certificate ever sent (`select-client-certificate` → none), `will-frame-navigate` (every frame,
  the main one included) and `will-redirect` only to https on the operated host (`navigationAllowed`; a
  subframe may be `about:blank` / `about:srcdoc`), certificate errors refused (`callback(false)`, no
  bypass; production code never sets a certificate check), HTTP auth prompts and webviews refused.
  Nothing is handed to the system browser or another app: `keepAppPageInWindow` / `webLinkForBrowser`
  are the app pages' and are not used here. Refusals are logged per host and reason
  (`[browser] refused N request(s) to <host> (<reason>)`, every 10 s and when the window closes), never
  an address's path, query or a body.
- **What the request hook cannot see** (verified on Electron 45: without these, a preconnect, a
  `<link rel=preload>`, a NEL report, STUN and TURN reached a host the site does not list): the session's
  proxy is a PAC script (`browserProxyScript`) sending the site's hosts DIRECT and every other connection
  to the shell's own refusing proxy on 127.0.0.1 (answers 403 to anything, then closes); nothing loads
  before it is set, and a window whose proxy cannot be set is destroyed. WebRTC:
  `setWebRTCIPHandlingPolicy('disable_non_proxied_udp')` (no UDP; its TCP goes through that proxy).
- **The `ai`-mode write gate** (the runner below switches a window to `ai`; nothing in the app starts a
  run yet): `setMode('ai', { decide, decideRead?, stopped })`. After the first page load (attaching
  to an empty window hangs) it attaches `webContents.debugger` and `Fetch.enable` for every request; a
  write (not GET / HEAD) goes on only when `decideAiWrite` says so: https on the operated host, the AI
  not stopped, no method-override header, and the approved step's decider says yes (none = refused; a
  decider that throws = refused). **PR 5's decider must refuse a write whose `body` is undefined**: an
  upload or a large body has no `postData` in Fetch. Verified on Electron 45: the request hook runs
  **before** Fetch, so the hook cannot rely on the gate's verdict; instead in `ai` mode it refuses a
  write to the operated host before the gate is attached (or after it detached), refuses **every**
  request from outside the window's page (no `webContentsId` of the window: a service worker, which the
  page's Fetch does not see) — reads too, also of the very path main reads (6b-1, design memo §33 2-4:
  main never uses this session, so nothing outside the page here is main's) —, and refuses WSS to the
  operated host. In `human` mode the site's rule alone: the member's own browsing, a worker included. A dedicated worker's write, and a keepalive fetch or
  beacon sent on `pagehide`, are seen and refused (tested). `setMode('human')` detaches.
- **Emergency stop (decision, safe side):** the stop is about the AI, so it does not close a window the
  member operates (`human` mode: their own browsing, as in their own browser). In `ai` mode every write
  is refused while a whole-AI stop or a `web` / `mcp-external` stop is in force (`browserAiStopped`, as
  for a connector's read), checked per request; the runner's `stopped` dependency is meant to be
  `browserAiStopped(policy.stop(companyId))` when it is wired.
- **IPC** (`browser:sites`, `browser:open`, `browser:clearLogin`; event `browser:changed`): only the main
  window's main frame (`isMainFrameSender`: the main window, and `senderFrame` = its main frame);
  the host is only a name — main opens or clears only a site its current valid policy lists, exactly.
- **Remaining limits** (not closed, or not testable here): DNS — a page's links are not prefetched
  (`X-DNS-Prefetch-Control: off`) and other hosts' connections go to the refusing proxy, but a name the
  page makes Chromium resolve otherwise may still reach the system's DNS resolver (not testable with
  `host-rules`); WebRTC over TCP to a **loopback** address goes direct (Chromium always bypasses proxies
  for loopback; it reaches only this computer); the client-certificate refusal is untested (Chromium
  asks only when the system store holds a matching certificate); the header stripping, the refusing
  proxy's own server (vs. a closed port) and revoking before `destroy` are second layers no test can
  tell apart from the first (mutation survivors, each kept on purpose).

Tests: `client/tests/browser-window.test.ts` (the request, navigation, proxy, header and gate rules, the
stop, the log by host, memory-only partition names, leftover session folders removed at start and a link
never followed, nothing before a valid answer / for an older server / when off, an invalid `browser` =
off, the host checked exactly and per company, a failed refresh closes windows, a removed site or mode
off closes and clears, a changed site reaches the window, sign-out / another account, 「ログインを消す」
answers after the clear and says so when it failed, every failed refresh reported, the sender check, IPC
from the main window only, an opened window watched) and `client/tests/browser-window-electron.test.ts`
(a real Electron 45 window against local HTTPS sites through `tests/browser-window-harness/`: fetch / XHR
/ image / beacon / WebSocket / iframe / redirect / window.open / target=_blank / `javascript:` link / link
/ download to a host not listed get 0 requests and no popup window, and every click runs on the operated
page; no TCP connection at all reaches that host (preconnect, preload, NEL / reporting, TURN) and no STUN
datagram leaves; no session folder on disk; the window's own refusals of popup, navigation and frames are
logged; an asset host gets only GET of its script, style and image (no fetch, frame or POST); no
`electronAPI` / `require` / `process` in the page, permissions denied, no download saved, http refused;
in `human` mode the member's writes go out; in `ai` mode fetch / XHR / beacon / form / WSS / a dedicated
worker's / keepalive and beacon on `pagehide` writes are refused without an approving step, reads pass,
the approved write goes out and another write, a method override or a stopped AI do not; a window the app
closes is gone although its page cancels `beforeunload`, and its session then reaches nowhere; clearing
removes the cookie; an untrusted certificate is never bypassed; the log carries hosts and reasons only).
It runs on macOS (CI "Client tests 2/2 (macOS)", `client-tests.mjs` `MACOS`) and skips without a display.
`client/tests/ui/browser-settings.spec.ts` (preview `download-folders-ui.html?browser=…`): no item
without a site, the notes, 「開いてログイン」, 「ログインを消す」 and its failure. Each guard mutation-checked
(survivors above).

## The runner (PR 5a: built and tested; the AI cannot reach it)

Owner plan 2026-11-20: every automated operation goes through one gate; only per-site operation types
(the connector's declaration + a reviewed checker, "The checker"); the AI's entry stays **closed**: the
runner is made only by `features/browser/wire.ts` and run only by the card's ［任せる］ (`browserPlans:run`,
main window only, 6b-2d); no agent, chat tool, chat server, preload or renderer code names it
(`browser-runner.test.ts` 「only the card's ［任せる］ reaches the runner」 checks the importers, the one
handler, the IPC inventory and the agents / chat server / renderer). Since 6b-2c it runs a plan the
server holds ("Executing a plan" below); while the build's switch is off it refuses at once (`off`).

- **Pieces.** `client/shared/browser-runner.ts` (pure: the plan `parseBrowserRunPlan`, the claim
  `parseBrowserClaim` / `parseFixedContent` / `fixedContentMismatch` / `permitValidMs`, `createRunGate`,
  the checker interface `BrowserChecker`, `BrowserRunSurface` with `BrowserWriteSteps` /
  `BrowserWriteOutcome`, the step record, `stoppedBeforeSending`, `BROWSER_RUN_WORDS`);
  `client/shared/browser-checkers.ts` (`createBrowserCheckerRegistry` over the checkers it is **given**
  — an id not given is never run, two with one id refused — `createBrowserConnectors` over the
  declaration texts it is given, `parseBrowserDeclaration`); `client/electron/features/browser/runner.ts`
  (`createBrowserRunner`: the steps, no Electron), `run-records.ts` (the step record on disk),
  `read-session.ts` `writeThroughSession` (the write's chunk); the window's `run` surface in
  `browser-window.ts`; `controller.ts` `siteNow` / `runWindow` / `previewWindow` (what the runner's deps
  will be). `shared/core/plugin-browser-declaration.ts` `expectedAfter` (the state after).
- **Site code lives outside the core** (owner decision 2026-11-21, design memo §24): `client/connectors/<site>/`
  holds a site's checkers and its bundled declaration (`client/connectors/lstep/`: `reminder-step.ts`,
  `declaration.ts`, `index.ts` `lstepConnector({ account })`). A connector folder imports only itself,
  the checker's **types** from `client/shared/browser-runner.ts` and the repository's `shared/core`;
  nothing in `client/electron`, `client/src` or `client/shared` but `electron/main.ts` imports a
  connector (`architecture-boundaries.test.ts` 「the browser core knows no site」; `client/tsconfig.json`
  includes `connectors`). It is a stand-in until checkers run isolated and signed, handed out with
  their declaration from the shelf (design memo §25): moving a site out is moving its folder.
- **A plan** (the server's claim, `BrowserClaim.plan`, checked against its fixed content): `planId`, `companyId`, connector `{ id, version }`
  (exact), `operation`, `account` (the outside account's id as the checker reads it), `target`, `change`,
  `before` (the target's state the person saw: named lists of ids only), `approvedAt` (a plan approved
  more than a day ago never runs, whatever its expiry; one "approved" over a minute in the future is
  refused), `expiresAt` (never more than a day ahead). Its values must fit the type (`browserPlanProblem`).
  Single use: the server claims a plan once and permits its execution once ("Plans, executions,
  permits and locks"); the step record on this PC adds that this PC never runs a plan it has any
  record of.
- **One run** (the checks of PR 5a, inside the flow of "Executing a plan"), refusing with nothing sent at each check: the plan; the step record (a plan with any
  record never runs again — also one cut off by a crash); the connector declaration at that version; the
  operation (this PR: one form write, not irreversible); the checker (`checker.id` must equal the
  declaration's `checker`, else `unknown-checker`); **every target field no declared write carries is
  one the checker confirms on the page** (`targetFieldsOutsideWrites` ⊆ `checker.confirms`, else
  `target-unconfirmed`); the plan's values (`browserPlanProblem`); **what the page must show afterwards**
  (`expectedAfter(before, operation, values)`: the declaration's `expect` applied to the state the person
  saw; a removal of something `before` does not hold cannot come true → `cannot-come-true`; a page that
  would look the same afterwards — a value added and taken away again — cannot tell a done write from a
  refused one → `no-visible-change`, never run); the
  company's setting now (`browserOperationsAllowed` against the site the member's
  current valid policy lists: on, asset hosts, level); the AI stop; the member's open window; one run
  per window. Then the facts are read again ("Executing a plan"), the window enters `ai` mode with the
  run's gate (true only once DevTools Fetch sees the page), the checker's declared reads are made, and
  the run **stops before writing** for: an account that cannot be read (`account-unknown`) or is not the
  plan's (`account-mismatch`), a target that is not exactly one existing item, a state other than
  `before`, a missing CSRF field, a stop / setting change / expiry / closed window since (also checked
  by the gate per request). Then the one declared write is armed and sent (the permit, the last check:
  "Executing a plan"), and the page is read again: exactly the state `expectedAfter` gave =
  `succeeded`; **everything else once the request left** — a 4xx with the page unchanged, another
  state, another account, no target, no answer, no re-read — is **`unknown` (結果が分からない), never
  sent again** by the runner (6b-2c removed the old `failed`-on-4xx branch: the write did reach the
  site; `model/browser-plan` `BrokenFailedOn4xx`). The window always goes back to `human`. Every reason
  is a word of `BROWSER_RUN_REASONS`; a checker's `problem` that is not one becomes `checker-problem` (a
  checker's or a site's text never reaches a record or a result).
- **The gate** (`createRunGate`, the one rule for every request of a run): the page's own writes are
  refused for the whole run (the window's write decider says no; a page's fetch / XHR / timer / form of
  the very same write included); the page's reads of the operated host pass only for its parts
  (`Script`, `Stylesheet`, `Image`, `Font`, **without a query**: a GET with parameters may do
  something) or a declared read path without a query (**read strictness, decision**: a navigation,
  XHR or fetch elsewhere on the operated host is refused during a run, so a site that changes things on
  a GET cannot be driven by the page meanwhile; a part with a cache-busting `?v=` does not load while
  the AI operates — the page may look incomplete for those seconds; a part's GET without a query that
  has side effects is the remaining limit); requests from outside the page: a GET / HEAD
  only on a declared read path, no query, no body; a write only while armed, with a body the gate could
  read (undefined = an upload / blob: refused), no query, through `matchDeclaredWrite` (exact method,
  raw path, the plan's values, no other key but `ignore_body`, no repeated key or `_method`), in
  declared order, **at most once**; nothing while stopped. The runner sends the write from main
  through the window's login, never through the page (`run.write`; reads `run.request`): the page's script cannot see,
  change or answer it, and its hidden fields play no part (the body is built from the declaration,
  the plan and the CSRF value the checker read in the server's HTML).
- **A write gets a connection of its own** (verified on Electron 45): Chromium **resends a request whose
  reused keep-alive connection dropped before the answer**, below the request hook — one lost answer
  reached the test site 12 times through the window's session. So each write goes through the window's
  **write session** (`browserWritePartition`: `<window partition>-write`, in memory, one per window
  session — they do not pile up): its connections closed and its storage cleared (awaited) **before and
  after** every write, so it never holds an idle connection to reuse; the cookies **for the write's own
  address** copied in (path-scoped ones included), the site's proxy rule, ONE request hook asking the
  same run gate (Electron keeps the last listener: set per write). A first connection that drops is not
  resent. What the site sets in the write's answer (`Set-Cookie`) is **not** carried back to the window
  (decision: the runner re-reads with the window's own login; a rotated cookie stays as the window had
  it). In the window's session, a write from outside the page is always refused. Redirects are not
  followed (`net.request`, `redirect: 'manual'`: a 3xx is an answer; `ses.fetch` with `manual` rejects
  instead, so it is not used). An answer over 5 MiB is refused whole (`answer too large`): a read cut
  short is a failed read, never parsed.
- **Automatic retries that remain** (not closed): the fresh connection stops Chromium's resend after a
  dropped keep-alive connection, but Chromium still retries a request on its own where the protocol
  says the server did not process it — HTTP/2 `REFUSED_STREAM` or a `GOAWAY` naming a later stream, and
  similar for HTTP/3 / QUIC. The site's own failure to keep that promise could apply a write twice;
  the page's re-read would then show another state (`unknown`), never `succeeded`.
- **The step record** (`run-records.ts`, `<userData>/browser-runs/records.json` since 6b-2d's wiring): plan id,
  operation name, step, `claimed` / `permit-asked` / `succeeded` / `failed` / `unknown` (6b-2c; a file
  with the older `pending` / `sent` reads as unreadable — nothing ever wrote one outside tests), a fixed
  reason word, a time — never an account, a template, a token, the secret or any other value (refused).
  `permit-asked` is written right before the permit is asked: from then on the write may have left. No
  `sent` mark (decision: writing it would sit between the last check and the request leaving — the
  accepted limit's stretch —, and `permit-asked` already means "maybe sent"). `failed` = provably never
  left; `stoppedBeforeSending` (the latest record is `failed`) is the card's only hint, never a confirm
  (6b-2 decision 10). Kept two days (a plan lives at most one). A file that exists but cannot be read
  refuses every run.
- **The checker** (`BrowserChecker`, design memo §24): `id` (`<site>.<thing>`, named by a declaration's
  `checker`), `confirms` (the target fields it confirms on the page), `readPaths(values)` (the exact
  paths, no query, it reads), `view(values, reads)` → `{ account, state, ignored, problem }`. It has
  **no "after"**: what the target must show after the writes is the operation's `expect`, computed by
  the core. One checker serves every operation on its thing. It reads only the facts the request does
  not carry (the target is one existing item of the planned parent, the account, the state as named
  lists of ids, the `ignore_body` values); nothing else of the page is code — exploring and planning
  are the AI's. **Prefer stable sources** for a new checker: a JSON answer the page itself uses or a
  fixed id marker over the layout of the HTML; a site whose request names the whole target needs no
  target check. What the person approves (`before`) is the state the checker read, not what the AI said.
- **Lステップ** (`client/connectors/lstep/`): the declaration `lstep@0.6.1` (`declaration.ts`, bundled
  until the shelf hands browser connectors out; parsed by the core's `parsePluginManifest` like any
  package) with one type, **「リマインダの段にテンプレートを足す」** (`reminder_step_add_template`): effect
  `write`, checker `lstep.reminder_step`, `lock: { kind: lstep.reminder_step }`, `delivers: scheduled`
  (0.6.0, design memo §37, the owner who runs Lステップ: the template reaches only people who have the
  step's time still ahead, at that time, never anyone already past it — the reviewed meaning of the
  type, not read at run time; 0.2.0–0.5.0 said `none`), facts version 2 (`account`, `step_parent`,
  `names` required; `state`, `templates`, `schedule` required and complete; `shared_with` (0.6.1, the
  owner: Lステップ cannot say which 回 use a reminder) and `audience` optional — the card always shows the
  `shared` note — "The facts a checker reads" below), target `{ reminder, step }`, change `{ template }`, one write
  `POST /line/episode/step/pack/template` form `{ content_id: {step}, template_id: {template} }`,
  `ignore_body: [_token, _lm_user_id]`, `expect: [{ list: templates, add: "{template}" }]`, account
  required, the `shared` note (共有のリマインダ). Another operation on a step's templates is a new entry
  there, not new code. The checker `lstep.reminder_step` (`reminder-step.ts`, `confirms: [reminder,
  step]`) reads `GET /line/episode/show/<reminder>`, without its
  `<script>`, `<textarea>` and comments (`markupOnly`): `id="templateStep<step>"` must stand **exactly
  once as an attribute of a tag** (not a longer id, not another attribute); the step's box runs from
  there to the next `id="templateStep…"` or the next step's `id="template_confirm_…"`, whichever comes first (on the real page the next step's table follows this box); **every** `openModal(<reminder>, <step>, <hole>, <template>,
  <type>)` in the box must name this reminder and this step, and none of this step may stand outside
  the box (else no target). The state is the box's template ids (`templates`). Every id of the plan
  (each target and change field, so a later operation's extra id too) is a positive integer (never `0` / `-1`). `_token` / `_lm_user_id` are taken from
  hidden inputs of the markup (`_token` also `meta[name=csrf-token]`), one value each, plain token
  characters; none → `csrf-missing`, no write. **The real page's rows** (design memo §39–§41; §41 = the
  raw page as the server sends it, no scripts run — exactly what main reads): the attached templates are
  rows in `#template_confirm_<step>` — outside `templateStep<step>`, which there holds only the
  「テンプレートから追加」 form —: 「#N」 in a header cell, 「テンプレート <name>」, 編集 with
  `@click="openModal(<reminder>, <step>, <hole>, <template id>, <form type>)"` (the page's script defines
  `openModal(episodeId, packId, holeId, eggId, eggFormType)`: the 4th is the attached template's id, 8 =
  text; the rendered page drops `@click`, which is why §40's rendered capture showed no id) and a delete
  form `POST /line/episode/step/pack` with hidden `_method=DELETE`, `hole_id`, `content_id=<step>`
  (element ids repeated on every row). The checker reads each row (`stepTable`): exactly one
  `openModal(…)` naming this reminder and this step with a positive hole and template id, and exactly one
  delete form of this step whose `hole_id` is that hole; the table's last row (no header cell) holds
  neither; no call outside its rows; the table once and before the box. Every delete form of the step
  must be one of those rows (`stepHoles`, failing closed: every form closed, every `…episode/step/pack…`
  action exactly `/line/episode/step/pack` or `…/pack/template` once the origin is removed — a trailing
  slash, a query, a relative or another path → no target —, one `content_id` that is a positive id as
  written, one positive `hole_id`, `_method` `DELETE`, no hole twice). Anything else → no target: no plan
  (the facts' `state` unknown), a run stops before writing, the read after a write is `unknown`, never
  `failed`. A template's body spelling a call in its row makes two calls there → no target (never a
  guessed id). The state is the rows' template ids (plus slots in the box, the 11/20 capture's shape), so
  a plan can be made for a step that already has templates and the read after a write says `succeeded`
  when the new template's id stands in a row. The form type is not kept (the facts' `templates` check
  says whether the added one is text). Nothing else of the page is read — it also carries account-wide
  counts in Vue props: never read. The write's form, seen again in §40 (read only, field
  names, no values): `POST /line/episode/step/pack/template` with `content_id` (the chosen template is
  added by the page's script; `template_id` is the 11/20 capture's name), `_token` (also
  `meta[name=csrf-token]`) and `_lm_user_id` — the declaration agrees. Also seen, not declared: a step's
  content removed by `POST /line/episode/step/pack` (`_method`, `hole_id`, `content_id`: the swap's
  removal, "Not yet"), steps made / changed / removed by `POST /line/episode/step`, actions by `POST
  /line/episode/step/action`.
- **The account** (6b-1; confirmed on the real site with the owner's login, design memo §34): every page
  carries `<meta name="lm-account-id" content="<id>">`; the checker's default reader `accountFromMeta`
  takes it from real markup only — whole start tags, so a tag spelled inside an attribute value is not
  one, and nothing of scripts, text areas, comments, `<style>`, `<noscript>` or `<template>`: exactly one value, a positive
  integer, else none (missing, empty, two different values) — the run then stops with
  `account-unknown` before writing. `lstepConnector({ account })` still takes another reader (the
  real-Electron harness's test site).
- **The preview's reads** (0.3.0 the reminder page; 0.4.0 the lists, 0.5.0 their pages; design memo §34–§36, §38, each confirmed
  with the owner's login in a read-only window and `no_side_effects: reviewed` — our fixed GETs changed
  nothing; the pages' own background reads do not run since main reads without a page):
  `reminder_folders` `GET /api/episode-groups` (no query; the site's page sends an empty `?`, we send
  none) → `group`; `reminders` `GET /api/episodes?group={group}&page=<n>` (`pages: { param: page, max: 10 }`) → `reminder`; `reminder`
  `GET /line/episode/show/{reminder}` (reader `lstep.reminder_steps`: the steps, and the templates
  already on each step as `attached_template` — never `template`, so a candidate can never "add" one
  already there); `template_folders` `GET /api/template-groups` → `template_group`; `templates`
  `GET /api/templates?group={template_group}&page=<n>` (paginated likewise) → `template`. The four list
  readers (`list-readers.ts`, JSON) hand on ids and names only (never a template's body), and are whole
  only when the answer is the shape seen: a paginated answer reports where it stands (`current_page`,
  `last_page`, `total` — all three plain numbers, else no report and incomplete) and the app reads the
  pages ("Paginated reads" below; up to 10 pages = 500 items, a longer list is not offered — design
  memo §38, owner), and every entry of a folder's list, on every page, must name the asked folder (`group_id` and `group.id`, each one present equal to it, at least one;
  else left out, incomplete). 「未分類」 in the template folders is `id 0`: not selectable up to 0.6.0;
  **selectable since 0.6.1** (design memo §40: `GET /api/templates?group=0&page=1` answers like any folder,
  its entries with `group: null`) — the only `0` taken (the number 0 in the template folder list; never a
  reminder folder, an item or a plan id), and an entry of 「未分類」 counts only when every folder id it
  carries is `null` or `0` (at least one). The reminder list is always read with `group` (§36 confirmed
  `GET /api/episodes?group=<folder>&page=<n>` answers): §40's script read without `group` (`?page=1`)
  got nothing back, which the preview never sends. So 0.5.0 (and 0.6.0, 0.6.1) passes
  `previewProblem` (two id-free reads to start from; `reminder`, `step`, `template` each taken out by a
  reader) and the real connector walks a fake Lステップ to a candidate (`browser-preview.test.ts`); the
  preview stays switched off. Not declared: `/api/landings/<id>` (not this type's). 0.6.0 reads its
  facts through these same reads ("The facts a checker reads"). 0.6.1 adds `reminder_schedule`
  `GET /api/episodes/{reminder}` (no query; the JSON the reminder page itself reads, design memo §39,
  `no_side_effects: reviewed` from the owner's read-only window) with the JSON reader
  `lstep.reminder_schedule` (`reminder-schedule.ts`): the reminder's steps as `step` (no label); another
  reminder's answer, a hidden one (`hid_at` not `null`), a step twice or naming another reminder →
  incomplete; and `step_timing` `GET /api/episode-steps/{step}` (§40, read only) with `lstep.step_timing`:
  the step asked, labelled with the site's own `step_timing_text`.

Tests: `client/tests/browser-runner.test.ts` (the gate: not armed, another step / template, an extra /
repeated / `_method` key, no body, a query, http / another host, an undeclared method, a second send,
a stop; declared reads only, the page's parts without a query; the window's outside rule and read
rule; the plan's shape, expiry, `approvedAt` and one-day limits; the checker's box (exactly one id
attribute, not in a comment / script / text area, slots of this reminder and step only, none outside)
/ ids / token, the real page's rows (§41 structure: none, one, two, the same template in two holes read;
a row without its openModal or with two, naming another reminder or step, a hole other than its form's,
ids like 0, a hole twice, a body spelling a call, a call of this step in another step's table, a delete
form or a call outside the rows, the table twice or after the box, the last row holding a form, a
delete-like form of another action / a padded or missing `content_id` / unclosed or nested, a row's form
of another shape → no target; other steps' rows, the add form, a comment or script left alone),
the account from `lm-account-id` (present, missing, two different values, not a
positive integer, only in a comment or script); the bundled declaration, its `expect`, an unknown checker and
two checkers with one id; the record on disk and fail-closed; the closed AI entry: no module outside
`features/browser` names the runner, only the controller has `runWindow`, only the runner enters ai
mode) and `client/tests/browser-window-electron.test.ts` with a
Lステップ-like site in `tests/browser-window-harness/sites.ts` (exactly one POST with the planned ids
and the page confirms it; while the run operates the page's fetch, XHR, timer autosave, tampered form
and undeclared read reach nothing; another LINE account and a stop during the run send nothing; a lost
answer reaches the site exactly once and the plan never runs again; an answer over 5 MiB is a failed
read; a permit 5 s old by the last check: the write session never ends the request, nothing reaches the
site, the server is told failed; the write needs a cookie scoped to its own path and leaves nothing in its session, one write
session for every write; on the real window the armed write alone, once, another step / template /
extra key refused, undeclared reads refused for the runner and the page). Each guard mutation-checked;
kept on purpose: awaiting the write session's clear after the write (Chromium queues it before any later
read, so no test can tell; it is also cleared before each write) and `runWindow`'s policy check (the
controller already closes a window whose site leaves the policy).

## Plans, executions, permits and locks (PR 6a, 6b-2a: the server side; nothing in the app calls it yet)

The server half of the plan and its approval (internal design memo §27–§31; §30 + §31 are the
contract). A plan is fixed on the server, approved by its member, claimed **once**, and every
send asks the server for a permit right before it; the server is the authority. Nothing in the
app calls these routes in 6a (6b wires the operator AI, the preview read, the card, claim → permit →
send → report; 6c turns it on for the owner's PC).

- **Pieces.** `shared/core/browser-plans.ts` (pure: the fact shape `BrowserFact` and its checks
  `browserFactShapeProblem` / `browserFactsProblem` / `browserFactsDeclarationProblem`, one schema per
  facts version and checker — `BROWSER_FACT_SCHEMAS`, versions 1 and 2 of `lstep.reminder_step` —,
  `browserFactsChangedProblem` (the app's re-read against the approved facts, below), the report
  reasons `BROWSER_REPORT_REASONS`, `browserLockKey`, the states, `BROWSER_PLAN_TIMES`); the declaration's `lock` / `delivers` /
  `facts` and `browserFirstVersionProblem` (`plugin-browser-declaration.ts`, `plugins.md` "Browser
  connectors"); `browserAiStopped` moved to `shared/core/browser-operation.ts` (the app re-exports
  it). Server: `routes/browser-plans.ts` → `services/browser-plans.ts` → the handle's `browserPlans`
  (`ports/browser-plans.ts`, `adapters/sqlite/browser-plans.ts`, tables in
  `db/schema/browser-plans.ts`), the control-plane `BrowserExecutionLookup` (an execution's company by
  its secret's hash, listed in `company-scoped-sql.test.ts` like a key-broker token) and the
  `BrowserConnectorCatalog` (`adapters/browser-connector-catalog.ts`). API shapes:
  `shared/types/browser-plans.ts`.
- **Approved combinations** (§30.7): `shared/browser-connectors/approved.json`, one row per
  `{ connector, version, declarationHash, checkerHash, factsVersion, minAppVersion, status, declaration }`,
  written by `client/scripts/browser-connectors.ts` (`cd client && npx tsx scripts/browser-connectors.ts`,
  `--check`). `checkerHash` = the whole site folder `client/connectors/<site>/` (every file but
  `.DS_Store`: sha256 per file, the listing in name order, sha256 of it — `pluginFingerprintV2`);
  `status` is `pending` / `approved` / `retired`: the script writes a new row **`pending`** (design memo
  §33.5: listed, but the server reads it as not approved, `BROWSER_TYPE_NOT_APPROVED`) until a reviewed
  edit approves it together with its `minAppVersion` (6b: the small PR after 6b-2, the 6b-2 merge's
  build). Today: `lstep@0.2.0` … `lstep@0.6.0` (their old checker hashes too) `retired`, `lstep@0.6.1`
  (facts version 2; the timing from JSON) `pending`;
  `declarationHash` = `sha256:` of the declaration text, **and the text itself is in the row**: the
  server reads declarations only from this file (never from `client/`, which `server/src` may not
  import), re-hashes each and parses it with the core's parser (a row that does not match its hash
  or does not parse is left out, logged). Each site's `declaration.ts` exports `DECLARATIONS`. Every
  declared fact must be known to the current facts version's schema for its checker, or the script
  refuses; a version whose declaration changed is refused (raise the version). Rows the files no
  longer give are kept (an older app may carry that code); retiring is a reviewed edit of `status` to
  `retired`; `minAppVersion` starts null and may be set by hand (`X-ACB-Client-Version` then must be
  at least it). `client/tests/browser-connectors-approved.test.ts` fails when the file is not what
  the script writes (CI's client tests run on any `client/` or `shared/` change). The server reads the
  file once at start (`/app/shared` in the image); a missing file accepts no plan. The app's checker
  hash is the app's own word (a modified app is outside what this protects, §29.4).
- **Tables** (all behind the company handle, `company_id = ?` in every statement): `browser_plans`
  (the fixed content as canonical JSON + `content_hash`; trigger `browser_plans_fixed` refuses any change
  of the id, company, member, connector, version, operation, combination hashes, facts version,
  account, content, hash or times — only the state and its times move), `browser_executions` (one per plan: unique index; `secret_hash`,
  `lock_key`, state, `claimed_at` / `permitted_at` / `settled_at`, `void_reason`, `confirmed_by`, and
  since 6b-2a `permitted_mono_ms` / `permitted_boot` — nullable, added by `migrateBrowserExecutionMonotonic`),
  `browser_execution_reports` (every report, append-only — no UPDATE, no DELETE while its company
  exists; deleting the company still cascades: result, a fixed reason word, `outcome` applied / same /
  recorded / conflict, the state before), `browser_target_locks` (company × key →
  execution), `browser_type_grants` (member × connector × operation × **declaration hash**: a
  changed declaration needs a new grant).
- **Routes** (`/api/companies/:companyId`, `companyMember` — a person's session; no record-token
  route exists): `POST /browser-plans` (candidate + facts → draft, 201), `GET /browser-plans-open` (6b-2a:
  the member's own draft / approved plans for the inbox, newest first, at most 100 with `more`, each
  `BrowserOpenPlan` — no facts or explanation —, plans past their hour closed on this touch, the
  content never read or parsed: the target and the consultation come from the plan's copies
  `target_json` / `conversation_id` (`migrateBrowserPlanSummary`, nullable, fixed by trigger
  `browser_plans_fixed_summary`; a row without them is read whole, alone),
  `Cache-Control: no-store`; its own segment for the RegExpRouter), `GET /browser-plans/:planId`,
  `POST …/approve { contentHash }`, `POST …/cancel`, `POST …/claim` (answers `{ executionId, secret,
  plan, fixed }` once, `Cache-Control: no-store`; `fixed` added in 6b-2a — `{ content, contentHash,
  factsVersion }`, `content` the exact canonical JSON stored and hashed (`BrowserPlanContent`), so the
  app checks `sha256:` of it equals `contentHash` equals the hash the person approved; optional in the
  type: an older server sends none and the app must then refuse to run), `POST /browser-executions/:executionId/send-permit`
  (`X-ACB-Browser-Execution: <secret>`), `POST /browser-executions/:executionId/confirm { result:
  done | not_done }`, `GET /browser-executions-waiting?after=` (「確かめ待ち」, 100 open executions a page,
  oldest claim first, `{ items, next }`; its own segment for the RegExpRouter), `GET /browser-type-grants`, `PUT /browser-type-grants/:userId { connector, operation,
  declarationHash, allowed }` (owner/admin: `BROWSER_PLAN_WORDS.manageForbidden`). And `POST
  /api/browser-executions/report { result, reason? }` with the secret alone (`ownCredential`; 401
  without it): the member may have left. A plan and an execution are their member's own: anyone
  else's — and another company's — is the same 404 as one that does not exist (owners/admins too,
  except confirm below).
- **The checks** at register, approve, claim and permit (`gate`, in this order): the combination
  (connector, version, declaration hash, checker hash, facts version) is in the catalog
  (`BROWSER_TYPE_NOT_APPROVED`) and not retired (`BROWSER_TYPE_RETIRED`), the app at least
  `minAppVersion` (`BROWSER_APP_TOO_OLD`), the operation exists, **the first version's rule**
  (`browserFirstVersionProblem`: `delivers: none`, or `delivers: scheduled` with `facts.schedule`
  and `facts.templates` both `required` and `complete` (6b-2a), a `shared` note unless `facts.shared_with`
  is declared required (optional or not declared; 0.6.1: the card's warning stands in for it), not irreversible, exactly one write, not delete, a lock kind —
  `BROWSER_OPERATION_NOT_YET`), the member's browser setting (company mode with their
  override, `browserOperationsAllowed`: site and level — `BROWSER_NOT_ALLOWED`), the AI stop
  (`browserAiStopped` of the member's stops: whole AI, `web`, `mcp-external` — `BROWSER_AI_STOPPED`),
  the member's grant given while they are a member this time (`BROWSER_TYPE_NOT_GRANTED`). Report,
  confirm and the lists never ask them: a retired combination, a stop or a revoked grant never stop
  the clean-up. Sentences: `BROWSER_PLAN_WORDS` (plain Japanese).
- **Register**: strict body (`connector`, `operation`, the three combination fields, `target`,
  `change`, `facts`, optional `explanation` ≤ 2000 and `conversationId`); the values fit the type
  (`browserPlanProblem`); **the facts** (§31.3): only facts the type declares, each `{ status, value?,
  complete?, readAt, source }` and nothing else, every `required` one `known` with a value its
  schema accepts, every `complete` one `complete === true`, then the checks across facts and values
  (`lstep.reminder_step`: `step_parent.reminder` = `target.reminder`; the bodies of the added
  template and of every template on the step are there) — `BROWSER_FACTS_REFUSED` with the reason;
  every `readAt` within the last 10 minutes and at most 1 minute ahead (`BROWSER_FACTS_STALE`); the
  account is the `account` fact's id, `before` the `state` fact; `expectedAfter` must be possible
  (`BROWSER_CANNOT_COME_TRUE`). Unknown, an empty list and 0 are different answers. The fixed content
  (company, member, conversation, combination, operation, account, target, change, facts,
  explanation, created / expires) is hashed by the server (`canonicalJson`, `hashCanonical`).
- **Plan states** (§30.3): `draft` → approve (the hash the person saw, else `CONTENT_CHANGED`;
  compare-and-set) → `approved` → claim → `claimed` → `done` when its execution is final;
  `draft` / `approved` → `closed` by cancel (`cancelled`), by the hour (`expired`, an hour from
  creation by the server's clock — approval does not extend it) or by leaving (`left`).
- **Execution states** (§30.4 with §31.1–2): `claimed` (no permit: nothing sent) → permit →
  `permitted`, or → `void` by cancel (`cancelled`), 2 minutes without a permit or the plan's hour
  (`expired`), leaving (`left`), or **a permit the checks refuse** — the AI stop (`stopped`), the
  setting off / the site removed / its level no longer allowing (`setting`), the grant revoked
  (`not-granted`), the combination retired or no longer approved (`retired` / `not-approved`), the app
  below `minAppVersion` (`app-too-old`): lifting the cause later never revives that secret;
  `permitted` → report `succeeded` / `failed` (**only** "the app stopped before sending", the first
  version's one failure) / `unknown`, or `unknown` at permit + 5 s + 30 s (both clocks, below) without a report — a stop, a
  revoked grant or a time-out never make it `void` (it may have been sent); `unknown` → a report
  `succeeded` (the secret proves it; a late, sure success) or a person's confirm (`confirmed_done` /
  `confirmed_not_done`). `succeeded`, `failed`, `confirmed_*`, `void` are final: the lock goes (only
  the one this execution holds) and the plan is `done`. Every change is a compare-and-set on the
  state; **time-outs are judged on every touch** (get, the list, claim — the target's holder first —,
  permit, report, confirm), not by a timer.
- **Claim** (once per plan, ever): in one transaction the plan's checks, the target lock (a holder
  that timed out is settled first; held → `BROWSER_TARGET_BUSY`, nothing changed), the execution
  with a new 256-bit secret whose sha256 alone is stored, the plan `approved → claimed`. A second
  claim (a lost answer, another PC) gets `BROWSER_PLAN_NOT_APPROVED`, never a secret. The answer's
  `plan` is what `parseBrowserRunPlan` takes (`before` = the state fact).
- **Permit** (§29.3, §30.1): the member's own execution and its secret (else 404), then in one
  transaction: time-outs, state `claimed` (`BROWSER_PERMIT_USED` after a permit — asking again is
  never a new permit; `BROWSER_EXECUTION_CLOSED` when void), the plan's checks again (a refusal makes
  the execution `void` and lets its target go, in the same transaction), this execution holds its lock, `claimed → permitted` with the server's wall-clock time, its monotonic reading and this process start's id (the clock fix). Answer `{ permittedAt,
  validMs: 5000 }`: the app sends only within 5 s (6b: counted from just before it asked, both
  clocks).
- **Report**: `permitted` → the result; `unknown` + `succeeded` → `succeeded`, + `failed` → kept,
  unchanged (`recorded`), + `unknown` → `same`; a final state: the same answer `same`, a non-
  contradicting one `recorded`, a contradicting one (`succeeded` vs `failed` / `confirmed_not_done`,
  `failed` vs `succeeded` / `confirmed_done`) 409 `BROWSER_REPORT_CONFLICT`, kept as `conflict`;
  `claimed` / `void` (no permit, nothing sent) → 409, kept. Never "who is a member now": the secret
  decides.
- **Confirm** 「済んでいた / されていなかった」: the plan's member; an owner / admin only once the member
  left or 24 hours after the permit (`BROWSER_CONFIRM_NOT_YET`); others 404. Refused while the
  server's clock reads before the permit (`BROWSER_CLOCK_BACKWARDS`) and before permit + 5 s + 30 s
  on both clocks (`BROWSER_TOO_EARLY`); `claimed` / `void` → `BROWSER_NOT_PERMITTED`; once only
  (`BROWSER_ALREADY_SETTLED`). After it a report never changes the result.
- **The clock fix** (6b-2a, design 6b-2 §7-2; found by the model, `model/browser-plan/`): 6a counted the
  35 s on the wall clock alone, so a forward step of it (NTP, a VM resumed) right after a permit let a
  person confirm 「されていなかった」 while the app was still, correctly, sending — a confirm that a
  later send made false (R5). Now "past the window" (`pastWindow`: `permitted → unknown`, confirm, the
  waiting list's `canConfirm`) = wall elapsed ≥ 35 s **and** monotonic elapsed ≥ 35 s — since the
  permit when `permitted_boot` is this process start's id (`MonotonicClock` port: `bootId`,
  `monoMs()` = `performance.now()`, `adapters/system.ts`), else since this process started (a restart,
  or a row an older build permitted with no reading, waits a whole window from the start). The
  `confirmableAt` shown stays the wall-clock estimate; a press too early gets `BROWSER_TOO_EARLY`. A
  forward step only ever voids a claimed execution or closes a plan early (nothing sent: the safe
  side). The admins' 24 hours stay on the wall clock (they say who may confirm, not when).
  **One API process is assumed**: a monotonic reading compares only within its own process start,
  so two API processes behind one database would each count from their own start (a row permitted by
  the other one counts from this process's start, so never early, but the two disagree). The deploy
  runs one `api` container; a second one needs a shared monotonic source first. **During a deploy
  overlap** an old build (6a) still serving requests judges by the wall clock alone, so the hole stays
  open for those requests until it stops (nothing in the app calls these routes yet).
- **Facts version 2** (6b-2a, design 6b-2 §2-3; for `delivers: scheduled`): `lstep.reminder_step` v2 =
  v1's `account`, `step_parent`, `state`, `names`, `shared_with` + `templates` (`{ [id]: { name, kind:
  'text', body } }` — text templates only, decision 2; replaces `template_bodies`; the added one and
  every one on the step) + `schedule` (`{ timing }` as the page shows it, ≤ 100, never parsed) +
  `audience` (`{ count ≥ 0 }`; the declaration makes it optional: unknown makes a plan and is shown as
  「読み取れませんでした」, never 0 — decision 1). `BROWSER_FACTS_VERSION` (what the approved list's script
  writes for a new row) is 2 since the connector reading it (`lstep@0.6.0`, 6b-2b); rows already
  written keep their version, and version 1 stays readable by the server. **The re-read**
  (`browserFactsChangedProblem`, the app's, 6b-2c): the re-read must make a plan by itself, then every
  declared fact the same status; known ones the same value (canonical JSON), except `audience` (may fall,
  never rise — decision 8) and `shared_with.items` (a multiset: any order, each as often); unknown → known is a change (decision 9).
- **Report reasons** (`BROWSER_REPORT_REASONS`, 6b-2 §5-5): one list for the app and the server; the
  server still records any word of its pattern (an app newer than the server may send another).
- **Target lock** (§30.5): `browserLockKey` — the canonical JSON of `{ company, host, account, kind,
  fields: [[name, value]…] by name }` from the approved declaration's `lock.kind` and target fields
  and the plan's values (built by the server, never sent by the app; the type's version plays no
  part). Taken with the claim, held through `permitted` and `unknown`, released only on a final state
  and only by its execution (`DELETE … AND execution_id = ?`). Another plan for the same target can be
  made and approved, not claimed.
- **Leaving the company** (§31.1, `companies.removeMember` → `onMemberLeft`, inside the removal's
  transaction, over **every** row — lifecycle work never pages; only the waiting list does): draft /
  approved plans close (`left`), a claimed execution becomes void (its lock goes), permitted / unknown ones stay with
  their lock (an owner / admin confirms them; the app's report still counts), the grants go.
  Invited back, nothing returns (grants also count only from the current membership).
- **Remaining limits** (said, not closed): the app's checker hash is self-reported (§29.4); the
  stretch between the app's last clock check and the request leaving (§30.1); a site already
  processing a send; a parent / child target (§28.A); a version that changes `lock.kind` or the
  target fields while an execution is open is not held back yet (§30.5's compatibility rule: today
  one version exists). (A server wall clock jumping forward right after a permit was 6a's hole,
  closed by 6b-2a's clock fix.)

Tests: `server/tests/unit/browser-plans.test.ts` (the clock fix: a forward step after the permit, the
window opening once 35 s really passed, a restart, a restart with a step, a row with no reading, the wall
clock must pass too, the columns added to an older database; the claim's `fixed`; the open plans: own,
newest first, not claimed / closed / another's, closed on touch, 100 and `more`; a scheduled v2 type:
count unknown or 0, no schedule, a non-text template, v1 facts, a schedule not required; every report
reason kept; every row of both state tables, the time-outs on
touch, claim / permit / confirm once, the service's own compare-and-set losing to a row changed
between its read and its write (claim and permit), compare-and-set on stale state, a refused permit
voids the execution for good (stop, setting, grant, retired, app version), leaving with 520 claimed
executions, the waiting list's pages, the fixed columns and the reports' log, the lock: busy, released by a timed-out claim, only by its holder,
across members; reports: late, duplicate, contradicting, without a permit, after a confirm, a bad
secret; confirm timing, the clock behind, admins after leaving / 24 h; leaving; unknown, retired,
mismatching and too-old combinations; facts missing / unknown / incomplete / stale / contradicting;
grants), `server/tests/unit/browser-plan-rules.test.ts` (the declaration's new keys and refusals,
the first version's rule (also `scheduled`; an optional `shared_with` without a `shared` note), each fact's shape, unknown / empty / 0, facts version 2,
the re-read comparison, the reasons, the lock key, the stop),
`server/tests/integration/browser-plans.test.ts` (over HTTP: grants owner/admin only, the secret once
and uncached and only in its header, the claim's `fixed` hashing to the stored hash, the open plans
uncached and own only, the report without a session, the real member removal),
`client/tests/browser-connectors-approved.test.ts`, permission matrix rows + `CROSS`,
`company-scoped-sql.test.ts` (`HANDLE_TABLES`, the lookup), `jobs-schema.test.ts` (additive tables).
Each guard mutation-checked.

## Executing a plan (6b-2c: built; 6b-2d: wired behind the card, switched off)

Design 6b-2 §3, §5 (owner approved every recommendation): `createBrowserRunner(deps).run({ companyId,
planId, contentHash })` (`features/browser/runner.ts`) runs one plan the member approves on the card —
the card's press is all it takes (never a fact, a hash of its own or the AI's word). No Electron; the
server comes in as `BrowserPlansApi` (approve / claim / cancel / permit with the session, report with
the secret; the HTTP client is 6b-2d's `plans-api.ts`, none retries by itself), the window as `BrowserRunWindow`
(`run` + `preview` of one window), the context as `context()` → "still the same?" (sign-in, company,
setting generation: 6b-2d's `context.ts`), the clocks as `now()` and `monoMs()`.

- **Order** (each step names a `model/browser-plan/PlanLife.tla` action): the switch (off → nothing
  asked) → the input's shape → this PC's record (any record → `already-ran`) → `approve { contentHash }`
  (a lost answer still tries the claim) → `claim` (refused / lost → `refused`, nothing else possible: a
  lost claim's plan is used up). From the claim on, **every stop before the permit gives the plan back**
  (`cancel`: the server makes the execution void; record `failed`; outcome `stopped`): a claim without
  `fixed` (**an older server: never run**, `server-too-old`); `fixed.content` must hash (`sha256:` of its
  UTF-8) to `fixed.contentHash`, equal the hash the person approved, be exactly the canonical JSON of what
  it parses to, and agree with the claim's plan field by field (company, connector, operation, account —
  also the `account` fact —, target, change, expiry, facts version, `before` = the `state` fact:
  `fixedContentMismatch`) — else `fixed-mismatch`; record `claimed`; the PR 5a checks ("The runner")
  plus **the build's own combination** (`deps.combination`: declaration and checker hashes and facts
  version equal the fixed content's, the checker's `facts.version` too — else `connector`); the setting,
  the stop, the plan's hour (the hashed `expiresAt`; the claim's `approvedAt`, not hashed, only refuses
  at parse), the context; the window, one run per window; **the full re-read**
  (`readBrowserFacts` through the window's page-less read session, then
  `browserFactsChangedProblem(approved facts, re-read)`, saying what for the card: not read whole /
  a read that cannot be made → `read-failed`, the checker's own problem → `checker-problem`, another
  account → `account-mismatch`, the step's templates → `before-changed`, any other approved fact →
  `facts-changed`; a count may fall, never rise; unknown → known is a change); `ai` mode and the
  checker's view (`checkBefore`: account, target, state, CSRF).
- **The write** (`run.write`, typed so it cannot be sent without its two steps; shell:
  `writeThroughSession` + `sendOnce`): the write session is prepared first (connections closed, storage
  cleared, its hook, the cookies) — those seconds never eat into the permit —, then `ready`: record
  `permit-asked`, both clocks read, the permit asked **once** (5 s, `askWithin`; a refusal → the server
  voided it, nothing reported, `stopped` `permit-refused`; no usable answer → `failed`
  `permit-unanswered`), then `beforeSend` synchronously right before `request.end`, no await between:
  monotonic **and** wall elapsed since just before asking both in `[0, min(validMs, 5000))` (a sleep stops
  the first, a clock set back makes the second negative → `permit-late`), the context, the stop, the
  setting, the expiry, the window. False or a throw → the request is never ended → **`failed`, reported
  failed**. Every path to `failed` is "the app stopped before sending", provably, and only after the
  permit was asked: no usable permit answer (none in 5 s, an error, a malformed one, `ready` throwing —
  `permit-unanswered`), the record `permit-asked` cannot be kept, `beforeSend` false or throwing
  (`permit-late`, `context-changed`, `stopped`…), or the request not even made (`net.request` /
  `setHeader` failing before `end`: `error`). The shell's send rejects with `BrowserNotSentError` only
  before `request.end`; every other failure is `sent` with no answer. **Decision (safe side)**: a
  refusal of the write session's hook or a stop right after `end` (the hook cancels the request) is
  reported `unknown` although nothing left — the app cannot tell it from a lost answer.
- **After the send**: no answer / an error / a disconnect / an exception once the permit was asked →
  **`unknown`** (`no-answer`); otherwise the page read again decides: exactly `expectedAfter` →
  `succeeded`; another account, no target, a checker problem, any other state — **a 4xx with the page
  unchanged included** — → `unknown`. Never `failed` once the request may have left; **never sent again**
  (no resend path; the plan is claimed once and permitted once; this PC's record refuses it; a new try is a
  new request in the chat → new facts → new approval, 6b-2 decision 6).
- **The report** (secret in its header): the result and a word of `BROWSER_REPORT_REASONS` (a closed
  window, a setting change and an expiry are said as `context-changed`), sent at most 3 times with the
  same body, only while unanswered; all lost → the server's time-out makes it `unknown`. The secret lives
  in memory only (decision 8): a crash = the server's time-outs and a person's confirm.
- **Remaining limits** (said): the app freezing between `beforeSend` and the request leaving
  (`limits/LimitFrozenAfterCheck`); the seconds between the re-read and the send; the page's own worker or
  WebSocket in the run window is not stopped (writes for the plan go only from the write session).

Tests: `client/tests/browser-execute.test.ts` (the real runner, the real Lステップ 0.6.1 declaration,
checker, facts driver and parser against a fake Lステップ and a fake of the plan routes,
`tests/browser-plans-fake.ts`: success with one write and one report; an older server, every fixed-content
mismatch and another combination never run; each re-read change (a body, the timing, a template on the
step, the account, the count rising, unknown → known) stops before the permit, a falling count runs; a
stop / setting / context change before the permit, each saying what; a re-read that cannot be made; the record not kept; 4999 ms sends, 5000 ms on either
clock or a clock set back does not; a stop / closed window / changed context / a throw in the last check
→ failed; a refused permit → nothing reported; no usable permit answer (an error, a malformed one, none in
5 s) → failed, asked once; a 4xx → unknown; an error, a lost answer applied or not → unknown and never sent
again, also from another PC; the page after the send decides (the real page's rows: the new template's id in a row → succeeded, a row without its openModal → unknown); reports retried ≤ 3; the record's hint;
the type / checker / window checks after the claim; CSRF; the hour running out; one run per window),
`browser-read-session.test.ts` (the permit only after the write session is prepared; "not sent" only before
the request is ended), `browser-window-electron.test.ts` (the real window: the happy path through the
permit, a permit 5 s old by the last check sends nothing). Each guard mutation-checked.

## The plan model (`model/browser-plan/`: the lifecycle in TLA+, checked in CI)

The plan's life (register → approve → claim → permit → send → report → confirm) is also written as a
TLA+ model, `model/browser-plan/PlanLife.tla`, with rules R1–R7 (one send per plan; no send without
approval and a live permit; one open execution per target; failed only if not sent; a "not done"
confirmation stays true; no change twice; everything can settle). `model/browser-plan/check` explores
every reachable state with tla-ts (pinned by the folder's own npm lockfile, outside the pnpm
workspace) and also requires each `broken/` variant (one guard removed) to fail its named rule, so a
checker that passes everything fails the job. CI job "Model (browser plan)" (`ci.yml`, area `model`),
README in the folder.

- **A PR that changes the plan lifecycle changes the model in the same PR**: the state transitions,
  the order of checks (gate, lock, re-read, the last check before sending), what a report may move,
  or the time contract (`BROWSER_PLAN_TIMES`, which clock decides). Better: change the model first and
  run `check`. A PR that touches a cited file (area `model`) without touching the model says in its
  body why the model is unaffected.
- A changed state count updates `expected.txt` with the reason in the PR; a new guard adds a `broken/`
  variant that removes it. **Weakening or removing a rule is the owner's call** (the rule set is
  compared with `expected.txt`; the independent review looks for it).
- **The model is copied by hand**: each action names the function (`server/src/services/browser-plans.ts`,
  `shared/core/browser-plans.ts`) or design section it copies, and `check-areas.mjs` keeps every cited
  file in area `model`, but nothing compares behaviour mechanically, so it can drift; regressions in
  the code stay the tests' job. The app side copies the runner of 6b-2c ("Executing a plan":
  `runner.ts`, `browser-runner.ts`, `read-session.ts`, each action naming its step; built and switched
  off, nothing in the app calls it yet); `AppPermitAnswerUnusable` is the `failed` before 5 s (an unusable
  permit answer, asking threw), and `broken/BrokenFailedOn4xx` also stands for "failed after an error once
  the request left" (the same transition in the model). Left out on purpose: more than
  one target / two plans / two PCs, real durations (5 s and 30 s are abstract units), the app's two
  clocks as separate values, a person confirming wrongly, the facts' fields (folded into
  before / after / other), a modified app, a site processing a send late, and liveness under fairness
  (R7 says a path to settled exists).
- **The server's clock jumping forward** is part of the real model (`ServerClockJumps`; 6b-2a, "The clock
  fix" above): the window counts on both clocks (`Past(p)`), and `broken/BrokenNoMonotonicWindow` (the
  wall clock alone, as 6a did) must fail R5. No hole is open (`holes/`, `proposals/` empty).
  `limits/LimitFrozenAfterCheck` is the accepted "Remaining limits" stretch between the app's last
  clock check and the request leaving (fails R2, kept so it does not change unnoticed).

## The operator and the preview (PR 6b-1: built, switched off; nothing in the app calls it)

Design memo §33 (third draft; owner decision 2026-11-21, final — not reopened by review): the operator
is the member's own **Claude Code with the Team login**; the company's managed settings and the settings
Anthropic's server pushes are trusted as the company's own; the most closed start and the init checks on
every start stay. 6b connects every path but ships **off**; 6c turns it on for the owner's PC.

- **The switch** (`client/shared/browser-ai.ts` `BROWSER_AI_BUILD_SWITCH = false`, handed in as
  `features/browser/ai-switch.ts` `buildAiSwitch`): the first line of the preview (`runBrowserPreview`)
  and of the runner (`run` → `refused: off`) — off = nothing asked, no page read, no CLI resolved or
  started, nothing sent. Clean-up paths (cancel, report, confirm, the waiting list, the card) never ask
  it. `browser-preview.test.ts` fails while it is anything but `false`.
- **The operator's start** (`electron/agents/claude-browser-operator.ts`, registry
  `capabilities.browserOperator` — Claude Code only —, `tasks.browserOperator`, `browserOperatorCli.min`
  2.1.316; `browserOperatorOf(id)`): per request the app's `claude` is resolved **once** to its real path
  (a regular, executable file; `cli-missing`), its `--version` at least the floor (`cli-too-old`;
  unreadable too), and that path is used for every step — never looked up on PATH again. Each step is a
  fresh `claude -p --model <tasks.browserOperator> --safe-mode --tools "" --permission-mode dontAsk
  --strict-mcp-config --setting-sources "" --disable-slash-commands --no-session-persistence --max-turns 1
  --output-format stream-json --verbose --system-prompt <BROWSER_OPERATOR_SYSTEM_PROMPT>`
  (`browserOperatorArgs`), started with `spawnVoiceProcess(cli, args, { cwd, env }, { inheritEnv: false })`
  in a new empty folder (removed afterwards), in a process group of its own (`detached`; the whole group is SIGKILLed when a step ends, so nothing the
  CLI started outlives it) with an environment **built from nothing**
  (`browserOperatorEnv`): PATH = the CLI's folder (and its `node`'s for a `#!…node` script) + /usr/bin:/bin,
  HOME / USER / LOGNAME, TMPDIR (another new folder), `LANG=en_US.UTF-8`,
  `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `DISABLE_AUTOUPDATER=1`,
  and `HTTPS_PROXY` / `NO_PROXY` (either case) / `NODE_EXTRA_CA_CERTS` only when set — never `CLAUDE_CONFIG_DIR` (its
  users cannot use it: remaining limit), another `CLAUDE_CODE_*`, `CLAUDE_AGENT_SDK_*`, `XDG_*`,
  `ANTHROPIC_*` or a key. The material goes as JSON on stdin; the SDK is not used (it cannot pass
  `--safe-mode`).
- **Checked on every start** (`operatorInitProblem`, `readOperatorMessage`; any failure SIGKILLs and ends
  the request): one `system`/`init` (none, a second one, or anything but another `system` message before
  it → `init-mismatch`) with `tools` and `mcp_servers` empty arrays, `slash_commands` / `skills` /
  `plugins` / `agents` empty or absent, `cwd` the app's folder, `permissionMode: dontAsk`, the model asked
  for (or it without `[1m]`); any `tool_use` / `server_tool_use` → `tool-asked`; a line over 2 MB, a stream
  over 4 MB or a line that is not JSON → `bad-answer`; an error result → `not-signed-in` (login words) or
  `bad-answer`; no answer in time → `timeout`. A managed hook's own system message is not a reason to
  stop (trusted). Memory is not in init: cut by `--safe-mode` and the variable, checked once on a real
  machine (§33 1-6). Failures are fixed words (`BROWSER_OPERATOR_FAILURES`) and one sentence
  (`browserOperatorFailureSentence`); the CLI's text is never shown or logged.
- **The step loop** (`electron/features/browser/preview.ts` `runBrowserPreview`, no Electron): the switch
  → the type (an operation that writes, every `explore` read with its handed-in reader, and previewable:
  `previewProblem` — a read without a `{name}` to start from, and every id field of the target and change
  taken out by some declared reader, else `not-previewable`) → the member's
  setting (`browserOperationsAllowed`) → the AI stop → the open window → the agent's operator → the CLI
  → up to **8 steps in 4 minutes** (each ≤ 90 s and ≤ what is left). Each answer is **exactly one JSON
  object** (`parseOperatorAnswer`, unknown keys refused): `{ do: read, read, values }` — a declared read
  with exactly its `{name}`s —, `{ do: candidate, target, change, explanation }` — exactly the type's
  fields, fitting it (`browserPlanProblem`) —, or `{ do: stop, why, question }`. **Every id must be one a
  reader took out of a page of this request under the same field name** (`seenValues`), else
  `bad-answer` and nothing is read. Context (`stillCurrent`, required; the signal; the stop; and **the
  window**: the one open when the request started — closed, or another one in its place, even on the same
  partition, is a changed context, and every read goes through that first window) is checked after the
  CLI's answer and after each read. The 4 minutes count from before the CLI's version check. The candidate comes back to the caller (registering it is 6b-2).
- **The read session** (`features/browser/read-session.ts`, the shell's `pageless` in
  `browser-window.ts`): main's reads — the preview's (`BrowserPreviewSurface.read`, controller
  `previewWindow`) and the runner's before / after a write (`run.request` GET) — go through the window's
  page-less **read session** `<partition>-read` (`browserReadPartition`), its writes through the write
  session as before; never through the page or the window's session. One request = one chunk on the
  session's **lane** (`createSessionLanes`, one table per app keyed by the partition's name, so a window
  closed and opened again waits for the old chunk): connections closed and storage cleared (awaited), its
  one request hook (the preview: `exactRead` — GET of exactly that address, the path and the whole query
  string compared byte for byte with what `explorePath` built (the parameters' order and spelling, no
  other or repeated parameter, nothing encoded otherwise), no body, no fragment, and only an address a
  declared read can have at all (`exploreAddressProblem`: a fixed path without `..` or `//`, plain
  `name=value` pairs; the window asks it too before reading; a paginated read's later pages are each
  such an address, `…&page=2` etc., built by main); the runner: the run's gate, and only while the session's window is still
  this window, in `ai` mode), the site's proxy rule, the window's cookies for exactly that address copied in → the
  request (no redirect followed, 5 MiB) → cleared again. A chunk asks again, when its turn comes, whether
  its own window is still the one open (it may have waited behind another's) and sends nothing otherwise. A caller that gives up only drops the answer:
  the chunk finishes its clean-up before the lane goes on, so an old clean-up never clears a newer
  read's login. The preview never touches the window (no `ai` mode, its page and the member's typing
  stay). `clearPartition` also clears both page-less sessions (through their lanes). Two connections
  with one login stay logged in on Lステップ (§34).
- **What the operator gets** (`operatorMaterial`): the request's hints and reason and every page read so
  far as **the readers' items only** — `field`, `value` (the reference) and the label / extras as outside
  text (`{ outside }`, `shared/core/outside-text.ts`) — plus the type's fields and its reads. No free page
  text, attribute, hidden input, meta, script, JSON or query ever reaches it.
- **Reading a page** (`features/browser/html.ts` with **parse5** 7.3.0 — the WHATWG parsing algorithm,
  already in the lockfile through jsdom; main process only — and `client/shared/browser-page.ts`): the
  page becomes a neutral tree and a reader sees only `BrowserPageView` (elements, their attributes,
  their visible text; types in `client/shared/browser-runner.ts`). Nothing inside `hidden`,
  `aria-hidden="true"`, `<template>`, `<noscript>`, `<script>`, `<style>`, `<meta>`, `<link>`, `<base>`,
  `<input type="hidden">`, comments or an inline `display:none` / `visibility:hidden` is seen — `<html>`
  and `<body>` included (a hidden root hides the whole page); an element whose id stands twice in the
  document (hidden copies counted) or with an attribute written twice (the parser's
  `duplicate-attribute`, mapped to its start tag) is never shown, nor anything in it, **whatever the
  query** (by id, tag or attribute), and the read is incomplete. `runExploreReader` keeps only the reader's
  declared `fields` with plain ids (`BROWSER_ID_VALUE_RE`), labels cleaned (`cleanLabel`: NFC, no control /
  bidirectional / zero-width characters, one line, 80) and declared `extra`s; anything else, more than
  300 items or a reader that throws → incomplete. A stylesheet elsewhere that hides something is not
  known (remaining limit: the person checks the card).
- **Reading a JSON answer** (`client/shared/browser-json.ts`; a site's lists its own pages read as JSON,
  design memo §35): a reader marked `answer: 'json'` (`BrowserJsonExploreReader`) gets the answer parsed
  strictly (`parseStrictJson`: standard JSON only, ≤ 2 000 000 characters, ≤ 32 levels, **a key written
  twice refuses the whole answer** — `JSON.parse` keeps the last copy —, objects without a prototype),
  never the text; one that does not parse is no items, incomplete. What it hands back is kept by the same
  rules as an HTML reader's (`keepReaderItems`: declared fields, plain ids, cleaned labels, 300 items per
  answer; a paginated read's merged list up to 500, `BROWSER_PAGED_ITEMS`, below).
  The preview picks the reader's kind by its mark (`preview.ts`).
- **Declared reads** (`explore` in the declaration, `shared/core/plugin-browser-declaration.ts`; `plugins.md`
  "Browser connectors"): ≤ 10 per connector, each `{ label, path, query?, reader, no_side_effects:
  reviewed }`; a path's segments are literals or one `{name}` each, no fragment, `..` or `//`
  (`checkUpstreamPath`); a read without the reviewed mark is refused. **A query string only when declared**
  (§33 decision 6; 2026-11-22, Lステップ 0.4.0): `query` is an ordered list of 1–5 `{ name, value }` —
  `name` a letter then letters, digits, `_` (so never `_method` / `_token`; also refused by name), none
  twice (in any case); `value` a fixed literal of unreserved characters (`[A-Za-z0-9_.~-]`, ≤ 64:
  nothing to encode) or exactly one `{name}` — free text, `%`, `+`, `&`, `=`, a space, text around a
  `{name}` or a number are refused. The `{name}`s of the path and the query together: ≤ 5, none twice.
  `explorePath` fills only plain ids for exactly those `{name}`s and builds `path?name=value&…` in the
  declared order; the operator never names an address or a parameter (a second `page` included).
  A site's reader is code in its connector folder (`lstepConnector().readers`).
- **Paginated reads** (design memo §38, owner 2026-11-22; Lステップ 0.5.0): a declared read may say
  `pages: { param, max }` — `param` a query name (`BROWSER_QUERY_NAME_RE`, not `_method`, not one of
  its `query` names in any case; it counts toward the 5 parameters), `max` an integer 1–10. **The app
  decides the page number, never the AI**: the operator asks for the read once with its ids (a `page`
  in its values is refused, nothing read); `explorePath(read, values, n)` appends `param=<n>` as the
  last parameter (page 1 when not given; only 1..max; a read without `pages` takes no page). Only a
  JSON reader may serve one (a paginated read whose reader is an HTML one: the type is refused,
  `connector`, before anything starts). A JSON reader reports `page: { current, last, total }`
  (`BrowserListPage`) and nothing about what to read next; `runJsonExploreReader` passes it on only as
  whole numbers that fit (`current`, `last` ≥ 1, `current` ≤ `last`, `total` ≥ 0), else drops it and
  the read is incomplete. `readPages` (`preview.ts`) reads page 1 (the operator's read), then — only
  when page 1 reports `last` ≤ `max` and `total` ≤ 500 (`BROWSER_PAGED_ITEMS`) — pages 2..last **in
  order**, each through `exactRead` byte for byte and within the request's 4 minutes: no later page
  starts after them, and one still waiting is cut off then (`timeout`; the request's stop and the
  deadline as one signal; a stop or a changed context ends the request with no further page read).
  **A list that cannot be read whole offers nothing** (design memo §38: it is not chosen from — not
  even the pages already read): page 1 not reporting where it stands, `last` > `max`, `total` or the
  merged items over 500, a later page failing (status, no answer), a page not reporting, a `current`
  other than the page asked, a `last` or `total` other than page 1's, an id (field + value) twice in
  the read — on one page or across pages —, or, every entry kept, a count other than `total`. Page 1
  failing is the read failing (`read-failed`), as before. Entries a reader leaves out (another folder, no
  name) make the merged list incomplete with the rest, as in any read. A read declared without `pages`
  whose reader reports a page is whole only as its only page (`current` 1, `last` 1), its items offered
  as before (0.4.0's shape: page 1, incomplete when longer). The operator gets one merged list for the
  read, its values as it asked them — no page, `last_page` or `total` anywhere. Size: a full list is
  ~150 KB of material (500 items, 80-character labels), so the 8 rounds' material can reach ~1 MB; it
  goes on the CLI's stdin, whose size nothing caps (the 2 / 4 MiB limits are the answer's) — a material
  too large for the model ends the step (`failed`), never a looser read.
- **Wired in 6b-2d** ("The card, the IPC and the request tool"): `wire.ts` runs the preview for the
  consultation AI's request and registers its candidate with the facts the checker reads; still switched off.
- **To check once on a real machine** (§33 1-6; a completion condition of 6b-1 not yet done — it needs
  the owner's Team login and seeding their own `~/.claude`): the member's own hooks, CLAUDE.md, memory,
  MCP, plugins and Skills seeded with marker words do nothing and do not show in init or the answer, and
  `ps eww` shows only the table's variables; record the CLI version, OS and result. Also whether the real
  CLI's init lists `slash_commands` empty under `--disable-slash-commands` and names the model as asked
  (else every start stops with `init-mismatch`: availability, never a looser start).

Tests: `client/tests/browser-operator.test.ts` (a fake `claude` through the real `/bin/sh` wrapper: the
exact arguments and the final child environment with secrets in the app's environment, a fresh folder
per step, the real path fixed for the request after the link moved, the floor / unreadable version /
missing / not executable, every init check, a second or missing init, a tool request, a long line, a
long stream, a non-JSON line, an error result, a time-out and a stop; a child the CLI started dies with
it; on the macOS list),
`browser-preview.test.ts` (the switch: nothing asked, read or started; the loop; what the material holds
and never holds; ids not taken out refused with nothing read; one JSON object; 8 steps and 4 minutes;
refusals before anything; a changed context; the window closed or replaced; the real Lステップ 0.6.1
connector previewable and walking a fake Lステップ — folders → reminders → the reminder page → template
folders → templates — to a candidate reading exactly the declared addresses, a template's body never
offered, 「未分類」 offered and a template there chosen; a folder not shown, 「未分類」 before the folder
list, a template only on the step or an extra parameter refused with nothing read), `browser-page.test.ts` (hidden parts, hidden
inputs / meta / link / base, a hidden root, repeated ids and attributes under any query, mended HTML, references never from text, the kept items, labels, Lステップ's
reader and 0.6.1's `explore` (paginated reads with JSON readers); strict JSON — a repeated key, too deep, too long, trailing text, keys
without a prototype —; the list readers: ids and names only, 「未分類」 a template folder (only the number 0; its
entries `group` null or 0; never a reminder folder; a positive folder's `group: null` entry left out), another folder or none,
the page report — whole numbers that fit, else dropped and incomplete —, no page fields, bad ids → incomplete;
the reminder's steps as JSON (0.6.1): this reminder's steps, no label, another reminder /
hidden / no `hid_at` / steps not a list → nothing, a step twice or naming another reminder → left out, incomplete;
a step's timing: the site's text for the step asked only, an empty / multi-line text or bad ids → nothing),
`browser-preview-pages.test.ts` (the real Lステップ 0.6.1 connector against a fake Lステップ of 1, 3, 10
and 11 pages, every read through the real session chunk and `exactRead`: exactly `…&page=1..N` in
order; 11 pages, over 500 items or a `total` over 500 on one page → nothing offered; a changed
`last_page` / `total`, a wrong `current_page`, an id twice across pages or within one, a failing page 2,
a count short of `total`, page 1 without a report → nothing offered; entries of another folder →
incomplete with the rest; a page from the operator refused with nothing read; a stop or a changed
context while a later page is read; time running out between pages, and a later page that never answers
cut off at the 4 minutes; a read without `pages` whole only as its only page; a paginated read with an
HTML reader refused), `browser-read-session.test.ts` (an aborted read's late clean-up never
clears a newer read's login, also across a reopened window; one request at a time per session; a failed
request still cleaned; a queued chunk whose window closed sends nothing; `exactRead`: an extra,
reordered, changed, percent-encoded, re-spelled or second parameter, and addresses no read can have),
`browser-runner.test.ts` (the window's session refuses a worker's read
of main's path in `ai`, the member's browsing passes in `human`; the runner off by default),
`browser-window-electron.test.ts` (the runs' reads and writes through the read and write sessions made
with the window; a preview read with the login leaves the member's typing and an empty session; a
declared read's query reaches the site exactly as built, an encoded one is never sent),
`server/tests/unit/plugin-browser-declaration.test.ts` (`explore`; a query: accepted shapes, every refusal, the built address, `exploreAddressProblem`; `pages`: accepted, every refusal, the page appended last only 1..max), `browser-plans.test.ts` (`pending`).
Each guard mutation-checked; kept on purpose (second layers no test can tell apart): `explorePath`'s own address check (the parser already admits only such parts) and the window's address check before a preview read (`exactRead` refuses the same address in the request hook).

## The facts a checker reads (6b-2b: built; nothing in the app calls it yet)

Design 6b-2 §2-3 (owner approved): the facts a plan is registered with — and compared with again right
before the permit — are read by main through the checker, never taken from the AI.

- **Pieces.** `BrowserChecker.facts` (`BrowserCheckerFacts`, types in `client/shared/browser-runner.ts`):
  `version` (the facts version it reads), `next(values, answers)` — which declared reads to make next,
  worked out again from the answers each time (`[]` = done) — and `read(values, answers)` → drafts
  `{ status, value?, complete?, from, rawMarkup? }` and an optional fixed `problem` word. The core's
  driver `readBrowserFacts` (`client/shared/browser-facts.ts`; 6b-2c calls it with the preview surface's
  `read`, `parseBrowserHtml` and the clock): every request must be an `explore` read of the declaration
  (`undeclared-read`), its address built by `explorePath` with exactly its `{name}`s and, for a paginated
  read, a page 1..max (`bad-address`; a page on a read without `pages` too); at most
  `BROWSER_FACT_READS` (50) reads (`too-many-reads`); a read already made is not made again; a checker of
  another facts version reads nothing (`facts-version`); `stop` ends it. Answers: HTML as its text and the
  core's page view (`createPageView` over the parsed tree), JSON parsed strictly (`parseStrictJson`),
  anything else (no answer, not 200, not parsed) `ok: false`. Each declared fact gets `readAt` (when its
  answer was read) and `source` (that answer's path, never the query); a fact from a failed answer is
  never known; a fact from a page whose view was not whole is `unknown` unless the checker marks it
  `rawMarkup` **and** it is one of `BROWSER_RAW_MARKUP_FACTS` (`account`, `step_parent`, `state`: read
  by its run-time `view` from the raw markup — the same reading the run compares the page with, so
  `before` is exactly what the run checks; any other fact so marked stays unknown); only declared
  facts are kept, a declared one without a draft is `unknown`. The result carries `browserFactsProblem`.
  Second layer kept on purpose: `exploreAddressProblem` on what `explorePath` built.
- **Lステップ 0.6.1** (`client/connectors/lstep/reminder-step-facts.ts`, in the checker's folder, so in its
  hash): only shapes seen with the owner's login (design memo §34–§36, §39); the rest is never guessed.
  `account` (`lm-account-id`), `step_parent` and `state` from the reminder page through the checker's own
  `view`; `templates` — every template on the step and the one to add — from `GET
  /api/templates?group=<folder>&page=<n>` entries `{ id, name, content_text, form_type, group }`, found
  by id folder by folder (`/api/template-groups` in order; pages in order while `current_page` is the page
  asked and below `last_page`, at most 10): **`form_type` 8 (a number) only = text** (§34; any other → no
  plan, `problem: template-not-text`), name ≤ 200 and body ≤ 5000 plain text, an entry only when every
  folder id it carries is the folder asked, an id found twice with different contents not found, 「未分類」
  (`id 0`) walked like the others since 0.6.1 (§40; its entries must carry folder ids `null` / `0` only);
  the walk stops once every id sought is found, so a copy of an id
  in a later folder is not seen (only the pages read are checked: ids are the site's record numbers, and
  a filter the site did not apply shows as entries of other folders, left out; walking every folder
  would make the 50-read cap likely); the step in the reminder (0.6.1, design memo §39) from `GET
  /api/episodes/<reminder>` (strict JSON, `reminder-schedule.ts`): the answer's `id` is the reminder,
  `hid_at` present and `null` (a hidden reminder → no timing), `steps` a list of objects in which the
  target step's `id` stands **exactly once** and that step's `episode_id` is the reminder (the captured
  step carries it: `episode_id: 1904672`); `names.reminder` is that answer's `name`, plain text ≤ 200
  (0.6.0 walked the reminder folders for it, which could stop at the read cap; a name is for showing
  only); `schedule.timing` and `names.step` (0.6.1, §40) are **the site's own display text**, `GET
  /api/episode-steps/<step>` → `{ episode_id, episode_group_id, episode_name, episode_step_id,
  step_timing_text }`: `step_timing_text` verbatim — trimmed, one plain line of 1–100 characters, never
  parsed or rebuilt — when `episode_step_id` is the step and `episode_id` the reminder, and only when the
  reminder's answer above holds the step; anything else is unknown (no plan). The step's own fields
  (`step_days`, `step_type`, `skip`, `initial`, `step_minutes`) play no part: the site's text replaces a
  table built from them (which could not tell 「前」 from 「後」). `names` is stamped from the reminder's
  answer. 0.6.0 read the timing from the page's text, which
  always failed on the real page (it repeats ids in every step's form, so the view is never whole): that
  reader is removed — the JSON is the one source. `shared_with` and `audience` **always unknown** (no
  reading exists: Lステップ has no reverse lookup of the 回 using a reminder — people join it from tags,
  forms, keywords, friend-add, reservations and actions —, owner decision 2026-11-22), both **optional**
  since 0.6.1: unknown makes a plan, the card shows the declaration's `shared` warning 「全部の回で共有の
  リマインダです。…」 always and the count as 「読み取れませんでした」; a value read is still held to its
  shape, and unknown → known at the re-read is a change. Nothing beyond the reminder page is read when the
  step is not there. So 0.6.1 **can** make a plan from the real site's shapes (any step whose timing
  text the site gives, text templates in any folder, a step with or without templates already — §41), behind the switch and the `pending` row. Safety it leans on (the owner:
  let plans be made where safety holds): `delivers: scheduled`, a template removable before the step's
  time (§39), the card's approval and the re-read before the permit.
- **Connector refusals reviewed** (0.6.1, owner: lean toward letting plans be made while safety holds):
  relaxed — `shared_with` optional, the reminder's name from the reminder's JSON (no folder walk), the
  timing as the site's own text (any step, §40), 「未分類」 walked (§40). Kept — text only (`form_type` 8: the card shows a text body only, no other
  kind's shape seen); body ≤ 5000 (LINE's text limit); the 50-read cap and 10 pages a folder (core /
  declaration bounds on time; raising them is a separate change); the walk stopping at the first folder
  holding every id.
- **To confirm at the owner's next login** (read-only window, as §34–§40): the value of
  `step_timing_text` beside the page's text for a 「当日」 and a 「N日前」 step (§40 recorded its shape
  only); what `skip` means (§40: `initial` is 「リマインダ開始時に配信を行う」; `skip`'s field is hidden);
  whether any read means
  exactly "people who will still receive this step" (`audience`; §40: the reminder list reads no counts);
  that `content_text` is a text template's whole body (§40: the longest, 1161 characters, has no 「…」 —
  likely whole) and `form_type` is a number with 8 = text; that
  `/api/episodes/<reminder>`'s `name` is the reminder's name as shown; that the real reminder page reads whole in the core's view (an id written
  twice anywhere makes the view-read facts unknown — §39: it does not, the page repeats form ids; only
  the timing was read through the view, and it is JSON since 0.6.1); the slots of a step with templates
  attached (§39: the test step now holds one). Before the step's time a template added to a step can be
  removed again (§39, the owner).
  Each answer that changes a reader is a new connector version (a new `pending` row).

Tests: `client/tests/browser-facts.test.ts` (the real connector against a fake Lステップ, made-up names:
exactly the declared reads in order, 「未分類」 walked like any folder, a later page only when page 1 says so;
every confirmed fact known with its source and time, `shared_with` / `audience` unknown and optional, so a plan (a read
`shared_with` still held to its shape); the reminder's name from its JSON (missing, a bidirectional mark, a number → no names);
the read-after's `expectedAfter`; a template in 「未分類」 (`group` null or 0) found, one there naming a folder
or none, a positive folder's `group: null` entry, a non-text one there; a non-text template (also `form_type: '8'`), one in
another folder, twice differently, with a control character, a failed or repeated-key folder answer, a
misnumbered page → no templates; the timing as the site's text verbatim (trimmed; empty, multi-line, a
control or bidirectional character, over 100, not text → unknown; another step's or reminder's answer, ids
missing or not plain, a failed or repeated-key answer → unknown; the reminder's answer: the step missing,
twice, naming another reminder, another reminder's answer, a hidden reminder, no `hid_at`, a step that is
not an object, `steps` not a list, failing → unknown; the step's own fields and the page's text play no part); a page with repeated ids (the real page's form ids)
keeps the account, state, timing and names; the real page's rows (§41 structure) read by their openModal ids
(none, one — a plan —, two), a row without one makes no state and nothing else is read; no account,
no step (nothing else read), a failed page;
the cap, undeclared reads, a page past `max`, a page on an unpaginated read, a bad id, another facts
version, a stop, a careless checker (a fact from a failed answer, an undeclared fact, the same read asked
again, `rawMarkup` on a fact outside the list); the re-read: the same site passes, a changed body / name / timing (the site's text; `schedule` alone too) / reminder name / state, a timing no longer readable, `shared_with` unknown → known, a
template gone, the count rising or unknown → known are refused, a fall is not). Each guard
mutation-checked; second layers kept on purpose: `exploreAddressProblem` after `explorePath`.

## The card, the IPC and the request tool (6b-2d: built, switched off)

Design 6b-2 §2–§4, decisions 1, 4–10 (owner approved). `features/browser/wire.ts` (`wireBrowserPlans`, no
Electron; called once from `main.ts` with the window controller, the policy store's stop, the session and
the bundled connectors) makes everything below. **The build's switch stays off** (`BROWSER_AI_BUILD_SWITCH`):
the request tool does not exist, a request makes nothing, ［任せる］ is refused at once (`off`) and the card
says 「この機能は、このアプリではまだ使えません」 — no site read, no operator started, no server call
(`browser-plans-app.test.ts` 「as it ships」). The card's reads, ［やめる］ and the confirm are clean-up
paths and never ask the switch.

- **The server client** (`plans-api.ts`, `createBrowserPlansHttp`): the runner's `BrowserPlansApi` plus
  register / get / open / confirm. The member's session for every company route; **the report carries
  the execution's secret alone, no session**; the secret goes only in `X-ACB-Browser-Execution`, never
  an address or a body. Ids are put in an address only in the server's own shapes (`bp_` / `bx_` + 32
  hex, a company id of `[A-Za-z0-9_-]`): anything else is refused before a request. 2xx with `data` →
  ok, 4xx → refused with the server's code, anything else (5xx, no connection, a time-out) → no answer.
  No call retries.
- **The context** (`context.ts`): one generation, advanced by sign-out, a sign-in, a failed policy
  refresh, a change of a company's browser setting (the same setting again does not) and quitting; a
  capture also reads the signed-in member and, for a request, the turn's signal. The runner's
  `context()` and the registration's reads use it.
- **This build's combination** (`combination.ts`): `shared/browser-connectors/carried.json`, written by
  `client/scripts/browser-connectors.ts` beside approved.json (the current folder's rows only; approved.json
  may list several checker hashes for one version) and held to the folders by
  `browser-connectors-approved.test.ts`. A row is used only when its declaration hash is the hash of the
  declaration text the app bundles, and only when it is the one row of that id and version.
- **Registration** (`register.ts`, `registerBrowserPlan`): the switch → this build's combination and
  checker (else `notAllowed`, nothing started) → the preview (6b-1) → the facts read by the checker
  through the window's page-less read session (6b-2b), the context **and the emergency stop**
  (`browserAiStopped`) checked before and after each read → any facts problem or the checker's own
  problem = no plan → the context and the stop once more → `POST /browser-plans` with the combination,
  the candidate's ids and the facts. **The operator's explanation** goes as `explanation` (≤ 2000, plain
  text): kept as it is, shown on the card under its own label 「AI の説明（サイトから読んだ情報ではありません）」,
  never a fact and never compared at the re-read (the server hashes the fixed content, explanation
  included, so the card shows exactly what was approved). The plan then waits for the member; nothing here
  approves, claims or sends.
- **The request tool** (`electron/browser-request/tools.ts`, `browser_request` on `acb_browser`,
  `mcp__acb_browser__browser_request`): offered only when `browserRequestForTurn` gives one — the wiring
  present and the switch on — and only to an agent with `capabilities.browserOperator` (Claude Code, in
  process, `alwaysLoad`, auto-allowed), never in an unattended step. **It stops with the turn**: its signal
  follows the request's (the member's stop) and, once the turn is tracked, the turn's own (`chatTurns`: an
  administrator's stop, a job ended, a window closed) — the preview, the facts' reads and the registration
  all end. Input: `site`, `operation`,
  `target_hints`, `change_hints` (names as the user said them), `reason`. **The AI gets the plan's number and
  fixed words only** (`BROWSER_REQUEST_WORDS`): never a fact, a hash, the page's text, the operator's
  question or a run's result (decision 7); it cannot approve, run, report or confirm (no such tool). Its
  category is `web` (the emergency stop's `web` kind stops it, as `browserAiStopped`). A plan made puts
  the card's reference in the reply (`data-browser-plan`, `BrowserPlanCardRef`, stored as `browserPlans`).
- **IPC** (`plans-ipc.ts`; main window's main frame only, `isMainFrameSender`; every argument checked at
  the entry before anything is asked): `browserPlans:list` (the inbox's rows, "The inbox's rows" below: **only
  while the switch is on** — off, or signed out, it answers empty and asks the server nothing; then
  `/browser-plans-open` and the first page of `/browser-executions-waiting` together, copied by
  `readBrowserInboxPlans` — only the signed-in member's own runs (an owner's / admin's waiting list holds
  everyone's), only `permitted` / `unknown`, only the fields a row shows, an item not of its shape left out —;
  either list unreachable → offline), `browserPlans:get` (the server's view — every field the card reads checked for its
  shape and copied alone, `readBrowserPlanView`; anything else of the answer stays in main — + `ready` +
  `stoppedHere` + `runningHere` + the site's host), `browserPlans:run { companyId, planId, contentHash }` — approve + claim + the run in one
  press on this PC (decision 5), nothing else ever reaches the runner (no fact, target or AI word), one run
  per plan at a time —, `browserPlans:cancel`, `browserPlans:confirm { executionId, done | not_done }`.
- **Whether ［任せる］ can be pressed** (`browserCardReadiness`, decision 4): the switch on, the plan a
  draft, the site listed by the member's current policy, the AI not stopped, the site's window open here,
  and the page (read through the window's page-less read session with the checker's declared reads)
  showing the plan's own account; else a plain reason on the card (no window → 「開いてログイン」). Only a
  hint for the button: the runner checks everything again after the press. **Showing a draft card
  therefore reads the site** — the checker's declared reads each time a draft card is shown (the 15 s
  re-read is for unsettled executions only, which make no site read) — only while the switch is on and the AI not stopped (owner OK,
  2026-11-22).
- **The card** (`client/src/features/browser-plans/`: `components/BrowserPlanCard.tsx` opened by
  `{ companyId, planId }` from anywhere — the chat's reply and the inbox's row —, `planStore.ts` +
  `hooks/useBrowserPlan.ts` (read whenever a card shows it again — cards shown together share one read —,
  no effect of its own; an unsettled execution — claimed, permitted, unknown — is read again every 15 s,
  so the server's time-outs and the confirm's opening show without a restart), `model.ts` the words,
  `api.ts` small ports. Decision (safe side, the IPC is main window only): in a consultation's own window
  the card shows only 「このカードは、アプリのメインの窓の相談で開いてください」. The copy is kept per
  signed-in member, through the server being out of reach only — a refusal or not-found drops it). Read from the server's fixed view only: what / where / to whom / when under 「サイトから読み取った
  情報」 — the account, the reminder and the step, the templates on the step and the one to add (name and
  body), 「届く時」 as the page shows it (never parsed) with 「この段の時刻をこれから迎える人に、その時刻に
  届きます。すでに過ぎた人には届きません。」 for `delivers: scheduled`, 「これから届く人数」 N人 or
  **「読み取れませんでした」 in amber, never 0** (decision 1), the 回 using it, the read time —, the
  declaration's shared note as a warning callout, then 「AI の説明（サイトから読んだ情報ではありません）」.
  Amber while awaiting approval. After a run: 「計画どおりの状態になっています。」 / 「送る前に止めました。この
  操作の送信は行っていません。」 / 「…送りませんでした。」 (with the reason while the press is fresh) /
  **「届いたか分かりません。」 with what to check in the site** (the reminder, the step, the template) and
  ［済んでいた］［されていなかった］ only from `confirmableAt` (before: 「HH:MM から…」); this PC's record
  as a hint only (decision 10). **No resend button anywhere** (decision 6): 「もう一度は送りません。もう一度
  やるときは、相談で頼み直してください。」. Never: 「安全です」, a hash, a token, the secret.
- **Remaining limits** (said): the readiness read is a hint (a logout between it and the press stops the
  run before the permit with `account-unknown`); `browser_request` is Claude Code only (Codex has no
  operator).
- **The inbox's rows** (`notifications.md` "The inbox"; `src/features/inbox/model.ts` `browserRows`,
  `hooks/useInboxBrowserPlans.ts`): AppShell hands the inbox slot the list port and the card
  (`browserPlans`) **only while `BROWSER_AI_BUILD_SWITCH` is on** — off there is no way to read and no
  row (composed by AppShell, so no feature-to-feature import). A draft → あなた待ち amber 「承認を待っています」
  ［承認する…］ (with the approvals); an `unknown` run the server says can be confirmed now (its `canConfirm`,
  never this PC's clock) → あなた待ち amber 「届いたか分かりません」 ［確かめる…］ (right after the stops); an approved
  plan not started, a `permitted` run and an `unknown` one not yet confirmable → 作業中. Every row only opens this
  card in `InboxCardDialog` (the type guard in `model.test.ts` refuses an action kind that approves, sends, runs
  or confirms). Settled = in neither list = gone (nothing stored; no できた・未確認, the server keeps no notice for
  plans). **Read** when the inbox mounts, when the panel opens, when a card in the inbox closes, **when a plan's
  state moves on any card** (`planStore` `subscribePlanStates`: ［任せる］ in the consultation's card, a cancel, a
  confirm, a settled result — not a card's first look or the same state read again), a second after the next
  `confirmableAt`, and **every 60 s while any plan or run is listed and 3 minutes after the last answer that listed one** (`PLANS_REREAD_MS`, `PLANS_GRACE_MS`: a run claimed on another PC is in neither list until its permit, which the server waits for at most 2 minutes; then no timer);
  offline keeps the rows shown, another failure clears them. Limits (said): a plan made in a consultation shows
  at the next of those reads (no push for plans); **only the waiting list's first page is read** (100, oldest
  claim first: an admin with more open runs of others may not see their own there; the open list's `more` is
  not told).

Tests: `client/tests/browser-plans-app.test.ts` (the switch off: no preview, read or server call — the inbox's list empty with no request —; the inbox's list: the member's own runs only, the row's fields only, a bad list refused, either list offline; a plan
registered with this build's combination and the checker's facts, the AI's words only as the explanation;
a required fact unread, the context moving, the emergency stop or the turn's stop during the reads or
right after the preview, no combination, the operator not finding it → nothing registered; the plan view
copied to the card only in its shape; the tool's fixed words and no operator question; the secret only in its header and
the report without a session; ids outside the server's shapes never sent; 4xx / 5xx / thrown; the IPC from
another window or with bad arguments asks nothing, ［任せる］ hands exactly company, plan and hash, one run
per plan; readiness by switch, state, site, stop, window and account; the context's generation; the
combination's checks; as it ships nothing reaches a site, the operator or the server and the turn gets no
tool; switched on, the tool hands the request the turn's company, consultation and signal),
`agent-stop.test.ts` (an administrator's stop of the turn reaches the request's signal), `src/features/browser-plans/model.test.ts` (an unread count never 0; awaiting only for a draft; a
result nobody knows says what to check, no resend, confirm only after its time; plain reasons),
`client/tests/ui/browser-plan-card.spec.ts` (preview `browser-plan-card-ui.html`: the facts, the
timing sentence, 「読み取れませんでした」, the shared warning; ［任せる］ sends only the plan and the shown
hash; disabled with the reason and 「開いてログイン」; ［やめる］; unknown before and after its time, the
confirm opening by itself on a fake clock; the plain results; no jargon), `src/features/browser-plans/planStore.test.ts`
(a card shown again reads again, a failure recovers, two cards share one read; a copy survives only the server being out of reach; a state moving is told, a first look or the same state is not), `browser-runner.test.ts` (the one way in). Each guard mutation-checked; second
layer kept on purpose: the registration's context check before each read (the check after each answer
catches the same change).

## Not yet (later PRs)

**Keeping a login on disk** (`browserLoginStorage`, kept in `shared/core` for that PR): deferred until
it can be bound to "every AI turn on this PC is enclosed". Reviews of PR 4 found that a member's
`enforce` alone does not guarantee it: when the sandbox cannot start, `record-only` re-runs the turn
unenclosed (`agents/claude.ts`, `agents/codex.ts`); another company opened in the same app (the company
switcher) or a conversation with another agent (the API key's `executeCommand`, no sandbox) runs AI
turns against the same userData unenclosed; and a refused policy refresh (403) would keep the login.

The AI does not operate the window yet: the runner, the first type and the server's plans (6a,
above) exist but nothing starts a run. Still to come: **6b** — the operator AI and the preview's reads
are built (6b-1, "The operator and the preview", switched off) and the facts read for a plan (6b-2b,
"The facts a checker reads": the unconfirmed ones read as unknown until the owner's next login) and
the execution (6b-2c, "Executing a plan": claim → re-read → permit → send → report) and the registration,
the card, its IPC and the request tool (6b-2d, "The card, the IPC and the request tool"), all switched
off, and the inbox's rows (switched off too); **6c** — the switch on, on the owner's PC only;
`irreversible` types and more than one write (refused by the first version's rule today); **the method override and the swap** (design memo §24: a write may
declare `method: DELETE` / `PATCH` with `override: form_field`, sent as POST with `_method=<method>` in the
body; `matchDeclaredWrite` would then match the effective method and the declared `_method` pair, still
refusing `_method` from anything else and every override header; an effective DELETE needs `effect:
delete` and `irreversible: true`; then the swap is a declaration only — add then remove, `expect` add +
remove, target `{ reminder, step, hole }`, the checker confirming the hole is the step's and holds
`old`; a run cut between its two writes is partly done, never resent or rolled back), **checkers run
isolated and signed** and handed out with their declarations from the shelf (design memo §25: a
JavaScript engine without network, files or clock, limits on time and memory; only checkers div signed;
the package's `signature.yaml` verified first), landing routes, a
recording helper, JSON writes, types with more than one write, the shelf handing out browser connectors. WSS to the operated host stays refused (no type declares
one). Until the AI operates, the admin page says next to the mode choice what 「使う」 does today
(`BROWSER_NOT_YET_NOTE`); the PR that lets the AI operate removes that note (and its assertion in
`admin/tests/agent-browser.test.tsx`).

Tests: `server/tests/integration/agent-browser.test.ts` (owner/admin only, refusals of a
wildcard / duplicate / operated host as a parts host / unknown level, no row = off, an unchanged
save records nothing, a save reaches every member's policy with a new version, an override
changes only that member and only members can have one, a departed member's override neither
shows nor applies after they come back, the push announcement, an invalid stored row reads as
off), permission matrix + `CROSS` rows, `admin-contract.test.ts`, `admin/tests/agent-browser.test.tsx`
(linked from 「AI の安全」, member never loads it, words from the lib, invalid parts hosts / the
operated host / a duplicate site block saving, what a save sends, an override changes one
member), `admin/tests/advanced.test.ts` (「変えています」).
