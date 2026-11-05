---
paths:
  - "client/electron/company-watcher.ts"
  - "client/electron/features/fs/**"
  - "client/electron/features/skills/**"
  - "client/electron/features/git-history/**"
  - "client/electron/git-search.ts"
  - "client/electron/local-file-protocol.ts"
  - "client/src/shared/lib/fileEvents.ts"
  - "client/src/shared/lib/fileVersions.ts"
  - "client/src/shared/lib/folderExists.ts"
  - "client/src/features/doc-review/line-diff.ts"
  - "client/src/shared/ui/DiffViewer.tsx"
  - "client/src/app/AppShell.tsx"
  - "client/src/features/doc-review/**"
  - "client/src/features/skills/**"
  - "client/shared/skill-frontmatter.ts"
  - "client/tests/skill-frontmatter.test.ts"
  - "client/src/features/history/**"
  - "client/src/app/FileSidePanel.tsx"
  - "client/src/features/search/**"
  - "client/src/shared/ipc/diffs.ts"
  - "client/src/shared/ipc/file-events.ts"
  - "client/src/features/files/**"
  - "client/src/features/editor/**"
  - "client/src/app/WindowCloseGuard.tsx"
  - "client/electron/services/close-guard.ts"
  - "client/tests/close-guard.test.ts"
  - "client/src/shared/lib/unsavedEdits.ts"
  - "client/src/features/workspace/**"
  - "client/shared/skills-refresh.ts"
  - "client/shared/editor-disk-state.ts"
  - "client/shared/local-file-url.ts"
  - "client/tests/company-watcher.test.ts"
  - "client/tests/git-search.test.ts"
  - "client/tests/editor-*"
  - "client/tests/doc-review-ui.*"
  - "client/tests/file-tree-ui.*"
  - "client/tests/ui/file-tree.spec.ts"
  - "client/tests/ui/editor-*.spec.ts"
  - "client/tests/ui/doc-review.spec.ts"
  - "client/tests/skills-refresh.test.ts"
  - "client/shared/file-names.ts"
  - "client/tests/file-names.test.ts"
  - "client/tests/keep-work-ui.*"
  - "client/tests/ui/keep-work.spec.ts"
  - "client/tests/ui/tidy-tabs.spec.ts"
  - "client/tests/ui/tab-arrangement.spec.ts"
  - "client/src/features/settings/components/TidyTabsSetting.tsx"
---

# File watching, file tree, editor, search

The owner's requirement: anything that creates, changes, deletes or replaces a file — the AI
above all — shows in the app at once, without the member doing anything. And nothing here may
freeze the window on a 15k-file company. Measurements and the dropped chokidar design:
`docs/architecture/files-and-editor.md` (internal).

## Watcher (`client/electron/company-watcher.ts`, opened via `features/fs/watchers.ts`)

- One native `fs.watch(root, { recursive: true })` per company (FSEvents /
  ReadDirectoryChangesW / inotify on Node ≥ 20), opened by `useCompanyWatcher` (`src/features/files/hooks/`, used by `src/app/AppShell.tsx`) when the company
  opens (`watchCompany`, port `CompanyWatchReads` in `src/shared/ipc/file-events.ts`) and closed when it closes or the app quits — never per department or
  tab. chokidar opened one handle per directory and file and took ~30 s to close on the main
  thread; it stays only as the fallback for `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`.
- Raw events are collected per path for 100 ms, then classified by `lstat` into `add` / `addDir`
  / `unlink` / `unlinkDir` / `change` (≤ 2000 paths per batch). A write-temp-then-rename arrives
  as `add`; a removed folder may arrive as `unlink`, so consumers treat `unlink` as "this path and
  everything under it". `.git` (any depth), `node_modules`, `.workspace`, `.backups` and
  `.DS_Store` are dropped. The `disableWatchers` perf switch skips the watcher.
- Renderer: one subscription (`src/shared/lib/fileEvents.ts` `subscribeFileChanges`, over
  `src/shared/ipc/file-events.ts` `FileChangeReads`); consumers filter by path prefix.

## File tree (`src/features/files/`: `fileTreeModel.ts`, `components/FileTreePanel.tsx`)

- One model per shown folder in a module-level registry (switching back is instant), all fed by
  the watcher. First view reads two levels (`readDirectoryTree(…, 1)`); deeper folders load on
  expand. An event re-reads only the changed path's parent if it is on screen; a collapsed or
  off-screen folder is marked stale and re-read when shown; `change` re-reads nothing
  (`planTreeRefresh`, unit-tested). Rows are memoised (`components/TreeRow.tsx`; their handlers
  sit behind one ref so a row never re-renders for new callbacks).
- `components/FileTreePanel.tsx` only composes: `hooks/useFileTreeModel.ts` (the model, the
  visible rows), `useNotDownloadedFolders.ts` (placeholders, one-click download, the refusal),
  `useTreeSelection.ts` (⌘ / shift selection, the right-click menu's snapshot),
  `useFileOperations.ts` (new / rename / delete / copy path, their dialogs, the reserved-name and
  private-root refusals), `useTreeDragDrop.ts` (moves, the private-edge confirm, Finder drops:
  allowed types, 20 MB, a free name), `contextMenuItems.tsx`, `components/FileTreeHeader.tsx`. The menu's
  「やることにつなぐ…」 is the core's (owner decision 2026-11-01: the task list is the core's, so
  linking is too): it shows only when the panel gets `onLinkToTask` — `AppShell` passes it while
  the task list shows for the department on screen — and opens the task feature's chooser
  (`tasks-ui.md` "Linking files"). The tree's drag data (`src/shared/lib/dragTypes.ts`,
  `application/x-file-paths`) also links a file dropped on a task row or the task card. The
  plugin insertion point for this menu (milestone 5) stays for other plugins.
- The not-downloaded department prompt is an overlay (the tree stays mounted;
  `download-choices.md`); the "folder exists" check is keyed per folder (`src/shared/lib/folderExists.ts`,
  used by `src/features/workspace/hooks/useDepartmentAvailability.ts`); left tabs stay mounted
  once opened.
- The screen may ask the tree to show a folder (`FileTreePanel` `controls.reveal(absPath)`: each level re-read
  and opened, the folder selected and scrolled to; dot files shown) — 「今日のフォルダを開く」, `tasks-ui.md`.
- Not-downloaded folders and read-only badges: `download-choices.md`, `chat-write-guard.md`.
- **Too large to share** (owner decision 2026-11-02, 案A): a file sync keeps on this computer
  because it is over 100 MB (`sync.md` step 4) carries 「共有されていません」 in its row
  (`TreeRow` `tooLarge`, aria-label 「<name>は大きすぎて共有されていません」). Pressing it opens
  `components/TooLargeFileHelp.tsx`: why (over 100 MB never reaches anyone else; the file is still
  here) and what to do — 小さくする (and save it under a new name: the old name stays ignored),
  分ける, 共有のリンクで渡す. The list comes from main's `git:unsharedLargeFiles`
  (`findUnsharedLargeFiles` in `electron/sync/large-files.ts`: untracked files over the limit,
  ignored or not yet; tracked ones are shared and not marked; ignored folders — `.backups/`, private
  clones, nested repositories kept local — are not entered, so a private folder's own large files
  are not marked), held per company folder by `hooks/useUnsharedLargeFiles.ts`
  (`useSyncExternalStore`, reloaded 1.5 s after file events). The sync message's count stays.
  Tests: `tests/unshared-large-files.test.ts`, `file-tree.spec.ts` 「a file sync keeps on this
  computer for its size is marked…」.
- IPC goes through `src/features/files/api.ts`: `FileTreeReads` (listings, stat),
  `UnsharedLargeFileReads` (the too-large files, read-only git),
  `FileTreeWrites` (new file / folder, rename, move inside, delete), `FileImportWrites` (a Finder
  drop: takes a file from anywhere on the computer; where the dropped file lies comes from
  `getPathForFile`, preload's `webUtils.getPathForFile`, no IPC — `File.path` is gone since
  Electron 32), `ReservedNameOutbound` (the typed name goes to
  the server's `paths/check`), `FileDragOutbound` (Alt-drag hands a file to another app), plus the
  private-folder ports (`private-folders-client.md`).
- **Nothing is replaced by accident** (owner, 2026-10-31: 新規ファイル with an existing name emptied
  that file, a rename onto a taken name replaced it, and sync spread it). Main is the authority:
  `fs:createFile` writes with `wx`; `fs:rename` / `fs:move` / `fs:moveFromExternal` / `fs:copy`
  refuse a target that exists (`code: 'name_taken'`,
  「同じ名前のファイルまたはフォルダがすでにあります。別の名前にしてください。」,
  `features/fs/file-guards.ts`), except the same entry under another spelling (a case-only
  rename) and the review's temporary save file renamed over its own sidecar. `fs:writeFile` is
  saving and replaces on purpose (editor, sidecars). The tree checks typed names first
  (`client/shared/file-names.ts`: no `/ \ < > : " | ? *`, control characters, trailing space or
  dot, Windows device names, `.git`, > 255 bytes) and keeps the dialog open with the reason
  (`InputDialog` `error`); a multi-delete names what failed and keeps it selected. Tests:
  `ipc-fs.test.ts` 「…never replaces what is already there…」, `file-names.test.ts`,
  `file-tree.spec.ts`. Deletes still remove at once (moving them to the OS trash is an open
  proposal to the owner).
- UI test: `client/tests/ui/file-tree.spec.ts` on the preview `client/tests/file-tree-ui.html`
  (selection and ⌘/shift ranges, new file / rename / delete and their dialogs, the reserved-name
  and private-root refusals, internal moves and the private-edge confirm, Finder drops: free
  name, type and 20 MB refusals, hidden sidecars and the review mark).

## Previews never show a stale file

`src/shared/lib/fileVersions.ts` bumps a per-path counter on every event (read through
`features/editor/hooks/useFileVersion.ts`); images and PDFs load
`local-file://<path>?v=<n>` (`client/shared/local-file-url.ts`). The protocol handler
(`electron/local-file-protocol.ts`) drops the query, applies the allowed-roots check and answers
`Cache-Control: no-store`. An open file that is deleted shows a notice; one replaced reloads.

## Skills list freshness (`client/shared/skills-refresh.ts`)

A SKILL.md's frontmatter is YAML the AI reads: the app writes `name` / `description` as
double-quoted scalars (`yamlQuoted`; a line break, `---`, `: `, `#` typed into the wizard once
broke the block) and changes one entry in place (`setFrontmatterField`, the copy's new name);
`skills:list` reads plain, quoted, block and continued values like YAML does
(`client/shared/skill-frontmatter.ts`, test `tests/skill-frontmatter.test.ts` against `js-yaml`).

`skills:list` caches one scan per root + department folder (`''` = company-wide) for 5 s, for
plain tab switches only. A scan is stale after any event at/under a `.claude/skills/` it reads
(root → company-wide; inside a department → that department), the `.claude` folder itself, the
root `.gitignore` (older apps' private marks → every scan), or a folder added/removed in the department.
Private marks are kept in this computer's `.git/info/exclude` (`ACB private skills` block,
`sync/local-ignores.ts`); `skills:makePrivate` / `skills:publish` invalidate the scans themselves.
Main drops stale scans in `sendFileChanges`; the renderer rescans the shown list and the
company-wide skills behind slash commands with `{ force: true }` (coalesced 120 ms, deferred
≤ 1 s while typing in chat; `src/features/skills/hooks/useSkillsAutoRefresh.ts`) and after every
successful sync, keeping the list on screen.
`.claude/commands` / `.claude/agents` are not listed.
The renderer reaches skills only through `src/features/skills/api.ts`: ports `SkillReads` (list,
read a file), `SkillToolRuns` (start / stop a skill's tool), `SkillOutbound` (open the tool's
page in the browser), `SkillWrites` (new skill, copy, 育成中) and `SkillSharingWrites` (private /
publish: the `.git/info/exclude` line — or an older app's line in the shared `.gitignore`, which
publish also removes — that decides whether the next sync shares the skill; a company folder
without a `.git` folder is refused).
A member who may not change skill files (`shared/core/skill-files.ts`; `push-check.md`) is told so
in a sentence before anything is written: `guards.skillRefusal` behind `fs:writeFile`, `fs:createFile`,
`fs:delete`, `fs:rename` / `fs:move` (both ends), `fs:copy`, a backup restore, 育成中 and
`privateFolders:reservedPathRefusal` (what the tree, the editor's failed save and the copy dialog
ask). `skills:publish` asks with `sharing: true`: 公開する is where a private skill would reach the
server. A skill kept on this computer is otherwise the member's to write, and an empty folder is
never refused. 「他からコピー」 by someone who may not share keeps the copy on this computer
(`useSkillActions`): the way to change and try a shared skill before asking for it to be shared.
The same handlers (through `writeRefusal`) also refuse agent config for anyone but owner/admin
(`guards.agentConfigRefusal`, `isAgentConfig`: `.mcp.json`, `.codex/`, and the rest of `.claude/`
/ `.agents/` beyond skill and instruction files). Unknown authority allows. Tests: `client/tests/skill-file-refusal.test.ts`,
`client/tests/ipc-fs.test.ts` 「fs and skills handlers…」.

New skill and copy never replace a skill folder that exists (checked first, then main's
`fs:createFile` / `fs:copy`); a new skill is marked private before anything is written, and
`skills:makePrivate` refuses (`already_shared`) a folder the index or `origin/main` already has —
an ignore line does not stop sync from sharing tracked files (`features/skills/shared-check.ts`,
test `ipc-app.test.ts` 「skills:makePrivate never marks…」). The wizard and the copy modal wait for
the result, disable their buttons meanwhile and show the reason (`role="alert"`); preview
`client/tests/keep-work-ui.html?view=skills` (`tests/ui/keep-work.spec.ts`).

## External changes to open files (`client/shared/editor-disk-state.ts`, `TabbedEditorPanel`)

- A tab remembers the disk version it loaded/saved (`originalContent`). No edits → it follows the
  disk. With edits, a disk change shows 「このファイルは外部で変更されました」 (ディスクの内容を読み込む
  after a confirm / 差分を見る — disk vs. edits / 自分の編集を残す) and **pauses autosave**; deleted →
  「ファイルは削除されました。保存すると作り直します」.
- Every save first re-reads the disk: if it is no longer the loaded version, autosave stops and
  ⌘S / closing the tab asks 「外部の変更を上書きして保存」 / 「キャンセル」 (Enter does not confirm).
  Overwriting first backs the disk version up (`editor:backupBeforeOverwrite` →
  `.backups/<ts>_editor_overwrite/`, or the private backups for a file in a private folder;
  `features/backups/keep-current.ts`, shared with 復元 and 「元に戻す」, `sync.md` "Backups").
  Closing a tab whose save was cancelled asks before discarding.
- **Leaving never drops edits** (stage-1 #1, 2026-10-31). Autosave writes only the shown tab, so
  an edit in a tab left within the second, a tab paused by an external change and a failed save
  were lost on sign-out or closing the window. Now every editor registers a saver
  (`src/shared/lib/unsavedEdits.ts` `registerUnsavedEditsSaver`, in `useFileSaving.ts`) that writes
  every tab with edits without asking; `features/editor/hooks/useSaveBeforeLeaving.ts` runs them and
  names what could not be saved (「保存できていない編集があります」 … 「保存せずに進む」 / 「キャンセル」,
  Enter does not confirm; `LeaveConfirmDialog`). Sign-out (`AppShell` → `authStore.signOut`, the
  one sign-out: it also closes the company, so the login screen shows) and closing the main
  window go through it. Closing / quitting: main holds the window's close and asks the renderer
  (`app:closeRequested`; `electron/services/close-guard.ts`), `src/app/WindowCloseGuard.tsx`
  (mounted next to `App` on every screen) answers `app:closeResponse` `ack` at once, then
  `close` or `stay`; no `ack` within 3 s → it goes on anyway. A quit held this way quits after
  `close`. Either way, with a sync running the member is then asked and the window may wait for it;
  the renderer is asked to save once more after the wait, because typing goes on meanwhile
  (`ipc-and-main-process.md`, "closing during a sync"). Tests: `tests/close-guard.test.ts`, `tests/ui/editor-panel.spec.ts` 「closing the window
  saves every tab…」 / 「a tab that cannot be saved…」, `tests/ui/skill-layout.spec.ts` 「ログアウト…」.
- `src/features/editor/components/TabbedEditorPanel.tsx` only composes: `hooks/useOpenFiles.ts`
  (each tab's text, loading, the watcher: follow the disk / mark external / missing),
  `useFileSaving.ts` (autosave after 1 s, the explicit save, save before close, load the disk
  version, the confirm), `useMarkdownView.ts` (preview / source mode, scroll positions; the
  preview pane is keyed by file so each file restores its own),
  `useEditorReview.ts` (the review of the active document); parts `EditorTabBar`,
  `EditorNotices` (閲覧のみ, deleted, external change, notice, error), `MarkdownPreview` (+
  `hooks/usePreviewSearch.ts`), `MarkdownPreviewPane` (preview + review UI), `BinaryPreviews`
  (image, PDF); `fileKinds.ts` decides how a file is shown. No band under the editor (owner
  2026-11-04: it only said 「自動保存」 and took space): unsaved edits are the tab's dot
  (「保存していない変更があります」), a paused autosave is the external-change banner, a failed
  save is `EditorError` above the editor (`editor-panel.spec.ts` 「a failed autosave…」). ⌘S, ⌘⇧V and ⌘F are the commands
  `editor.save` / `editor.togglePreview` / `editor.find`, delivered only while the focus is in
  that editor (`commands.md`).
- The editor's IPC: `src/features/editor/api.ts`, `EditorReads` (text, PDF bytes) and
  `EditorWrites` (save, recreate the folder, back up before overwriting); nothing leaves the computer.
- Preview: `client/tests/editor-tabs-ui.html?view=external` (`editor-tabs.spec.ts`); `?view=tabs`
  for the panel itself (`editor-panel.spec.ts`: autosave after 1 s, ⌘S, closing saves first,
  preview tabs pinned on double-click / first edit, ⌘⇧V and its remembered mode, ⌘F in a
  preview, the preview's scroll position, image / PDF views).
- **Files and records share the middle's tabs** (plan A, 新しい画面のデモ 2026-11-02): the left
  tab (ファイル, やること, 探す…) is the narrow column of the `files` split and the middle
  (`TabbedEditorPanel`) is beside it for every left tab, so switching the left tab keeps what is
  open; a `wide` panel (スキル, a plugin's screen; `leftPanels.ts`) covers the middle, which stays
  mounted. A record is a tab under the key `acb-record:<id>` (`editorTabs.ts` `recordTabKey`; no
  path can have it), drawn with its kind's icon and title (`RecordTabLook`, told by the card once
  read: `onLoaded`), and its card is drawn by the screen (`renderRecord`); only file tabs load
  text, save or check the disk. `record.open` / `file.open` open a tab for good, a list row the
  preview tab; ← → go over all tabs. Test: `tests/ui/tasks-layout.spec.ts`, `editorTabs.test.ts`.
- Open tabs (files and records), the active tab and the left panel tab are saved per company in localStorage
  `editor:<company id>` = `{ openFiles, activeFilePath, leftTab, records, pinned }` (`records`: the open
  record tabs' titles, so they show at once after a restart; a record tab is not checked against
  the disk; `pinned`: the tabs pinned 固定, "Tidying the tabs"; missing = none)
  (`src/features/editor/hooks/useEditorPersistence.ts`). They are read during the first render
  (no empty editor before the tabs appear); tabs of files deleted meanwhile are dropped in the
  background; any `leftTab` string is kept and one no registered panel has opens the default tab
  (`renderer-structure.md`, panel registry). Existing installs hold this shape:
  keep reading it (`client/tests/ui/skill-layout-state.spec.ts` seeds it).

## Tidying the tabs (「タブを片づける」, owner decision 2026-11-04, OneTab-style)

- **Pinned (固定)** is its own mark (not the preview tab's 「固定」 on double-click, `pinFile`): a
  tab's right-click menu or the tabs' 「…」 → 「このタブを固定する」; a pinned tab shows a pin
  (pressing it unpins). Closing a pinned tab forgets the mark.
- ［タブを片づける］ (the tabs' 「…」, command `tabs.tidy`, also the AI's): every editor's saver runs
  first (`saveUnsavedEdits`, as on leaving); a tab still holding edits (changed on disk, the write
  failed) stays open and the notice names it — **a tidy never loses an edit**. Every other tab
  but the pinned ones closes and is saved as one group (time, company day, by hand / automatic)
  in 「片づけたタブ」. A one-line notice above the tabs says what happened (`TidyNoticeBar`).
- **Daily tidy**: when a company's tabs are restored (`useEditorPersistence` `onRestored`) on a
  company day (`companyDay`, Japan time like 今日のフォルダ) later than the one remembered, the
  restored tabs are tidied the same way (`auto`). No day remembered (first open after the update,
  a new company) → nothing is closed. Once per company day; 設定 → 自分の設定 「前の日のタブを自動で
  片づける」 (per Mac, on by default) turns it off. The first time it closes something:
  「毎日、前の日のタブを自動で片づけます（設定でオフにできます）」 with 「片づけたタブを見る」. Only on
  open: an app left open overnight is not tidied under the member.
- **「片づけたタブ」** (`components/TidiedTabsDialog.tsx`; from the tabs' 「…」, the notice, ⌘K
  「片づけたタブ」): sections per company day, newest first, ［全部開き直す］［この日の分を消す］; an item
  opens alone. Files are kept by company path (they follow a moved company folder); a file gone
  (checked on this computer) or a record the server answers `notFound` for (first 60, offline =
  unknown) is greyed 「見つかりません」 and can still be removed. Reopened items leave the list.
  Cap: the last 30 tidies and 500 tabs, oldest dropped (the list's footer and the tidy notice say so).
- **Storage: this Mac only** — localStorage `tidiedTabs:<company id>` (groups),
  `tidiedTabs:lastDay:<company id>`, `acb.tabs.dailyTidy` (`off` when switched off),
  `acb.tabs.dailyTidyNoticeShown`; nothing reaches the server or another company.
- Code: `features/editor/tidyTabs.ts` (pure rules + the store, Storage injected),
  `hooks/useTabTidying.ts` (pinning, the commands, the daily tidy, restoring),
  `components/TabTidyingControls.tsx` (the 「…」 menu, the notice, the list as `AppShell` /
  `AppDialogs` place them). The AI's side (another company refused, private names hidden):
  `commands.md` "Handed to the AI". Tests:
  `tidyTabs.test.ts` (pinned / unsaved kept, cap, once per day, the switch, local per company),
  `tests/ui/tidy-tabs.spec.ts` (tidy → list → restore, missing items, saving first, the daily
  tidy and its notice, the AI's commands).
- A tidy can take **one kind** (`tabs.tidy { kind }`: a kind chip's menu 「この種類（…）を片づける」, the
  「…」 for the shown tab's kind) or **one named group** (`{ group }`: id from the chip, or the name
  the AI read; 「このまとまりを片づける」) — same rules (pinned stay, edits saved first). **A kind tidy takes
  only the tabs under that kind's chip**: a tab in a named group (unpinned) stands under the group's
  chip and stays. Unknown group → `{ error }`, which the AI gets as `ok: false` (nothing closes).
- **Every tidy keeps each tab's named group** (item `tabGroup: { name, color }`; whole, daily, by kind
  or by group), so reopening puts it back in a group of that name (`regroup`: the open group of that
  name, else a new one with the colour it had). A group left with no tab goes with the tidy.
  Without this, the daily tidy (on by default) dissolved every group overnight.

## Arranging the tabs (owner 2026-11-04, after the tidy: order, kinds, named groups)

- **One order, shown in runs.** `openFiles` stays the one order (saved as before); the bar shows a
  stable split of it (`tabArrangement.ts` `arrangeTabs`): **pinned first**, then the member's
  **named groups** (まとまり, in the order made), then the rest — one run, or, with
  「種類ごとにまとめる」 on, by kind in a fixed order: ファイル, やること, the bundles (named by the labels
  of the ones open: 「案件・プロジェクト」, `bundleWords`), 会議の記録, 決めたこと, その他 (a record not
  read yet, other kinds). A kind group and a named group start with a chip (icon or colour, name,
  count; press = fold / open, its 「…」 or right-click = menu). A folded group still shows the tab
  that is open (the chip is ringed): the member always sees where they are. A new tab lands at the
  end of its run (its kind group when grouped; outside any named group).
- **Drag inside the bar moves; anywhere else links** (the drop target decides). A tab's drag still
  carries the record / file data with `effectAllowed: link` (a tab never moves a file in the tree)
  plus `TAB_DRAG_TYPE` (`dragTypes.ts`); the bar takes it only for its own tab (a ref, not state:
  changing the dragged element on dragstart can cancel the drag), shows an insertion line
  (`data-drop-line`) and moves it (`moveTab`). Rules (`canMoveTab`): a pinned tab moves only among
  the pinned and nothing else enters them; beside a tab of a named group a tab joins it, beside one
  outside it leaves its group; by kind, a tab stays among its kind. Dropped on a named group's chip
  it joins at the end (`addToGroup`).
- **Named groups (Chrome-style)**: a tab's right-click or the 「…」 → 「新しいまとまりに入れる…」 (name +
  one of six colours, `TabGroupParts.tsx` on `InputDialog`), 「〇〇に入れる」, 「まとまりから外す」; the
  chip's menu: たたむ / ひらく, 名前と色を変える, このまとまりを片づける, まとまりを解く (tabs stay open). A
  pinned tab stands with the pinned (its membership is ignored meanwhile). A group with no open tab
  left is not shown and is dropped on the next change (`pruneGrouping`). **Names are unique** as the
  member reads them (`groupNameKey`: NFKC, A–Z case, outer spaces): a taken name keeps the dialog
  open with 「同じ名前のまとまりがあります。別の名前にしてください。」 (the AI's `group` and reopening
  rely on the name).
- **Storage: this Mac only**, per company, localStorage `tabGroups:<company id>` =
  `{ byKind, collapsedKinds, groups: [{ id, name, color, collapsed? }], members: { <tab key>: <group id> } }`
  (unreadable parts dropped, `parseGrouping`); beside `editor:<company id>`, so older apps reading that
  entry are unaffected. The AI's `tabs.list` gives each open tab `kindId` and `tabGroup` (name).
- Code: `features/editor/tabArrangement.ts` (pure rules + the store), `hooks/useTabArrangement.ts`
  (mounted by `AppShell`), `components/EditorTabBar.tsx`, `TabGroupParts.tsx`, the 「…」 in
  `TabTidyingControls.tsx`. Tests: `tabArrangement.test.ts` (runs, moves, joining / leaving,
  pruning, ungrouping, unique names, regrouping, the store), `tidyTabs.test.ts` (an item's group kept),
  `tests/ui/tab-arrangement.spec.ts` (reorder + pinned + kept; reorder vs drag out to the
  consultation on `chat-header-ui.html?tabs=1`; by kind, folding, a kind tidied — not a grouped tab of
  that kind; named groups made, a taken name refused, joined, renamed, tidied and reopened; the daily
  tidy keeping groups; the AI by kind / group, unknown group `ok: false`).

## Document review (`src/features/doc-review/`, shown inside `TabbedEditorPanel`)

A Markdown preview can be reviewed: comments on selected text, replies, resolved marks. Everything
lives in sidecar files next to the document, one writer per file so teammates never conflict in
git. These names and JSON shapes are stored in company folders and read by every member's app
and by the AI: **do not change them by one character** (no renamed key, no reordered key).

- `<doc>.review.<uuid>.json` — `{ version: 1, review: { id, reviewerName, reviewerEmail, status
  (in_progress | completed), createdAt, completedAt, comments[], snapshot? } }`, written only by
  the reviewer; `snapshot` (the document at completion) feeds 「変更を確認」.
- `<doc>.reply.<replyFileKey(email, memberId)>.json` — `{ version, authorName, authorEmail,
  replies[], resolutions? }`: everyone else's replies and resolved marks (`{ reviewId, commentId,
  resolved }`, last one wins over the review file). With an email the key is `emailToHash(email)`
  (must keep its output: existing files are found by it); without one, the member id. Every
  reply file in the folder is read, whoever wrote it.
- `<doc>.review-request.json` — `{ requestedBy, requestedAt }` (button hidden, kept for a Slack
  notification; `readReviewRequestFile` & co. in `api.ts`). Not the chat's 「確認をお願いする」
  (`request_review`, `client/shared/review-request.ts`).
- **Opening or viewing a document never writes or deletes a sidecar** (owner, 2026-10-29: members
  fix the document from the reviews, so everyone must still be able to read them). 「位置不明」 is
  computed in memory (`markOrphanedComments`); completed reviews stay even when all comments are
  resolved and remain in レビュー履歴. Only the reviewer's own actions write their review file;
  replies and resolved marks go to the member's own reply file.
- Saving (`api.ts`): every sidecar write goes to `.<name>.acb-tmp-<random>` next to it
  (`client/shared/temp-save-file.ts`; sync never commits one, `sync-guards.md`) and is
  renamed over the target (nobody — sync, the AI — reads half a file), retried twice (150 / 400
  ms; `fs:writeFile` only answers yes/no), one save at a time per file, and the reply file is
  changed on what is on disk at that moment. The reviewer's file changed since last read (sync
  from another computer, the AI) is merged (`mergeReviewEdits`). A sidecar that exists but cannot
  be read or parsed is never overwritten. A load for a document no longer shown is dropped.
- A save that still fails changes nothing on screen and says so in plain Japanese
  (`components/ReviewSaveError.tsx`): a comment or reply keeps its text in its box (press the
  button again); other actions offer 「もう一度試す」.
- The file tree hides sidecars (`isReviewSidecarFile`) and badges documents with unseen reviews
  (`localStorage review-seen:<doc path>`).
- Rules and shapes: `model.ts` (pure); every file read/write/delete: `api.ts` (the hook and
  components never call `window.electronAPI`), over two small ports — `ReviewReads` (readFile,
  readDirectory, exists) and `ReviewWrites` (writeFile, renameItem, deleteItem); nothing is sent
  outside the computer; state in `hooks/useMarkdownReview.ts` and
  `hooks/useTextSelection.ts`; banners, side panel, popover, history and the snapshot diff in
  `components/`. Tests: `client/src/features/doc-review/model.test.ts` (names, hash, merging, unseen,
  text matching, merging edits), `api.test.ts` (atomic write, retries, unreadable files, one at a
  time) and `client/tests/ui/doc-review.spec.ts` on the preview
  `client/tests/doc-review-ui.html` (the files written, byte for byte as 2-space JSON).

## Places, ← → and the file's side column (milestone 5 U8, design §7)

- The editor area shows a file tab or a record's card (`features/records/components/RecordCard.tsx`,
  `records.md` "The app's views"). `features/editor/places.ts` (pure) + `hooks/usePlaceHistory.ts`
  keep the places shown, like a browser: ← / → (`components/PlaceNavigation.tsx`, in front of the
  tabs) step through them, a new place drops the forward ones, ≤ 50, a new company starts over;
  the restored active tab is the first place. `AppShell` records a place for what the member
  chose (tree, tab, Cmd+P, `file.open`, `record.open`); ← to a closed file opens it again.
  `TabbedEditorPanel` takes the parts as slots (`navigation`, `overlay` = the card shown instead
  of the file with the tabs kept, `aside`), so the editor knows nothing of records.
- Beside the open file, `src/app/FileSidePanel.tsx` (foldable, `localStorage editor:side-open`)
  composes 「つながっているもの」 (`features/records/components/FileConnections.tsx`) and 「前の版」
  (`features/history/components/FileVersions.tsx`).
- **No 履歴 tab** (owner decision §7-8): the commit list of a folder is gone; a file's earlier
  versions are reached from the file. 「前の版」 lists `git log` of that one file (30) and shows what
  a version changed (`DiffModal`, commit mode); it reads again after every sync
  (`features/history/refresh.ts` `refreshFileVersions`, called by `AppShell`). Putting an earlier
  version back is not built (the 履歴 tab had none either; 復元 of `.backups` is unchanged).
- UI tests: `tests/ui/skill-layout.spec.ts` (search with records, the card, ← →, 「前の版」 after a
  sync), `skill-layout-state.spec.ts` (the side column keeps the editor inside the window).

## Search, Cmd+P and a file's history (`client/electron/git-search.ts`, `features/git-history/ipc.ts`)

- Content search is a fixed string, A–Z case-insensitive (`LC_ALL=C -F -i`), ≤ 20 matches per
  file and **≤ 500 in all**: git's output is streamed and the process killed there (`truncated` →
  「結果が多いため最初の500件を表示しています」), 15 s timeout, lines cut to ~300 chars around the
  match. Uncapped, 「の」 in one department sent 53 MB through IPC and froze the window.
- Searched: the worktree (tracked + untracked, never ignored), never `.backups/` / `.workspace/`
  or a not-downloaded folder (exclude pathspecs); readable private folders in their own clone
  (paths company-relative). Every read runs with `GIT_NO_LAZY_FETCH=1` + `GIT_OPTIONAL_LOCKS=0`
  so a search never downloads a blob. `''` = the whole company (pathspec `.`, never `/`).
- `git:log` takes a folder or one file: `git log -- :(literal)<path>` without `--follow`
  (simple-git's `file` option added it: 0.9 s instead of 0.02 s on a folder, same commits). A path
  inside a readable private folder is read from that folder's own clone (the deepest `.git` under
  the company root, validated by the allowed roots), as is `git:commitFileDiff` (`repoHolding`;
  test `ipc-git.test.ts`). `git:showCommit` was removed with the 履歴 tab.
- The 探す tab (formerly 検索; the narrow column, `SearchPanel`; `records.md` "探す"): live as the
  member types (250 ms after the last key, never mid-IME, Enter at once, Esc clears), one row per
  file however many lines match (its best line shown; it opens at that line, `gotoLine`), records and
  consultations beside the files. The file contents are grepped in the department on screen, or the
  whole company after 「全社で探す」 — still one capped `git:grep` per search, the previous one
  stopped; file names come from one `git:listFiles` of the company kept 30 s; only the found files'
  times are read (`fs:stat`, ≤ 80). A not-downloaded folder in the scope is said in one line
  (「ダウンロードしていないフォルダのファイルは探していません」); its files are never searched.
- The review diff (`src/features/doc-review/line-diff.ts`) is Myers O((N+M)·D) in linear space with a work
  budget; past it the view says the diff is too large instead of building an O(m·n) table.
- Tests: `client/tests/git-search.test.ts`, `company-watcher.test.ts` (incl. a live temp-folder
  test), `src/features/files/fileTreeModel.test.ts`, `local-file-url.test.ts`, `line-diff.test.ts`; perf budgets in
  `client/tests/perf/` (`testing.md`). Preview `download-folders-ui.html?view=filetree` exposes
  `__acbAddFile(dirRel, name)` to simulate a file the AI writes.
- The renderer reaches these through read-only ports: `src/features/search/api.ts`
  (`CompanySearchReads`: the file list for Cmd+P, content search, a hit's text),
  `src/features/history/api.ts` (`FileVersionReads`: a file's log) and, for
  `DiffViewer` (shown by the sync preview and 「前の版」), `src/shared/ipc/diffs.ts` (`DiffReads`).
  Record hits go through `RecordSearchOutbound` (⌘K) and `RecordFindOutbound` (the 探す tab) in
  search's `api.ts` (the words go to the server); a found file's time through `FileTimeReads`.
