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
  - "client/electron/browser-window.ts"
  - "client/electron/features/browser/**"
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
- **The login is kept on disk only when the member's AI sandbox is `enforce`**
  (`browserLoginStorage`): otherwise the chat AI's commands could read the app's data, so the
  login stays in memory and is gone when the app quits.
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
「AI はまだこの窓を操作しません。」 (+ 「アプリを開き直すと、もう一度ログインが必要です。」 when the login is
not kept). Words: `BROWSER_WORDS` (`client/shared/browser-operation.ts`).

- **Pieces.** `client/shared/browser-operation.ts` (pure: the IPC payloads, `decideWindowRequest`,
  `navigationAllowed`, `decideAiWrite`, `browserAiStopped`, `hostForLog`, `createRefusalTally`);
  `client/electron/browser-window.ts` (shell layer, the only Electron code: the window, its session's
  guards, the `ai`-mode gate, `clearPartition`); `client/electron/features/browser/` (`controller.ts`:
  which policy answer opens, closes and clears what; `logins.ts`: `<userData>/browser-logins.json`, the
  logins kept on disk; `ipc.ts`); wired in `main.ts` (lane C) on the policy store's `onPolicy` /
  `onRefreshFailed`, sign-out and sign-in. Renderer: `src/features/settings/components/BrowserSection.tsx`,
  `hooks/useBrowserSites.ts`, `api.ts`.
- **Only a valid answer opens anything.** `agent-policy-store.ts` validates `browser`
  (`parseBrowserPolicy`, shared rules; invalid = left out = off) and reports every refresh without a
  valid answer (`onRefreshFailed`: no server, an error status, an answer that does not validate, a
  network failure). Unlike the sandbox part, the browser never runs on the last answer: a failure =
  off until the next valid answer, the company's windows close (their logins stay — unknown is not
  "removed"). `browser:sites` asks the server first (≤ 5 s) and watches the company's push channel,
  so a change reaches open windows (and the 60 s check runs).
- **One window per account × company × site**, its own session: partition
  `persist:acb-browser-<sha256(user, company, host)[0..32]>` when the login is kept on disk, else
  `acb-browser-mem-<…>` (memory, gone when the app quits). On disk only when `loginStorageFor`: the
  member's sandbox is `enforce` (`browserLoginStorage`) **and** really runs here — `sandboxPlatform`
  and the current agent's `capabilities.sandbox` (the API-key agent runs `enforce` as observe and has
  a command tool), re-decided at every policy answer (also at each chat turn's refresh).
- **Close and clear.** A valid answer that drops the site or turns the mode off closes its window and
  clears its login (disk and memory); one whose storage left disk closes the windows keeping a login on
  disk and clears every kept login of that account × company (also those from an earlier run, read from
  `browser-logins.json`, whose entries must be `persist:acb-browser-<32 hex>`: an edited file never names
  another session). Sign-out closes every window and clears every login; a sign-in as another account
  clears the others'. 「ログインを消す」 closes the window and clears both partitions of that site.
  Clearing = `clearStorageData` (cookies, local storage, IndexedDB, service workers, cache storage…),
  `clearCache`, `clearAuthCache`, `clearData`. A changed site (its asset hosts) reaches the open
  window at once (`updateSite`).
- **The window** (`browser-window.ts`): never the app pages' web preferences — no preload, `sandbox`,
  `contextIsolation`, no Node (also in workers / subframes), `webviewTag: false`, no plugins,
  `navigateOnDragDrop: false`; the title always names the site. Its session has **one**
  `onBeforeRequest` (Electron keeps only the last listener: installed once per session in `guarded`,
  nowhere else), deciding with `decideWindowRequest` (the site's `decideBrowserRequest`; with no window
  open — a service worker left running — it refuses everything). Popups denied
  (`setWindowOpenHandler`), downloads cancelled (`will-download`), every permission request and check
  denied (also devices), `will-frame-navigate` (every frame, the main one included) and `will-redirect`
  only to https on the operated host (`navigationAllowed`; a subframe may be `about:blank` /
  `about:srcdoc`), certificate errors refused (`callback(false)`, no bypass; production code never sets
  a certificate check), HTTP auth prompts and webviews refused. Nothing is handed to the system browser
  or another app: `keepAppPageInWindow` / `webLinkForBrowser` are the app pages' and are not used here.
  Refusals are logged per host and reason (`[browser] refused N request(s) to <host> (<reason>)`, every
  10 s and when the window closes), never an address's path, query or a body.
- **The `ai`-mode write gate** (built and tested now so PR 5's runner plugs into it; nothing switches a
  real window to `ai` yet): `setMode('ai', { decide, stopped })`. After the first page load (attaching
  to an empty window hangs) it attaches `webContents.debugger` and `Fetch.enable` for every request; a
  write (not GET / HEAD) goes on only when `decideAiWrite` says so: https on the operated host, the AI
  not stopped, no method-override header, and the approved step's decider says yes (none = refused; a
  decider that throws = refused). Verified on Electron 45: the request hook runs **before** Fetch, so the
  hook cannot rely on the gate's verdict; instead in `ai` mode it refuses a write to the operated host
  before the gate is attached (or after it detached) and one from outside the window's page (no
  `webContentsId` of the window: a service worker, which the page's Fetch does not see; a dedicated
  worker's requests are seen), and refuses WSS to the operated host. `setMode('human')` detaches.
- **Emergency stop (decision, safe side):** the stop is about the AI, so it does not close a window the
  member operates (`human` mode: their own browsing, as in their own browser). In `ai` mode every write
  is refused while a whole-AI stop or a `web` / `mcp-external` stop is in force (`browserAiStopped`, as
  for a connector's read), checked per request; PR 5 passes `stopped: () => browserAiStopped(policy.stop(companyId))`.
- **IPC** (`browser:sites`, `browser:open`, `browser:clearLogin`; event `browser:changed`): only the main
  window's main frame (`fromMainWindow`: `mainWindowHost.isWindow` and `senderFrame` = the main frame);
  the host is only a name — main opens or clears only a site its current valid policy lists, exactly.

Tests: `client/tests/browser-window.test.ts` (the request, navigation and gate rules, the stop, the log
by host, where a login is kept and the partition names, nothing before a valid answer / for an older
server / when off, an invalid `browser` = off, the host checked exactly and per company, a failed
refresh closes windows and keeps logins, a removed site or mode off closes and clears, a changed site
reaches the window, leaving 「囲う」 closes disk windows and clears kept logins, sign-out / another
account, 「ログインを消す」, an edited logins file, every failed refresh reported, IPC from the main window
only) and `client/tests/browser-window-electron.test.ts` (a real Electron 45 window against local HTTPS
sites through `tests/browser-window-harness/`: fetch / XHR / image / beacon / WebSocket / iframe /
redirect / window.open / target=_blank / `javascript:` link / link / download to a host not listed get
0 requests and no popup window; the window's own refusals of popup, navigation and frames are logged;
an asset host gets only GET of its script, style and image (no fetch, frame or POST); no
`electronAPI` / `require` / `process` in the page, permissions denied, no download saved, http
refused; in `human` mode the member's writes go out; in `ai` mode fetch / XHR / beacon / form / WSS
writes are refused without an approving step, reads pass, the approved write goes out and another
write, a method override or a stopped AI do not; a closed window's session reaches nowhere; clearing
removes the cookie; an untrusted certificate is never bypassed; the log carries hosts and reasons
only). It runs on macOS (CI "Client tests 2/2 (macOS)", `client-tests.mjs` `MACOS`) and skips without
a display. `client/tests/ui/browser-settings.spec.ts` (preview `download-folders-ui.html?browser=…`):
no item without a site, the notes, 「開いてログイン」 / 「ログインを消す」. Each guard mutation-checked.

## Not yet (later PRs)

The AI does not operate the window yet: no operation runner, no adapters, nothing switches a window to
`ai` mode. The operation types' declaration is fixed (`plugins.md` "Browser connectors (contract
only)", `shared/core/plugin-browser-declaration.ts`: a connector plugin with `browser`, its types,
`matchDeclaredWrite`, `browserOperationsAllowed` against this setting), but the shelf refuses such a
package until the runner and its reviewed adapters ship. The runner's contract is there too: every
request to the operated host that is not GET / HEAD goes through `matchDeclaredWrite` (and each
declared write of an approved step passes at most once); WSS to the operated host is refused unless
an operation type declares it (none can yet; the window's `ai` mode refuses it). Until then the admin
page says next to the mode choice what 「使う」 does today (`BROWSER_NOT_YET_NOTE`: members open and log
in, the AI part is being prepared); the PR that lets the AI operate removes that note (and its
assertion in `admin/tests/agent-browser.test.tsx`).

Tests: `server/tests/integration/agent-browser.test.ts` (owner/admin only, refusals of a
wildcard / duplicate / operated host as a parts host / unknown level, no row = off, an unchanged
save records nothing, a save reaches every member's policy with a new version, an override
changes only that member and only members can have one, a departed member's override neither
shows nor applies after they come back, the push announcement, an invalid stored row reads as
off), permission matrix + `CROSS` rows, `admin-contract.test.ts`, `admin/tests/agent-browser.test.tsx`
(linked from 「AI の安全」, member never loads it, words from the lib, invalid parts hosts / the
operated host / a duplicate site block saving, what a save sends, an override changes one
member), `admin/tests/advanced.test.ts` (「変えています」).
