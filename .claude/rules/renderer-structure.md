---
paths:
  - "client/src/**"
---

# Renderer structure (`client/src`): where code goes

The renderer is being moved, gradually, from folders by kind (`components/`, `hooks/`, `lib/`)
to folders by feature. The goal is that an agent finds what to touch from the folder name alone
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
    hooks/          data hooks several features use (write access, sparse checkout, departments)
    lib/            logic that belongs to no single feature (paths, file events, perf marks)
    ipc/            typed wrapper around window.electronAPI, when one is introduced
  stores/           app-wide state (appStore, authStore); feature state lives in its feature
  i18n/  types/
```

Planned features: `workspace` (department tabs, left panel tabs, panel layout, department
choice), `skills`, `files`, `editor`, `doc-review` (the Markdown review of a document),
`chat`, `sync`, `history`, `search`, `settings`, `auth`. Only create what you need; add a feature
folder when the code has no home among these.

Naming: `doc-review` is the review of a Markdown document (sidecar `*.review.*.json` files). Do
not call it `review`: in the app "review" already means 「確認をお願いする」 (`request_review`,
`ReviewRequestCard.tsx`, `src/lib/reviewRequest.ts`), which belongs to `chat`.

## Legacy folders

`components/` (all of it: `skill-ui/`, `common/`, `settings/`, `auth/`, `chat/`), `hooks/`,
`lib/` and `utils/` are legacy. `skill-ui/` in particular holds far more than skills (file tree,
editor, review, search, history, backups).

- New features and new modules of a feature go to `features/<name>/` (or `shared/`), never into a
  legacy folder.
- A small change to a legacy file stays in place. Move a legacy area when you are about to change
  it substantially, in its own move-only PR first (below).
- Do not add to the barrels `components/skill-ui/index.ts` and `components/settings/index.ts`;
  they go away when their files move.

## Principles

1. **Colocate what changes together.** A screen, its hooks, its pure logic, its types and its
   tests sit in one feature folder. Split by "changes together", not by line count.
2. **Dependencies point one way: `app → features → shared`.** A feature never imports another
   feature; `app/` composes them (pass data and callbacks through props). `shared/` never
   imports `features/` or `app/`. An unavoidable cross-feature import is listed, with its reason,
   in `client/tests/architecture-boundaries.test.ts`, like the agent-id exceptions there.
   `stores/`, `i18n/` and `types/` may be imported from anywhere.
3. **No barrel files.** No `index.ts` that re-exports a folder: import the file you need. The
   boundary test, not a public index, guards a feature's edges (barrels also defeat tree shaking).
4. **IPC goes through a data layer.** Components and hooks do not call `window.electronAPI`
   directly; a feature's `api.ts` (or `shared/ipc/`) does. Existing direct calls are an explicit
   list in the boundary test that may only shrink. The IPC contract itself (channels, arguments,
   `client/shared/ipc-contract.ts`) does not change for this: `ipc-and-main-process.md`.
5. **A screen component composes named hooks.** State, effects and IPC go into hooks named after
   their concern (`useDepartmentSelection`, `useEditorPersistence`); presentational parts take
   props and render; React-free computation is a pure function in `model.ts`. The chat panel
   (`components/chat/`, `chat-ui-and-history.md`) is the model to follow.
6. **About 300 lines per file.** A new or split file over ~300 lines states in one or two lines
   at its top why it stays whole. Do not split finer than that: hopping between tiny files costs
   more reading than it saves.
7. **Comments say why, not what.** Inline comments at most two lines; no links or change history
   in comments. Long background belongs in the internal `docs/architecture/` notes; rules that
   must hold belong in `.claude/rules/`.
8. **Nest at most 3–4 levels** (`features/<name>/components/X.tsx` is the deepest normal case).

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

These are the agreed direction for the skeleton work (splitting `SkillCentricLayout.tsx`). The
owner confirms them again before that work starts.

- **Panel registry.** The left panel's tabs (today `type LeftPanelTab = 'skills' | 'files' |
  'search' | 'history'` and `VALID_LEFT_TABS` in `SkillCentricLayout.tsx`) become a list of
  registered panels, the four current ones included, so a later extension adds a tab without
  special cases. A remembered tab id that is not registered falls back to the default tab. Same
  idea as the agent registry (`client/shared/agents/registry.ts`).
- **Split-tree layout.** Panel sizes become a tree of horizontal / vertical splits saved per
  company, the chat pane one leaf of it, instead of fixed columns with three widths. The first
  version builds only the tree that looks like today's screen; multiple chat panes come later and
  need the chat's "one panel on screen" assumptions (`isActive`, `pendingChatInput`, window-wide
  shortcuts) removed first.
- **Extension UI stays isolated.** Extension screens will run in an isolated frame and get only
  the operations they are allowed, never `window.electronAPI`. Keep the data layer split into
  read / write / send-outside operations so permissions can be decided in one place.

Do not add a fifth hard-coded left tab or another fixed width meanwhile: ask first.
