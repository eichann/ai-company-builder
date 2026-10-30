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
- `keybinding: { key: 'mod+shift+c', area }`: `mod` = ⌘ or Ctrl; `key` is `KeyboardEvent.key`,
  compared exactly as the listeners it replaced did. A shortcut runs the command with no
  arguments, so its args must allow `{}`; two commands cannot share a key in one area.
- `defineCommands` refuses a bad catalog at start-up (duplicate id, missing class, bad id,
  unreadable key), and `register` refuses a second handler for the same command and target.

Only operations that cross features, are invoked from outside (a shortcut, later the AI or an
extension) become commands. Calls inside one feature stay direct function calls.

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
- `runCommand` logs a failure (`[commands] <id> failed: <code>`) and resolves to undefined; it
  never logs arguments (paths, what a member typed).
