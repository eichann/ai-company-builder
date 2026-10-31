---
paths:
  - "client/src/**"
---

# Renderer structure (`client/src`): where code goes

The renderer was moved (2026-10, refactor phases 2–5) from folders by kind (`components/`,
`hooks/`, `lib/`) to folders by feature. The goal is that an agent finds what to touch from the folder name alone
and does not read hundreds of unrelated lines to change one thing. Area rules (what the code must
do) stay in their own files — `files-and-editor.md`, `chat-ui-and-history.md`,
`download-choices.md`, `private-folders-client.md`, … — this file says only where code lives.

## Target layout

```
client/src/
  app/              start-up, providers, the screen skeleton (AppShell): composes features
  features/<name>/  one feature: its screens, hooks, data access, pure logic and tests
    components/       presentational parts (props in, JSX out)
    hooks/            state, effects and data loading, one concern per hook
    api.ts            the IPC calls this feature makes (window.electronAPI)
    model.ts          pure logic, no React (more files if it grows)
    *.test.ts         node tests, next to the code they test
  shared/
    ui/             generic parts used by several features (dialogs, menus, badges, icons)
    hooks/          hooks two or more features use (write access, sparse checkout, departments)
    lib/            logic that belongs to no single feature (paths, file events, perf marks)
    ipc/            window.electronAPI's types (electron-api.ts) and the ports of shared parts
    commands/       the renderer's command registry and shortcut dispatch (commands.md)
  stores/           app-wide state (appStore, authStore); feature state lives in its feature
  i18n/  types/
```

Planned features: `workspace` (department tabs, left panel tabs, panel layout, department
choice), `skills`, `files`, `editor`, `doc-review` (the Markdown review of a document),
`chat`, `sync`, `history`, `search`, `settings`, `auth` (server address, sign-in, session),
`company` (choosing a company and setting its folder up: the company selector). Only create what you need; add a feature
folder when the code has no home among these.

Naming: `doc-review` is the review of a Markdown document (sidecar `*.review.*.json` files). Do
not call it `review`: in the app "review" already means 「確認をお願いする」 (`request_review`,
`ReviewRequestCard.tsx`, `src/features/chat/reviewRequest.ts`), which belongs to `chat`.

## No legacy folders

`components/`, `hooks/`, `lib/` and `utils/` were emptied into `features/` and `shared/` and
deleted (refactor 5-6). Do not create them again: new code goes to `features/<name>/` or
`shared/` (`app/`, `stores/`, `i18n/`, `types/` as in the layout above).

## Principles

1. **Colocate what changes together.** A screen, its hooks, its pure logic, its types and its
   tests sit in one feature folder. Split by "changes together", not by line count.
2. **Dependencies point one way: `app → features → shared`.** A feature never imports another
   feature; `app/` composes them (pass data and callbacks through props). `shared/` never
   imports `features/` or `app/`. `stores/`, `i18n/` and `types/` may be imported from anywhere.
   An unavoidable cross-feature import is registered **per imported file**, with its reason, in
   `FEATURE_IMPORT_EXCEPTIONS` (`client/tests/architecture-boundaries.test.ts`,
   `'files -> doc-review/model.ts'`): any other file of that feature still fails. What another
   feature may see: in principle only its pure functions and types (`model.ts`), and components
   registered with a reason; using its `hooks/` or `api.ts` needs a reason why it cannot be
   avoided. A PR that adds an entry says why `app/` cannot compose the two through props or a
   slot. Still no barrels: the registered files are a feature's public surface.
3. **No barrel files.** No `index.ts` that re-exports a folder: import the file you need. The
   boundary test, not a public index, guards a feature's edges (barrels also defeat tree shaking).
4. **IPC goes through a data layer.** Components, hooks, stores and `App.tsx` do not call
   `window.electronAPI` directly; a feature's `api.ts` (or `shared/ipc/`) does. The boundary
   test fails on any other use, with no list of exceptions (the last older callers moved
   2026-10-30). A store imports the port functions it needs (`authStore` →
   `features/auth/api.ts`, `appStore` → `shared/ipc/allowed-folders.ts`); calls that reach the
   company server are ports like any other, one small port per role, never a server client
   object. The IPC contract itself (channels, arguments,
   `client/shared/ipc-contract.ts`) does not change for this: `ipc-and-main-process.md`.
   **Small ports, never one client object** (owner, 2026-10-29): an `api.ts` names only the
   methods it uses (`ElectronPort<'readFile' | …>`, for `voiceInput` `VoiceInputPort<…>`, both in
   `src/shared/ipc/electron-api.ts`), grouped
   by what they can do — read on this computer, write on this computer, send outside — so a
   later plugin bridge can be handed exactly one group. No wrapper of the whole API, and no
   stand-in that pretends something exists: what a setup lacks is a capability the UI reads.
5. **A screen component composes named hooks.** State, effects and IPC go into hooks named after
   their concern (`useDepartmentSelection`, `useEditorPersistence`); presentational parts take
   props and render; React-free computation is a pure function in `model.ts`. The chat panel
   (`features/chat/`, `chat-ui-and-history.md`) is the model to follow.
6. **One hook per `use*.ts` file, in its owner's `hooks/`.** A hook lives in the `hooks/` of
   the feature that uses it; only a hook two or more features use goes to `shared/hooks/` (the
   skeleton `app/` does not count as a feature). Do not gather all hooks in one folder, and do
   not export a hook from a file named otherwise (`shared/lib/fileVersions.ts` keeps the store,
   `features/editor/hooks/useFileVersion.ts` the hook), so a hook is found by its file name.
   Exceptions, kept in the file of their mechanism: a store's selector hooks (`useAppStore`,
   `agentStatusStore.ts`, `consultationStatusStore.ts`) and the command registry's hooks
   (`useCommandHandler`, `useCommandAvailable`, `useKeybindings` in `shared/commands/commands.ts`).

   **When to extract a hook into its own file** (owner, 2026-10-31; "one hook per file" applies
   to the hooks you extract). Extract only when one of these holds:
   1. two or more components or features use it;
   2. it holds exactly one connection to the outside — an IPC subscription, an event listener, a
      timer, a data load — with its clean-up (`useIpcEvent`, `useEventListener`, `useInterval`
      are the good kind);
   3. it has rules worth testing on their own — but first consider a pure function in `model.ts`.

   Otherwise keep the state and handlers in the component that uses them, where they change
   together with the screen; if that file passes ~300 lines, one line at its top says why it is
   not split. Do not create hooks that only wrap one `useState`, or lifecycle-named hooks
   (`useMount`, `useUpdateEffect`). Naming check: you can say "this hook does X" in one phrase;
   if the description needs "and" / "or" (「と」「や」), rethink the split. Why: extracting to cut
   line counts does not cut reading — single-use hooks spread over many files cost people and the
   AI more. Code already split stays as it is; this applies to new code.
7. **About 300 lines per file.** A new or split file over ~300 lines states in one or two lines
   at its top why it stays whole. Do not split finer than that: hopping between tiny files costs
   more reading than it saves.
8. **Comments say why, not what.** Inline comments at most two lines; no links or change history
   in comments. Long background belongs in the internal `docs/architecture/` notes; rules that
   must hold belong in `.claude/rules/`.
9. **Nest at most 3–4 levels** (`features/<name>/components/X.tsx` is the deepest normal case).

## What goes in `src/shared/`

Two kinds; a new file says on its first line which one it is:

1. **Generic** — knows no ACB vocabulary (department, skill, chat, review, sync, …): buttons and
   dialogs, path operations, `useInterval`. No reason line needed.
2. **ACB foundation** — uses ACB vocabulary and two or more features use it (`useWriteAccess`,
   `departments.ts`). Its first line names the features that use it and why it cannot live in
   its owner feature.

When unsure, keep it in the owner feature and register the import exception: moving it to
`shared/` later is easier than moving it back. Existing files are reviewed when touched. If the
foundation files become hard to tell from the generic ones, consider `shared/domain/`.

## Where types go

Agents find a type by its name, so one name means one definition: two types called `Company`
with different fields send a fix to the wrong one. Three places:

1. **Contract types** (the server API, IPC): defined only in `shared/types/` and
   `client/shared/ipc-contract.ts`. The renderer imports them and never copies them; a re-export
   (`export type { X } from …`) is fine.
2. **One feature's types**: in that feature's `model.ts` (a `types.ts` when it grows), e.g.
   `Skill` / `SkillTool` in `features/skills/model.ts`, `FileEntry` in `features/files/fileTreeModel.ts`.
3. **Screen types several features share**: `client/src/types/` (`DepartmentConfig`,
   `CompanyView`). Build them from the contract type when they are one (`CompanyView extends
   Pick<Company, …>`); when they really are something else, give a name that says the role
   (`CompanyView`, `DepartmentFolder`), never the contract type's name (owner decision D10).

`client/tests/architecture-boundaries.test.ts` fails when an exported type's name is defined
(`interface X`, `type X =`) in another file of `client/src`, `client/shared` or `shared`; a file's
private `Props` / `Options` do not count unless the name is also exported somewhere. Deliberate
duplicates go into `TYPE_NAME_EXCEPTIONS` there with a reason (none today).

The same test caps `// eslint-disable… react-hooks/exhaustive-deps` in `client/src` at today's
count (`MAX_EXHAUSTIVE_DEPS_DISABLES`; lower it when one goes, never raise it) and requires a
reason with each: `-- reason` on the directive, or a comment on the line above.

## Effects

`useEffect` is for syncing with something outside React. The renderer had 172 (2026-10-31,
owner-approved reduction, refactor stage 3); most belong elsewhere. Sort each one:

- **A. Syncing with the outside world** — IPC event subscriptions, DOM / keyboard / mouse
  listeners, timers, observers, a third-party widget (CodeMirror), writing to an external store.
  Legitimate. Prefer the small shared hooks in `src/shared/hooks/` over a hand-written effect:
  `useIpcEvent(subscribe, handler, enabled?)` (a data-layer `on…` function), `useEventListener`
  (window / document / an element, `capture`, `passive`, `enabled`), `useInterval(fn, ms | null)`,
  `useIsNarrowerThan(px)` (a callback ref + ResizeObserver, no effect), `useLatestRef`; a focus on
  mount is `autoFocus`. These generic hooks live in `shared/hooks/` even before a second feature
  uses them. Comparing with the previous render (`useState` of the previous value, adjusted while
  rendering) replaces an effect that only reacts to a prop change (`useConsultationStatus`).
- **B. Derived state** — a value computed from props / state and stored with `setState` in an
  effect: compute it during render (`useMemo` only when it is expensive).
- **C. Chains that react to state to trigger an action** (save when the status turns ready,
  tell the parent, fill a field after a choice): do it in the event handler or callback that
  caused the change.
- **D. Data loading**: in the feature's small data hook (`hooks/use<Thing>.ts` over its
  `api.ts`), not inline in a component.
- **E. Resetting state when a prop changes**: give the component a `key` (or render it only while
  open) instead of clearing state in an effect.

New effects only for category A, preferably through the shared hooks. Also avoid an effect that
only copies the latest value into a ref (`xRef.current = x`): use `useLatestRef`
(`src/shared/hooks/useLatestRef.ts`); a parent's handle on a child is `useImperativeHandle`. `architecture-boundaries.test.ts`
caps the `useEffect(` calls in `client/src` (tests excluded) at today's count
(`MAX_USE_EFFECTS`): lower it when you remove effects, never raise it.

## How to move code

- **Move-only PRs are separate from PRs that change behaviour.** A move-only PR is `git mv` plus
  import updates: easy to review, and `git log --follow` keeps the history. Refactor in the next
  PR.
- In the same PR as a move: update every `.claude/rules/*.md` `paths:` entry and every path
  mentioned in rule text and code comments (rules reference `client/src/...` in ~30 places; a
  stale `paths:` silently stops a rule from loading), the preview pages that import the moved
  file (`client/tests/*-ui.tsx`), and the tests (move a node test next to its code with
  `git mv`).
- Security guards move together with their tests and keep their wording: `useWriteAccess`,
  `ReadOnlyBadge`, the not-downloaded refusals (`download-choices.md`), private folder names never
  shown to non-readers (`private-folders-client.md`). Error and log texts do not change in a move.
- Data formats stored in company folders do not change: the review sidecars
  (`<file>.md.review.<id>.json`, `<file>.md.reply.<hash>.json`, `<file>.md.review-request.json`) and their fields
  are read by members' apps and by the AI.
- Where something goes when several features use it: one feature uses it → that feature; two or
  more → `shared/`; only the skeleton uses it → the feature it belongs to (the skeleton may
  import any feature).

## Tests

- Node tests (`*.test.ts`) sit next to the code they test (`features/doc-review/model.test.ts`
  beside `model.ts`). How they run: `testing.md`.
- Tests that look at the whole tree or need fixtures stay in `client/tests/`:
  `architecture-boundaries.test.ts`, `sync/`, `sync-harness/`, `ipc-harness/`, `ui/`
  (Playwright), `perf/`, the preview pages `*-ui.tsx` / `*-ui.html`, the Swift tests.
- Write tests of the contract (input → promised result, failures, edge cases), not snapshots of
  today's behaviour; before writing one, be able to name the bug it catches.

## Planned shape of the screen (build toward it, do not hard-code around it)

These are the owner's decisions for the skeleton work (splitting `src/app/AppShell.tsx`, formerly `SkillCentricLayout.tsx`;
D7–D9, confirmed 2026-10-30).

- **Panel registry (built, Phase 4-6).** The left panel's tabs are a list of registered panels,
  today's four (スキル / ファイル / 検索 / 履歴) included: `src/features/workspace/leftPanels.ts`
  (`LeftPanel`: id, title, icon, optional badge count and visibility, mount policy, `onOpen`,
  `render`; `resolveLeftPanel`) drawn by `components/LeftPanelTabs.tsx`; `src/app/AppShell.tsx`
  registers the four. A remembered id with no shown panel opens the first one, and the saved id is
  kept (an extension's tab may register later; `skill-layout-state.spec.ts`). An extension's
  entry will carry the text its manifest declares and render the app's isolated frame, never its
  own React. Same idea as the agent registry (`client/shared/agents/registry.ts`).
- **Split-tree layout (built, Phase 4-3).** Pane sizes are a tree of row / column splits, the
  chat pane one leaf: `src/features/workspace/layoutTree.ts` (tree, limits, saved shape),
  `hooks/useSplitLayout.ts` (per company in localStorage `layout:<company id>` =
  `{ version: 1, trees: { screen, files } }`, written only when the member drags; nothing saved,
  unreadable, another version or another tree shape → today's look; sizes clamped to the limits in
  code; which pane is hidden is not saved) and `components/SplitView.tsx` on the in-house
  `ResizeHandle` (`react-resizable-panels` was prototyped and not taken: its collapse model
  differs from "drag 60 px past the max hides the chat", it stores percentages, and it released
  weekly with API breaks across majors). Today the tree has the screen's look only; the chat no
  longer assumes one panel on screen (refactor 5-7, `chat-ui-and-history.md` 「Several chat
  panes」): a tab is `isShown` in its pane, the voice key and `chat.*` commands go to the pane
  used last, a consultation is open in one pane at most, tabs are remembered per pane. A second
  chat leaf in the tree is what is left. Changing the saved shape means a new
  `version` and reading the old one (`layoutTree.test.ts`, `client/tests/ui/skill-layout-state.spec.ts`).
  A pane that takes the remaining space (and the left side while the chat is hidden) has
  `min-width` = its limit or 0, never the flex default `auto`: otherwise wide content (many tabs,
  a long source line) stretched it past the window, leaving the document in a sliver at the
  right edge and the show-chat button off screen. Inner flex rows that hold a document need
  `min-w-0` for the same reason (`skill-layout-state.spec.ts` 「⌘⇧C with …」).
- **Extension UI stays isolated.** Extension screens will run in an isolated frame and get only
  the operations they are allowed, never `window.electronAPI`. Keep the data layer split into
  read / write / send-outside operations so permissions can be decided in one place.

- **Commands (built, E1).** A feature that needs another feature's operation, or a shortcut,
  goes through a named command (`runCommand('file.open', { path })`), not a new React context, a
  store field or a window-wide key listener: `commands.md`.

Add a left tab by registering a panel, and a pane by changing the layout tree; ask first before
adding either for an extension (loading extensions is not built yet).
