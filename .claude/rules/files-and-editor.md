---
paths:
  - "client/electron/company-watcher.ts"
  - "client/electron/features/fs/**"
  - "client/electron/features/skills/**"
  - "client/electron/features/git-history/**"
  - "client/electron/git-search.ts"
  - "client/electron/local-file-protocol.ts"
  - "client/src/lib/fileEvents.ts"
  - "client/src/lib/fileTreeModel.ts"
  - "client/src/lib/fileVersions.ts"
  - "client/src/lib/folderExists.ts"
  - "client/src/lib/line-diff.ts"
  - "client/src/lib/editorTabs.ts"
  - "client/src/components/skill-ui/**"
  - "client/src/features/doc-review/**"
  - "client/shared/skills-refresh.ts"
  - "client/shared/editor-disk-state.ts"
  - "client/shared/local-file-url.ts"
  - "client/tests/company-watcher.test.ts"
  - "client/tests/file-tree-model.test.ts"
  - "client/tests/git-search.test.ts"
  - "client/tests/editor-*"
  - "client/tests/doc-review-ui.*"
  - "client/tests/ui/doc-review.spec.ts"
  - "client/tests/skills-refresh.test.ts"
---

# File watching, file tree, editor, search

The owner's requirement: anything that creates, changes, deletes or replaces a file — the AI
above all — shows in the app at once, without the member doing anything. And nothing here may
freeze the window on a 15k-file company. Measurements and the dropped chokidar design:
`docs/architecture/files-and-editor.md` (internal).

## Watcher (`client/electron/company-watcher.ts`, opened via `features/fs/watchers.ts`)

- One native `fs.watch(root, { recursive: true })` per company (FSEvents /
  ReadDirectoryChangesW / inotify on Node ≥ 20), opened by `SkillCentricLayout` when the company
  opens (`watchCompany`) and closed when it closes or the app quits — never per department or
  tab. chokidar opened one handle per directory and file and took ~30 s to close on the main
  thread; it stays only as the fallback for `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`.
- Raw events are collected per path for 100 ms, then classified by `lstat` into `add` / `addDir`
  / `unlink` / `unlinkDir` / `change` (≤ 2000 paths per batch). A write-temp-then-rename arrives
  as `add`; a removed folder may arrive as `unlink`, so consumers treat `unlink` as "this path and
  everything under it". `.git` (any depth), `node_modules`, `.workspace`, `.backups` and
  `.DS_Store` are dropped. The `disableWatchers` perf switch skips the watcher.
- Renderer: one subscription (`src/lib/fileEvents.ts` `subscribeFileChanges`); consumers filter
  by path prefix.

## File tree (`src/lib/fileTreeModel.ts`, `components/skill-ui/FileTreePanel.tsx`)

- One model per shown folder in a module-level registry (switching back is instant), all fed by
  the watcher. First view reads two levels (`readDirectoryTree(…, 1)`); deeper folders load on
  expand. An event re-reads only the changed path's parent if it is on screen; a collapsed or
  off-screen folder is marked stale and re-read when shown; `change` re-reads nothing
  (`planTreeRefresh`, unit-tested). Rows are memoised (`TreeRow`).
- The not-downloaded department prompt is an overlay (the tree stays mounted); the
  "folder exists" check is keyed per folder (`src/lib/folderExists.ts`); left tabs stay mounted
  once opened (history follows the department only while shown, since it runs `git log`).
- Not-downloaded folders and read-only badges: `download-choices.md`, `chat-write-guard.md`.

## Previews never show a stale file

`src/lib/fileVersions.ts` bumps a per-path counter on every event; images and PDFs load
`local-file://<path>?v=<n>` (`client/shared/local-file-url.ts`). The protocol handler
(`electron/local-file-protocol.ts`) drops the query, applies the allowed-roots check and answers
`Cache-Control: no-store`. An open file that is deleted shows a notice; one replaced reloads.

## Skills list freshness (`client/shared/skills-refresh.ts`)

`skills:list` caches one scan per root + department folder (`''` = company-wide) for 5 s, for
plain tab switches only. A scan is stale after any event at/under a `.claude/skills/` it reads
(root → company-wide; inside a department → that department), the `.claude` folder itself, the
root `.gitignore` (private marks → every scan), or a folder added/removed in the department.
Main drops stale scans in `sendFileChanges`; the renderer rescans the shown list and the
company-wide skills behind slash commands with `{ force: true }` (coalesced 120 ms, deferred
≤ 1 s while typing in chat) and after every successful sync, keeping the list on screen.
`.claude/commands` / `.claude/agents` are not listed.

## External changes to open files (`client/shared/editor-disk-state.ts`, `TabbedEditorPanel`)

- A tab remembers the disk version it loaded/saved (`originalContent`). No edits → it follows the
  disk. With edits, a disk change shows 「このファイルは外部で変更されました」 (ディスクの内容を読み込む
  after a confirm / 差分を見る — disk vs. edits / 自分の編集を残す) and **pauses autosave**; deleted →
  「ファイルは削除されました。保存すると作り直します」.
- Every save first re-reads the disk: if it is no longer the loaded version, autosave stops and
  ⌘S / closing the tab asks 「外部の変更を上書きして保存」 / 「キャンセル」 (Enter does not confirm).
  Overwriting first backs the disk version up (`editor:backupBeforeOverwrite` →
  `.backups/<ts>_editor_overwrite/`, or the private backups for a file in a private folder).
  Closing a tab whose save was cancelled asks before discarding.
- Preview: `client/tests/editor-tabs-ui.html?view=external`.

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
- The file tree hides sidecars (`isReviewSidecarFile`) and badges documents with unseen reviews
  (`localStorage review-seen:<doc path>`).
- Rules and shapes: `model.ts` (pure); every file read/write/delete: `api.ts` (the hook and
  components never call `window.electronAPI`); state in `hooks/useMarkdownReview.ts` and
  `hooks/useTextSelection.ts`; banners, side panel, popover, history and the snapshot diff in
  `components/`. Tests: `client/src/features/doc-review/model.test.ts` (names, hash, merging, unseen,
  text matching) and `client/tests/ui/doc-review.spec.ts` on the preview
  `client/tests/doc-review-ui.html` (the files written, byte for byte as 2-space JSON).

## Search, Cmd+P and folder history (`client/electron/git-search.ts`, `features/git-history/ipc.ts`)

- Content search is a fixed string, A–Z case-insensitive (`LC_ALL=C -F -i`), ≤ 20 matches per
  file and **≤ 500 in all**: git's output is streamed and the process killed there (`truncated` →
  「結果が多いため最初の500件を表示しています」), 15 s timeout, lines cut to ~300 chars around the
  match. Uncapped, 「の」 in one department sent 53 MB through IPC and froze the window.
- Searched: the worktree (tracked + untracked, never ignored), never `.backups/` / `.workspace/`
  or a not-downloaded folder (exclude pathspecs); readable private folders in their own clone
  (paths company-relative). Every read runs with `GIT_NO_LAZY_FETCH=1` + `GIT_OPTIONAL_LOCKS=0`
  so a search never downloads a blob. `''` = the whole company (pathspec `.`, never `/`).
- Folder history uses `git log -- :(literal)<folder>/` without `--follow` (simple-git's `file`
  option added it: 0.9 s instead of 0.02 s, same commits). `invalidateCommitCache()` also makes
  the visible history panel re-fetch.
- The review diff (`src/lib/line-diff.ts`) is Myers O((N+M)·D) in linear space with a work
  budget; past it the view says the diff is too large instead of building an O(m·n) table.
- Tests: `client/tests/git-search.test.ts`, `company-watcher.test.ts` (incl. a live temp-folder
  test), `file-tree-model.test.ts`, `local-file-url.test.ts`, `line-diff.test.ts`; perf budgets in
  `client/tests/perf/` (`testing.md`). Preview `download-folders-ui.html?view=filetree` exposes
  `__acbAddFile(dirRel, name)` to simulate a file the AI writes.
