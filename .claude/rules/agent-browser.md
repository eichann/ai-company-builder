---
paths:
  - "shared/core/browser-operation.ts"
  - "shared/core/plugin-browser-declaration.ts"
  - "shared/core/browser-plans.ts"
  - "shared/core/browser-map.ts"
  - "shared/core/browser-read-line.ts"
  - "shared/core/browser-opened.ts"
  - "shared/core/browser-write-line.ts"
  - "server/tests/unit/browser-write-words.test.ts"
  - "client/connector-maps/**"
  - "client/browser-lines/**"
  - "client/scripts/browser-opened.ts"
  - "client/tests/browser-lstep-map.test.ts"
  - "client/tests/browser-step-template-line.test.ts"
  - "server/tests/unit/browser-read-words.test.ts"
  - "server/tests/fixtures/browser/**"
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
  - "client/tests/browser-asset-hosts.test.ts"
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
  - "client/tests/browser-read-line-runner.test.ts"
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
  and the exact hosts its pages load parts from (GET of scripts, styles, fonts, images only) —
  since plan B the reviewed declaration's, not the admin's ("Asset hosts"); every other request is
  refused. No `*.` wildcards.
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
  段階; add / remove; a duplicate site blocks saving; `BROWSER_PARTS_NOTE` says the parts and login
  hosts come from the site's reviewed declaration — the 画面の部品を取る先 field is the developer
  setting, shown only in a console built with `NEXT_PUBLIC_ACB_BROWSER_DEVELOPER=1`, "Asset hosts"; there
  invalid lines or the operated host as a parts host are shown and block saving), the login note (kept only for
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
  `navigationAllowed`, `windowNavigationAllowed`, `decideLoginHelper`, `frameSeenByPageGate`, `foreignFrameCount`, `browserProxyScript`, `browserResponseHeaders`, `decideAiWrite`, `decideAiRead`,
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
  changed site (its level; a development build's asset hosts) reaches the open window at once (`updateSite`: the rules and the proxy).
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
  subframe may be `about:blank` / `about:srcdoc`, and in `human` mode a declared login helper's frame:
  "Login helpers"), certificate errors refused (`callback(false)`, no
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
  current valid policy lists: on, level); the AI stop; the member's open window; one run
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
- **Lステップ** (`client/connectors/lstep/`): the declaration `lstep@0.6.3` (0.6.1 + its login helpers, "Login helpers", 0.6.2; + the web fonts among its asset hosts, "Asset hosts", 0.6.3; `declaration.ts`, bundled
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

## Login helpers (plan B's first step, 2026-11-23: a person's login needs a CAPTCHA)

Owner-approved plan B (「ブラウザ操作の始め方の改良案」 §5): Lステップ's login page shows Google's reCAPTCHA (a
frame `https://www.google.com/recaptcha/…`, its script from `https://www.gstatic.com/recaptcha/…`); the
window refused the frame (`frame-navigation`) and the login button stayed disabled. The window guards two
times differently: **while a person logs in** (`human` mode) a site's declared login helpers work; **while
the AI operates** (`ai` mode, a run's `enterAi` … `leaveAi`) they are shut. The AI never touches the window
(main reads and writes through page-less sessions), so a helper working for the person is no path for the AI.

- **The declaration owns them** (`browser.login_helpers`, `plugins.md` "Browser connectors"): ≤ 5
  `{ host, path_prefix, frame?, post? }` — an exact host (its very spelling, no `*.`), never the operated
  host or an asset host, once each; `path_prefix` whole plain segments starting and ending with `/`
  (never `/` alone, no `.` / `..`, `//`, `%`, `?`, `#`, ≤ 100); `frame` / `post` booleans, absent = false.
  Reviewed and versioned with the connector (a change is a new version and a new approved row); the admin
  types nothing, and no vendor name is in the core. Main hands the window the helpers of the bundled
  declaration of the site's host — approved and carried only, below — (`browserLoginHelpers`,
  `client/shared/browser-checkers.ts`: a host two declarations name gets none). Lステップ 0.6.2 / 0.6.3: `www.google.com` under `/recaptcha/` (frame, post) and
  `www.gstatic.com` under `/recaptcha/` (parts only). Tag manager, error / chat services the page also
  asks for are not needed to log in and stay refused (web fonts are asset hosts since 0.6.3, "Asset hosts").
- **The rule** (`decideLoginHelper`, reached from `decideWindowRequest` for every request on a helper's host
  that the site's rule refused, whatever its reason (only https, its default port, no user ever counts as a helper's host, so a scheme / port / user refusal is never re-decided), `client/shared/browser-operation.ts`): https on the default port, no user, the
  helper's exact host, the path (as the address parser gives it: dot segments resolved; any `%2f` / `%5c` /
  `%2e` refused) under the prefix; then only in `human` mode (`ai` → `ai-login-helper`), only from the
  window's page (not a service worker), GET / HEAD of script, stylesheet, image, font, media, XHR / fetch,
  other (a worker's script); a subframe only where `frame`; a POST only by XHR / fetch and only where
  `post`. Never a top-level navigation, a WebSocket, a beacon, a plug-in object. Out of the prefix the log
  says `login-helper-path` (so a missing path shows as such, host only).
- **A helper's host also listed as an asset host by the company's list** (since plan B only the developer
  setting, "Asset hosts"; seen on a real machine, 2026-11-23: the admin
  listed `www.google.com` as a parts host too, the asset rule refused the reCAPTCHA frame with `asset-use`
  before the helper rule was asked, and nobody could log in). Precedence: the site's rule first — what it
  allows (the asset rule's GET / HEAD of script, stylesheet, font, image, in and out of the prefix, in
  both modes) stays allowed —; whatever it refuses on that host is decided by the helper rule alone. So in
  `human` mode the helper's frame and declared POST work under its prefix; in `ai` mode the helper rule
  refuses everything (`ai-login-helper`), so `ai` mode gets exactly what the asset rule allows, never more.
  Frames: an asset host is never a frame of the site's rule, so the helper's frame rule above applies
  unchanged. The proxy: an asset host is DIRECT in both modes as before (`ai` mode's request rule still
  refuses what is not a part). The declaration itself still may not name one of its own asset hosts as a
  helper.
- **Frames** (`windowNavigationAllowed`, the window's `will-frame-navigate` / `will-redirect`): the site's
  rule, plus in `human` mode a subframe to a helper with `frame`, under its prefix.
- **The proxy** (`browserProxyScript(site, port, proxyHelperHosts(state))`): the helpers' hosts DIRECT in
  `human` mode only, for the window's own session only (never the read / write sessions). `setMode` (the
  window's) sets the mode first — the request rule and the frames' navigation shut the helpers before any
  await —, then re-routes the proxy for the mode and, entering `ai`, closes the session's open connections.
- **No frame the write gate does not see, while the AI operates** (independent review M1/L1; verified on
  Electron 45: a `<iframe sandbox="allow-scripts" srcdoc>` the page makes is opaque and in a process of its
  own). The gate's DevTools Fetch is attached to the page's own target only, so an out-of-process frame's
  requests pass it. A frame counts as seen only by **origin and process, never by its address**
  (`frameSeenByPageGate`: exactly `https://<operated host>` and the main frame's process; an empty document
  the site made inherits that; unknown = not seen). Two guards:
  - **the request rule** (`decideWindowRequest`, `ai` mode, the operated host): a request of a frame not seen
    — or whose frame is gone — is refused (`ai-other-frame`), reads included; only the main frame's own
    navigation is not asked. The shell reads the frame from the request (`details.frame`, `fromPageFrame`);
  - **the run** (`run.pageClean`, `foreignFrameCount` over every subframe): the runner's `abort()` asks it at
    every check — before entering `ai`, after it, the gate's `stopped`, before the permit and synchronously at
    the last check right before the request leaves. Not clean → `foreign-frames`: before the permit the plan
    is given back (nothing sent); at the last check the write is never ended (`failed`, reported
    `context-changed`). The card says 「サイトの窓に、ログインの確かめ（…）が残っていたので、送りませんでした。
    ログインを済ませた画面にしてから、相談で頼み直してください。」 (`BROWSER_RUN_REASONS`). A frame still
    loading at a check is caught by the request rule when its requests go out. A frame the window refused
    stays an empty document of the site and does not count (tested: the start page's two refused frames).
- **Helpers only from an approved, carried declaration** (review L2): main hands the window
  `bundledLoginHelpers` (`features/browser/wire.ts`) = `approvedBundledDeclarations`
  (`combination.ts`): a bundled declaration this build carries (`carried.json`, as for plans) whose one
  row in this build's `approved.json` (the server's source for plans) is `approved` with the same checker
  hash and exactly that declaration text. Pending, retired, another text or two rows: no helper (the login
  page then looks as before). A server-side retirement after the build shipped reaches it only with a new
  build (the server still refuses that combination's plans).
- **Remaining limits** (said): a helper's script runs with the login page's authority while the person
  logs in (GET-only loading would not make it harmless either; reviewed per helper, per path); SSO
  (Google / Microsoft account login) is not a helper — it needs its own reviewed flow (top-level
  navigation, return addresses) when a site needs it; a site that frames another origin on its pages after login can
  never be operated (availability, never a looser check).

Tests: `client/tests/browser-login-helpers.test.ts` (the rule as a table: every mode × resource kind ×
method × in / out of the prefix × from the page or not × frame / post flag; `ai` refuses every helper
request; exact host, https, default port, no user, the prefix literally — encoded `/`, `\`, `.` and dot
segments; the site's own rules unchanged; frame navigation; the proxy per mode; `frameSeenByPageGate` by
origin and process, `foreignFrameCount`; `ai-other-frame`; Lステップ 0.6.3's helpers; two declarations for
one host → none; helpers only from a carried and approved declaration — pending, retired, another text,
another checker, two rows, not carried → none), `server/tests/unit/plugin-browser-declaration.test.ts`
(`login_helpers` accepted and every refusal), `client/tests/browser-execute.test.ts` (a frame not seen
after entering `ai` → stopped before the permit, plan given back, window back to `human`; one appearing
while the permit is asked → `failed` at the last check, never sent, the server told), `src/features/browser-plans/model.test.ts`
(the card's words), `client/tests/browser-window-electron.test.ts` (a real window: on a login page with a
CAPTCHA-like frame the helper's script, frame, its part and its POST work, outside the prefix / a frame of
the parts helper / a beacon reach nothing; with the frame there the page is not clean, also in `ai` mode;
in `ai` mode a helper's script, POST and new frame reach nothing; back in `human` the frame loads again;
refused frames leave the page clean; a sandboxed `srcdoc` frame made by the page's script after entering
`ai` → the run stops before the permit, made while the permit is asked → `failed` at the last check, and
its own write and read to the site reach nothing, logged `ai-other-frame`). Each guard mutation-checked;
survivors kept on purpose: re-routing the proxy on a mode change (the request rule refuses every helper
request in `ai` mode first; the proxy only also stops a bare connection such as a preconnect). The table
also covers a helper's host listed as an asset host by the admin (every mode × kind × prefix × page: the
asset rule's parts in both modes, the helper rule for the rest, `ai` refused) — fails when the helper rule
is asked only for a `host` refusal, and when it is asked before the site's rule allows.

## Asset hosts (plan B's second step, 2026-11-23: the declaration decides, the admin types nothing)

Owner decision 2026-11-23 (「ブラウザ操作の始め方の改良案」 §6-2): the hosts a site's pages load parts
from (fonts, images, scripts, styles) and its login helpers are decided by **the site's reviewed
declaration only**. Before, the admin typed them (「画面の部品を取る先」) and every declared asset host had
to be among them (`browserOperationsAllowed`'s `asset-host-not-allowed`): the side that knows the site
least had to find them, and a wrong line widened the window for everyone (2026-11-23: `www.google.com`
typed there broke the login, #768).

- **The window's site** (`browserWindowSite(site, declared, developer)`, `client/shared/browser-operation.ts`,
  applied once by the controller to every site of a valid policy answer — so the window, its proxy, its
  read / write sessions and `siteNow` see the same site): `host` and `level` from the policy; `assetHosts`
  = the declaration's (`assetHostsOf`; main composes `bundledAssetHosts` = `browserAssetHosts` over
  `approvedBundledDeclarations`: a bundled declaration this build carries whose row is `approved` for that
  exact text and checker hash — pending, retired, another text: none; two declarations for one host:
  none), each exact (`normalizeBrowserHost`, its very spelling), never the operated host, once. A site
  with no such declaration loads from its operated host only (its pages may look incomplete: availability,
  never a looser window). The rules that use the asset hosts are unchanged (`decideBrowserRequest`: GET /
  HEAD of script, stylesheet, font, image, in both modes; never a frame, fetch, write or WebSocket; DIRECT
  in the proxy; the login helpers' precedence above).
- **The company's list is a developer setting** (kept, never deleted; data already stored keeps its
  shape): `BrowserSiteSetting.assetHosts` is still validated, stored, sent in the policy and saved back
  unchanged by the admin page. The app adds it to the declaration's only when **both** `!app.isPackaged`
  **and** `ACB_BROWSER_DEVELOPER_ASSET_HOSTS=1` (`developerAssetHostsOn`, composed in `main.ts` →
  `developerAssetHosts`): a released app never does, whatever is stored. The admin page shows the field
  only in a console built with `NEXT_PUBLIC_ACB_BROWSER_DEVELOPER=1` (`developerAssetHostsShown`; inlined at
  build time, the production image does not set it); otherwise it says where the hosts come from
  (`BROWSER_PARTS_NOTE`), shows a site's stored list read only (「画面の部品を取る先（前に書いたもの）」,
  `BROWSER_STORED_PARTS_NOTE`: unused by a current app, still read by an older one) with
  「前に書いたものを消す」, and a save sends the stored list back as it was unless cleared there. The server API still accepts the list from any owner / admin (no
  released app of this version honours it). **A released app from before plan B** still applies the stored
  list (and, with its own core, still requires the declared hosts to be listed) until it is updated.
- **The core** (`browserOperationsAllowed`): the setting on, the site listed, the level — no asset-host
  condition, in the app and in the server's plan gate alike (`missingAssetHosts` and
  `asset-host-not-allowed` are gone).
- **The declaration's `asset_hosts`** (`plugins.md` "Browser connectors"): ≤ 10
  (`BROWSER_DECLARATION_LIMITS.assetHosts`), exact hosts in their very spelling (no `*.`, IP, localhost,
  scheme, trailing dot), never the operated host, never a login helper's host, once each. Reviewed and
  versioned with the connector like everything in it. **Lステップ 0.6.3**: `d1nhtjid4lgi9y.cloudfront.net`,
  `profile.line-scdn.net` (images, scripts), `fonts.googleapis.com` (the icon fonts' stylesheet) and
  `fonts.gstatic.com` (the font files) — the real run (6c) showed the icons as words (`chevron_right`)
  without the fonts; googletagmanager, bugsnag, datadog and chatplus stay refused.
- **Remaining limits** (said): a declared parts host also receives what a stylesheet or image GET carries
  (its address, the cookies the browser holds for that host) in both modes — reviewed per host, as before
  with the admin's list; a site whose pages need a host its declaration does not list looks incomplete
  until a new declaration version is reviewed (the learning mode stays diagnosis only, §6-4).
- **Who may use a site** (plan B's 「使える人」): not in this step. The server's per-member type grant
  (`PUT /browser-type-grants/:userId`) has no admin page yet; a button for it waits for the PC
  registration (§33.3; "This PC's opt-in" weakness: a grant to a second member before it turns them on
  wherever they write the opt-in file).

Tests: `client/tests/browser-asset-hosts.test.ts` (the window's site: the declaration's hosts, the company's
list only for a development build, exact / not the operated host / once; only an unpackaged build with
the flag adds it (`developerAssetHostsOn`); the controller hands the window
and `siteNow` the declaration's hosts and ignores a changed stored list; Lステップ 0.6.3's fonts and images
load in both modes, as parts only, its trackers refused; hosts only from a carried and approved declaration —
pending, retired, another text → none), `browser-window.test.ts` (a development build's list reaches an open
window), `server/tests/unit/plugin-browser-declaration.test.ts` (a site listing none of the declared hosts
runs its types; `asset_hosts` exact and ≤ 10), `admin/tests/agent-browser.test.tsx` (no address field
without the developer console, a save keeps the stored list, the stored list shown read only and cleared
by 「前に書いたものを消す」; the field's checks in the developer console). Second layer kept on purpose:
`bundledAssetHosts`' wiring through `approvedBundledDeclarations` (tested through its parts, as
`bundledLoginHelpers`).
Each guard mutation-checked.

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
  edit approves it together with its `minAppVersion` = the first build that carries everything the
  combination needs. Today: `lstep@0.2.0` … `lstep@0.6.0` (their old checker hashes too) `retired`,
  `lstep@0.6.1` (facts version 2; the timing from JSON) **`approved`** (owner decision 2026-11-22, the
  owner the only user; 6c) with `minAppVersion` `0.0.1+0d2fe19.20261122105658` — the commit adding the
  operator's init fix on top of this PC's opt-in (the enable PR): builds order by commit date, so the
  merge's build and every later one pass; a main build made between that commit and the merge passes too
  but has no opt-in (its switch is the constant, off) and makes no plan; `lstep@0.6.2` (0.6.1 + the login
  helpers) **`approved`** with `minAppVersion` = the login helpers' code commit (its PR, 2026-11-23; kept
  `pending` if the owner says so) — 0.6.1 stays approved for the build already installed (nothing of it is
  less safe; a type grant is per declaration hash, so 0.6.2 needs its own grant); `lstep@0.6.3` (0.6.2 +
  the web fonts as asset hosts, "Asset hosts") **`approved`** with `minAppVersion` = the asset hosts' code
  commit (its PR, 2026-11-23) — 0.6.1 and 0.6.2 stay approved for builds already installed, and 0.6.3
  needs its own grant;
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
- **A second real model, `StepsLife.tla`** (the generalization's PR 1, below): the several-writes design,
  checked by the same `check` with its own rules R1'–R13 and `broken/BrokenSteps*` variants. `PlanLife.tla`
  stays the copy of today's one-write code; `StepsLife.tla` is ahead of the code and is what PR 4 / PR 5
  copy. `expected.txt` names both (`model`, `rule <model>`, `states <model>`).

## Executions with several writes (generalization PR 1: the state table and the model; PR 4 built the server's half)

Owner-approved design memo 「ブラウザ操作の汎用化」 (2026-11-24) §4, §5, §9, §15 (C11–C15), §15-2 (PR 1 =
"実行と書き込みの状態の表＋模型＋戻せる下限の決め。設計の PR（コードは模型だけ）"), §16-3, §18. **This
section is the contract** PR 4 (server: shape-2 plans, a permit and a report per write, the common lock
key) and PR 5 (app: the writes in order, finding what was created) implement; `model/browser-plan/StepsLife.tla`
is the same contract as a checked model (each action names its row here). PR 4 built the server's half ("Plans of
opened lines on the server": the tables, routes and `services/browser-line-steps.ts`, unreachable until a line can
write); before it, the memo put no code but the model in PR 1, and §18 keeps every irreversible shape (stored rows,
wire formats) changeable until a second site fits it — the table below is **provisional** until PR 4.
Today's one-write path (`lstep@0.6.x`, "Plans, executions, permits and locks") is unchanged and keeps
its own model (`PlanLife.tla`).

- **The line judge (I4, §4-1)**: before its last write a plan writes only to what this execution
  created (and confirmed its own, below); a change of what it created comes after the create; the
  object that existed before the plan is written by the last write only. Judged at approval of the line
  and when the server loads the list (`browserLineProblem`, read part and write part; PR 2 built the read part's check, `browserReadLineProblem`: "The read-side words"); a line that fails it is never loaded,
  approved or not. Model: `HarmlessPrefix` at `Claim`, `broken/BrokenStepsNoLineJudge` → R9.
- **Execution states** (shape 2): `claimed` (nothing permitted) → `running` (a write permitted at least
  once) → final `succeeded` (every write done) / `partial` (the first k done for sure, the rest surely
  not sent: `not_sent` or `skipped`) / `failed` (write 1 not sent: nothing changed) / `void` (claimed,
  never permitted) / `confirmed_done` · `confirmed_not_done` (the person's answer for the unknown write);
  and `unknown` — **not final, but never runs again**: the writes after the unknown one are `skipped` at
  once; it waits for the person's confirm or a late sure "done", and either ends it (R10).
- **Write states** (one row per execution × index): `pending` → `permitted` → `done` / `not_sent` /
  `unknown`; `unknown` → `done` (a late sure report) / `confirmed_done` / `confirmed_not_done`; `pending`
  → `skipped` (never tried: an earlier write stopped, the gate refused, the plan's limit). A write's
  state never moves backwards; `done`, `not_sent`, `skipped`, `confirmed_*` are final. A `void`
  execution's writes stay `pending` (none was ever permitted); `pending` in a final execution reads as
  "never tried", like `skipped`.
- **The rows** (every change a compare-and-set in one transaction; time-outs judged on every touch, as
  today):

  | Row (model action) | When | Then |
  |---|---|---|
  | claim (`Claim`) | plan approved, line judged, every lock key the line names free | execution `claimed`, all its locks taken, the secret once |
  | claimed → void (`VoidClaimed`) | cancel, 2 minutes, leaving | `void`, locks go |
  | permit write k (`ServerPermits`) | the holder's secret; `claimed` (k = 1) or `running`; write k `pending`; **write k−1 `done` (recorded)**; no write `permitted` / `unknown`; for k > 1 the plan's limit (from the first permit) not past; the gate | write k `permitted` with both clocks' readings; execution `running`; a permit is given once per write |
  | permit while k−1 still `permitted` (`ServerSaysNotYet`) | its report not in yet | "not yet", nothing changes; the app may ask again |
  | the app gives the rest back (`AppStopsBetween`) | a stop before asking write k's permit (the re-read differs, the window, the setting, the stop): cancel | `claimed` → `void`; `running` with nothing open and write k `pending` → `partial` (k on `skipped`), locks go; lost → the claim limit / the gap settle it |
  | the gate refuses (`ServerRefusesPermit`) | stop, setting, grant, retired line, app version | `claimed` → `void`; `running` with nothing open → `partial` (rest `skipped`); a write open → left to its report / time-out |
  | permitted and silent (`ServerSettlesUnknown`) | **that write's** permit + 5 s + 30 s on both clocks | write `unknown`, rest `skipped`, execution `unknown` |
  | the gap (`ServerEndsGap`) | `running`, nothing open, the next write `pending`, the plan's limit past (the app stopped between two writes, C12) | `partial`, rest `skipped`, locks go |
  | report for write k (`ServerGetsReport`) | the secret; the report **names its write index** (never "the current one") | `permitted` + done → `done` (a create also records what it created and takes its lock); last → `succeeded`. `permitted` + not sent → `not_sent`, rest `skipped`; k = 1 → `failed`, else `partial`. `permitted` + unknown → `unknown`, rest `skipped`, execution `unknown`. `unknown` + done → `done`, execution ends `succeeded` (last) or `partial` — **never `running` again**. Anything else: recorded only (`same` / `recorded` / `conflict`, append-only as today) |
  | confirm (`PersonConfirms`) | only the unknown write, only past **its own** window on both clocks; who may: as today | the write `confirmed_*`, execution `confirmed_*`, locks go; nothing more is sent |

- **Idempotent reports, late and duplicate** (C12): every report is kept with its write index; the same
  report again is `same`; a report for a write that was never permitted is `conflict` (409, kept); a
  report never moves another write (`broken/BrokenStepsReportToCurrentWrite` → R13).
- **What was created** (C1, C3): recorded only from a create write's `done` report, and the app reports
  `done` only when the new object is identified for sure — the site's answer id, the parent's list
  differing by exactly that id, its content as planned, its parent and account — **and** nothing else
  references it (a copy may share a child with its original). Anything less is `unknown` (the next
  write is never permitted). A later write on "what write k created" goes to the id the server
  recorded (the permit binds it; the app cannot name another). Model: `Identified`, R11;
  `BrokenStepsNoReferenceCheck`, `BrokenStepsPickNewest`.
- **Locks** (C11, C12): one key for one object on both paths — company, host, account, the object's
  kind and id, from the map (never the line's author), byte-equal to today's `browserLockKey` for the
  same object (PR 4 tests the two side by side). Taken at the claim for every existing object the line
  names and as a "create in this parent" reservation; a created object's key in the transaction that
  records it; **all held until the execution is final** (`unknown` keeps them). Model: R3,
  `BrokenStepsLockFreedAfterWrite`, `BrokenStepsOldPathOwnKey` — for the existing object's key only;
  the parent's reservation and the created object's key are not modelled (one folder, no second
  new-path plan): PR 4's server tests carry them.
- **Time**: each write has its own 5 s permit and its own 35 s window counted from **its** permit (the
  last time something could have been sent; a restart counts from the start as today) —
  `BrokenStepsWindowFromFirstPermit` → R5. The plan's limit (memo §4-2: about 2 minutes from the first
  permit) only stops later permits and ends a gap; it never shortens a write's window. It bounds how long
  a run may take (availability): no rule depends on it, so the model has no variant for it.
- **Partial is sure** (§16-3, R4 of the second Codex round): a `partial` execution holds no `unknown`
  write, so the card's 「していないこと」 lists only writes surely not sent (R12,
  `BrokenStepsGapEndsOpenWrite`).
- **Provisional storage for PR 4** (additive only, memo §8): a new table `browser_execution_steps`
  (company, execution, index, write kind, state, `permitted_at` / `permitted_mono_ms` / `permitted_boot`,
  `settled_at`, the created object's id and lock key — nullable —, `confirmed_by`; unique execution ×
  index; fixed columns by trigger as today) and a nullable write index on `browser_execution_reports`. A
  shape-1 execution has no step rows and is read as one write; no existing column changes. **As built in PR 4**: the
  new path has tables of its own (`browser_line_plans`, `browser_line_executions`, `browser_execution_steps`,
  `browser_line_reports` with the write index, `browser_line_locks`) and touches no column of the old path's: an old
  server never reads a shape-2 row, and the old path's claim checks the new lock table (one key, both paths).
- **Rolling back the server** (C13, decided here): today's server knows one write and one lock in its
  report, confirm, time-out and leaving paths, so it is **not** a safe place to roll back to once a
  shape-2 row exists. The first build that can write shape 2 is preceded by a **floor build** (a
  separate, earlier deploy: PR 4's first part) whose every plan entry — get, the lists, claim, permit,
  report, confirm, the time-outs, leaving — treats a shape it does not know as frozen (not listed, not
  claimed or permitted, a report kept and answered 409, locks it holds kept), with a cross-version test
  that leaves `partial` and `unknown` executions and rolls back (as jobs' 4b-0.5). Production is never
  rolled back below that floor (deployment rule, added with PR 4).
- **What the model proves** (`StepsLife.tla`, 28,320 states; site-neutral: an existing object E, a
  folder, what this execution created, a person's object in the same folder): over every interleaving of
  one three-write plan (create → change it → change E, and a second shape that breaks the line judge),
  an old-path one-write plan on the same E, lost / late / duplicate reports, lost answers, app crashes at
  any step, a person editing E or creating in the folder, and a create that re-uses a shared child —
  R1' each write reaches the site at most once; R2' only under a live permit for that write; R3 one open
  execution per object across both paths; R4' `not_sent` / `skipped` / `pending` never reached the
  site; R5' a "not done" confirmation stays true; R6 no change twice; R7 everything can settle; R8
  write k only after k−1 recorded done; R9 a stopped execution left E alone; R10 nothing permitted after
  `unknown`; R11 what is recorded as created is the execution's own, unshared object; R12 `partial` has
  no unknown write; R13 `done` means it landed. Each of the 15 `BrokenSteps*` variants removes one guard
  and fails its rule. **Left out** (assumptions checked elsewhere): whether a site's create shares a
  child and what creating sets off (the map's reviewed promise and a test object, C2); more than three
  writes, more objects, two new-path plans at once (the claim-once and one-lock rules are PlanLife's); the
  app's two clocks and a server clock jump (PlanLife's `ServerClockJumps`; both clocks per write are
  required here as there); the approval and the facts (PlanLife); the old path's inner life (folded into
  claim → write → end).

## The read-side words (generalization PR 2: the core's words; nothing calls them yet)

Design memo 「ブラウザ操作の汎用化」 §3-2, §3-5–§3-7, §15 C6 / C14, §15-2 (PR 2 = 「本体の言葉のうち読む側」), §16-1, §16-2,
§16-4, §17, §18. Two pure modules in `shared/core` that **know no site, thing or field**; nothing in the app or the
server imports them yet (PR 3 adds the first map and the check line beside the connector, PR 4 the server). Every shape
here is **provisional** until a second site fits it (§18): nothing is stored or sent in it yet. Today's one-write path
(`lstep@0.6.x`: `browserFirstVersionProblem`, `BROWSER_FACT_SCHEMAS`, `BROWSER_RAW_MARKUP_FACTS`, which name
Lステップ's facts) is untouched and stays the old path's guard; the new path uses the map's names instead.

- **The map's read side** (`browser-map.ts`): `BrowserMap` = `{ site, version, things }`; a thing has a Japanese
  `label`, `answer: 'json'` (read strictly; since PR 6 also `html`, "The write words and the first write line"), its
  `id` field, an optional `parent` (`{ thing, field }`), its `fields` (`BROWSER_FIELD_KINDS`, closed: `id`,
  `id_list`, `id_set` — any order, each as often —, `text`, `date` `YYYY-MM-DD` in the site's own day, `time`
  `HH:MM`, `number`, `flag`; `nullable`; a Japanese heading) and `keys`: every key path the answer may carry
  (`a`, `list[].b`) as `required` (the reader uses it; it stands in every object that should hold it), `optional` (the
  reader uses it; may be absent: list items that differ by kind) or `ignored` (読まない欄: never compared, reviewed one
  by one). `browserMapProblem` checks a map where it is loaded (each key's container listed, the id an `id` field, the
  parent in the map, limits `BROWSER_MAP_LIMITS`).
- **Strict read** (§3-2, owner decision §16-1; `readBrowserThing(map, thing, answer, reader)`): the core walks every
  key of the parsed answer at every depth; a key the map does not list, a `required` key missing from an object that
  should hold it, or a container of the wrong shape (an object where the map lists keys, a list of the listed depth
  where it lists items; null only for a key not `required`) ⇒ `not_read` (no plan; after approval nothing is sent).
  A key path never ends in `[]` (a list is named by its key). A key not of `BROWSER_ANSWER_KEY_RE` is always
  unknown (a key `"a.b"` or `"a[]"` would otherwise spell a nested path and pass for it) and is never named. Then the
  site's reader (code in its connector folder) turns the answer into the state, which must hold **exactly** the map's
  fields, each of its kind (`browserThingStateProblem`, on a copy taken once); a reader that throws or gives anything else ⇒ `not_read`
  (`unreadable`). Never a partial state. Too deep (8) or too many keys (2000) ⇒ `not_read`.
- **What is told** (§16-1 with Codex round 2 R1/R2): `BROWSER_SHAPE_WORDS.member` 「サイトの形が変わったので確認中です。
  今回は手でお願いします。」 (+ 「送っていません。」 after an approval) is all the member sees. The result's `notices`
  (`BrowserShapeNotice`: site, map version, thing — the map's own strings —, `unknown_keys` / `missing_keys` /
  `unreadable`, a count) are what may later go to the owner / admin; **no key name, value or page text**. A thing name
  the map does not have gives no notice. The key names stay in `diagnosis` (≤ 50 each), which never leaves the PC. The
  route that carries a notice (§16-1 `POST /browser-shape-notices`, limits, one per company × site × version × thing)
  is PR 4's ("Plans of opened lines on the server").
- **The read part of a line** (`browser-read-line.ts`, `BrowserReadLine` = `{ site, values, reads, checks }`, §17-2's
  line check `browserReadLineProblem(line, map)`): values with a kind (`id`, `text`, `date`), a role (`target` — an
  object's id —, `which` — what decides which / when, what a check compares against —, `write`) and the sources the line
  accepts; reads, in order, each a thing of the map by a `target` value or by an `id` field of an earlier read; checks
  from the closed list `BROWSER_CHECK_WORDS`, arguments names only (a read, a field of its thing, a value, a format of
  `BROWSER_DATE_FORMATS`): `unchanged_except(read, reference, except)` (same kind of thing, every field but the id and
  `except` equal), `source_unchanged(read)` (**after only**: refused in a line that writes nothing — a write line is a
  later PR; `sourceUnchanged` judges it), `no_sibling_named(read, field)` (a thing with a parent; a text field),
  `date_in_text(read, field, date, format)` (a text field; `date` a `which` date value), `datetime_on_date(read, field,
  date)` (a date field). Refused too: an unknown thing / field / word / argument, an id from a later read, from an
  earlier read's own id field (the same object again: a check would compare it with itself) or from a value that is not
  a `target`, a value nothing uses, sources the role does not allow. No expression, condition or calculation
  can be written (plugins.md §8-1); a new word is a change of the core.
- **Where a value comes from** (§16-4, owner decision Q14 §18; `BROWSER_ROLE_SOURCES`, the one copy):
  `which` ← `record_field` (a: a record field a business plugin bound — which record type and field is the plugin's,
  checked by the server later) or `person` (b: confirmed on the card, one value at a time); `target` ← `site_fact` (c);
  `write` ← any, the AI included. `browserLineValuesProblem(line, supplied)` asks the role's rule **and** the line's list
  (a line that wrongly lists the AI is still refused), the value's kind, nothing missing or extra; a `which` value from a
  record field the AI wrote last (Codex round 2 R5) or from a person not yet confirmed is `unconfirmed` (the card asks
  the person). Answers carry a fixed word and the line's value name, never the value.
- **Judging** (`evaluateBrowserReadLine(line, map, facts, phase)`): facts are what main read (each read's
  `readBrowserThing` result, the parents' lists for `no_sibling_named`, the values) — never the AI's word. A read counts
  only when read whole, a valid state of its thing **and the object asked for** (its id equal to the value or the earlier
  read's field); otherwise `not-read` / `wrong-object` makes no plan, **even when no check uses that read**. Each check is
  `ok` / `ng` / `unreadable` / `later`; **only `ok` is ✓**, and nothing turns `unreadable` into `ok`: a check whose read is
  not counted, a parent's list not read whole, not this parent's (an item of another parent), not holding the thing
  exactly once or holding an item that is not a valid state, are `unreadable`. `later` (an after word before the write)
  is never ✓ (C14). `problem` is null only when the values pass, every read counts and every check is `ok`.
  The values are copied once (plain data) and the copy is checked and used. `dateInText`: the date must stand in the
  chosen format (ASCII digits, a real day, no digit or separator right next to it: `12/3` not in `12/31`, `2026/12/3`,
  `112/3`), every real day in that format must be it, and **the whole text, NFKC-folded (full-width digits count), may
  name no other day in any date-like spelling** — `YYYYMMDD`, `YYYY-M-D` / `/` / `.`, `YYYY年M月D日`, `M/D`, `M月D日`
  (§15 C6 「部分一致しない」: `参加者_20261203_20261126`, `20261203（変更: 2026/12/04）`, `12/3 または １２/４` ✗); `M/D` has
  no year (the line chose it). `no_sibling_named` compares names by `siblingNameKey` (owner decision 2026-11-24: refuse
  more): NFC, full-width ASCII and the ideographic space folded to half-width (for this only), whitespace runs collapsed
  and trimmed, A–Z case-folded — a trailing space, a full-width variant or another ASCII case is the same name.
- **Not in this PR** (later, memo §15-2): the map's must-hold facts per thing (C5: account and parent binding, mandatory
  notes — PR 3, next section; content kinds and the verbs' facts come with the write verbs), value-shape words (§14-1),
  the opened list's file and hashes (PR 3), the notice route (PR 4) and the server's re-check of a bound record field (until then PR 4 refuses every
  record-field value),
  write verbs and predictions (built in generalization PR 6: "The write words and the first write line").

Tests: `server/tests/unit/browser-read-words.test.ts` with an **example map** (`server/tests/fixtures/browser/
example-map.ts`, shaped like stage 0's landing-route keys; not a reviewed map) — the map's refusals; strict read
(whole, optional / ignored keys, unknown keys at the top and in list items, a key spelled like a nested path counted and
never named, missing required keys at the top and in items, containers of the wrong shape and a null required one, readers that throw / add / drop / mistype a field, not an
object, too deep, a thing not in the map telling nothing, the notice holding no key name, the member's sentence); the
line's refusals; the sources (which from the AI or the site refused even when the line lists them, a record field the
AI wrote last and an unconfirmed person `unconfirmed`, a target from the AI, missing / extra / bad values); judging (all
✓, a read not whole — also one no check uses —, another object, a forged state, every word unreadable without its read,
values refused, a value read once, `unchanged_except` naming the differing fields with an id set in another order equal, the previous
round's tag, another day, a twin sibling (also by a trailing space, full width or case), every bad list, `source_unchanged`), `dateInText` as a table, and **§17-2:
the new core modules name no site, thing or field** — every approved connector's id, hosts, operations, checkers,
readers and reads with their labels (from `approved.json`, so a new site is covered by itself) and the example map's
things, thing labels, `_` field names and each part of its key paths must not appear in `browser-map.ts` / `browser-read-line.ts` (the old path's files are the named exception, §16-7 R8).
Each guard mutation-checked; kept on purpose: the depth check on lists (stack safety; every deep list also fails the
reader), `sourceUnchanged`'s status check (the state check after it catches the same), the date words' values check
(a values problem already makes every value-rooted read `wrong-object`), `dateInText`'s "every one in the format is
the date" (the whole-text scan catches the same) and the reader state's copy (a reader is reviewed site code).

## The first map and the inspection line (generalization PR 3: data, words and the card's shape; nothing calls them yet)

Design memo 「ブラウザ操作の汎用化」 §3-2, §3-5, §3-7, §7-3 (the inspection first), §15 C5 (must-hold facts, owner: in this
PR), §15-2 (PR 3), §16-4, §16-5 with Q15 (§18), §17. Read only: no line writes, nothing reads a site, no route, IPC or
screen uses any of it yet (the reading path, the server's list and the card on screen are later PRs). Every shape is
**provisional** until a second site fits it (§18). **The old path is untouched**: `client/connectors/lstep/` and
`lstep@0.6.3`'s approved declaration and checker hashes do not change (`browser-lstep-map.test.ts` holds the folder's hash
to the approved row and `carried.json`).

- **Where a site's map lives**: `client/connector-maps/<site>/` (`index.ts` exports `MAPS`; `map.ts` the map and
  `LSTEP_MAP_READS`, how each thing is read; `readers.ts` answer → state). **Not** in `client/connectors/<site>/`: that
  folder's fingerprint is the approved checker hash, so a map there would move it (memo §8, §15 C10). It imports only
  itself, `shared/core` and (since PR 6) its own site's connector folder, whose checker it reads a step with; only
  `electron/main.ts` may import it (`architecture-boundaries.test.ts`, like a connector;
  nothing does yet). Opened lines are data in `client/browser-lines/<site>.ts` (`LINES`, core types only).
- **The opened list** `shared/browser-connectors/opened.json` (beside approved.json, never touching it; written by
  `cd client && npx tsx scripts/browser-opened.ts`, `--check`; `browser-lstep-map.test.ts` fails when it differs):
  `{ format: 1, provisional: true, maps, lines }`. A map row holds the map itself (the server will read it from here,
  never from `client/`), `mapHash` (`sha256:` of its canonical JSON) and `readersHash` (the map folder's fingerprint,
  `folderHash`; since PR 6 together with the site's connector folder, `mapReadersHash` — rows already written keep theirs); a changed map **or reader** under the same version is refused (raise the map's version: the version
  names the mechanics a line was approved with). A line row: name, version, site, map version, `status`
  (`pending` → `approved` → `retired`, **written `pending`**, changed only by a reviewed edit, kept by the script),
  `meaningHash`, `mechanicsHash`, the line; a changed line under the same name, version and map version is refused.
  Rows the files no longer give are kept. Every stored row is checked against its own hashes on each run (Codex review:
  a map or line edited by hand with its hash strings left would otherwise pass as reviewed).
- **Two hashes** (`shared/core/browser-opened.ts`, §16-5 / Q15): `browserLineMeaning` — the line's values, reads,
  checks and shown fields with, copied from the map, each read thing's id field and its source, parent, fields' kinds and
  must-hold facts (a note's presence, not its words): the key of a member's grant (PR 4); `browserLineMechanics` — the
  map's version and hash, the readers' fingerprint, the line's words. Grants carry over a mechanics change only when a
  review calls it compatible (Q15): never automatic. The core gives canonical JSON; hashing is the caller's.
  `browserOpenedLineProblem` checks a line against its map (the read part's validator, a heading per read, shown fields
  the thing has).
- **Must-hold facts** (§15 C5; `BrowserMapThing.must_hold`, applied by `evaluateBrowserReadLine` to every read of the
  thing whatever the line says): `account` — the read counts only when the account (the site's marker, read right before
  and after the line's reads, `facts.account`) is known on both sides, the same, and the plan's (`expectedAccount`) when
  given — else `account-unknown` / `account-mismatch`; `parent` — every line read of it must name `parent` (a target
  value or an earlier read's id field; the validator refuses a line that does not) and the state's parent field must be
  it — else `wrong-parent` (a `parent` named for any thing is checked too); `note` — a sentence (≤ 200) the card shows
  whenever the line reads the thing. A map with an account-bound thing needs `account: { label }`.
- **Core additions** (provisional): `id_from: 'address'` (the answer has no id of its own: `readBrowserThing(…, address)`
  puts the address's id in the state, and a reader that gives one is not read); a read of **another** thing of the map by
  an earlier read's own id is allowed (a list's row of the same object; the same thing again is still refused) — and,
  since two reads may then name one object, each read's **origin** (a value, or an earlier read's field that is not its
  own id, passing through own ids) is tracked: two reads of one origin are never compared (`unchanged_except`,
  `changed_from`) and a parent is never taken from a read of the same object (independent review M1 / L3); the word
  `changed_from(read, reference, fields)` — ✓ only when every named field differs from the reference's (what a copy must
  change; ✗ names the fields still the same); the outcome's per-read `reads` status and `account`.
- **The generic card** (`shared/core/browser-card.ts`, `buildBrowserReadCard`): title, `state` (`all_ok` / `ng` /
  `not_read`), a headline (`BROWSER_CARD_WORDS`; a read not whole says `BROWSER_SHAPE_WORDS.member`), the account row,
  sections of rows — one value (a read) or before / after (a write, later) —, check rows ✓ / ✗ / 「読み取れませんでした」 /
  「書いたあとに確かめます」 (`BROWSER_CARD_MARK_WORDS`) with the ✗ fields' headings, and the must-hold notes. Built only
  from the map's and the line's words and what main read; **unreadable is never ✓**: a value only from a read that
  counted, a check ✓ only when the outcome says so **and** every read it names counted, `all_ok` only with no problem.
  No AI word, key or page text beyond the read fields' values: a supplied value (a check's base date) is shown only once
  the values passed and as a real day, else 「—」 (independent review L4); another object read says so
  (`wrongObject`).
- **For the reading path (PR 4 / 5)**: an `id_from: 'address'` thing is "the object asked for" only if main builds the
  address from the line's wanted id and passes that same string as `address` — never an id the AI supplies.
- **Lステップ map 1.0.0 → 1.0.1** (`client/connector-maps/lstep/map.ts`; stage 0 「段0の結果」 R3, R4, R8, R10, R11, key names
  only): `landing` (`GET /api/landings/{id}`, its id from the address; the R11 keys, `action_texts` and a variable's
  `name` not compared), `landing_row` (one entry of `GET /api/landings?group=&page=`, 50 a page: the friend-add and QR
  addresses), `action_set` (`GET /api/actions/{id}`, id from the address: `inputs` — 13 `tag_ids`, 12 `egg_id`, 15
  `episode_id` + `firetype`, any other type not read —, `a_name`, `a_twice_type`; `aid`, `funnel_descriptions`,
  `group_id` not compared). All three bound to the LINE account; `action_set`'s note says actions can be shared (R3).
  Stage 0 recorded the row's and the action's keys **in part**: an answer with more keys is not read whole and the card
  says so (availability) until a reviewed map version lists them — part of approving the line. **Map 1.0.1** (PR 4,
  owner decision 2 on #818): the full key sets confirmed read only with the owner's login (「段0の結果」 追記2, 0 writes):
  `landing` exactly 19 keys (`group_id` a number or null, `from_*` empty strings, `to_date` / `to_time` a value or an
  empty string, the place null, `custom_params` empty); `landing_row` exactly 17 (the unused ones and the folder object
  `group` {id, name, order} `ignored`; the list's envelope keys in `LSTEP_MAP_READS` for the reading code); `action_set`
  exactly 6 (`aid` equal to the number asked, still unused; `funnel_descriptions` an empty object); each input exactly
  its kind's keys plus `member_query_id` / `send_member_query_id`, which must be null (a condition on who receives it is
  never compared away); `egg_id` / `episode_id` are strings. The fields did not change, so the line's meaning hash is
  the same on 1.0.0 and 1.0.1 (only the mechanics moved). **Never `?copy=1`**:
  no read carries a query but the folder list's `group` / `page` (tested). No business word (a round's tag, its time, its
  source) is in the map or the lines (tested).
- **The first line** `landing_inspect` 「流入経路を点検する」 (`client/browser-lines/lstep.ts`; on map 1.0.1 **`approved`**,
  owner decision on #818 after the full-key confirmation — on 1.0.0 it stays `pending`): values `landing`
  and `source` (targets: what the site showed, §16-4); reads the route, its list row, its action, the source and the
  source's action; checks `unchanged_except(landing, source, [name, to_date, to_time, action_id])`,
  `changed_from(landing, source, [action_id])`, `changed_from(action_set, source_action_set, [tags])`,
  `unchanged_except(action_set, source_action_set, [name, tags])`; shows name and end of reception, URLs, tags /
  templates / cancels. Business checks (a date in the name or tag) are a business plugin's line once a `which` value's
  source can be supplied (§16-4, later).

Tests: `server/tests/unit/browser-inspection-core.test.ts` (the map's new refusals; the address's id — none, bad, a
reader's own refused; the account: unknown, one side, not an id, changed, not the expected, a thing not bound; the parent:
required by the validator, another parent, a reference in another folder, a parent named for a thing that need not hold
it, every bad parent shape; `changed_from` ✓ / ✗ / unreadable and its refusals; another thing by the same id; the opened
line's refusals; words and the note's wording move the mechanics only, and each meaning part moves the meaning; the card:
all ✓, a read not whole, a forged ✓ for a read that did not count, values of an uncounted read, ✗ with headings, the
account moving, the note always, 「なし」, another object's headline, a supplied value only once valid; one object reached
again through another thing or one value read twice never compared, a parent from the same object refused),
`browser-read-words.test.ts` (§17-2 over `browser-opened.ts` and
`browser-card.ts` too, with every opened map's and line's names from `opened.json`), `client/tests/browser-lstep-map.test.ts`
(the map's keys equal stage 0's lists; each thing read from made-up answers of those shapes; a key more or less, unseen
spellings, an unknown input type, another kind's key → not read; no query but `group` / `page`; the inspection end to
end: a good copy all ✓, the copy still on the source's action, the source's tags kept, a template / cancel / folder
changed, the account moving or unread, a row of another shape, a source action not whole; opened.json as written, a new
line `pending`, a reviewed status kept, a changed map or line under the same version refused, a stored row edited by
hand refused; the old path's hash),
`architecture-boundaries.test.ts` (the map folder and the lines import only what they may; only main.ts imports them).
Each guard mutation-checked; kept on purpose: the card's real-day check on a supplied value (the values check already
refuses a date value that is not one).

## Plans of opened lines on the server (generalization PR 4: built; nothing in the app calls it yet)

Design memo 「ブラウザ操作の汎用化」 §3-5, §8, §15 C11–C13, §15-2 (PR 4), §16-1, §16-4, §16-5 with Q14 / Q15 (§18), §17; the
owner's decisions on #813 (the state table lands here; a rollback floor before the first build that writes; a late
"done" for a write in doubt ends the execution; a void execution's writes stay `pending`) and #818. Every shape is
**provisional** until a second site fits it (§18). **The old path is unchanged** (`lstep@0.6.x`, "Plans, executions,
permits and locks": its tables, routes, gate and tests), except one added check: its claim is also busy when the new
path holds the same lock key (below).

- **Pieces.** `routes/browser-lines.ts` → `services/browser-lines.ts` (the opened list, the gate, inspections, grants,
  the strict read's notice) and `services/browser-line-steps.ts` (the write state table) → the handle's `browserLines`
  (`ports/browser-lines.ts`, `adapters/sqlite/browser-lines.ts`, tables in `db/schema/browser-lines.ts`), the control
  plane's `BrowserLineExecutionLookup` (a write execution's company by its secret's hash, listed in
  `company-scoped-sql.test.ts`), `fileBrowserOpenedList` (`adapters/browser-connector-catalog.ts`). API shapes:
  `shared/types/browser-lines.ts`; the states in `shared/core/browser-plans.ts` (`BrowserLinePlanState`,
  `BrowserLineExecutionState`, `BrowserWriteState`, `BrowserWriteResult`) and `browserObjectLockKey`.
- **The opened list on the server**: `shared/browser-connectors/opened.json` read once at start (`/app/shared` in the
  image; missing or not of the shape → no line). Every map re-hashed (`hashCanonical(canonicalJson(map))` = `mapHash`)
  and checked (`browserMapProblem`; a version listed more than once → every copy out); every line checked against its map
  (`browserOpenedLineProblem`, its own name / version / site) and **both hashes recomputed** (`browserLineMeaning` /
  `browserLineMechanics`) — a row that does not match is left out, logged, never trusted; a line listed twice under one
  version is left out. The site's operated host and name come from its one approved declaration in approved.json (two
  hosts → none: nothing allowed).
- **The gate = an exact line match** (create, approve, claim, every permit; in this order): an `approved` row whose
  site, name, version, map version, meaning hash and mechanics hash all equal the request's (`BROWSER_LINE_NOT_APPROVED`;
  `retired` → `BROWSER_LINE_RETIRED`); the member's setting (mode on, the site's host listed, its level allowing the
  line's effect — 「見るだけ」 for an inspection, 「入力・保存まで」 for writes — `BROWSER_NOT_ALLOWED`); the AI stop
  (`BROWSER_AI_STOPPED`); the member's **per-line grant** (`BROWSER_TYPE_NOT_GRANTED`). Results, reports, confirms and
  leaving never ask it (clean-up never stops). The PC registration (「担当者の PC で使う」) adds its check in this one
  function and an additive device column later; nothing here has to change shape for it.
- **Per-line grants** (§16-5, owner decision Q15): `browser_line_grants` = member × site × line × **meaning hash** ×
  the mechanics hash it was given on. `PUT /browser-line-grants/:userId { site, line, meaningHash, mechanicsHash,
  allowed }` (owner/admin): `true` only for an approved row exactly; **`false` takes away every grant of that person on
  that line** (any meaning or mechanics: a carried one too — nothing stays in force behind an untick). `GET
  /browser-line-grants` (owner/admin): the approved lines and **the grants in force**, one per approved row and person,
  each `from` `direct` (given on that row) or `carried` (which version of the line and map it was given on). A grant
  counts for a row with the same meaning hash and its own mechanics hash **or one its reviewed `grantsFrom` names**
  (`BrowserOpenedLineRow.grantsFrom`, written only by a reviewed edit that calls the mechanics change compatible, kept
  by the script; a `grantsFrom` naming no row of the same line and meaning leaves the row out). Never automatic. Given
  while a member this time (as the old path); leaving removes them. No admin page yet.
- **Where a value comes from** (§16-4, Q14): the core's `browserLineValuesProblem` (which / when only from a record
  field or a person's confirmation, a target only from the site, the AI only for `write`; a person's value not yet
  confirmed → `BROWSER_VALUE_UNCONFIRMED`, anything else → `BROWSER_VALUE_REFUSED` with the value's name and a fixed
  word, never the value) and, **until the server can re-read a business plugin's bound record field, no `record_field`
  value at all** (`BROWSER_VALUE_SOURCE_NOT_YET`, safe side). The values are copied into the fixed content.
- **An inspection** (a line that writes nothing): `POST /browser-line-plans { line, values, conversationId? }` → a plan
  `open` (shape 2, `bl_` + 32 hex, an hour from creation); the app reads the site (PR 5) and reports **once** `POST
  …/:planId/result { reads: { <read>: BrowserReadStatus }, checks: [ok | ng | unreadable] }` — fixed words only, every
  read of the line named, one word per check, a ✓ only when every read the check names (`read`, `reference`) is `ok`,
  never `later` (a read-only line has no after) — else `BROWSER_BAD_RESULT`; the server keeps it (`result`, canonical
  JSON, settable once by trigger) with `state` `all_ok` / `ng` / `not_read` and the plan is `done`. **No value the site
  showed is ever sent or kept.** A second result → `BROWSER_RESULT_DONE`; past the hour → closed `expired`; `cancel`
  closes it. `GET /browser-line-plans/:planId`: the member's own (anyone else's, another company's: the same 404).
- **No plan of writes in this build**: since PR 6 an opened line may hold writes (`step_template_add`, `pending`), but
  `writeGate` refuses every plan of writes at approve / claim / permit (`BROWSER_LINE_WRITES_NOT_YET`) — also one a
  later build left in the database — and `create` refuses an inspection of a line that writes (it would pass the
  「見るだけ」 gate) with the same code. The routes and the state table exist so that **this build is the rollback floor**
  of the first build that writes (below, deployment.md).
- **The write state table** (`browser-line-steps.ts`, "Executions with several writes" row by row; tables
  `browser_line_executions`, **`browser_execution_steps`** — one row per write, a trigger allows exactly the table's
  moves (a write's state never moves backwards; its permit time and created id never change once set) —,
  `browser_line_reports` append-only with the write's index, `browser_line_locks`): claim once (every lock on **both**
  paths free, `bw_` id, the secret's sha256 only); a permit per write (`POST /browser-line-executions/:id/permit
  { index }` with the secret header: write k `pending`, k−1 `done`, nothing open, k = 1 only from `claimed`; k−1 still
  permitted → `BROWSER_LINE_NOT_YET`; after `unknown` → `BROWSER_LINE_AFTER_UNKNOWN`; the gate refusing → `claimed` →
  `void`, running with nothing open → `partial`; a change of "what write j created" is bound to the id the server
  recorded, `createdTarget`); a report per write (`POST /api/browser-line-executions/report { index, result: done |
  not_sent | unknown, reason?, createdId? }`, the secret alone; a `reason` is kept only when it is a word of
  `BROWSER_REPORT_REASONS`, else null — never a page's text in slug form: a create is `done` only with its `createdId`, which is
  recorded and its lock taken — a key someone holds ends the run `partial`; not_sent → write 1 `failed`, later
  `partial`; unknown → the rest `skipped`, the execution `unknown`, locks kept; **a late "done" for the unknown write ends
  the execution (`succeeded` when last, else `partial`), never `running` again**; a report for a write never permitted or
  contradicting → 409, kept; the same again `same`); confirm (`POST …/:id/confirm { index, result }`: only the unknown
  write, past its own permit + 5 s + 30 s on both clocks, never with the clock behind; who as the old path); time-outs on
  every touch (2 minutes without a permit → `void`, **the writes stay `pending`**; a write silent past its own window →
  `unknown`; running with nothing open past `BROWSER_LINE_TIMES.runLimit` (2 minutes from the first permit) →
  `partial`); the rest given back (cancel, leaving: `claimed` → `void`, running with nothing open → `partial`, a write open
  → `BROWSER_MAY_HAVE_SENT`). Every final state releases this execution's locks and makes the plan `done`.
- **One lock key on both paths** (C11): `browserObjectLockKey` = `browserLockKey` with kind `<site>.<thing>` and the
  object's id (and its parent's) as the fields — byte-equal to the old path's key for the same object (tested with
  `lstep.reminder_step`). The new path's claim is busy when either table holds a key; **the old path's claim is busy when
  `browser_line_locks` holds its key** (the one change to the old path; no such row can exist until a write line does).
- **The rollback floor** (C13, owner decision on #813): this build knows every row the first writing build leaves
  (executions running, unknown, partial; reports; locks) and serves them without that build's line: no permit (the
  gate), reports and confirms still settle them, locks held until final. A plan whose `shape` this build does not know
  (`BROWSER_LINE_PLAN_SHAPES` = [2]) is **frozen**: get, cancel, claim, permit, confirm → 409 `BROWSER_PLAN_FROZEN`; its
  report kept (`conflict`) and answered 409; its locks kept; leaving leaves it. deployment.md "Rolling back production"
  says never to roll back below this build once a writing build has run.
- **The strict read's notice** (§16-1 with Codex round 2 R1 / R2): `POST /browser-shape-notices { site, mapVersion,
  thing, change: unknown_keys | missing_keys | unreadable, count 1..2000 }` (exactly these keys: **no key name can be
  sent**) — a map an approved line uses and a thing it has (`BROWSER_BAD_NOTICE`), from a member whose setting allows the
  site and who holds a grant on one of its approved lines (`BROWSER_TYPE_NOT_GRANTED`), at most 20 a member and 200 a
  company per site and day (`BROWSER_NOTICE_LIMIT`, 429; `browser_shape_report_counts`; only an accepted report is
  counted, so a member past their own limit never uses up the company's). One row per company × site ×
  version × thing (`browser_shape_notices`: the latest count of each kind, reports, first / last), and only the first one
  tells every owner / admin (`browser_shape_changed`, recordless, key `browser_shape:<site>:<version>:<thing>`;
  notifications.md); its text is built when read from the stored names and counts (the site's declared name, the thing's
  label) — 「ブラウザ操作：「Lステップ」の「流入経路」の形が変わりました（知らない項目が2つ増えた）。メンバーには手で作業してもらっています。
  地図の確かめが要ります」 — and shown only while the reader is an owner / admin. `GET /browser-shape-notices` (owner/admin).
  A report is an unchecked diagnosis: it never stops, approves or changes anything. The admin page's 「サイトの形が変わりました」 is
  a later PR.
- **Shape headings** (memo §8's `X-ACB-Browser-Plan-Shapes`): not needed here — shape-2 plans live in their own tables
  and routes, which no released app calls; the old routes never list them.

Tests: `server/tests/unit/browser-lines.test.ts` (the real opened list and declaration: the approved line inspected, the
pending one refused even with a grant; each of the six fields; a row or map edited with its hashes left, retired, no
file; setting, stop, grant, a grant from before leaving; `grantsFrom` carrying, the grants in force with where they came
from, one untick taking a carried grant away, a bogus `grantsFrom`; grants owner/admin only, only approved rows, gone on
leaving; the values' sources — a target from the AI, a person unconfirmed / confirmed, a record field, the AI, the site,
missing / extra / bad —; the inspection's result once, its words, a ✓ whose read did not count, expiry, another member's
or company's, cancel, leaving, the triggers; a write plan never approved or claimed; the notice once per key to owners /
admins, no key name sendable, only a granted member, the daily limit; the state table: claim's locks on both paths, the
order of permits, `createdTarget`, not_sent, unknown and its late done, reports naming their write and conflicts, the
trigger, the gate refusing, every time-out with the window per write and both clocks, confirm, giving back; the lock key
side by side; the rollback floor — running / unknown rows served by a build without the line, a frozen shape —;
leaving), `browser-plans.test.ts` (the old claim busy on a new-path key; every old test unchanged), permission matrix
rows + `CROSS`, `company-scoped-sql.test.ts`, `jobs-schema.test.ts`, `client/tests/browser-lstep-map.test.ts` (map
1.0.1). Each guard mutation-checked (27 mutations, all caught).

## The read runner of an opened line (generalization PR 5a: built and tested; nothing calls it yet)

Design memo 「ブラウザ操作の汎用化」 §3, §9, §16-1 (strict read, the member's sentence, the notice), §17 (layers). The app's
side of a **read-only** opened line: `client/electron/features/browser/read-line-runner.ts` (`createBrowserReadRunner`, no
Electron, no site). Not wired: the server side is "Plans of opened lines on the server" above (PR 4); the HTTP client,
the chat and the card are PR 5b; no module imports it but its test (it names no runner, run window or `enterAi`, so the closed-entry test of "The
runner" is unchanged). The old path (`client/connectors/lstep/`, `runner.ts`) is untouched.

- **Input**: an opened line whose row is `approved` (anything else → `not-approved`), its map (`browserMapProblem`; the
  line `browserOpenedLineProblem` on it, same site), the map's readers, how each read thing is addressed
  (`BrowserThingAddress`, site data), the account marker (`{ path, read(html) }`, reviewed site code) and the values
  (`browserLineValuesProblem`, before anything is read). Ports: the switch (first line: off = nothing asked), the stop, the
  member's open window as main reads through it (`BrowserPreviewSurface`, controller `previewWindow`), the context, the
  reporter (`BrowserLineReporter`: `notice` = one `POST …/browser-shape-notices { site, mapVersion, thing, change, count }`
  per notice, `result` = `POST …/browser-line-plans/:planId/result { reads, checks }` once when the run was for a plan —
  `planId`, the server's `bl_` + 32 hex, else `input` —; both the member's session, given by 5b). Refusals are fixed words (`BROWSER_READ_RUN_REFUSALS`); what was read before a refusal is dropped.
- **Only GETs of the map's declared addresses**: every request goes through the surface's `read` — the window's page-less
  read session, the shell's `exactRead` (GET of exactly that address) — never the page, a write or `ai` mode. An `object`
  address is a fixed path with exactly one `{id}` segment filled with a plain id (`BROWSER_ID_VALUE_RE`); a `list_entry`
  address is a fixed path plus exactly `?<folder>=<id>&<page>=<n>` (the folder from the same object's earlier read, the
  page the app's). A description with a query, a fragment, `%` or another `{…}` is refused before anything is read
  (`browserThingAddressProblem`); so **never `?copy=1`** (tested), and every address also passes `exploreAddressProblem`.
  At most `BROWSER_READ_RUN_LIMITS` (30 reads, 60 s; a caller may only tighten them). One run per window (per runner:
  the composition root makes one).
- **The account** (must-hold, §15 C5): the marker page is read right before the line's reads and right after (status 200,
  the reader's plain id, else unknown); `evaluateBrowserReadLine` counts an account-bound read only when both agree (and
  equal `expectedAccount` when given). Which page carries the marker for the map path is the wiring's (5b) choice.
- **Strict read**: each answer parsed strictly (`parseStrictJson`) and read by `readBrowserThing` (address things get the
  address's id from main, never from the AI or the answer). A list entry: every page read in order (`current` the page
  asked, the same `last` / `total` as page 1, `last` ≤ `max`, `total` ≤ `max × perPage`, ≤ `perPage` items), the
  envelope's keys strictly against the description's list (and its link items' keys) — an unknown or missing key is a
  notice for the entry's thing —, the items adding up to `total`, the entry there **exactly once**; else not read.
- **What is told**: a request that fails (not 200, no answer) or an entry not found is **not** a shape change: not read,
  no notice. A strict-read failure gives `member` = `BROWSER_SHAPE_WORDS.member` and `notices` (one per thing × kind of
  change, rebuilt from exactly site / map version / thing / change / count — no key name, value or page text; the
  `diagnosis` key names are dropped). The result carries the outcome, `buildBrowserReadCard`'s card (unreadable is never
  ✓) and `report`, the server's result body: each read's `BrowserReadStatus` by name, each check `ok` / `ng` /
  `unreadable` in the line's order (`later` sent as unreadable) — fixed words, never a value. Notices and the result go to
  the reporter fire-and-forget (a failure or a throw changes nothing); a refused run sends no result (the plan closes at
  its hour). Nothing is logged; no answer is
  kept.
- **For 5b / later**: the list entry's folder source (`group` ← the route's `group_id`) is handed in as data (the envelope
  keys come from `LSTEP_MAP_READS` since map 1.0.1); it belongs with the map once the wiring reads it from there. `no_sibling_named` gets no
  siblings yet (its check stays 「読み取れませんでした」). **The host** is the caller's: the map has none, so 5b must take
  it from the reviewed declaration of `map.site` (as `approved.json`), never from the request — else a map's GETs could go
  to another site with its cookies (independent review). The card's values are site data: 5b decides where they may go.
- **Remaining limit**: the account marker is read before and after only, so a switch A → B → A in the middle is not seen
  (the rule's design for a read-only card); before a plan binds `expectedAccount`, re-read it between reads or check an
  account field of the object where the site has one.

Tests: `client/tests/browser-read-line-runner.test.ts` (a fake Lステップ from stage 0's key sets, answers made up and cut to
the keys the map lists, the list's envelope from `LSTEP_MAP_READS` (map 1.0.1): a good copy ✓ with exactly the line's reads in order and the marker before and after; the account
moving, unreadable, an error status or not the expected → nothing ✓; an unknown key — also one shaped like a customer's
data —, a missing key, a repeated JSON key, an unknown envelope or link key → the member's sentence and one notice per thing
× change with no key name, reported; a failed request → no notice, unreadable never ✓; only `read` used, no query but
`group` / `page`, descriptions with `?copy=1` / a fragment / `%` / another `{…}` refused with nothing read; values from the
AI or not plain refused first; the list entry on page 2, twice, missing, short of `total`, a moving `last`, too many pages
(only page 1 asked), no folder; refusals before anything (the switch asks nothing, not approved, another site, the stop,
no / closed window); a stop, a changed context, the switch off, a closed or replaced window mid-run → nothing more read;
one run per window; the read cap and the time limit, never loosened by the caller; the line is the opened list's
approved row on the map's version; the result sent in the server's words only — no value, every check unreadable when
the account moved —, none for a refused or card-only run, a plan id of another shape refused; a failing reporter;
nothing logged).
Each guard mutation-checked; kept on purpose: the address check
after building (the description check already refuses what it would), the notices' rebuild beyond the merge (the core's
notices hold only those fields) and `later` → unreadable in the result (a read-only line has no after word).

## The write words and the first write line (generalization PR 6: data and words; nothing writes with them yet)

Design memo 「ブラウザ操作の汎用化」 §3-3 (the verbs), §3-4 (one generic check), §4-1 (the harmless prefix, I4), §6 (today's
step-template operation as map + one line: "proof the model fits"), §15 C4 / C5 / C7 / C11, §16-2 (付け替え stays manual: a
step's templates go one hole at a time, stage 0 R15), §16-4, §17, §18. **Nothing writes**: the server still refuses every
plan of writes and every inspection of a line that writes (`BROWSER_LINE_WRITES_NOT_YET`); the app has no writing path for
lines; the new line is **`pending`** until the owner's test write (PR 7). Every shape is **provisional** (§18). **The old
path is unchanged** (`client/connectors/lstep/`, `lstep@0.6.3` and its approved declaration and checker hashes); old and
new take the same lock key for a step.

- **The write part** (`shared/core/browser-write-line.ts`; knows no site): `BrowserOpenedLine.writes?` =
  `[{ read, verb, field, value }]` (absent = an inspection; its meaning hash unchanged). `browserLineWritesProblem` (asked by
  `browserOpenedLineProblem`, so by the script and the server's loader): the verb in `BROWSER_WRITE_VERBS` (`add_child` only,
  §17-3; `remove_child` is not a word); the read's thing lists the verb and field in its `writes`; **only the last write may
  change what existed before** — no verb creates yet, so a line holds one write (§4-1, I4); the written object's id and its
  parent's are `{ value }` (the server takes the lock from the plan's values, C11); the added value is one the line reads by
  that value as the thing the map says goes in that field, bound to the account (C5: it exists in this account, it is a
  template and not any id, and the card shows it).
- **The map's write facts** (`browser-map.ts`, reviewed with the map, C7): a thing's `writes` (per verb, the fields a line may
  change and the account-bound thing whose id goes in each — `{ add_child: { templates: 'template' } }`; only an `id_set`,
  not nullable — where an id lands in an ordered list is not predictable), `delivers` (`none` /
  `scheduled`, `BROWSER_MAP_DELIVERS`; required with `writes`), and a written thing must hold `account` (and `parent` when it
  has one). A line can only narrow: it uses what the map lists or nothing.
- **html things** (`answer: 'html'`): a thing a site shows only in a page's markup (a step's templates). No `keys` (nothing to
  read strictly); its id always from the address; `readBrowserThing(map, thing, page, reader, id, parentId)` hands the page
  (≤ `htmlChars`, 5,000,000) and the ids main built the address from to the reviewed reader, which must fail closed; the state
  must hold exactly the map's fields, the id is the address's (a reader's own refused) and the parent field exactly the parent
  asked. Anything else is `unreadable` (no key name to tell). Lステップ's reader is the old checker's `view`, imported unchanged
  (memo §6, §16-7 R3: the same reading the old path approved); the map's `readersHash` covers that folder.
- **The prediction** (`predictBrowserWrites`, §3-4 step 2): every read's state before, with each write applied —
  `add_child` adds the value once more (each as often: adding is always visible) — and nothing else. **The judgement**
  (`judgeBrowserWrites`, I3): the reads before must have made a plan; the reads after are judged by
  `evaluateBrowserReadLine` (strict read, the objects asked for, every must-hold fact), both under **the plan's account**
  (a required argument); then every read after must equal the prediction field by field: `as_predicted`, else
  `not_as_predicted` (naming each read's differing fields) or `unreadable`. Never "done" from the site's answer.
  **Scope** (independent review): "nothing else changed" is about what the line reads — Lステップ's step reader returns
  the asked step's templates only, so a template also landing on another step is not seen (the old path's checker reads
  the same one step; reading every step of the page is an owner decision for PR 7).
- **The lock** (`browserLineWriteLocks`, C11): `browserObjectLockKey` with the written thing's id and parent fields from the
  plan's values — for `reminder_step` byte-equal to the old path's `browserLockKey` (`lstep.reminder_step`, target
  `{ reminder, step }`).
- **The meaning** (§16-5): a line's `writes`, and for each thing it writes that thing's `writes` and `delivers`, are part of
  its meaning (a member's grant); added only when present, so an inspection's meaning hash never moves (`landing_inspect`'s
  is the same on 1.0.1 and 1.0.2).
- **Lステップ map 1.0.2** (`client/connector-maps/lstep/`): adds `reminder` (`GET /api/episodes/{id}`: not hidden, every step
  naming it, none twice), `reminder_step` (html, `GET /line/episode/show/{reminder}`: `templates` as the old checker reads
  them; `writes: { add_child: { templates: template } }`, `delivers: scheduled`, account + parent held, the old declaration's `shared`
  sentence as its note), `step_timing` (`GET /api/episode-steps/{id}`: the site's text), `template_folder` (an entry of
  `GET /api/template-groups`, 「未分類」 `0`) and `template` (an entry of `GET /api/templates?group=&page=`: text only —
  `form_type` 8 —, 「未分類」's `group: null` read as folder `0`). Key names only from the old path's records (design memo
  §34–§36, §39–§41); **the full key sets are not confirmed** (the old readers are lenient), so strict read stops on a real
  answer with a key more until a read-only confirmation lists them (PR 7). `LSTEP_MAP_WRITES` is the old declaration's
  write word for word (mechanics). The template list's envelope is `null` (unconfirmed). `landing_inspect` gets a row on
  1.0.2, `pending` (the readers moved, its meaning did not: carrying its grants is the owner's "compatible" call, Q15); its
  approved row on 1.0.1 is unchanged. Until that call the read runner (PR 5a), handed the bundled map 1.0.2, refuses the
  inspection (`not-approved`): nothing calls it yet, but approving the 1.0.2 row (with `grantsFrom` the 1.0.1 row's
  mechanics hash) must come before PR 5b wires it. `browser-read-line-runner.test.ts` hands the runner the 1.0.2 row as
  approved and checks it has the 1.0.1 row's meaning.
- **The line** `step_template_add` 「リマインダの段にテンプレートを足す」 (`client/browser-lines/lstep.ts`, **`pending`**):
  values `reminder`, `step`, `template_folder`, `template` (all `target` ← `site_fact`, §16-4); reads the reminder, the step
  (parent: the reminder), its timing (parent: the reminder) and the template (parent: its folder); one write
  `add_child(step.templates, template)`; no check word (the old type had none, memo §6); shows the reminder's name, the
  step's templates, the timing, the template's name and body.
- **Not yet** (PR 7 and later): the html reader's own account (the page's `lm-account-id`, which the old checker read
  from the same page; the new path reads the marker before and after the reads instead); the reading code for html things and value-named folders (PR 5a reads JSON objects and list
  entries whose folder comes from an earlier read); the plan of writes on the server (matching the plan's writes to the
  line's, the locks from the values); the app's write (matching `LSTEP_MAP_WRITES`, the CSRF value); the card's before /
  after rows; reading the bodies of the templates already on the step (the old facts read them; a line's reads are fixed,
  so this needs a core word); the owner's test write on a test reminder.

Tests: `server/tests/unit/browser-write-words.test.ts` (an example map: the map's write facts and html things refused
shape by shape; an html read — the address's id, the parent asked, a reader's own id / another parent / an extra field /
a throw / not a page / too long refused —; a line's writes refused — a field or thing the map does not let, an unknown
verb, two writes, an object or parent not named by the plan, a value not read or read outside the account —; an
inspection's meaning unmoved by the map's writes, a line's writes and a written thing's reach moving it; the prediction and
the judgement), `client/tests/browser-step-template-line.test.ts` (map 1.0.2's new key lists and readers on made-up answers
of the recorded shapes, each refusal; the step's templates equal to the old checker's reading; the line `pending` with no
business word; the write the old declaration's; exactly one template added → `as_predicted`, anything else not; the account,
a read not whole, another reminder or folder → `unreadable` / `wrong-parent`; the shared note on the card; the lock key equal
to the old path's; the reader fingerprint covering the connector folder), `browser-lines.test.ts` (an approved, granted
write line is never made an inspection), `browser-read-words.test.ts` (§17-2 over `browser-write-line.ts`, with the lines'
value names), `architecture-boundaries.test.ts` (a map may import its own site's connector, never another's).
Each guard mutation-checked (33 mutations, after the independent review too; two redundant checks removed, their cases covered by the remaining ones).

## The operator and the preview (PR 6b-1: built, switched off; nothing in the app calls it)

Design memo §33 (third draft; owner decision 2026-11-21, final — not reopened by review): the operator
is the member's own **Claude Code with the Team login**; the company's managed settings and the settings
Anthropic's server pushes are trusted as the company's own; the most closed start and the init checks on
every start stay. 6b connects every path but ships **off**; 6c turns it on for the owner's PC.

- **The switch** (`client/shared/browser-ai.ts` `BROWSER_AI_BUILD_SWITCH = false`; main hands in
  `features/browser/ai-switch.ts` `createThisPcSwitch` = that constant or this PC's opt-in, "This PC's
  opt-in" below): the first line of the preview (`runBrowserPreview`)
  and of the runner (`run` → `refused: off`) — off = nothing asked, no page read, no CLI resolved or
  started, nothing sent. Clean-up paths (cancel, report, confirm, the waiting list, the card) never ask
  it. `browser-preview.test.ts` fails while the constant is anything but `false`.
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
  it → `init-mismatch`) with `tools` and `mcp_servers` empty arrays, `slash_commands` / `skills` empty
  or absent, `plugins` absent or only plugins built into the CLI binary (exactly `{ name, path:
  'builtin', source: '<name>@builtin' }`) and `agents` absent or only the CLI's own
  (`BROWSER_OPERATOR_BUILTIN_AGENTS`: `claude`, `Explore`, `general-purpose`, `Plan` — unusable, the
  operator has no tool to start one) — owner decision 2026-11-22 (what Anthropic ships is trusted, as the
  CLI itself; a member's or a marketplace's plugin and a member's own agent still stop the start), `cwd` the app's folder, `permissionMode: dontAsk`, the model asked
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
  **Seen 2026-11-22 (CLI 2.1.330, macOS, the owner's Mac, no markers)**: `tools`, `mcp_servers`,
  `slash_commands`, `skills` empty, the model named without `[1m]` — but `plugins` lists the four plugins
  built into the CLI (`{ name, path: 'builtin', source: '<name>@builtin' }`) and `agents` the CLI's own
  (`claude`, `Explore`, `general-purpose`, `Plan`), under every flag: today every start there stops with
  `init-mismatch` — hence the built-in plugins and agents accepted above (owner decision 2026-11-22).

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
  text the site gives, text templates in any folder, a step with or without templates already — §41), behind the switch (this PC's opt-in) and the `approved` row. Safety it leans on (the owner:
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
  capture also reads the signed-in member, for a request the turn's signal, and **the switch, asked again
  on every check** (this PC's opt-in removed mid-run = a changed context, up to the runner's last check
  before the request leaves). The runner's
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
  (`browserPlans`) whenever a company is open (composed by AppShell, so no feature-to-feature import);
  **main decides** — switched off on this PC, `browserPlans:list` answers empty and asks the server
  nothing, so there is no row (6c: the switch is per PC, which the renderer cannot know by itself). A draft → あなた待ち amber 「承認を待っています」
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

## This PC's opt-in (6c: on for the owner's PC only)

Owner decision 2026-11-22: the AI's browser operation is turned on **only on the owner's PC** for the
real-machine check (design memo §33 1-6) and the first real run; everyone else stays off, also members
running the very same build. Design memo §33.3 prescribes the server's PC registration for 6c; for one
PC whose person is the company's owner, this PR uses the smallest mechanism that keeps the build off for
everyone else, and leaves that registration as the condition before anyone else is turned on ("Not yet").

- **The build constant stays `false`** (`BROWSER_AI_BUILD_SWITCH`): no build is on for everyone. main
  composes `createThisPcSwitch({ file: <userData>/browser-ai-this-pc.json, server, userId })`
  (`features/browser/ai-switch.ts`) and hands it to `wireBrowserPlans` as the switch.
- **The opt-in** is a file the person writes **by hand** in the app's userData folder (never a company
  folder), exactly `{ "browserAi": "this-pc", "server": "<origin>", "userId": "<id>", "until": "<ISO
  time with zone>" }` (`browserAiOptInOn`, `client/shared/browser-ai.ts`, pure): on only while `server`
  is the app's server (origin compared), `userId` the signed-in member, and `until` in the future and at
  most 14 days ahead (`BROWSER_AI_OPT_IN_MAX_DAYS`: a forgotten opt-in ends by itself). Any other key,
  value or shape, more than 4 KB, a link (`O_NOFOLLOW`), a folder, a pipe (`O_NONBLOCK`, so main's thread
  never waits) or a file that cannot be read = off. No setting, IPC or screen writes it: nothing in the
  app can turn itself on.
- **Read on every ask** (no cache): removing the file, `until` passing, signing in as another member or
  to another server turns everything off at once — the request tool, the inbox's list, ［任せる］, the
  card's readiness — and, through the context (`context.ts` asks the switch on every check), **a run or a
  registration in progress**: the next check stops it (before the permit: the plan given back; at the
  last check before the request leaves: `failed`, never sent).
- **Everything else still decides** (unchanged): the company's setting 「使う」 with the site listed in the
  admin console and the member's override (`browserOperationsAllowed`, app and server), the AI stop,
  the member's **type grant** (`PUT /browser-type-grants/:userId`, owner / admin, per declaration hash —
  no admin page yet: the 6c notes give the call), the approved combination (`approved.json` `approved`
  with its `minAppVersion`; `lstep@0.6.1` approved in this PR, `lstep@0.6.2` since "Login helpers", `lstep@0.6.3` since "Asset hosts"), the card's approval
  and the re-read before the permit. Turning off: delete the file, or the company's setting 「使わない」 /
  the site removed (the context moves, the server's permit refuses), or the emergency stop.
- **Weakness (said)**: **the per-PC file is not access control — the server's type grant is.** The file
  is the person's own; an AI turn outside the sandbox (`record-only`, the API key's agent) could write it
  as it could read §33.3's device file. It only narrows where it is on; the grant and the person's
  approval on the card are the guards. So **granting a second member before §33.3's registration exists
  turns them on wherever they write the file** — do not grant anyone else until then.
- **The operator's init check, accepted as built in** (owner decision 2026-11-22, "Checked on every
  start"): built-in plugins are matched by **pattern** (`path: 'builtin'`, `source: '<name>@builtin'`), not
  pinned by name — a later CLI's new built-in plugin passes (consistent with "what Anthropic ships is
  trusted"); the agents are an **exact list** — a member's agent with one of those names cannot be told
  apart, but the operator's flags load no member agents and with `--tools ''` none can be started. `BROWSER_NOT_YET_NOTE` in the
  admin page stays (true for every PC but the owner's).

Tests: `client/tests/browser-ai-opt-in.test.ts` (an opt-in only for its server, member and until its end,
14 days at most, exactly its shape; the file read on every ask — removed = off at once, a link, a folder,
a pipe, an unworkable path = off; the same build without the opt-in — the company's setting on, the site
listed, an opt-in for another member — reaches no site, operator or server and offers no tool; with it on,
the tool exists and the inbox asks the server, and the opt-in removed while the approval is on its way
stops the run before the claim), `browser-plans-app.test.ts` (a capture reads false once the switch is
off), `browser-execute.test.ts` (the opt-in removed between the permit and the send, with the switch and
context composed as main does: the last check refuses, failed, nothing reaches the site). Each guard mutation-checked; second layer kept on purpose: the regular-file check after
`O_NOFOLLOW` / `O_NONBLOCK` (a folder or a pipe already fails to read).

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
off, and the inbox's rows (switched off too); **6c** — on for the owner's PC only through "This PC's
opt-in" (built, `lstep@0.6.3` approved: "Login helpers" lets the person log in, "Asset hosts" draws the page), and **the server's PC
registration** (design memo §33.3: server × company × member × PC, `X-ACB-Browser-Device`, enabled by an
owner / admin, checked at register / approve / claim / permit) before it is on for anyone else;
`irreversible` types and more than one write (refused by the first version's rule today); **the method override and the swap** (design memo §24: a write may
declare `method: DELETE` / `PATCH` with `override: form_field`, sent as POST with `_method=<method>` in the
body; `matchDeclaredWrite` would then match the effective method and the declared `_method` pair, still
refusing `_method` from anything else and every override header; an effective DELETE needs `effect:
delete` and `irreversible: true`; then the swap is a declaration only — add then remove, `expect` add +
remove, target `{ reminder, step, hole }`, the checker confirming the hole is the step's and holds
`old`; a run cut between its two writes is partly done, never resent or rolled back), **checkers run
isolated and signed** and handed out with their declarations from the shelf (design memo §25: a
JavaScript engine without network, files or clock, limits on time and memory; only checkers div signed;
the package's `signature.yaml` verified first), landing routes (the read-only inspection's map 1.0.1 and line exist, the line `approved`, and the server takes its
plans and results: "The first map and the inspection line", "Plans of opened lines on the server"; reading them in the
app and the card on screen are PR 5 / 6), a
recording helper, JSON writes, types with more than one write (their state table and model are in
"Executions with several writes"; the server's half is PR 4, unreachable until a line can write; the app's is PR 5), the shelf handing out browser connectors. WSS to the operated host stays refused (no type declares
one). Until the AI operates, the admin page says next to the mode choice what 「使う」 does today
(`BROWSER_NOT_YET_NOTE`); the PR that lets the AI operate removes that note (and its assertion in
`admin/tests/agent-browser.test.tsx`).

Tests: `server/tests/integration/agent-browser.test.ts` (owner/admin only, refusals of a
wildcard / duplicate / operated host as a parts host (the developer setting) / unknown level, no row = off, an unchanged
save records nothing, a save reaches every member's policy with a new version, an override
changes only that member and only members can have one, a departed member's override neither
shows nor applies after they come back, the push announcement, an invalid stored row reads as
off), permission matrix + `CROSS` rows, `admin-contract.test.ts`, `admin/tests/agent-browser.test.tsx`
(linked from 「AI の安全」, member never loads it, words from the lib, no parts field outside the developer
console and the stored list saved back, invalid parts hosts / the operated host (developer console) / a
duplicate site block saving, what a save sends, an override changes one
member), `admin/tests/advanced.test.ts` (「変えています」).
