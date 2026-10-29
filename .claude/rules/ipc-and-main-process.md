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
  (git:preview, diffs, revert, summary, log, showCommit, listFiles, grep, getBinaryStatus),
  `sync` (git:sync, writeAccess:get), `private-folders` (privateFolders:*; `guards.ts`),
  `company-setup` (git:inspectCompanyFolder, git:setupCompanyRemote), `download-choices`
  (git:sparse*, git:folderSizes), `skills` (skills:*, scan + cache), `tools` (tools:start/stop,
  shell:openExternal; running tools stop on quit), `chat` (`server-config.ts`: what the embedded
  chat server gets; `system-prompt.ts`).
- `electron/services/` — shared state as explicit objects instead of module variables:
  `config-store.ts` (config.json, cached, written atomically), `api-key-store.ts` (the API key,
  encrypted through the shell's `SecretBox`; main decrypts it only where it is used), `shell-env.ts` (PATH / env for spawned processes; AI processes get it cut down by `agents/agent-env.ts`),
  `claude-cli.ts` (the member's `claude`, status cached 30 s), `session.ts` (server session
  cookies, memory only; every server client and git's token read them here), `app-git.ts` (every
  git the app runs: bundled-or-system binary, `GIT_ASKPASS` token, the guarded
  `sync/git-factory.ts` configuration), `commit-messages.ts` (sync's AI commit message).
- `electron/electron-adapter.ts` — Electron's implementations of the ports (`DesktopShell`,
  `WindowPort`, `SecretBox` (safeStorage), sync's message boxes) and the `local-file://` protocol registration.
- `main.ts` (~330 lines) — the composition root: creates services and stores in dependency
  order, calls each `register…Ipc`, owns the window, the app lifecycle and
  `chat-server:getInfo`, starts voice input and the chat server in `app.whenReady`.
- Shell layer = `main.ts`, `preload.ts`, `electron-adapter.ts`, `voice-input.ts`: the only files
  that import Electron, i.e. what another desktop shell (Tauri) would replace. ESLint
  `no-restricted-imports` forbids `electron` in `features/**`, `services/**`, `ipc/**`;
  `client/tests/architecture-boundaries.test.ts` checks the same over the whole tree, plus the
  agent boundaries (CLAUDE.md "App modules point one way too") and the renderer's (no feature →
  feature imports, `src/shared` ↛ `src/features` / `src/app`, `window.electronAPI` only in the
  data layer or the shrinking list of older files: `renderer-structure.md`).
- Keep `main.ts` importable without side effects beyond registering handlers (startup stays in
  `app.whenReady`), because the IPC harness loads it under plain Node.

## IPC contract (`client/shared/ipc-contract.ts`, types only)

`IpcInvokeChannels` (invoke ↔ handle: args tuple + result), `IpcSendChannels`, `IpcSyncChannels`
(`sendSync`), `IpcEventChannels` (main → window payloads) and `ElectronAPI`
(`window.electronAPI`). The compiler checks both ends: `preload.ts` builds `window.electronAPI`
as an `ElectronAPI` through typed `invoke` / `send` / `sendSync` / `subscribe` helpers, and main
registers through `typedIpc(ipcMain)` (`electron/ipc/registrar.ts`, an `IpcRegistrar`, no
Electron import). Preview pages fake it with `Window['electronAPI']` (`tests/ui/fixtures`).

How to add a channel:
1. Add it to `shared/ipc-contract.ts` (channel → `{ args, result }`, or the event payload) and its
   `ElectronAPI` method (`Invoke<'channel'>`, or a hand-written signature when it adapts args).
2. Implement it in `electron/preload.ts` with named parameters
   (`(path: string) => invoke('fs:x', path)`, no `...args`).
3. Register with `ipc.handle('channel', …)` — a string literal on a variable named `ipc` — in
   the feature module. A local path from the renderer goes through the allowed-roots validator,
   and the parameter goes into GUARDED (or EXEMPT, with a reason) in
   `tests/ipc-path-guard.test.ts`.
4. Regenerate `tests/ipc-harness/ipc-inventory.json` and review the diff in the PR.

## IPC characterization tests

`client/tests/ipc-*.test.ts` load the real `main.ts` under plain Node:
`tests/ipc-harness/electron-loader.mjs` (a `node:module` resolve hook) maps `electron` to
`tests/ipc-harness/fake-electron.ts`, which records `ipcMain` handlers, window sends, dialogs and
the `local-file` protocol; a fake server sits behind global `fetch` (`main-harness.ts`,
`loadMain()`; one main.ts per test file, all under one temp dir).

- `ipc-contract.test.ts` compares the whole IPC surface with `ipc-inventory.json` (every handler
  and its parameters in main.ts, voice-input.ts and `features/**`, every window event, each
  preload function's calls and compiler-resolved type, unmatched ends = dead-code candidates) and
  asserts contract and running app agree (`notInContract`, `inContractButUnused` empty).
  Changing a channel or payload fails it on purpose: regenerate with
  `UPDATE_IPC_INVENTORY=1 npx tsx --test tests/ipc-contract.test.ts` and review the JSON diff.
- `ipc-path-guard.test.ts`: every handler parameter named like a path (path / root / folder /
  dir) is GUARDED (called with a path outside every root it must reach `AllowedRoots.validate`
  and fail) or EXEMPT with the reason. A new path parameter fails until classified.
- The other files pin behaviour that lives in the handlers (refusals, result shapes); logic one
  level down keeps its own tests. One file: `npx tsx --test tests/ipc-fs.test.ts`
  (`IPC_HARNESS_VERBOSE=1` prints main's console).

## Guards on what the renderer hands main (keep them)

- Every renderer path (all `fs:*`, `local-file://`, `editor:backupBeforeOverwrite`, `env:*`,
  `git:*` incl. sync / log / showCommit / commitFileDiff, `backup:*`, `skills:*`, `tools:start`)
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
- `backup:openFolder` opens only a folder directly under `.backups/` or `acb-private-backups/`;
  `tools:start` only `<…>/.claude/skills/<skill>/tools/<tool>` with `dev` / `start`;
  `skills:publish` / `makePrivate` refuse a multi-line entry; `skills:toggleNurturing` only a
  `SKILL.md`; `shell:openExternal` only `http:` / `https:` / `mailto:` (`electron/external-url.ts`).
- A commit the renderer names reaches git only as a hex object id (`commitIdArg`,
  `/^[0-9a-f]{4,64}$/i`, `git-search.ts`; `showCommitArgs` / `commitFileDiffArgs`), and paths
  always follow `--`. Other renderer-supplied git arguments are after `--`, behind `-e`, or
  prefixed (`origin/main:<folder>`, `/` and `!/` sparse patterns). `--output=<file>` once let
  `git show` write anywhere. Test: `client/tests/ipc-git.test.ts`.
- Known gap: the server does not refuse committed symlinks yet (it needs a client recovery first,
  or members would be unable to sync), and sync and the chat write guard judge paths lexically.
