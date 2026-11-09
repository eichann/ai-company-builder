---
paths:
  - "client/electron/main.ts"
  - "client/electron/preload.ts"
  - "client/electron/electron-adapter.ts"
  - "client/electron/voice-input.ts"
  - "client/electron/features/**"
  - "client/electron/services/**"
  - "client/electron/ipc/**"
  - "client/electron/allowed-roots.ts"
  - "client/electron/external-url.ts"
  - "client/electron/permission-policy.ts"
  - "client/electron/local-file-protocol.ts"
  - "client/electron/git-search.ts"
  - "client/shared/ipc-contract.ts"
  - "client/tests/ipc-*.test.ts"
  - "client/tests/ipc-harness/**"
  - "client/eslint.config.mjs"
  - "client/tests/architecture-boundaries.test.ts"
---

# Main process and IPC (client)

Full text: `docs/architecture/main-process-and-ipc.md` (internal).

## Layout (R3 split the 3,220-line `main.ts` into these)

- `electron/features/<domain>/ipc.ts` — one module per IPC domain exporting
  `register<Domain>Ipc(ipc: IpcRegistrar, deps)`. Dependencies are injected (like sync's
  `SyncDeps`): the allowed-roots `PathGuard`, the `WindowPort` for events, the `DesktopShell`
  (`features/ports.ts`), services, stores. Domains: `settings` (config:*, codex:status), `env`,
  `backups`, `auth` (auth:*, api:*), `chat-history` (chatHistory:*, handoff:*),
  `agent-interactions` (tool approvals), `fs` (fs:*, dialog:selectDirectory,
  editor:backupBeforeOverwrite; company watchers in `fs/watchers.ts`), `git-history`
  (git:preview, diffs, revert, summary, log of a folder or a file, listFiles, grep, getBinaryStatus),
  `sync` (git:sync, git:autoSync, writeAccess:get), `private-folders` (privateFolders:*; `guards.ts`),
  `company-setup` (git:inspectCompanyFolder, git:setupCompanyRemote), `broker` (brokerKeys:*,
  the member's own API keys, and `brokerKeys:moveFromEnv`, which reads a `.env` key in main, sends
  it and removes it locally only after the server kept it: `key-broker.md`), `download-choices`
  (git:sparse*, git:folderSizes), `skills` (skills:*, scan + cache), `skill-shelf` (skillShelf:publish / editLocally / restoreCompany / requestPublish / openBackup and the event
  `skillShelf:changed`: a company without the shared folder, `plugins.md` "The Skill shelf in the app"), `tools` (tools:start/stop,
  shell:openExternal; running tools stop on quit), `app-link` (appLink:serverOffer / acceptServer /
  dismissServer: the invitation link's server address, below), `chat` (`server-config.ts`: what the embedded
  chat server gets; `system-prompt.ts`), `chat-windows` (chatWindow:*, 「別ウィンドウで開く」;
  the windows themselves come from `electron-adapter.ts` `createChatWindowHost`),
  `plugin-operations` (pluginOperations:undo / reconcile / recreate: the chat card's person
  actions on an outside system's write, with the session; `plugins.md` "The app"), `minutes`
  (minutes:watch / check / notices / skip / linkBundle and the event `minutes:changed`:
  received minutes checked with the session in main, `minutes.md` "The app"; minutes:arrivals /
  meeting / requestReading / skipReading / autoSeries / invite: meetings for their attendees,
  `features/minutes/meetings.ts`, `minutes.md` "In the app"), `record-views`
  (recordViews:search / find / findHome / card / forFile / topics: ⌘K and 探す hits, the record card, a file's
  「つながっているもの」 and the やること / 案件 of the member's consultations, read with the session;
  `records.md` "The app's views"),
  `notifications` (notifications:watch / state / markRead / settings / setSetting and the event
  `notifications:changed`: the title bar's 「あなたの番」 and bell, `notifications.md`), `absences`
  (absences:get / add / remove: the member's own absences and delegate, with the session;
  `records.md` "Absence and the delegate"), `ai-turns`
  (aiTurns:settings / claim / settle: the automatic 「AI の番」's claim by version and settle, main
  window only; the run itself is a hidden consultation in the renderer, `ai-turns.md`). `tasks`
  (tasks:list / create / act / card / linkFile / unlinkFile / retryRun / reconcile: the task list and card, read and
  changed with the session; `tasks-ui.md`).
- `electron/features/<domain>/wire.ts` — a feature's wiring that would otherwise sit in `main.ts`:
  `wire<Feature>(ipc?, deps)` creates the feature's services from injected ports, registers its
  IPC and its quit hooks (`AppLifecycle` in `features/ports.ts`), and returns what other features
  need. `agent-control` (AI policy, emergency stop + push channel, AI action log), `chat-history`
  (history store, hand-offs), `sync` (git:sync, commit messages, git-history), `private-folders`,
  `broker` (tokens, own keys, tools). No Electron, and no window event is sent from a wire
  module: sends stay where `ipc-inventory.txt` records them (`main.ts` passes a callback).
- `electron/services/` — shared state as explicit objects instead of module variables:
  `config-store.ts` (config.json, cached, written atomically), `api-key-store.ts` (the API key,
  encrypted through the shell's `SecretBox`; main decrypts it only where it is used), `shell-env.ts` (PATH / env for spawned processes; AI processes get it cut down by `agents/agent-env.ts`),
  `claude-cli.ts` (the member's `claude`, status cached 30 s), `session.ts` (server session
  cookies, memory only; every server client and git's token read them here), `app-git.ts` (every
  git the app runs: bundled-or-system binary, `GIT_ASKPASS` token, the guarded
  `sync/git-factory.ts` configuration), `commit-messages.ts` (sync's AI commit message).
- `electron/electron-adapter.ts` — Electron's implementations of the ports (`DesktopShell`,
  `WindowPort`, `SecretBox` (safeStorage), sync's message boxes), the windows (`createAppPages`:
  the page and web preferences; `createMainWindowHost`: the main window with its close guard;
  `createChatWindowHost`), the `local-file://` protocol registration and `acb-plugin://` (a
  plugin's screen: `servePluginFiles`, frame navigation; `plugin-frame.md`).
- `main.ts` (~320 lines) — the composition root: creates services and stores in dependency
  order, calls each `register…Ipc` / `wire…`, owns the app lifecycle, `app:closeResponse` and
  `chat-server:getInfo`, starts voice input and the chat server in `app.whenReady`.
- Shell layer = `main.ts`, `preload.ts`, `picker-preload.ts` (Google Picker's window only:
  two calls on that window's own `webContents.ipc`, no global channel; `google-drive.md`),
  `electron-adapter.ts`, `voice-input.ts`: the only files
  that import Electron, i.e. what another desktop shell (Tauri) would replace. ESLint
  `no-restricted-imports` forbids `electron` in `features/**`, `services/**`, `ipc/**`;
  `client/tests/architecture-boundaries.test.ts` checks the same over the whole tree, plus the
  agent boundaries (CLAUDE.md "App modules point one way too") and the renderer's (no feature →
  feature imports, `src/shared` ↛ `src/features` / `src/app`, `window.electronAPI` only in the
  data layer, no exceptions: `renderer-structure.md`).
- **Windows.** Every app window — the main one and the consultation windows — gets the one
  `webPreferences()` of `createAppPages` (`electron-adapter.ts`; contextIsolation, sandbox, no Node, the one preload; CSP from
  `index.html`). Every app window also shows only the app's page (`keepAppPageInWindow`): a
  popup (`target="_blank"` links in chat answers and markdown previews, `window.open`) is denied
  and a navigation away from the app's page (`isAppPage`) is prevented; either one, when it is
  `http:` / `https:`, opens in the member's own browser (`webLinkForBrowser`,
  `electron/external-url.ts`; never `file:`, `javascript:`, `mailto:` or a custom scheme). Owner
  decision (Electron 45 upgrade): before, the main window opened such links as a new Electron
  window. Only the main frame: the PDF preview's iframe is Chromium's own viewer. The main window alone adds
  `backgroundThrottling: false` (the automatic 「AI の番」 runs there while it is behind or
  minimized, `ai-turns.md`). Tests: `tests/ipc-window-links.test.ts`, `tests/ipc-chat-windows.test.ts`.
- **Web permissions are default deny.** Electron grants every Chromium permission request
  (camera / microphone, notifications, clipboard, USB, …) when no handler is set.
  `guardEverySession` (`electron-adapter.ts`, called from `main.ts` before ready) installs a
  request and a check handler on the default session and every session created later:
  `permission-policy.ts` allows only `clipboard-sanitized-write` (navigator.clipboard.writeText)
  and `fullscreen`, and only for the app's own page (the packaged `dist/index.html`, or the Vite
  dev server's origin); everything else, and any other page (another file://, a web site, `blob:`
  frames), is refused (logged with the permission's name only). The microphone is not a web
  permission here: voice input records in its native helper and asks macOS itself
  (`voice-input.ts`, `systemPreferences.askForMediaAccess`). A new web feature that needs a
  permission adds it to `APP_PAGE_PERMISSIONS`. Test: `tests/ipc-permissions.test.ts`.
- **Sender checks.** Handlers that look at who sent them accept exactly the windows they are for,
  never "any window": `chatWindow:open` / `focus` / `list` / `closeAll` only the main window;
  `chatWindow:getContext` / `reportStatus` / `openFile` only a registered consultation window, and
  only about itself (`openFile`: a file of its own company folder, then `chatWindow:fileRequested`
  to the main window only); `app:closeResponse` (the answer to closing the main window,
  `services/close-guard.ts`; closing during a sync: once the renderer is done or gone, a running
  `gitSync.isRunning()` asks 「終わったら閉じる」 (default) / 「閉じない」 / 「すぐに終了する」 in a message box from
  `electron-adapter.ts`; waiting is `gitSync.whenIdle()`, then the renderer saves again; another close
  during the wait asks again, so a hung sync cannot trap the member; 「すぐに終了する」 saves the tabs once more and really quits,
  also from the macOS window button, which alone would leave the sync running with no window to ask in; a
  sync cut off half-way is the next sync's clean-up, `sync-guards.md`; test `tests/close-guard.test.ts`) only the main window; `appCommand:respond` (the main window's answer to
  the consultation AI's app command, `features/app-commands/ipc.ts`) only the window that was asked,
  and `appCommand:request` goes to the main window only (`commands.md` "Handed to the AI"). Choice prompts and tool approvals go to the window that shows their conversation
  (`webContentsForSession` in `main.ts`, `features/agent-interactions/owner.ts`; the owner is
  that window's webContents, so only it may answer, as before). Conversation events (`chatHistory:changed`, `handoff:changed`) go to every
  window (`createBroadcastPort`). Tests: `tests/chat-windows.test.ts`,
  `tests/ipc-chat-windows.test.ts`.
- Keep `main.ts` importable without side effects beyond registering handlers (startup stays in
  `app.whenReady`), because the IPC harness loads it under plain Node.

## IPC contract (`client/shared/ipc-contract.ts`, types only)

`IpcInvokeChannels` (invoke ↔ handle: args tuple + result), `IpcSendChannels`, `IpcSyncChannels`
(`sendSync`), `IpcEventChannels` (main → window payloads) and `ElectronAPI`
(`window.electronAPI`). The compiler checks both ends: `preload.ts` builds `window.electronAPI`
as an `ElectronAPI` through typed `invoke` / `send` / `sendSync` / `subscribe` helpers, and main
registers through `typedIpc(ipcMain)` (`electron/ipc/registrar.ts`, an `IpcRegistrar`, no
Electron import). The renderer types `window.electronAPI` itself (`src/shared/ipc/electron-api.ts`,
`declare global`), so it does not depend on `preload.ts`; preview pages fake it with
`Window['electronAPI']` (`tests/ui/fixtures`).

How to add a channel:
1. Add it to `shared/ipc-contract.ts` (channel → `{ args, result }`, or the event payload) and its
   `ElectronAPI` method (`Invoke<'channel'>`, or a hand-written signature when it adapts args).
2. Implement it in `electron/preload.ts` with named parameters
   (`(path: string) => invoke('fs:x', path)`, no `...args`).
3. Register with `ipc.handle('channel', …)` — a string literal on a variable named `ipc` — in
   the feature module. A local path from the renderer goes through the allowed-roots validator,
   and the parameter goes into GUARDED (or EXEMPT, with a reason) in
   `tests/ipc-path-guard.test.ts`.
4. Regenerate `tests/ipc-harness/ipc-inventory.txt` and review the diff in the PR. If `main`
   moved meanwhile, a rebase normally merges the file by itself (see below); regenerate after
   resolving a conflict in it rather than hand-editing.

## Lane markers (parallel lanes A connectors, B inbox, C plugins)

Three lanes add IPC in parallel (same scheme as `server.md` "Lane markers"); the spots where they
would collide carry `// lane A ▼` … `// lane C ▲` blocks (the ▲ lines keep the blocks apart for
git):

- `client/shared/ipc-contract.ts` — the payload-type imports, the end of `IpcInvokeChannels`,
  `IpcEventChannels` and `ElectronAPI`. Payload types go into the feature's own
  `client/shared/<feature>.ts`; the contract gets only the channel lines and the import.
- `client/electron/preload.ts` — the type imports and the end of `api`.
- `client/electron/main.ts` — the imports and one registration line per feature
  (`register<Feature>Ipc(ipc, { … })` / `wire<Feature>(ipc, { … })`, after the AI turns' one, so
  `session`, `recordsApi`, `minutes`, `notices` and `agentControl` exist); the feature's code stays
  in `electron/features/<feature>/`.
- `client/tests/ipc-path-guard.test.ts` — `GUARDED` and `EXEMPT`.
- `client/src/app/recordSource.tsx` — what the task card's source slot shows (`tasks-ui.md`).

A lane adds lines only right under its own `▼`, never moves or removes a marker.
`ipc-inventory.txt` has no markers: it is sorted, so lanes' lines merge; regenerate it (above),
never hand-edit.

## IPC characterization tests

`client/tests/ipc-*.test.ts` load the real `main.ts` under plain Node:
`tests/ipc-harness/electron-loader.mjs` (a `node:module` resolve hook) maps `electron` to
`tests/ipc-harness/fake-electron.ts`, which records `ipcMain` handlers, window sends, dialogs and
the `local-file` protocol; a fake server sits behind global `fetch` (`main-harness.ts`,
`loadMain()`; one main.ts per test file, all under one temp dir).

- `ipc-contract.test.ts` compares the whole IPC surface with `ipc-inventory.txt` (every handler
  and its parameters in main.ts, voice-input.ts and `features/**`, every window event, each
  preload function's calls and compiler-resolved type, unmatched ends = dead-code candidates; the
  renderer "uses" a method by calling it on `window.electronAPI` or naming it in an
  `ElectronPort<…>` / `VoiceInputPort<…>`) and
  asserts contract and running app agree (`notInContract`, `inContractButUnused` empty).
  Changing a channel or payload fails it on purpose: regenerate with
  `UPDATE_IPC_INVENTORY=1 npx tsx --test tests/ipc-contract.test.ts` and review the diff; the
  failure lists the lines added (`+`) and gone (`-`).
- The inventory file is one independent fact per line, sorted by code unit (`inventoryLines` in
  `tests/ipc-harness/inventory.ts`): `main.handle|on <channel> @ <file> (<params>)`,
  `main.send <channel> @ <file>`, `preload <name> -> <calls>` / `preload <name> : <type>`,
  `contract.<kind> <channel>`, `contract.type <Name>[.<member>] = <text>` (an interface per
  member), `unmatched.<list> <item>`. Keep it that way — no counts, line numbers or other
  entries derived from the rest, no multi-fact lines — because that is what makes PRs that add
  different channels merge cleanly, with the merged file equal to a regeneration on the merged
  code (the old JSON kept each contract interface on one line, so every two channel PRs
  conflicted). Two new names that sort next to each other (e.g. two new `unmatched.*` entries)
  can still conflict: keep both sides, then regenerate. No `merge=union` for it: the test would
  catch a bad union, but only after the merge reached `main`.
- `ipc-path-guard.test.ts`: every handler parameter named like a path (path / root / folder /
  dir) is GUARDED (called with a path outside every root it must reach `AllowedRoots.validate`
  and fail) or EXEMPT with the reason. A new path parameter fails until classified.
- The other files pin behaviour that lives in the handlers (refusals, result shapes); logic one
  level down keeps its own tests. One file: `npx tsx --test tests/ipc-fs.test.ts`
  (`IPC_HARNESS_VERBOSE=1` prints main's console).

## Guards on what the renderer hands main (keep them)

- Every renderer path (all `fs:*`, `local-file://`, `editor:backupBeforeOverwrite`, `env:*`,
  `git:*` incl. sync / log / commitFileDiff, `backup:*`, `skills:*`, `tools:start`)
  goes through `AllowedRoots.validate` (`client/electron/allowed-roots.ts`): inside a registered
  company root **by name and by real location** — every symlink resolved (`realpathSync.native`;
  for a missing path its deepest existing ancestor, dangling links followed), compared in NFC
  against that root's real path. Otherwise
  「このファイル（またはフォルダ）は会社フォルダの外を指すリンク（シンボリックリンク）のため、アプリでは開いたり変更したりできません。」
  (lexically outside keeps `Access denied: path is outside allowed directories`). Why: a link a
  teammate committed (`営業/メモ.md -> ~/.zshrc`, `資料 -> /`) let the app read and overwrite
  anything the member's account can (IPC security review, 2026-10). Test: `ipc-path-guard.test.ts`.
- Operations on the entry itself (`fs:delete`, rename/move source, `git:revertFile` of a new file)
  judge the link, not its target (delete uses `lstat`), so a link inside can still be removed. The
  file tree lists links without descending into them.
- Secret values never go to the renderer. The company `.env` (skills' API keys) is answered
  by `env:status` as per name `{ set, last4? }` (`client/shared/env-file.ts`; every entry counts
  as secret, `last4` only for values of 12+ characters) and changed by `env:update` (a value sets
  or replaces one name, `null` removes it; other lines and comments stay; bad names, line breaks
  and non-strings are refused). Same shape as `config:getApiKeyStatus`. The value-returning
  `env:read` / whole-file `env:write` were removed (renderer and main ship together). Test:
  `ipc-fs.test.ts` ("env:status never hands a .env value to the renderer"). The server session
  stays in main too: `auth:signIn` / `auth:signUp` answer only `{ success, error? }` (Better
  Auth's response body carries the session token; who signed in comes from `auth:getSession`,
  the `/api/me` user fields). Test: `ipc-app.test.ts` ("auth:signIn / auth:signUp never hand the
  session token").
- **The invitation's 「アプリを開く」** (`ai-company-builder://open?server=<origin>`, 2026-11-02,
  管理画面の見直し 2-2; `build.protocols` in `client/package.json`; `electron-adapter.ts`
  `receiveAppLinks`: `open-url`, a second instance's and the first launch's arguments) only
  *offers* a server: `features/app-link/link.ts` passes an https origin alone (http only on
  loopback; no credentials, path, query or fragment, one `server`), `features/app-link/ipc.ts`
  holds it only while the app has no server (a link never switches a configured app), and
  `appLink:acceptServer` takes no argument — it saves the address main holds, after the member
  saw it on the server screen (`ServerSetupScreen`, host shown large) and pressed 「つなぐ」 and
  that server answered `/api/config` as ACB. Tests: `tests/app-link.test.ts` (mutation-checked),
  `ipc-app.test.ts` 「an invitation link (open-url) never points…」.
- `backup:openFolder` opens only a folder directly under `.backups/` or `acb-private-backups/`;
  `tools:start` only `<…>/.claude/skills/<skill>/tools/<tool>` with `dev` / `start` (its optional
  company id only selects the key broker's token, `key-broker.md` K6);
  `skills:publish` / `makePrivate` refuse a multi-line entry (`makePrivate` also a skill already
  shared); `fs:createFile` / `rename` / `move` / `moveFromExternal` / `copy` never replace an
  existing target (`files-and-editor.md`); `skills:toggleNurturing` only a
  `SKILL.md`; `shell:openExternal` only `http:` / `https:` / `mailto:` (`electron/external-url.ts`).
- A commit the renderer names reaches git only as a hex object id (`commitIdArg`,
  `/^[0-9a-f]{4,64}$/i`, `git-search.ts`; `showCommitArgs` / `commitFileDiffArgs`), and paths
  always follow `--`. Other renderer-supplied git arguments are after `--`, behind `-e`, or
  prefixed (`origin/main:<folder>`, `/` and `!/` sparse patterns). `--output=<file>` once let
  `git show` write anywhere. Test: `client/tests/ipc-git.test.ts`.
- Known gap: the server does not refuse committed symlinks yet (it needs a client recovery first,
  or members would be unable to sync), and sync and the chat write guard judge paths lexically.
