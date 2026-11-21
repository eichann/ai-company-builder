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
(the connector's declaration + a reviewed checker, "The checker"); the AI's entry stays **closed**: nothing
in the app imports `features/browser/runner.ts` (no IPC channel, preload method, chat tool or agent;
`browser-runner.test.ts` 「nothing in the app can start a run yet」 checks the importers, the IPC
inventory and the agents / chat server / renderer). PR 6 adds the approval (the plan provider).

- **Pieces.** `client/shared/browser-runner.ts` (pure: the plan `parseBrowserRunPlan`, `createRunGate`,
  the checker interface `BrowserChecker`, `BrowserRunSurface`, the step record, `BROWSER_RUN_WORDS`);
  `client/shared/browser-checkers.ts` (`createBrowserCheckerRegistry` over the checkers it is **given**
  — an id not given is never run, two with one id refused — `createBrowserConnectors` over the
  declaration texts it is given, `parseBrowserDeclaration`); `client/electron/features/browser/runner.ts`
  (`createBrowserRunner`: the steps, no Electron), `run-records.ts` (the step record on disk); the
  window's `run` surface in `browser-window.ts`; `controller.ts` `siteNow` / `runWindow` (what the
  runner's deps will be). `shared/core/plugin-browser-declaration.ts` `expectedAfter` (the state after).
- **Site code lives outside the core** (owner decision 2026-11-21, design memo §24): `client/connectors/<site>/`
  holds a site's checkers and its bundled declaration (`client/connectors/lstep/`: `reminder-step.ts`,
  `declaration.ts`, `index.ts` `lstepConnector({ account })`). A connector folder imports only itself,
  the checker's **types** from `client/shared/browser-runner.ts` and the repository's `shared/core`;
  nothing in `client/electron`, `client/src` or `client/shared` but `electron/main.ts` imports a
  connector (`architecture-boundaries.test.ts` 「the browser core knows no site」; `client/tsconfig.json`
  includes `connectors`). It is a stand-in until checkers run isolated and signed, handed out with
  their declaration from the shelf (design memo §25): moving a site out is moving its folder.
- **A plan** (from an injected `approvedPlan(planId)`): `planId`, `companyId`, connector `{ id, version }`
  (exact), `operation`, `account` (the outside account's id as the checker reads it), `target`, `change`,
  `before` (the target's state the person saw: named lists of ids only), `approvedAt` (a plan approved
  more than a day ago never runs, whatever its expiry; one "approved" over a minute in the future is
  refused), `expiresAt` (never more than a day ahead). Its values must fit the type (`browserPlanProblem`).
  **Single use is only per PC here**: the step record lives on this computer, so the same plan could
  run once on each PC of the member. The server's plans (6a, "Plans, executions, permits and locks")
  make a plan single-use on the server (claimed once, a permit per send); 6b must hand the runner only
  a claimed plan and ask for the permit right before the write.
- **One run**, refusing with nothing sent at each check: the plan; the step record (a plan with any
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
  per window. Then `pending` is kept, the window enters `ai` mode with the run's gate (true only once
  DevTools Fetch sees the page), the checker's declared reads are made, and the run **stops before
  writing** for: an account that cannot be read (`account-unknown`) or is not the plan's
  (`account-mismatch`), a target that is not exactly one existing item, a state other than `before`,
  a missing CSRF field, a stop / setting change / expiry / closed window since (also checked by the
  gate per request). Then `sent` is kept (**before** the send; not kept = not sent), the one declared
  write is armed and sent, and the page is read again: the state `expectedAfter` gave = `succeeded`; **`failed` only
  when the site answered the write with a 4xx (419, 422…) and the page shows `before`**; everything
  else — another state, `before` after a 2xx / 3xx / 5xx (`unchanged-unrefused`), no slot before and
  none after (`empty-state`: the checker may not read the real page as we think), no answer, no
  re-read — is **`unknown` (結果が分からない), never sent again** by the runner. The window always goes
  back to `human`. Every reason is a word of `BROWSER_RUN_REASONS`; a checker's `problem` that is not
  one becomes `checker-problem` (a checker's or a site's text never reaches a record or a result).
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
  through the window's login, never through the page (`run.request`): the page's script cannot see,
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
- **The step record** (`run-records.ts`, `<file>` given by its user; nothing wires it yet): plan id,
  operation name, step, `pending` / `sent` / `succeeded` / `failed` / `unknown`, a fixed reason word,
  a time — never an account, a template, a token or any other value (refused). Kept two days (a plan
  lives at most one). A file that exists but cannot be read refuses every run.
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
- **Lステップ** (`client/connectors/lstep/`): the declaration `lstep@0.4.0` (`declaration.ts`, bundled
  until the shelf hands browser connectors out; parsed by the core's `parsePluginManifest` like any
  package) with one type, **「リマインダの段にテンプレートを足す」** (`reminder_step_add_template`): effect
  `write`, checker `lstep.reminder_step`, `lock: { kind: lstep.reminder_step }`, `delivers: none`
  (adding a template sends nothing by itself; the step goes out on the reminder's schedule), the facts
  of design memo §31.3 (`account`, `step_parent`, `names` required; `state`, `template_bodies`,
  `shared_with` required and complete), target `{ reminder, step }`, change `{ template }`, one write
  `POST /line/episode/step/pack/template` form `{ content_id: {step}, template_id: {template} }`,
  `ignore_body: [_token, _lm_user_id]`, `expect: [{ list: templates, add: "{template}" }]`, account
  required, the `shared` note (共有のリマインダ). Another operation on a step's templates is a new entry
  there, not new code. The checker `lstep.reminder_step` (`reminder-step.ts`, `confirms: [reminder,
  step]`) reads `GET /line/episode/show/<reminder>`, without its
  `<script>`, `<textarea>` and comments (`markupOnly`): `id="templateStep<step>"` must stand **exactly
  once as an attribute of a tag** (not a longer id, not another attribute); the step's box runs from
  there to the next `id="templateStep…"`; **every** `openModal(<reminder>, <step>, <hole>, <template>,
  <type>)` in the box must name this reminder and this step, and none of this step may stand outside
  the box (else no target). The state is the box's template ids (`templates`). Every id of the plan
  (each target and change field, so a later operation's extra id too) is a positive integer (never `0` / `-1`). `_token` / `_lm_user_id` are taken from
  hidden inputs of the markup (`_token` also `meta[name=csrf-token]`), one value each, plain token
  characters; none → `csrf-missing`, no write. (Whether the real page has its slots in `onclick`
  attributes, as captured, rather than in a script is not verified beyond the capture: if not, the
  state reads empty and the run stops with `before-changed` or ends `empty-state`, never `failed`.)
- **The account** (6b-1; confirmed on the real site with the owner's login, design memo §34): every page
  carries `<meta name="lm-account-id" content="<id>">`; the checker's default reader `accountFromMeta`
  takes it from real markup only — whole start tags, so a tag spelled inside an attribute value is not
  one, and nothing of scripts, text areas, comments, `<style>`, `<noscript>` or `<template>`: exactly one value, a positive
  integer, else none (missing, empty, two different values) — the run then stops with
  `account-unknown` before writing. `lstepConnector({ account })` still takes another reader (the
  real-Electron harness's test site).
- **The preview's reads** (0.3.0 the reminder page; 0.4.0 the lists, design memo §34–§36, each confirmed
  with the owner's login in a read-only window and `no_side_effects: reviewed` — our fixed GETs changed
  nothing; the pages' own background reads do not run since main reads without a page):
  `reminder_folders` `GET /api/episode-groups` (no query; the site's page sends an empty `?`, we send
  none) → `group`; `reminders` `GET /api/episodes?group={group}&page=1` → `reminder`; `reminder`
  `GET /line/episode/show/{reminder}` (reader `lstep.reminder_steps`: the steps, and the templates
  already on each step as `attached_template` — never `template`, so a candidate can never "add" one
  already there); `template_folders` `GET /api/template-groups` → `template_group`; `templates`
  `GET /api/templates?group={template_group}&page=1` → `template`. The four list readers
  (`list-readers.ts`, JSON) hand on ids and names only (never a template's body), and are whole only
  when the answer is the shape seen: a paginated list must say `current_page` 1 and `last_page` 1 (page
  1 only: a longer list reads as incomplete — the remaining limit), and every entry of a folder's list
  must name the asked folder (`group_id` and `group.id`, each one present equal to it, at least one;
  else left out, incomplete). 「未分類」 in the template folders is `id 0`: **not selectable** (decision,
  safe side: every id is a positive integer) — left out, the list incomplete. So 0.4.0 passes
  `previewProblem` (two id-free reads to start from; `reminder`, `step`, `template` each taken out by a
  reader) and the real connector walks a fake Lステップ to a candidate (`browser-preview.test.ts`); the
  preview stays switched off. Not declared: `/api/landings/<id>` (not this type's). `delivers` stays
  `none` and the facts stay version 1: what a step's time means for people already past it is not known
  (§34), so no `scheduled` type and no facts version 2 yet.

Tests: `client/tests/browser-runner.test.ts` (the gate: not armed, another step / template, an extra /
repeated / `_method` key, no body, a query, http / another host, an undeclared method, a second send,
a stop; declared reads only, the page's parts without a query; the window's outside rule and read
rule; the plan's shape, expiry, `approvedAt` and one-day limits; the checker's box (exactly one id
attribute, not in a comment / script / text area, slots of this reminder and step only, none outside)
/ ids / token and the account from `lm-account-id` (present, missing, two different values, not a
positive integer, only in a comment or script); the bundled declaration, its `expect`, an unknown checker and
two checkers with one id; the runner: judged by the type's `expect` (a removal of what was not there
never starts, `cannot-come-true`; nor one whose page would look the same, `no-visible-change`; a page
that ends otherwise is `other-state`);
success with exactly one write, never twice even after a lost answer, wrong / unknown account,
missing target, changed state, a target field neither written nor confirmed, a stop, a policy change,
an expiry and an old approval during the run, refusals before anything starts, nothing sent unless the
record was kept first, `failed` only after a 4xx and unchanged, `empty-state`, fixed reason words, one
run per window; the record on disk and fail-closed; the closed AI entry: no module outside
`features/browser` names the runner, only the controller has `runWindow`, only the runner enters ai
mode) and `client/tests/browser-window-electron.test.ts` with a
Lステップ-like site in `tests/browser-window-harness/sites.ts` (exactly one POST with the planned ids
and the page confirms it; while the run operates the page's fetch, XHR, timer autosave, tampered form
and undeclared read reach nothing; another LINE account and a stop during the run send nothing; a lost
answer reaches the site exactly once and the plan never runs again; an answer over 5 MiB is a failed
read; the write needs a cookie scoped to its own path and leaves nothing in its session, one write
session for every write; on the real window the armed write alone, once, another step / template /
extra key refused, undeclared reads refused for the runner and the page). Each guard mutation-checked;
kept on purpose: awaiting the write session's clear after the write (Chromium queues it before any later
read, so no test can tell; it is also cleared before each write) and `runWindow`'s policy check (the
controller already closes a window whose site leaves the policy).

## Plans, executions, permits and locks (PR 6a: the server side; nothing in the app calls it yet)

The server half of the plan and its approval (internal design memo §27–§31; §30 + §31 are the
contract). A plan is fixed on the server, approved by its member, claimed **once**, and every
send asks the server for a permit right before it; the server is the authority. Nothing in the
app calls these routes in 6a (6b wires the operator AI, the preview read, the card, claim → permit →
send → report; 6c turns it on for the owner's PC).

- **Pieces.** `shared/core/browser-plans.ts` (pure: the fact shape `BrowserFact` and its checks
  `browserFactShapeProblem` / `browserFactsProblem` / `browserFactsDeclarationProblem`, one schema per
  facts version and checker — `BROWSER_FACT_SCHEMAS`, version 1 = `lstep.reminder_step` —,
  `browserLockKey`, the states, `BROWSER_PLAN_TIMES`); the declaration's `lock` / `delivers` /
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
  build). Today: `lstep@0.2.0` and `lstep@0.3.0` (their old checker hashes) `retired`, `lstep@0.4.0` `pending`;
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
  `lock_key`, state, `claimed_at` / `permitted_at` / `settled_at`, `void_reason`, `confirmed_by`),
  `browser_execution_reports` (every report, append-only — no UPDATE, no DELETE while its company
  exists; deleting the company still cascades: result, a fixed reason word, `outcome` applied / same /
  recorded / conflict, the state before), `browser_target_locks` (company × key →
  execution), `browser_type_grants` (member × connector × operation × **declaration hash**: a
  changed declaration needs a new grant).
- **Routes** (`/api/companies/:companyId`, `companyMember` — a person's session; no record-token
  route exists): `POST /browser-plans` (candidate + facts → draft, 201), `GET /browser-plans/:planId`,
  `POST …/approve { contentHash }`, `POST …/cancel`, `POST …/claim` (answers `{ executionId, secret,
  plan }` once, `Cache-Control: no-store`), `POST /browser-executions/:executionId/send-permit`
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
  (`browserFirstVersionProblem`: `delivers: none`, not irreversible, exactly one write, not delete,
  a lock kind — `BROWSER_OPERATION_NOT_YET`), the member's browser setting (company mode with their
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
  version's one failure) / `unknown`, or `unknown` at permit + 5 s + 30 s without a report — a stop, a
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
  the execution `void` and lets its target go, in the same transaction), this execution holds its lock, `claimed → permitted` with the server's wall-clock time. Answer `{ permittedAt,
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
  (`BROWSER_TOO_EARLY`); `claimed` / `void` → `BROWSER_NOT_PERMITTED`; once only
  (`BROWSER_ALREADY_SETTLED`). After it a report never changes the result.
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
  one version exists).

Tests: `server/tests/unit/browser-plans.test.ts` (every row of both state tables, the time-outs on
touch, claim / permit / confirm once, the service's own compare-and-set losing to a row changed
between its read and its write (claim and permit), compare-and-set on stale state, a refused permit
voids the execution for good (stop, setting, grant, retired, app version), leaving with 520 claimed
executions, the waiting list's pages, the fixed columns and the reports' log, the lock: busy, released by a timed-out claim, only by its holder,
across members; reports: late, duplicate, contradicting, without a permit, after a confirm, a bad
secret; confirm timing, the clock behind, admins after leaving / 24 h; leaving; unknown, retired,
mismatching and too-old combinations; facts missing / unknown / incomplete / stale / contradicting;
grants), `server/tests/unit/browser-plan-rules.test.ts` (the declaration's new keys and refusals,
the first version's rule, each fact's shape, unknown / empty / 0, the lock key, the stop),
`server/tests/integration/browser-plans.test.ts` (over HTTP: grants owner/admin only, the secret once
and uncached and only in its header, the report without a session, the real member removal),
`client/tests/browser-connectors-approved.test.ts`, permission matrix rows + `CROSS`,
`company-scoped-sql.test.ts` (`HANDLE_TABLES`, the lookup), `jobs-schema.test.ts` (additive tables).
Each guard mutation-checked.

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
  `name=value` pairs; the window asks it too before reading); the runner: the run's gate, and only while the session's window is still
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
  rules as an HTML reader's (`keepReaderItems`: declared fields, plain ids, cleaned labels, 300 items).
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
- **Not done here** (6b-2 and later): no chat tool, IPC or wiring in `main.ts` (nothing in the app
  imports `preview.ts`), registering the plan, the facts read for it (the checker's `factPaths` /
  `facts`), the card, claim → permit → send → report.
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
refusals before anything; a changed context; the window closed or replaced; the real Lステップ 0.4.0
connector previewable and walking a fake Lステップ — folders → reminders → the reminder page → template
folders → templates — to a candidate reading exactly the declared addresses, a template's body and
「未分類」 never offered; a folder not shown, 「未分類」, a template only on the step or an extra parameter
refused with nothing read), `browser-page.test.ts` (hidden parts, hidden
inputs / meta / link / base, a hidden root, repeated ids and attributes under any query, mended HTML, references never from text, the kept items, labels, Lステップ's
reader and 0.4.0's `explore`; strict JSON — a repeated key, too deep, too long, trailing text, keys
without a prototype —; the list readers: ids and names only, 「未分類」 left out, another folder or none,
a second page, no page fields, bad ids → incomplete), `browser-read-session.test.ts` (an aborted read's late clean-up never
clears a newer read's login, also across a reopened window; one request at a time per session; a failed
request still cleaned; a queued chunk whose window closed sends nothing; `exactRead`: an extra,
reordered, changed, percent-encoded, re-spelled or second parameter, and addresses no read can have),
`browser-runner.test.ts` (the window's session refuses a worker's read
of main's path in `ai`, the member's browsing passes in `human`; the runner off by default),
`browser-window-electron.test.ts` (the runs' reads and writes through the read and write sessions made
with the window; a preview read with the login leaves the member's typing and an empty session; a
declared read's query reaches the site exactly as built, an encoded one is never sent),
`server/tests/unit/plugin-browser-declaration.test.ts` (`explore`; a query: accepted shapes, every refusal, the built address, `exploreAddressProblem`), `browser-plans.test.ts` (`pending`).
Each guard mutation-checked; kept on purpose (second layers no test can tell apart): `explorePath`'s own address check (the parser already admits only such parts) and the window's address check before a preview read (`exactRead` refuses the same address in the request hook).

## Not yet (later PRs)

**Keeping a login on disk** (`browserLoginStorage`, kept in `shared/core` for that PR): deferred until
it can be bound to "every AI turn on this PC is enclosed". Reviews of PR 4 found that a member's
`enforce` alone does not guarantee it: when the sandbox cannot start, `record-only` re-runs the turn
unenclosed (`agents/claude.ts`, `agents/codex.ts`); another company opened in the same app (the company
switcher) or a conversation with another agent (the API key's `executeCommand`, no sandbox) runs AI
turns against the same userData unenclosed; and a refused policy refresh (403) would keep the login.

The AI does not operate the window yet: the runner, the first type and the server's plans (6a,
above) exist but nothing starts a run. Still to come: **6b** — the operator AI and the preview's reads
are built (6b-1, "The operator and the preview", switched off); still the facts read for a plan (where `account`, `step_parent`,
`names`, `template_bodies` and `shared_with` are read on the real site is confirmed with the owner's
login), register / the approval card / claim → permit → send → report from main with the context
check and both clocks (design memo §30.1–2), the post-send judgement (§29.6) and `failed` only when
stopped before sending, and how the app knows its own checker hash; **6c** — the `browser_request`
tool for the chat AI, on the owner's PC only; `irreversible` types and more than one write (refused
by the first version's rule today); wiring the runner in `main.ts` (deps: `controller.siteNow`
/ `runWindow`, `browserAiStopped(policy.stop(companyId))`, `createBrowserRunRecords(<userData>/…)`,
`lstepConnector()`'s declaration and checkers through `createBrowserConnectors` /
`createBrowserCheckerRegistry`), **the method override and the swap** (design memo §24: a write may
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
