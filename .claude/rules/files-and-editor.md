---
paths:
  - "client/electron/company-watcher.ts"
  - "client/electron/features/manual/**"
  - "client/shared/manual.ts"
  - "client/tests/manual.test.ts"
  - "client/tests/ui/manual.spec.ts"
  - "client/electron/features/fs/**"
  - "client/electron/file-guards.ts"
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
  - "client/shared/video-files.ts"
  - "client/shared/large-file-limit.ts"
  - "client/shared/file-drop.ts"
  - "client/tests/video-electron*"
  - "client/tests/fixtures/video/**"
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
  allowed types, 20 MB — a video 100 MB —, a free name), `contextMenuItems.tsx`, `components/FileTreeHeader.tsx`.
  **Drops**: a drop on a folder row goes into that folder, on a file row into that file's folder
  (owner, 2026-11-26: an `.html` dropped on a file did nothing), on empty space into the
  department; a row dropped where it already is moves nothing (it used to become 「name (1)」).
  Every move still goes through `requestMove` (private-root refusal, private-edge confirm, reserved
  names) and main's not-downloaded refusal. **A Finder drop copies** (owner decision 2026-11-26, review of #869):
  `fs:copyFromExternal` never moves or deletes the original — it used to rename it in, or across volumes copy
  and unlink it, so a video dropped from a camera's card or the Desktop was gone from there. Main checks the
  destination like any write (allowed roots, not downloaded, reserved names / skill files, a free name: `wx`-like
  `COPYFILE_EXCL`, a folder made alone first) and removes what a failed copy wrote. Finder's allowed types and
  sizes are one rule, `dropRefusal` in `client/shared/file-drop.ts` (`DROP_EXTENSIONS`): the tree asks it for
  the per-file warning and **main decides** (the source's `stat`, the name it gets in the company folder; a
  folder named like a video is refused, a file without an extension is held to the size). HTML
  included since the sandboxed viewer (`doc-frame.md`); a refused file is named in the panel's
  warning (`role="alert"`, 「<name>: 非対応の形式」), and a newer warning keeps its full time.
  **Size** (owner, 2026-11-26): 20 MB, except a video (`.mp4` / `.mov`, `client/shared/video-files.ts`), which may be
  as large as sync still shares — `LARGE_FILE_THRESHOLD` (100 MB, `client/shared/large-file-limit.ts`, the one
  value sync's step 4 uses) — and is refused over it (「<name>: 100MBを超える動画はほかの人と共有できないため、入れられません」):
  nothing the drop takes in is then silently kept on this computer only. A video copied in another way (Finder,
  the AI) still meets sync's rule and 「共有されていません」 below. The menu's
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
  drop: copies a file from anywhere on the computer, the original untouched; where the dropped file lies comes from
  `getPathForFile`, preload's `webUtils.getPathForFile`, no IPC — `File.path` is gone since
  Electron 32), `ReservedNameOutbound` (the typed name goes to
  the server's `paths/check`), `FileDragOutbound` (Alt-drag hands a file to another app), plus the
  private-folder ports (`private-folders-client.md`).
- **Nothing is replaced by accident** (owner, 2026-10-31: 新規ファイル with an existing name emptied
  that file, a rename onto a taken name replaced it, and sync spread it). Main is the authority:
  `fs:createFile` writes with `wx`; `fs:rename` / `fs:move` / `fs:copyFromExternal` / `fs:copy`
  refuse a target that exists (`code: 'name_taken'`,
  「同じ名前のファイルまたはフォルダがすでにあります。別の名前にしてください。」,
  `electron/file-guards.ts`), except the same entry under another spelling (a case-only
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
  name, HTML accepted, type and 20 MB refusals, a video up to 100 MB accepted and one byte over refused
  (`ipc-fs.test.ts`: main's own refusals, the original kept — also across volumes —, a half copy removed),
  a drop on a file row landing in its folder, the warning's timer; hidden sidecars and the review mark).

## Previews never show a stale file

`src/shared/lib/fileVersions.ts` bumps a per-path counter on every event (read through
`features/editor/hooks/useFileVersion.ts`); images and PDFs load
`local-file://<path>?v=<n>` (`client/shared/local-file-url.ts`). The protocol handler
(`electron/local-file-protocol.ts`) drops the query, applies the allowed-roots check and answers
`Cache-Control: no-store`. An open file that is deleted shows a notice; one replaced reloads.

`local-file://` reads anything in the company folders, so it is for images and PDFs shown by the
app's own page only. Videos have a scheme of their own ("Videos" below). An HTML document never loads through it: it is shown in a view of its own
on the document session from `acb-doc://`, which serves only that document's own folder under a
CSP with no network (`doc-frame.md`). A change of the document or of a file it can load (a served
type in its folder or below: `htmlViewer.ts` `changeShowsIn`) reloads its view, keeping the scroll
position and zoom; data files and other folders do not.

## Videos (`.mp4`, `.mov`; owner, 2026-11-26)

- **Shown in the editor** with the browser's own player (`BinaryPreviews.tsx` `VideoPreview`: `<video controls
  preload="metadata">`, **never autoplay**), from `acb-media://video/<the whole path, one encoded segment>?v=<n>`
  (`client/shared/video-files.ts` `localVideoUrl`; the version as for images). Never loaded as text, never read
  whole over IPC (`isBinaryFile`).
- **Why a scheme of its own** (measured on Electron 45): Chromium's media player seeks — asks for a byte range,
  needed for a 100 MB file and for a `.mov` whose index (`moov`) is at its end, as cameras write it — only on a
  **standard** scheme; on `local-file://` (not standard, no host) the second range was dropped at once
  (「data source error」), and `net.fetch` of a `file://` URL answers a range 200 without `Content-Range`. So
  `acb-media` is registered `standard`, `secure`, `stream` (no fetch, CORS or CSP bypass) on the app's session
  only (not the document session), and its handler (`electron-adapter.ts` `serveLocalFiles`) serves **only a
  `.mp4` / `.mov` name inside the allowed roots by name** (`localVideoTarget`, `local-file-protocol.ts`), **then by
  real location** (`AllowedRoots.validate`: a link out of the company folder is refused), opened once with
  `O_NOFOLLOW | O_NONBLOCK` (a link as the file itself, even one pointing inside, is 404), `fstat` a regular file,
  streamed from that handle: 200 whole, 206 one range, 416 past the end, `Cache-Control: no-store` (`videoFileResponse`,
  `byteRange`). (A Drive video a document embeds plays in ACB's player on its own scheme and session,
  `acb-drive-video`, `standard` + `secure` only: `doc-frame.md` "ACB's player over Drive embeds (plan 4)".) A not-downloaded folder has no file to serve; a private folder's video is on disk only for its
  readers. The app page's CSP has `media-src 'self' acb-media:` (`index.html`); a plugin frame's and a document's
  CSP have no media source.
- **Codecs** (Electron 45 on a Mac, measured): H.264, HEVC (`hvc1`, through macOS), VP9 and AV1 play, in `.mp4`
  and `.mov` alike; **ProRes does not** (`MEDIA_ERR_SRC_NOT_SUPPORTED`). A video the player cannot read shows
  「この動画はアプリの中では再生できません（…）」 with ［ほかのアプリで開く］: `fs:openVideo` (port `VideoOutbound`,
  `features/editor/api.ts`) hands it to the OS's app — only a `.mp4` / `.mov` name, inside the allowed roots,
  `lstat` a regular file (no link, no folder or app bundle named `x.mov`): `openPath` launches whatever it is given.
- Tests: `tests/video-electron.test.ts` (real Electron, the real registration and handler under `index.html`'s CSP:
  a `.mov` with its index 3 MB past its start gets its length and seeks, VP9 plays, ProRes fails with code 4, a
  video outside or through a link out never plays; each of `standard`, the range answer, `media-src` and the
  real-location check mutation-checked), `ipc-fs.test.ts` (privileges; whole / range / 416; another type, outside,
  a link out, a folder; `fs:openVideo`'s refusals), `local-file-url.test.ts` (`byteRange`, the URL's one segment),
  `tests/ui/editor-panel.spec.ts` 「a video opens in a player…」 (controls, not playing, ProRes → ［ほかのアプリで開く］).

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
  disk. With edits, a disk change shows 「このファイルは外部で変更されました。あなたの編集はまだ保存していません
  （自動保存は止めています）」 with **one button, ［比べて選ぶ］**, and **pauses autosave**; deleted →
  「ファイルは削除されました。保存すると作り直します」 (［保存して作り直す］).
- **Compare and pick in one press** (owner decision 2026-11-28, UX 点検 10: 「自分の編集を残す」 only
  changed a mark, then 「保存…」 and a red overwrite confirm followed — three presses, and 「ディスクの内容を
  読み込む」 threw the edits away). ［比べて選ぶ］ opens `ExternalCompareView` (− 届いた版 / ＋ あなたの編集)
  with two buttons; **the version not picked is always kept first, so there is no confirm**:
  - ［自分の版を保存］: the disk version is kept (`editor:backupBeforeOverwrite` →
    `.backups/<ts>_editor_overwrite/`), then the edits are written.
  - ［届いた版を採用］: the edits — never on disk — are kept (`editor:backupEdits` → `.backups/<ts>_editor_edits/`,
    `keepGivenVersion`), then the tab shows the version that arrived.
  Both go to the private backups for a file in a private folder or a nested repository
  (`features/backups/keep-current.ts`, shared with 復元 and 「元に戻す」, `sync.md` "Backups").
  **No backup, nothing replaced**: a keep that fails (or is skipped, other than the file being gone)
  stops with 「…バックアップに残せなかったため、…していません。あなたの編集はこのタブにそのまま残っています。」.
  At the press the disk is read again against the version shown (`decideCompareChoice`), and again
  after the keep: changed meanwhile → nothing written, the view shows the new version and
  「比べている間に、ファイルがまた変わりました。…もう一度選んでください。」 (also when the watcher redraws it).
  Typing during ［届いた版を採用］'s keep → nothing replaced, pick again.
- Every save first re-reads the disk (`decideSave`): if it is no longer the loaded version,
  nothing is written — autosave shows the banner; ⌘S opens the compare view; closing the tab keeps
  it open and brings it to the front with the compare view. **Only when a keep has failed for that
  change** (`OpenFile.keepFailed`, cleared once the change is resolved) does closing offer
  「保存せずに閉じる」, saying 「閉じると、この編集は残りません（バックアップ履歴にも入りません）。」 (owner
  2026-11-28: a file whose versions can never be kept, e.g. under `.backups/`, would otherwise never
  close). Closing a tab whose save failed otherwise asks before discarding.
  Tests: `tests/ui/editor-tabs.spec.ts` (one press each way, what is kept, a failed keep replaces
  nothing, changed again while comparing, ⌘S), `editor-panel.spec.ts` (closing: the compare view, and
  「保存せずに閉じる」 only after a failed keep), `tests/editor-disk-state.test.ts`, `tests/ipc-fs.test.ts`
  「editor:backupEdits…」.
- **Leaving never drops edits** (stage-1 #1, 2026-10-31). Autosave writes only the shown tab, so
  an edit in a tab left within the second, a tab paused by an external change and a failed save
  were lost on sign-out or closing the window. Now every editor registers a saver
  (`src/shared/lib/unsavedEdits.ts` `registerUnsavedEditsSaver`, in `useFileSaving.ts`) that writes
  every tab with edits without asking; `features/editor/hooks/useSaveBeforeLeaving.ts` runs them and
  names what could not be saved (「保存できていない編集があります」 … 「保存せずに進む」 / 「キャンセル」,
  Enter does not confirm; `LeaveConfirmDialog`). **［保存せずに進む］ keeps those edits first** (owner
  2026-11-28): each editor's keeper (`registerUnsavedEditsKeeper`, same file) writes them through
  `editor:backupEdits` with reason `editor_left_unsaved` (`.backups/<ts>_editor_left_unsaved/`, or the
  private backups); only a keep with a `backupPath` counts, and only while the tab's text is still what
  was kept (the dialog has closed, so typing can go on): after the first round every editor saves
  again and keeps what is unsaved then (a text already kept is not kept twice), and only that round's
  answer counts. What could not be kept is named again —
  「バックアップにも残せなかった編集があります」 … 「それでも進む」 / 「キャンセル」 (Enter does not confirm;
  `leaving.ts` `notKeptQuestion`). Tests: `editor-panel.spec.ts` 「a tab that cannot be saved…」 /
  「保存せずに進む when the edits cannot be kept either…」 / 「…typed while the edits are being kept…」 /
  「…typing still going on during the last keep…」 / 「…a keep that was skipped…」, `src/shared/lib/unsavedEdits.test.ts`,
  `ipc-fs.test.ts` 「editor:backupEdits…」 (the reason; an unknown one keeps nothing). Sign-out (`AppShell` → `authStore.signOut`, the
  one sign-out: it also closes the company, so the login screen shows), switching company from
  the title bar (`download-choices.md`) and closing the main window go through it. Closing / quitting: main holds the window's close and asks the renderer
  (`app:closeRequested`; `electron/services/close-guard.ts`), `src/app/WindowCloseGuard.tsx`
  (mounted next to `App` on every screen) answers `app:closeResponse` `ack` at once, then
  `close` or `stay`; no `ack` within 3 s → it goes on anyway. A quit held this way quits after
  `close`. Either way, with a sync running the member is then asked and the window may wait for it;
  the renderer is asked to save once more after the wait, because typing goes on meanwhile
  (`ipc-and-main-process.md`, "closing during a sync"). Tests: `tests/close-guard.test.ts`, `tests/ui/editor-panel.spec.ts` 「closing the window
  saves every tab…」 / 「a tab that cannot be saved…」, `tests/ui/skill-layout.spec.ts` 「ログアウト…」.
- `src/features/editor/components/TabbedEditorPanel.tsx` only composes: `hooks/useOpenFiles.ts`
  (each tab's text, loading, the watcher: follow the disk / mark external / missing),
  `useFileSaving.ts` (autosave after 1 s, the explicit save, save before close, the compare
  view's two choices), `useMarkdownView.ts` (preview / source mode, scroll positions; the
  preview pane is keyed by file so each file restores its own),
  `useEditorReview.ts` (the review of the active document); parts `EditorTabBar`,
  `EditorNotices` (閲覧のみ, deleted, external change, notice, error), `ExternalCompareView`, `MarkdownPreview` (+
  `hooks/usePreviewSearch.ts`; a file's `---` frontmatter is left out of the preview and its `name` /
  `description` shown in a small quiet box above it — `markdownFrontmatter.ts`, owner 2026-11-23: a
  SKILL.md's block read as a bold underlined heading; the source view is unchanged;
  test `markdownFrontmatter.test.ts`), `MarkdownPreviewPane` (preview + review UI), `BinaryPreviews`
  (image, PDF, video: "Videos"), `HtmlDocumentPane` (an `.html` / `.htm` file's 見る: its document in a view of its
  own, `doc-frame.md` "The viewer (A2)"; 中身 is the code editor under the same ［見る｜中身］
  (`HtmlViewToggle`; back to 見る where the member was reading), ⌘⇧V switches, 見る by default and
  per tab for the app's run; the band of blocked internet parts `BlockedPartsBand` and the chat's
  ［見る］ through `editor.viewDocument`, A3); `fileKinds.ts` decides how a file is shown. No band under the editor (owner
  2026-11-04: it only said 「自動保存」 and took space): unsaved edits are the tab's dot
  (「保存していない変更があります」), a paused autosave is the external-change banner, a failed
  save is `EditorError` above the editor (`editor-panel.spec.ts` 「a failed autosave…」). ⌘S, ⌘⇧V and ⌘F are the commands
  `editor.save` / `editor.togglePreview` / `editor.find`, delivered only while the focus is in
  that editor (`commands.md`).
- The editor's IPC: `src/features/editor/api.ts`, `EditorReads` (text, PDF bytes) and
  `EditorWrites` (save, recreate the folder, keep the disk version or the tab's edits in the
  backups); nothing leaves the computer.
- Preview: `client/tests/editor-tabs-ui.html?view=external` (`editor-tabs.spec.ts`); `?view=tabs`
  for the panel itself (`editor-panel.spec.ts`: autosave after 1 s, ⌘S, closing saves first,
  preview tabs pinned on double-click / first edit, ⌘⇧V and its remembered mode, ⌘F in a
  preview, the preview's scroll position, image / PDF views).
- **Files and records share the middle's tabs** (plan A, 新しい画面のデモ 2026-11-02): the left
  tab (ファイル, やること, 探す…) is the narrow column of the `files` split and the middle
  (`TabbedEditorPanel`) is beside it for every left tab, so switching the left tab keeps what is
  open; a `wide` panel (Skill, a plugin's screen; `leftPanels.ts`) covers the middle, which stays
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

A Markdown preview — and an HTML document in its view (`doc-frame.md` "Review in the document
view", same files and shapes) — can be reviewed: comments on selected text, replies, resolved marks. Everything
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
  computed in memory (`markOrphanedComments`, with the document kind's `DocumentReading`: Markdown as
  written, HTML its page's words — also what an HTML review's `snapshot` keeps, its readable text);
  completed reviews stay even when all comments are
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

## Screen tabs (a tab whose page the screen draws; 2026-11-22, for 「記録の一覧」)

- A key `acb-view:<name>` (`editorTabs.ts` `viewTabKey` / `viewOfTab`; no path can start so) sits in the
  same tab list as files and records. `TabbedEditorPanel` draws it with the screen's `renderView(name)`
  and its tab with `viewLooks[name]` (title, icon); it never loads text or saves (`fileTabsOf` leaves it
  out), has no side column, drags only within the bar, and stands in the kind group その他.
- **Not kept**: a restart drops it and any pin saved on it (`useEditorPersistence`), 「タブを片づける」 closes it without listing it,
  and the AI's `tabs.list` leaves it out — it is no file or record to open again; its screen opens it in
  one press. Tests: `editorTabs.test.ts`, `tests/ui/records-table.spec.ts` (main screen).
- Users: 「記録の一覧」 (`tasks-ui.md` "The records table (B4)") and 「使い方」 ("The user manual" below). Not a
  framework: another kind of screen tab decides what it needs when it comes.

## The user manual (「使い方」, owner decision 2026-11-23)

The server's manual (`server.md` "The user manual": static pages built from `manual/`, at
`/manual/` for signed-in accounts) opened **inside the app**, in the middle, through the HTML viewer's document view — not
an external browser.

- **Opening**: the title bar's 「使い方」 (?) button, ⌘K 「使い方」, or any screen running the command
  `help.openManual { page?, anchor? }` (a chapter: the page id of `manual/pages/<id>.md`, and a heading's
  id) opens the screen tab `acb-view:manual` (`features/editor/manual.tsx`, `components/ManualPane.tsx`)
  at that page; each request mounts a new pane (`key`), so asking for another page opens it afresh.
  The pane is `DocViewSession` with a `DocViewSource` that asks `manual:open(pageId, anchor)` instead of
  `docView:open(path)` (no file events reload it); toolbar: zoom, ［書き出す］, ［もう一度表示する］; a web
  link pressed in it gets the viewer's confirmation (「外のサイトを開きますか？」).
- **Why through main and the document view** (the safe design): the doc session refuses every network
  request, so main (`electron/features/manual/site.ts`) fetches the server's `manifest.json` and the
  files it names, with the member's session cookies (`cookies: session.cookies`, as the other server
  calls; none → nothing asked), into this computer's copy (`<userData>/manual/<sha256 of the server origin>/site`):
  each file's path must pass `isManualFilePath` and its size and sha256 must match the manifest;
  redirects are refused; each request waits at most 8 s (then the kept copy shows); a refresh is
  built beside the copy and renamed into place, the old copy put back if the second rename fails,
  and a refresh cut between the two renames is put right on the next look (`recover`: the retired
  copy back, leftovers removed); unchanged files are reused; refreshes and exports run one at a
  time. Then `manual:open` opens a document view with **a grant for that copy's folder alone**
  (`views.open(doc, ticket, fragment)`: the heading as `#…`, encoded by main) **with no script**
  (`noScripts`: `script-src 'none'`, the manual has none — whatever a server put in its copy), with
  every other guard of `doc-frame.md` (no network, opaque origin, no app, no other file). Offline: the copy kept is shown; nothing kept → 「使い方を
  読み込めませんでした…」; a server with no manual (404) → 「このサーバーには使い方がまだありません。」.
  Signed out, or the server refuses the session (401 / 403): nothing of the answer is read or written,
  the copy kept is shown; nothing kept → 「ログインすると使い方を見られます。」 (`signed-out`). The
  export writes the copy kept the same way.
  The renderer sends only a page id (and heading text); only the view's id comes back.
- **「書き出す」** (`manual:export`, no argument): main asks the shell's save dialog
  (`DesktopShell.selectSavePath`, starting at Downloads with 「ACB の使い方」) **every time**; the chosen
  path must not lie in a company folder by name or by real location (`AllowedRoots.touches`; a
  company folder syncs to everyone) — checked before and again after the folder is made — and must be
  a new folder or an empty one (never a file, never a folder holding something). Main then writes
  the copy's files (sha256 checked again, each created with `wx`: nothing replaced; on a failure what
  it wrote is removed again, and the folder too when this export made it) and answers the folder; the pane says 「…に書き出しました。中の
  index.html をブラウザで開くと、インターネットなしでも読めます。」 (links are relative). Cancelled → nothing.
- Tests: `client/tests/manual.test.ts` (the copy: only manifest files, checked, a tampered file or a
  bad manifest path changes nothing, a refresh cut between its renames put right, offline / none /
  missing; signed out or refused — also part-way — the copy byte for byte as it was, none kept →
  `signed-out` and its words from open and export; the page's CSP without scripts; a failed export leaves no folder; the IPC: main window only before any
  fetch, dialog or write; a page through the grant at its heading, the copy's other files reachable,
  `..` and `manifest.json` not; unknown page ids refused; the export into the chosen folder only,
  never a company folder — also through a link —, a folder holding something, a file, or on cancel —
  each guard mutation-checked), `tests/ui/manual.spec.ts` (the title bar's button opens one tab at the
  index, again afresh, the refusal shown, ［書き出す］ says where).

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

## Companies without the shared company folder

The file tree, editor and file operations work in the plain working folder as in a company folder
(the main-process file guards find no company repository there, so the skill / agent-config /
reserved-name refusals of the app's own operations do not apply: the folder is the member's own).
Hidden there: 「やることにつなぐ…」 and, on a task card, ［＋ファイル・フォルダをつなぐ］ and ［新しいファイル］
(the server refuses company paths; `TaskCard` `sharedFolder`). A file dragged from the tree onto a task
card or a task row is linked as the member's own (「あなただけ」); the card's ［Google Drive の
ファイルをつなぐ］ is offered in every company (`tasks-ui.md` "Linking files", `records.md` "Drive and PC file links"). Also hidden: the file's side column
(つながっているもの, 前の版), the 「大きすぎて共有されていません」 marks and 閲覧のみ. 探す and Cmd+P read the
disk (`electron/plain-search.ts`). Skills show 「この PC だけの Skill です」 instead of 共有.

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
