---
paths:
  - "client/shared/commands/**"
  - "client/src/shared/commands/**"
  - "client/shared/app-commands.ts"
  - "client/electron/app-commands/**"
  - "client/electron/features/app-commands/**"
  - "client/tests/app-commands.test.ts"
---

# Commands: named operations, their catalog and shortcuts

A command is a named operation another part of the app invokes without knowing who handles it
(design memo E1, owner decisions 2026-10-30). Today the renderer runs them; the same catalog is
meant for main-process handlers, the AI's tools and extensions later, so its shape is fixed now.

## Where things are

| File | What |
|---|---|
| `client/shared/commands/define.ts` | `CommandDefinition`, `CommandClass`, `CommandArea`, `defineCommands` (validates the list), shortcut parsing / matching |
| `client/shared/commands/catalog.ts` | `COMMANDS`: the one list of every command. Nothing else declares a command |
| `client/shared/commands/registry.ts` | `createCommandRegistry(catalog)`: `register`, `run`, `has`, `setActiveTarget`, `handleKey`, `subscribe`; `CommandError` |
| `client/src/shared/commands/commands.ts` | the renderer's registry `commands`, `runCommand`, `useCommandHandler`, `useCommandAvailable`, `commandArea`, `useKeybindings` |
| `client/src/shared/commands/focus.ts` | `focusChainOf`: the marked areas around the focused element |
| `client/src/shared/commands/commands.test.ts` | the registry's promises, type-checked with the app (`@ts-expect-error` lines) |

The catalog lives in `client/shared/` (pure: the renderer, main process and tests import it),
not in `shared/core`: it needs zod, and a command is an app concept — the server stays the
authority through its own API, so a command the server carries out will be a main-process
handler calling a server port. `client/shared/commands/` is the one `client/shared` folder allowed
a package (zod, the schema language the app's AI tools already take: `loopback-mcp.ts`
`ZodRawShape`), listed in `architecture-boundaries.test.ts` `CLIENT_SHARED_PACKAGES`.

## Declaring a command

- Id: English `area.verb` (`file.open`, `chat.insertText`, `layout.toggleChat`); `title` is the
  Japanese text a member reads. Names may still change: nothing outside the app calls them yet.
- **Class is required** (registration of the catalog fails without it), one of: `view`
  (見せるだけ), `local` (自分の手元だけ, undoable), `outbound` (外に出る・全員に届く — anything that
  sends outside or starts the AI), `admin` (管理者の操作), `never` (渡さない). It decides how the
  command may ever reach the AI (memo E1 「AI から ACB を操作する」).
- `exposeToAI` defaults to false. Only the three tab commands below have it (owner, 2026-11-04);
  do not set it on another command without the owner. `defineCommands` refuses it on any class
  but `view` / `local` (outbound and admin need the member's 「はい」 / ACB's confirmation screen,
  not built) and without an `aiDescription` (what the AI reads, Japanese then English). See
  "Handed to the AI".
- `args` is a zod object; `run` checks it at run time and the types check it at compile time
  (`run('file.open', { path })`; a wrong id or argument does not compile).
- `target: { arg, area }` for a command that acts on one of several instances of an area (a chat
  pane): the optional argument names the instance; without it, the instance the member focused
  last runs it (`setActiveTarget`, fed by focus), else the first registered. A named instance
  that is not there is refused, never redirected to another.
- `keybinding: { key: 'mod+shift+c', area }`: `mod` = ⌘ or Ctrl (either one, on every
  platform); `shift` and `alt` must match exactly (⌥⌘P is not ⌘P); `key` is `KeyboardEvent.key`,
  a letter A–Z matched in either case (Windows / Linux report Ctrl+Shift+C as `C`, macOS ⌘⇧C as
  `c`), any other key exactly. Test: `commands.test.ts` 「on Windows / Linux, Ctrl+Shift+letter」.
  A shortcut runs the command with no
  arguments, so its args must allow `{}`; two commands cannot share a key in one area.
- `defineCommands` refuses a bad catalog at start-up (duplicate id, missing class, bad id,
  unreadable key), and `register` refuses a second handler for the same command and target.

Only operations that cross features, are invoked from outside (a shortcut, later the AI or an
extension) become commands. Calls inside one feature stay direct function calls.

## The commands

| Id | Class | Handler | Callers |
|---|---|---|---|
| `file.open` `{ path }` | view | `src/app/AppShell.tsx`: files tab, opens and keeps the tab (as Cmd+P's choice); in a consultation's own window, `useOpenFileInMainWindow` hands it to main, which runs it in the main window (`chat-ui-and-history.md`) | a review request's files (`ReviewRequestCard.tsx`; shown as links only while a handler exists, `useCommandAvailable`); a file link from a consultation's own window (`useFilesFromChatWindows`) |
| `record.open` `{ recordId }` | view | `src/app/AppShell.tsx`: files tab, the record's card in the editor area as a new place (← →; `files-and-editor.md` "Places") | 探す's rows and its empty tab (`features/search/components/SearchPanel.tsx`), the card's and a file's 「つながっているもの」 (`features/records/components/RecordRows.tsx`), an item of the title bar's 「あなたの番」 or bell (`AppShell.tsx`, `notifications.md`) |
| `chat.consultAbout` `{ recordId, title, fresh?, purpose?, pane? }` | outbound (a new consultation's first message starts the AI) | each chat pane (`ChatPanel.tsx`): the member's most recent consultation whose main topic is the record (`topicRecordId`, `client/shared/task-consult.ts` `consultationAbout`) opens (not with `fresh`: 「＋新しい相談」, nor with a `purpose`); else a new one titled 「<title> の相談」 (`purpose: 'nudge'`: 「<title> の催促」, ［催促の下書きを作る］, `tasks-ui.md` "返事待ち and its 見込み") with `topicRecordId` and a first message naming the record (`taskConsultFirstMessage`) | 「相談する」 on a task's card and row (`features/tasks`, composed by `AppShell`; `tasks-ui.md` "Consulting about a task") |
| `chat.newConsultation` `{ message?, title?, minutesId?, pane? }` | outbound (the message starts the AI) | each chat pane (`ChatPanel.tsx`, target = its layout leaf id, today `chat`); `title` is kept (not generated), `minutesId` is stored with the conversation and needs an agent with record actions (else 「議事録の読み取りは Claude Code の相談でできます」, nothing starts) | a skill's 実行 (`features/skills/hooks/useSkillsTab.ts`, message `/<skill folder> `); 「自分で読み取る」 on a received meeting's row of the task list (`features/minutes/startReading.ts`, through `useMinutesSlots`; `minutes.md`) |
| `chat.insertText` `{ text, pane? }` | local (replaces the composer's text, sends nothing) | each chat pane | none yet |
| `chat.openInWindow` `{ sessionId, pane? }` | view (shows it in a window of its own; one shown elsewhere is focused) | each chat pane (`ChatPanel.tsx`, `useMoveToWindow`) | none yet; the row and header buttons call the same function directly (`chat-ui-and-history.md`) |
| `chat.openConsultation` `{ sessionId, pane? }` | view (shows that consultation; one another window shows is focused there) | each chat pane (`ChatPanel.tsx`, `openOrFocus`) | a consultation row in a record's 「つながっているもの」 (`src/shared/ui/consultationLinks.tsx`) |
| `chat.toggleVoiceInput` `{ pane? }` | outbound (recording goes to transcription and the AI tidies it) | the shown tab's composer of each chat pane (`VoiceInputControl.tsx`) | the member's voice key (`features/chat/hooks/useVoiceShortcut.ts`, below) |
| `settings.openOwnKey` `{ service? }` | view | `AppShell.tsx`: Settings → 「自分の鍵」, that service shown first (highlighted, its form open when the member may register; a new request remounts the panel) | the chat's 「<サービス> の鍵がありません」 card (`features/chat/components/BrokerKeyNeededCard.tsx`; a button only while a handler exists, `useCommandAvailable` — none in a consultation's own window) |
| `records.runAction` `{ recordId, action, expectedVersion, note?, args?, links?, ok? }` | outbound (changes shared state, tells the person it names) | none yet (the task screen, milestone 5); choices from `client/shared/record-actions.ts` | none yet (`records.md`) |
| `layout.toggleChat` ⌘⇧C (app) | view | `AppShell.tsx` (hides / shows the chat pane); declines the key for 1.2 s after typing in the chat (`isChatInputRecentlyActive`), so the key stays with the input | the shortcut; the collapsed chat's button calls the same function directly |
| `find.byName` ⌘K (app) | view | `AppShell.tsx`: 探す ⌘K, `FindPalette` — open anything by name (records the server finds, skills already loaded for the スキル tab and slash commands, 「AIへの相談」 read once when it opens, files; the open tabs as 「最近開いたもの」); a skill opens in the スキル tab (a company-wide one under 全社), a consultation through `chat.openConsultation` | the shortcut |
| `file.search` ⌘P (app) | view | `AppShell.tsx`: the same 探す window (kept for members used to ⌘P) | the shortcut |
| `folder.reveal` `{ path }` | view | `AppShell.tsx`: the folder's department, the ファイル tab, the folder revealed in the tree | a folder row of 「つながっているもの」 (`linkRows.tsx`, `tasks-ui.md` "Dropping links") |
| `files.openToday` ⌘⇧T (app) | local (makes a folder on this computer only; never synced) | `AppShell.tsx`: 今日のフォルダ made when missing, its department's files, the folder revealed in the tree (`tasks-ui.md` "今日のフォルダ") | the shortcut; the file panel header's calendar button calls the same function |
| `search.show` ⌘⇧F (app) | view | `AppShell.tsx`: the 探す left tab, cursor in its box (live search of what the member half remembers; `records.md` "探す") | the shortcut |
| `tabs.list` (AI) | view | `features/editor/hooks/useTabTidying.ts` (mounted by `AppShell`): this window's open tabs (title, kind, `kindId`, pinned, `tabGroup` = the named group's name) and 「片づけたタブ」 by day (`group` = `2026-11-03`, item ids) — titles and kinds only, never paths or contents | the consultation AI (`tabs_list`) |
| `tabs.tidy` `{ kind?, group? }` (AI) | local (this computer's screen; undone by `tabs.restore`) | the same: every open tab (or only one kind, `kind` = a `kindId`; or one named group, `group` = its id or name — unknown → an error, nothing closes) but the pinned ones and those whose edits cannot be saved goes into 「片づけたタブ」 (`files-and-editor.md` "Tidying the tabs", "Arranging the tabs") | the tabs' 「…」 menu ［タブを片づける］ and the shown tab's kind; a group chip's menu; the AI (`tabs_tidy`) |
| `tabs.restore` `{ group?, items? }` (AI) | local | the same: reopens a day or some items; a file gone stays listed 「見つかりません」 | the AI (`tabs_restore`); the list's buttons call the same function directly |
| `editor.save` `{ pane? }` ⌘S (editor) | local (writes this computer; sync shares it) | each editor (`features/editor/components/TabbedEditorPanel.tsx`, target = its `paneId`, today `editor`): the active tab's explicit save (`useFileSaving.ts`) | the shortcut |
| `editor.togglePreview` `{ pane? }` ⌘⇧V (editor) | view | each editor: Markdown preview ⇄ source; declines the key for other files | the shortcut; the editor / preview buttons call the same function |
| `editor.find` `{ pane? }` ⌘F (editor) | view | the shown Markdown preview (`hooks/usePreviewSearch.ts`); declines the key while hidden, so the source editor's own ⌘F (CodeMirror) works | the shortcut |

A chat pane keeps the request until its shown tab can act (history read): the tab then starts a
new conversation and sends the message, or puts the text in the composer (`ChatConversation.tsx`
`inputRequest`). Only the shown tab of the named pane receives it; the panel root is the `chat`
focus area (`commandArea('chat', paneId)`). UI test: `tests/ui/chat-panel.spec.ts` 「chat commands」.

An editor's root is the `editor` focus area (`commandArea('editor', paneId)`, `tabIndex={-1}` so a
click on the preview, which has nothing focusable, still focuses it). When a button pressed in
it disappears (preview ⇄ source, closing a tab) the focus returns to the root, or ⌘S / ⌘F would
stop working until the member clicks the editor again. Its shortcuts do nothing while the focus
is elsewhere (the file tree, the chat). UI test: `tests/ui/editor-panel.spec.ts`.

## Handed to the AI (the first app commands the AI runs, owner 2026-11-04)

Exactly `tabs.list`, `tabs.tidy`, `tabs.restore`; nothing else is exposed
(`tests/app-commands.test.ts` 「only tabs.list, tabs.tidy and tabs.restore…」). How they reach the
agent:

1. `client/shared/app-commands.ts` `aiCommands()` reads them from the catalog; the tool name is
   the id with `_` (`tabs_list`) on the app's own MCP server `acb_app`, the schema is the
   catalog's zod `args` (no second definition), the description its `aiDescription`.
2. `electron/app-commands/tools.ts` `createAppCommandTools` makes the tools for one chat request
   (`chat-server.ts`, only for an agent that owns its conversation, a consultation with a company,
   and never in an unattended 「AI の番」 step); Claude Code gets them in process, always loaded and allowed without asking
   (view / local; `tests/claude-tool-search.test.ts`), Codex as a loopback endpoint, like the
   review tool. The answer is the handler's result as JSON after `redactForAI`: the window adds a
   file tab's company path only so main can judge it — main removes every path, and a file in a
   private folder this consultation has not read is shown as 「（非公開のファイル）」 (its name never
   reaches the AI; `private-folders.md`). We hide rather than mark the folder as read: marking would
   hand the name over and then ask about every later public write. The tab tools are in the
   private-read guard's own servers (`APP_MCP_SERVERS`): they send nothing out. Labels:
   `acb-tool-displays.ts`.
3. The tool only relays: main (`electron/features/app-commands/ipc.ts`) checks the id and the
   arguments again, carries the consultation's `companyId` in the request, refuses a consultation shown in a window of its own (that window has no
   tabs: 「…メインの画面の相談からだけ扱えます。」), sends `appCommand:request` to the main window
   only, and accepts `appCommand:respond` only from that window (20 s, then 「画面が応答しませんでした」).
4. The main window (`src/app/useAiCommandRequests.ts`, mounted by `AppShell`) refuses another
   company's request (`appCommandRefusal`: 「この相談は、いま画面に出ている会社のものではありません…」)
   and any id not `exposeToAI`, runs the rest through the same registry as a click, and answers (`appCommandAnswerOf`: a handler result that is only `{ error }` — it refused, nothing was done — goes to the AI as `ok: false` with those words).

So the AI works only on the main window's tabs, and only for its own company. Tests:
`tests/app-commands.test.ts`, `tests/ui/tidy-tabs.spec.ts` 「the consultation AI lists…」.

## Handlers and shortcuts

- A handler registers where it runs: `useCommandHandler(id, handler, { target?, acceptsKey? })`
  while its component is mounted. `acceptsKey` returning false lets the key through untouched
  (the default action happens, as if no shortcut existed).
- Shortcuts are delivered only to the focused area: `useKeybindings()` (installed once, by the
  screen skeleton) listens on `document`, builds the focus chain from `data-command-area` /
  `data-command-target` (`commandArea(area, target)` on the area's root element), innermost
  first and ending with `app`, and runs at most one command per key press. A chat-area shortcut
  therefore reaches the focused chat pane only, never every pane. Do not add new `window` /
  `document` keydown listeners for app shortcuts; dialog-local Escape handlers stay where they are.
- The one window-wide app key: voice input's start / stop (member-configurable, default ⌘⇧M), so
  not a catalog keybinding. `hooks/useVoiceShortcut.ts` holds one `window` capture listener per
  page (however many composers), skips composition, repeats and open dialogs, and runs
  `chat.toggleVoiceInput` for the chat pane used last — wherever the focus is, as before.
  `editor.togglePreview` moved to ⌘⇧V (owner, 2026-10-30;
  VS Code's Markdown preview key) so the two no longer collide. Dialog-local Escape
  handlers (`ConfirmDialog`, `InputDialog`, `ContextMenu`, `DiffViewer`, `FileSearchModal`,
  `SyncPreviewDialog`, `SettingsPanel`) stay where they are.
- UI tests: `tests/ui/skill-layout.spec.ts` 「shortcuts」 (⌘P, ⌘⇧F),
  `skill-layout-state.spec.ts` (⌘⇧C), `editor-panel.spec.ts` (⌘S, ⌘⇧V, ⌘F, focus only) and
  `voice-input.spec.ts` (the voice key, two panes).
- `runCommand` logs a failure (`[commands] <id> failed: <code>`) and resolves to undefined; it
  never logs arguments (paths, what a member typed).
