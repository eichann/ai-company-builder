---
paths:
  - "shared/core/browser-operation.ts"
  - "shared/core/plugin-browser-declaration.ts"
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
  - "client/shared/browser-adapters/**"
  - "client/tests/browser-runner.test.ts"
  - "client/electron/browser-window.ts"
  - "client/electron/features/browser/**"
  - "client/tests/ui/browser-settings.spec.ts"
  - "client/src/features/settings/components/BrowserSection.tsx"
  - "client/src/features/settings/hooks/useBrowserSites.ts"
  - "client/tests/browser-window.test.ts"
  - "client/tests/browser-window-electron.test.ts"
  - "client/tests/browser-window-harness/**"
---

# Browser operation (「ブラウザ操作」): sites the chat AI may operate

The chat AI may operate web sites the company approved, in a browser window of the desktop app,
only through per-site operation types (later PRs), never by free clicking. Owner decisions
(2026-11-20, internal design memo §2, §13, §17, §18):

- **Admin-approved sites only.** Each site has one host the AI operates (writes go only there)
  and the exact hosts its pages load parts from (GET of scripts, styles, fonts, images only);
  every other request is refused. No `*.` wildcards.
- **Per-site operation types.** A site's level (見るだけ / 入力・保存まで / 削除も) caps what an
  operation type may do there (`levelAllows`; an effect it does not know is never allowed).
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
  write to the operated host before the gate is attached (or after it detached), refuses every write
  from outside the window's page (no `webContentsId` of the window: a service worker, which the page's
  Fetch does not see) and every read from there unless a run's gate says yes (`outside`, below), and
  refuses WSS to the operated host. A dedicated worker's write, and a keepalive fetch or
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
(a reviewed adapter in the app + the connector's declaration); the AI's entry stays **closed**: nothing
in the app imports `features/browser/runner.ts` (no IPC channel, preload method, chat tool or agent;
`browser-runner.test.ts` 「nothing in the app can start a run yet」 checks the importers, the IPC
inventory and the agents / chat server / renderer). PR 6 adds the approval (the plan provider).

- **Pieces.** `client/shared/browser-runner.ts` (pure: the plan `parseBrowserRunPlan`, `createRunGate`,
  the adapter interface, `BrowserRunSurface`, the step record, `BROWSER_RUN_WORDS`);
  `client/shared/browser-adapters/` (the registry by adapter id — an id not there is never run — and the
  bundled declarations); `client/electron/features/browser/runner.ts` (`createBrowserRunner`: the steps,
  no Electron), `run-records.ts` (the step record on disk); the window's `run` surface in
  `browser-window.ts`; `controller.ts` `siteNow` / `runWindow` (what the runner's deps will be).
- **A plan** (from an injected `approvedPlan(planId)`): `planId`, `companyId`, connector `{ id, version }`
  (exact), `operation`, `account` (the outside account's id as the adapter reads it), `target`, `change`,
  `before` (the target's state the person saw: named lists of ids only), `expiresAt` (never more than a
  day ahead). Its values must fit the type (`browserPlanProblem`).
- **One run**, refusing with nothing sent at each check: the plan; the step record (a plan with any
  record never runs again — also one cut off by a crash); the connector declaration at that version; the
  operation (this PR: one form write, not irreversible); the adapter (`adapter.id` must equal the
  declaration's); the company's setting now (`browserOperationsAllowed` against the site the member's
  current valid policy lists: on, asset hosts, level); the AI stop; the member's open window; one run
  per window. Then `pending` is kept, the window enters `ai` mode with the run's gate (true only once
  DevTools Fetch sees the page), the adapter's declared reads are made, and the run **stops before
  writing** for: an account that cannot be read (`account-unknown`) or is not the plan's
  (`account-mismatch`), a target that is not exactly one existing item, a state other than `before`,
  a missing CSRF field, a stop / setting change / expiry / closed window since (also checked by the
  gate per request). Then `sent` is kept (**before** the send; not kept = not sent), the one declared
  write is armed and sent, and the page is read again: the planned state = `succeeded`, `before` =
  `failed`, anything else, no answer or no re-read = **`unknown` (結果が分からない), never sent again** by
  the runner. The window always goes back to `human`.
- **The gate** (`createRunGate`, the one rule for every request of a run): the page's own writes are
  refused for the whole run (the window's write decider says no; a page's fetch / XHR / timer / form of
  the very same write included); the page's reads of the operated host pass only for its parts
  (`Script`, `Stylesheet`, `Image`, `Font`, any path) or a declared read path without a query
  (**read strictness, decision**: a navigation, XHR or fetch elsewhere on the operated host is refused
  during a run, so a site that changes things on a GET cannot be driven by the page meanwhile; a GET
  of a part with side effects is the remaining limit); requests from outside the page: a GET / HEAD
  only on a declared read path, no query, no body; a write only while armed, with a body the gate could
  read (undefined = an upload / blob: refused), no query, through `matchDeclaredWrite` (exact method,
  raw path, the plan's values, no other key but `ignore_body`, no repeated key or `_method`), in
  declared order, **at most once**; nothing while stopped. The runner sends the write from main
  through the window's login, never through the page (`run.request`): the page's script cannot see,
  change or answer it, and its hidden fields play no part (the body is built from the declaration,
  the plan and the CSRF value the adapter read in the server's HTML).
- **A write gets a connection of its own** (verified on Electron 45): Chromium **resends a request whose
  reused keep-alive connection dropped before the answer**, below the request hook — one lost answer
  reached the test site 12 times through the window's session. So each write goes through a fresh
  in-memory session (`acb-browser-write-<uuid>`: the window's cookies for the site copied in, the site's
  proxy rule, ONE request hook asking the same run gate, cleared and its connections closed right
  after); a first connection that drops is not resent. In the window's session, a write from outside
  the page is always refused. Redirects are not followed (`net.request`, `redirect: 'manual'`: a 3xx
  is an answer; `ses.fetch` with `manual` rejects instead, so it is not used).
- **The step record** (`run-records.ts`, `<file>` given by its user; nothing wires it yet): plan id,
  operation name, step, `pending` / `sent` / `succeeded` / `failed` / `unknown`, a fixed reason word,
  a time — never an account, a template, a token or any other value (refused). Kept two days (a plan
  lives at most one). A file that exists but cannot be read refuses every run.
- **The first type: 「リマインダの段にテンプレートを足す」** (`lstep.reminder_step_add_template`,
  `client/shared/browser-adapters/lstep.ts`). The declaration ships **with the app**
  (`BUNDLED_BROWSER_DECLARATIONS`, `lstep@0.1.0`, parsed by the core's `parsePluginManifest` like any
  package): the shelf still refuses browser connectors, and the adapter that reads for it is the app's
  anyway. Effect `write`, target `{ reminder, step }`, change `{ template }`, one write `POST
  /line/episode/step/pack/template` form `{ content_id: {step}, template_id: {template} }`, `ignore_body:
  [_token, _lm_user_id]`, account required, the `shared` note (共有のリマインダ). The adapter reads `GET
  /line/episode/show/<reminder>`: the step must be on that page (`templateStep<step>`, not a longer id),
  every `openModal(<reminder>, <step>, <hole>, <template>, <type>)` of the step under this reminder; the
  state is the step's template ids; after = one more of the planned template. Ids are positive
  integers (never `0` / `-1`). `_token` / `_lm_user_id` are taken from hidden inputs (`_token` also
  `meta[name=csrf-token]`), one value each, plain token characters; none → `csrf-missing`, no write.
- **The account binding is not confirmed on the real site.** Where Lステップ's page names the logged-in
  LINE account in a stable way was not verified; the adapter takes an injected reader
  (`createBrowserAdapterRegistry({ lstepAccount })`) and the app's default `UNCONFIRMED_ACCOUNT` reads
  nothing, so a real run always stops with `account-unknown` before writing until someone confirms
  the marker on the real page (test objects only) and sets the reader.

Tests: `client/tests/browser-runner.test.ts` (the gate: not armed, another step / template, an extra /
repeated / `_method` key, no body, a query, http / another host, an undeclared method, a second send,
a stop; declared reads only, the page's parts; the window's outside rule and read rule; the plan's
shape, expiry and one-day limit; the adapter's step / reminder / ids / token and the unconfirmed
account; the bundled declaration and an unknown adapter; the runner: success with exactly one write,
never twice even after a lost answer, wrong / unknown account, missing target, changed state, a stop,
a policy change and an expiry during the run, refusals before anything starts, nothing sent unless
the record was kept first, failed vs unknown after the send, one run per window; the record on disk
and fail-closed; the closed AI entry) and `client/tests/browser-window-electron.test.ts` with a
Lステップ-like site in `tests/browser-window-harness/sites.ts` (exactly one POST with the planned ids
and the page confirms it; while the run operates the page's fetch, XHR, timer autosave, tampered form
and undeclared read reach nothing; another LINE account and a stop during the run send nothing; a lost
answer reaches the site exactly once and the plan never runs again; on the real window the armed write
alone, once, another step / template / extra key refused, undeclared reads refused for the runner and
the page). Each guard mutation-checked.

## Not yet (later PRs)

**Keeping a login on disk** (`browserLoginStorage`, kept in `shared/core` for that PR): deferred until
it can be bound to "every AI turn on this PC is enclosed". Reviews of PR 4 found that a member's
`enforce` alone does not guarantee it: when the sandbox cannot start, `record-only` re-runs the turn
unenclosed (`agents/claude.ts`, `agents/codex.ts`); another company opened in the same app (the company
switcher) or a conversation with another agent (the API key's `executeCommand`, no sandbox) runs AI
turns against the same userData unenclosed; and a refused policy refresh (403) would keep the login.

The AI does not operate the window yet: the runner and the first type exist (above) but nothing
starts a run. Still to come: the plan and its approval (PR 6: the `approvedPlan` provider, the
person's confirmation, `irreversible` types), wiring the runner in `main.ts` (deps: `controller.siteNow`
/ `runWindow`, `browserAiStopped(policy.stop(companyId))`, `createBrowserRunRecords(<userData>/…)`,
`createBundledBrowserConnectors()`, the adapter registry), the swap (add + remove with `_method=DELETE`
— `matchDeclaredWrite` refuses `_method` today, so that needs a contract decision), landing routes, a
recording helper, JSON writes, types with more than one write, confirming Lステップ's account marker,
the shelf handing out browser connectors. WSS to the operated host stays refused (no type declares
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
