---
paths:
  - "client/shared/commands/**"
  - "client/src/shared/commands/**"
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
- `exposeToAI` defaults to false. Nothing hands commands to the AI yet; do not set it without
  the owner (a `never` command with it fails to load).
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
| `chat.newConsultation` `{ message?, pane? }` | outbound (the message starts the AI) | each chat pane (`ChatPanel.tsx`, target = its layout leaf id, today `chat`) | a skill's 実行 (`features/skills/hooks/useSkillsTab.ts`, message `/<skill folder> `) |
| `chat.insertText` `{ text, pane? }` | local (replaces the composer's text, sends nothing) | each chat pane | none yet |
| `chat.openInWindow` `{ sessionId, pane? }` | view (shows it in a window of its own; one shown elsewhere is focused) | each chat pane (`ChatPanel.tsx`, `useMoveToWindow`) | none yet; the row and header buttons call the same function directly (`chat-ui-and-history.md`) |
| `chat.toggleVoiceInput` `{ pane? }` | outbound (recording goes to transcription and the AI tidies it) | the shown tab's composer of each chat pane (`VoiceInputControl.tsx`) | the member's voice key (`features/chat/hooks/useVoiceShortcut.ts`, below) |
| `settings.openOwnKey` `{ service? }` | view | `AppShell.tsx`: Settings → 「自分の鍵」, that service shown first (highlighted, its form open when the member may register; a new request remounts the panel) | the chat's 「<サービス> の鍵がありません」 card (`features/chat/components/BrokerKeyNeededCard.tsx`; a button only while a handler exists, `useCommandAvailable` — none in a consultation's own window) |
| `records.runAction` `{ recordId, action, expectedVersion, note?, args? }` | outbound (changes shared state, tells the person it names) | none yet (the task screen, milestone 5); choices from `client/shared/record-actions.ts` | none yet (`records.md`) |
| `layout.toggleChat` ⌘⇧C (app) | view | `AppShell.tsx` (hides / shows the chat pane); declines the key for 1.2 s after typing in the chat (`isChatInputRecentlyActive`), so the key stays with the input | the shortcut; the collapsed chat's button calls the same function directly |
| `file.search` ⌘P (app) | view | `AppShell.tsx`: the 「ファイル名で検索」 dialog | the shortcut |
| `search.show` ⌘⇧F (app) | view | `AppShell.tsx`: the 検索 left tab, cursor in its box | the shortcut |
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
