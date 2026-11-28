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
  - "client/src/app/editorSelection.ts"
  - "client/scripts/check-bundle-size.mjs"
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
  rename) and the review's temporary save file renamed over its own sidecar. A rich reply kept as a page
  (`replyPage:save`, `chat-ui-and-history.md` "Rich replies: ［大きく見る］…") is created with `wx` too, at a name main
  chooses (「名前 (2).html」 when taken), in the today folder's `ページ/` only. `fs:writeFile` is
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
  was kept (the dialog has closed, so typing can go on, **in any tab**). The rounds are
  `leaveAfterSaving` (`features/editor/leaving.ts`, pure, its steps injected): save every tab, keep what
  is unsaved (a text already kept is not kept twice), and go on only when `unsettledEdits()` is empty —
  each editor's synchronous check over **all** its tabs (`registerUnsettledEditsCheck`: dirty and
  neither written by that round nor kept with exactly its text), read with no await before the answer
  (code review 2026-11-28: an edit in an already saved tab during the last keep was in no list, and the
  window closed before its autosave). A tab not kept because it was typed in gets one more round; not
  kept twice in a row is asked (a tab given up with ［それでも進む］ is not asked about again in that leaving);
  still typing after 5 rounds is asked again (「保存できていない編集があります」).
  What could not be kept is named again —
  「バックアップにも残せなかった編集があります」 … 「それでも進む」 / 「キャンセル」 (Enter does not confirm;
  `leaving.ts` `notKeptQuestion`). Tests: `editor-panel.spec.ts` 「a tab that cannot be saved…」 /
  「保存せずに進む when the edits cannot be kept either…」 / 「…typed while the edits are being kept…」 /
  「…typing still going on during the last keep…」 / 「…a keep that was skipped…」 / 「…an edit in another tab
  made during the last keep…」 (mutation-checked), `src/features/editor/leaving.test.ts`, `src/shared/lib/unsavedEdits.test.ts`,
  `ipc-fs.test.ts` 「editor:backupEdits…」 (the reason; an unknown one keeps nothing) / 「a root _metadata.json of the
  member's…」 (kept beside the backup's own metadata, `sync.md` "Backups"). Sign-out (`AppShell` → `authStore.signOut`, the
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
  preview tab (↑ ↓ over the list replace it: `tasks-ui.md` "Working through a list"); ← → go over all tabs. Test: `tests/ui/tasks-layout.spec.ts`, `editorTabs.test.ts`.
- Open tabs (files and records), the active tab and the left panel tab are saved per company in localStorage
  `editor:<company id>` = `{ openFiles, activeFilePath, leftTab, records, pinned }` (`records`: the open
  record tabs' titles, so they show at once after a restart; a record tab is not checked against
  the disk; `pinned`: the tabs pinned 固定, "Tidying the tabs"; missing = none)
  (`src/features/editor/hooks/useEditorPersistence.ts`). They are read during the first render
  (no empty editor before the tabs appear); tabs of files deleted meanwhile are dropped in the
  background; any `leftTab` string is kept and one no registered panel has opens the default tab
  (`renderer-structure.md`, panel registry). Existing installs hold this shape:
  keep reading it (`client/tests/ui/skill-layout-state.spec.ts` seeds it).

## Editing a document in place (UX check 9, owner decision 2026-11-28, 案A)

A Markdown document is read and edited in the same view (Milkdown, WYSIWYG): no switch to a page
of symbols to fix a word. **What was not edited never changes by one byte.**

- **Behind one small door** (`features/editor/inPlaceEditing.ts`): a document goes in, the file's
  whole new text comes out after each change (`InPlaceEngine.open(host, text, { folder, onChange,
  onChangeTakenBack })`). Milkdown (`milkdownSurface.ts`) and the write-back (`markdownSplice.ts`)
  are behind it; replacing either changes nothing outside. The screen (`components/InPlaceMarkdownEditor.tsx`)
  knows only the door. It is shown where the screen passes `inPlaceEditing` to `TabbedEditorPanel`
  (`AppShell` does; a preview page without it keeps the read-only preview).
- **The write-back** (`SplicedDocument`): the file is cut into its top-level blocks by Milkdown's
  own reader (source offsets), each read alone (link reference definitions handed to every block);
  the `---` block (`splitFront`, BOM / trailing spaces / `...` accepted) never reaches the editor.
  A change is written as the smallest edit that **reads back as exactly what the screen shows**:
  (0) nothing at all when what the file holds did not change — an empty paragraph or list item
  (Enter before anything is typed) has no Markdown (the editor would write `<br />`), so it is left
  out of what is written (`writable`) until text is typed into it; (1) the same text change in the
  file's own bytes, first inside that text block's own source range (so two equal list items cannot
  take each other's change), else located by its unique surroundings; or whole new lines in the
  source's own indentation and list marker (`-`, a repeated `1.`, or the next number); (2) a table's changed cells / one row / one
  column in its own padding; (3) only the changed blocks rewritten by the editor (reference links
  kept as references). Each candidate is accepted only when the written region reads back equal
  (what the editor derives for showing aside: a heading's `id`, a list item's number `label`)
  **and** the blocks right before and after it still read as the same blocks from the same bytes;
  changes in several places at once are written run by run; a block deleted whole takes the blank
  lines after it; a written change becomes the baseline (the next one is placed against it). CRLF
  files keep CRLF (a region's new lines follow the region's own). Spaces typed at the start or end
  of a line (before the next word) are left out of what is written, as a reader drops them: they
  stay on screen and reach the file with the next word (`trimEdges`; code keeps every space).
  Measured (demo, 2026-11-28): opening and leaving 0 lines, one character 1 line, Enter in a list
  one new line, bold / a heading level 1 line; a column added changes every row (accepted, owner).
- **Never written approximately**: a document with a block kind it does not hold (footnotes, …:
  `unsupported`), whose text the editor would lose on reading (`lossy`: visible text of each block
  vs the editor's), that the editor tidies when shown, or whose unchanged write-back is not the file
  byte for byte, stays in the reading view (`MarkdownPreview`) with a callout and
  ［もとの書き方で直す］ (the source); nothing is written. A change that cannot be written faithfully
  is taken back on screen (the last written state shown again, the caret kept; not while a word is
  being composed) with a callout — the screen never shows what the file does not hold. The editor failing to load → the same reading view.
- **Saving, external changes and leaving are the editor's as before**: each written change goes
  through `handleContentChange` (the tab's text, its dot, the preview tab pinned on the first edit),
  so autosave, ⌘S, the external-change band (it pauses autosave; the member's text stays on screen),
  ［比べて選ぶ］ and saving / 保存せずに進む before leaving apply unchanged and keep exactly what was
  typed. The compare view replaces the document while it is open; after ［届いた版を採用］ the document
  opens afresh on the version that arrived (the edits kept in the backups first), after
  ［自分の版を保存］ on the edits written — the next change is placed against that text. Any change of
  the tab's text that did not come from the editor (the disk followed, a version picked, the source
  edited) opens the document afresh. Tests: `editor-in-place.spec.ts` (both picks, 保存せずに進む).
- **The source** is the same `CodeEditor` (記号の画面): the toggle's ［もとの書き方］ button (back:
  ［文章］; were エディタ / プレビュー) and ⌘⇧V (`mdViewMode`; nothing chosen yet → the document view
  where in-place editing is on — a member who chose the source before keeps it). Reading view instead of editing: 閲覧のみ files, a review being
  made or read (its quotes are marked in the text), the snapshot diff. Someone else's review in
  progress: one line says comments may lose their place (they are never deleted) — no confirm.
- Raw HTML is shown as written, quietly (kept byte for byte); images load from the document's folder
  (`local-file://`); ⌘-click opens an `http(s)` / `mailto` link; ⌘F uses the browser's highlights
  (`usePreviewSearch` `marking: 'highlights'`: a `<mark>` in the editor's DOM would be read as an
  edit).
- **Bundle**: Milkdown is imported only when a document is first shown in place; `vite.config.ts`
  puts that chunk in `dist/vendor/` under its own budget (`check-bundle-size.mjs`
  `ON_DEMAND_VENDOR`, 430 KB; 372 KB today). Versions pinned (`@milkdown/*` 7.23.0).
- Tests: `src/features/editor/markdownSplice.test.ts` (the real Milkdown under jsdom: unchanged
  write-back byte for byte on frontmatter, `*` lists indented by 4, aligned / unpadded tables, HTML,
  comments, `***`, escapes, code fences, reference links, `===` / `---` headings, Japanese, CRLF;
  one typed character exactly; two far edits each their own line; a new list item; bold, a heading
  level, a table row; the refusals; read-back and neighbour checks — each guard mutation-checked),
  `tests/ui/editor-in-place.spec.ts` on `tests/editor-in-place-ui.html` (real keys, autosave, Enter in
  a list, ⌘⇧V, the AI writing the file with and without edits, closing the window, a refused
  document, ⌘F).
- PR2 is "The selection bubble" below, PR3 "The 「/」 list, line starts and the table bar", PR4 "Images in a
  document", PR5 "Asking the AI to fix a passage".

## The selection bubble (UX check 9 PR2, owner decision 2026-11-28)

- Selecting words in a document edited in place shows **one bubble** (`components/SelectionBubble.tsx`,
  `role="toolbar"` 「選んだ文字の飾り」): 太字・斜体・取り消し線・コード (pressed = every selected
  character has it; press again takes it off), リンク (an address box: `https://…`, `mailto:`, a
  relative path; on a link ［リンクを外す］ takes the whole link off), 文字の大きさ (本文 / 見出し1〜3 —
  offered only for one line where a heading can stand, a top-level paragraph or heading, not a list
  item or a table cell; a paragraph written over several lines has only the selected line changed;
  the size it already has changes nothing), ［コメント］. No typeface, colour or
  underline (a Markdown file cannot keep them; owner). Its presses never take the focus from the
  document. The operations are the door's (`InPlaceSurface.toggleMark / setLink / setSize`,
  `milkdownFormat.ts`) and are written back like typing: the changed line only.
- **Keys go through the command catalog** (`commands.md`): `editor.toggleBold` ⌘B, `toggleItalic`
  ⌘I, `toggleStrike` ⌘⇧S, `toggleCode` ⌘E, `editLink` ⌘K, `setBodyText` ⌘⌥0, `setHeadingOne|Two|Three`
  ⌘⌥1〜3 (area `editor`, `notInHtmlDocument`: an HTML document keeps them). Each declines its key
  unless the focus is in the document (⌘K also needs a selection) and, on a Mac, a Ctrl+letter (the
  text's own Ctrl+B back / Ctrl+E line end), so ⌘B / ⌘K stay the app's left column / 探す elsewhere. Milkdown's own keys for the
  same operations are switched off (one press, one change). ⌥ keys match by the physical key too, on
  a Mac's ⌥⌘ only (`KeyInput.code`: ⌥⌘1 is `¡` there; Windows' AltGr = Ctrl+Alt types a character).
- **［コメント］ through a slot** (`selectionSlot.ts` `SelectionSlot.commentBox`): `app/editorSelection.ts`
  hands doc-review's `CommentPopover` to `TabbedEditorPanel` (`selection`); the editor imports no
  other feature's parts for it, and the same box serves a review's selection in the reading view and
  the HTML document view. The comment goes into the member's own review in progress, or a new
  review of theirs holding it in one write (`useMarkdownReview.commentAsReviewer`; never into a
  completed review being read, nor while the reviews load or after they could not be read: a second
  review of theirs would be written beside the first; a review request is answered as by
  「レビューする」) — the sidecar's name and shape are those 「レビューする」 + a comment
  write (`editor-selection-bubble.spec.ts` checks the keys' order). The document then shows as
  reviewed (reading view, its comment beside it). `useTextSelection` moved from doc-review to
  `editor/hooks/` (the selection is the editor's). With this, `FEATURE_IMPORT_EXCEPTIONS` lost
  `editor -> doc-review/components/CommentPopover.tsx` and `…/hooks/useTextSelection.ts`; the
  review's banners, side panel, history, snapshot diff, its state hook and `model.ts` stay (the review
  shown around a document is not a selection part — moving it is the review's own slot, not this PR).
- Tests: `tests/ui/editor-selection-bubble.spec.ts` (bubble and keys, each written as its one line;
  size; link by ⌘K and off; ［コメント］ → the review file and the reviewed view; ⌘B / ⌘K the app's
  outside the document — mutation-checked: Milkdown's keys left on, the `acceptsKey`),
  `markdownSplice.test.ts` (a mark in a nested list and off, a size on one line of a multi-line
  paragraph, a `----` heading to body text, spaces typed at a line's end),
  `src/shared/commands/commands.test.ts` (⌥⌘1 on a Mac; ⌘B bold in the document, else the left column).

## The 「/」 list, line starts and the table bar (UX check 9 PR3, owner decision 2026-11-28)

- **「/」 list**: 「/」 typed onto an empty top-level line opens it for that line (the caret at its end, up to 16
  letters after it; a 「/todo」 line the file already holds is text — its Enter stays a new line) and shows
  `components/BlockTools.tsx` `BlockMenu` (`role="listbox"` 「形を選ぶ」): 見出し1〜3・箇条書き・番号つきの箇条書き・
  チェックリスト・引用・コード・区切り線・表 (3×3), the one list in `blockChoices.ts` (names, the line start shown
  beside each, the words typed after 「/」 that find it — `matchBlockChoices`). Nothing found → no list. The choice
  turns the 「/…」 line into that block (`InPlaceSurface.turnInto`, `milkdownBlocks.ts` `turnIntoBlock`; a divider
  and a table at the end get an empty line after them for the caret, not written while empty). The 「/」 is text
  until then (written as typed). The pointer picks only when it moves.
- **Its keys are the catalog's** (`commands.md`): `editor.blockMenuNext` ↓, `blockMenuPrevious` ↑,
  `blockMenuChoose` Enter, `blockMenuClose` Esc (`notInHtmlDocument`). Each declines unless the list shows in
  the focused document and no word is being composed (`KeyInput.isComposing`); the editor's own plugin only
  leaves ↓ ↑ Enter alone while the list shows (`blockMenuPlugin` `handleKeyDown`: no caret move, no new line),
  never Esc — so Esc with no list reaches another part (a list worked through, 「延ばす」). Esc closes the list for
  that line (typing 「/」 on an empty line opens it again), the 「/」 stays.
- **Line starts** (`lineStartRules`, replacing the editor's rules for the same starts — `REPLACED_LINE_START_RULES`):
  「- 」「* 」「+ 」 a list, 「1. 」 a numbered list (its number kept), 「[] 」「[ ] 」 a checklist (in a list item, that
  item; anywhere else a new checklist), 「```」 code at once, 「---」 a divider with the caret on the line after it;
  「# 」〜 and 「> 」 are the editor's own. 「```」 / 「---」 only on a top-level line with nothing else (in a list item
  or a quote they stay characters: the editor cannot hold a code block or divider made there). Lists are made as the
  reader makes them (`spread: false`, the item's kind): the editor's own made loose lists that were never written.
- **Empty line hint**: the empty top-level line holding the caret gets `acb-empty-line` (a decoration, not the
  document); `index.css` shows 「「/」で形を選べます」 there while the document has the focus.
- **Table bar** (`TableBar`, `role="toolbar"` 「表の操作」, over the table's top right while the caret is in it and
  no words are selected): ［行を足す］ (under the caret's row, each cell its column's alignment, the caret into it),
  ［列を足す］ (right of the caret's column, no alignment `---`, the caret into it), ［行を消す］ (never the header
  row, nor the last row under it: the editor would only empty it), ［列を消す］ (never the last column) — disabled where they do not apply (`InPlaceTable.can`).
- **Written back** (measured, as the demo): a 「/」 choice or a line start → the lines made only (a heading
  `## 議題`, a checklist `- [ ] …`, a table's four lines); a row → 1 line; a column → one cell on every line of
  the table (accepted, owner); words typed into a new cell → that cell (`| 商談 |  |`). How
  (`markdownSplice.ts`): an empty table cell stays in what is written (`writable`: it keeps its column — before,
  an empty row was dropped and words typed into its second cell could be written into the first); a table whose
  rows or columns changed, or an empty cell typed into, is written by `tablePatch` first (the file's own lines, not
  the editor's padding); new blocks after (before) unchanged ones are written beside those blocks' own bytes,
  not with them rewritten (a `----` heading stayed `----`, not `##`); a list made where the region had none takes
  the file's first bullet (else `-`), a divider the file's first (else `---`) — each read back like every
  candidate, so a `-` list right above a `-` list is written `*` (two lists, as on screen).
- Not built (owner): typeface, colour, a handle to drag lines (⋮⋮).
- Tests: `markdownSplice.test.ts` (each 「/」 choice and line start written exactly, the file's bullet and divider,
  the list beside a `-` list, a checklist item in a list, 「---」 before words, 「```」 / 「---」 in a list item stay
  characters; the list opened only by typing 「/」 (not on the file's 「/todo」), narrowed, closed by Esc;
  the table bar's row / column / delete and words in the right cell; the header row, the last row and column kept; a `----`
  heading kept), `tests/ui/editor-block-tools.spec.ts` (real keys: the list, ↓ Enter, Esc then `list.back` and Enter
  a new line, every line start, the hint, the table bar) — mutation-checked: empty cells kept, the table patch
  first, tight lists, the file's style (and only on new lines), the region kept beside new blocks, the header row,
  the last row, top-level 「```」 / 「---」, the list opened by typing, the editor holding Enter, the keys only while
  the list shows. Known: inside a quote a new list / divider is written `*` / `***` (the file's way is not applied
  after `>`; it reads back right). `doc-frame-protocol.test.ts`: the list's keys stay an HTML document's.
- Bundle: the list and bar (~5 KB) are in the app's JS; the rest in the Milkdown chunk (372 KB of 430).

## Images in a document (UX check 9 PR4, owner decision 2026-11-28)

- **One rule** (`client/shared/document-images.ts`): a document's image goes in the folder `images/`
  beside the document, named by the computer's local date and time to the second
  (`20261129-143005.png`; the same second again `-2`, `-3`, …), and the document gets
  `![](images/<name>)`. The same functions write the AI's one standing line (`documentImageInstruction`,
  `chat-server.ts` with the standing instructions: the AI already put its images there; now it is told
  the same name shape — `chat-and-agents.md` "What ACB tells the AI"). Beside the document, an image is
  seen by whoever sees the document (a private folder's document → its images in that folder's clone).
- **Ways in**: ⌘V in a document edited in place (only when the clipboard holds no text: Word, Excel and
  web pages put a picture beside copied words, which must paste as words — `pastedImageFiles`) and a
  Finder drop on it (`droppedFiles`; at the drop's place). Not in the 「/」 list (it would need a file
  picker through main; paste and drop cover it). The source view (記号の画面) is unchanged.
- **Main writes; the renderer hands the bytes and which document** (`editor:saveImage(documentPath,
  bytes)`, `features/fs/ipc.ts`; port `EditorImageWrites` in `features/editor/api.ts`): the document
  through `AllowedRoots.validate`, a Markdown name, a regular file (not a link), not at the top of a
  company folder (a root folder is a department: 「会社フォルダのいちばん上にある文書には…」); the kind **from the bytes**
  (`documentImageKind`: PNG, JPEG, GIF, WebP — never SVG, which can carry script and links and is opened
  by other programs too; never what the renderer says), ≤ 20 MB (`MAX_DROP_FILE_SIZE`, a Finder drop's;
  far under sync's `LARGE_FILE_THRESHOLD` 100 MB, so a pasted image never stops sharing); `images/`
  through `validate` (a link out of the company is refused), the not-downloaded and `writeRefusal`
  checks (reserved / private folder names, skill files, agent config), made alone (`mkdir`, not
  recursive) and **`lstat` a folder** (a link even pointing inside, or a file named `images`, is
  refused: 「…画像を置けるフォルダではないため…」), each name through `validate` and written with `wx`
  (never replaces; a taken name tries the next). The answer is only the address; a disk error is a plain
  sentence (「画像を保存できませんでした…」), never Node's text. The screen checks a
  file's type and size first (`documentImageFileRefusal`) so a large file is never read.
- **In the document** (`milkdownImages.ts`, behind the door: `InPlaceOptions.storeImage(file)` → the
  address or null): kept first, then put in — on the empty top-level line holding the caret, else as a
  new line right after the top-level block holding it (a list item never gains a paragraph); several
  files one line each, in order; the document changed meanwhile → at the caret. Written back like
  typing: `![](images/…)` plus its blank line; nothing else changes. A file not kept → one line above
  the document 「画像を入れられませんでした。<name>: <reason>」 (［閉じる］), nothing put in. Shown from
  `local-file://` like every image of the document (its version followed). Known: an image kept while the
  document was closed or switched to the source is left in `images/` with nothing pointing to it; words
  pasted from Word keep the editor's own paste (unchanged by this, `file://` pictures in its HTML included).
- Tests: `tests/document-images.test.ts` (the kinds by bytes — SVG / HTML none —, the 20 MB limit under
  sync's, names, the AI's line from the same functions), `tests/ipc-fs.test.ts` 「editor:saveImage …」
  (the place, the clock fixed by `mock.timers`, `-2` / `-3`, an existing file kept, SVG / HTML / not bytes
  / 20 MB / not Markdown refused; a link out, a link inside, a file named `images`, a not-downloaded
  `images`, a reserved one, a skill's document, a document at the top, a folder named `.md`, a linked
  document refused and nothing written; a disk error in plain words), `ipc-path-guard.test.ts`
  (GUARDED), `markdownSplice.test.ts` (the empty line, after a paragraph, after a nested list, two
  images: each exactly its line; a paste with words stays words), `chat-standing-instructions.test.ts`,
  `tests/ui/editor-in-place.spec.ts` (⌘V and a Finder drop through the real editor; a PDF / SVG refused
  in one line) — each guard mutation-checked.

## Asking the AI to fix a passage (UX check 9 PR5, owner decision 2026-11-28)

- **Where**: the bubble's ［AI に直してもらう］ (`SelectionBubble` mode `aiFix`: 「もっと丁寧に」「表にして」「3行に縮めて」 —
  `INLINE_FIX_SUGGESTIONS` — or the member's own words, ≤ 500) and, on a **completed** review being read, a comment's
  ［AI に反映してもらう］ (`ReviewSidePanel` `onAskAi`: open, not orphaned comments; the reading view closes, the document
  opens in place and the fix is asked for the block holding the comment's words, found with `findTextInMarkdown`).
- **Through the slot, to the current consultation** (`selectionSlot.ts` `AiFixPart`, composed by `app/editorSelection.ts`):
  `ask` runs the command `chat.askToFix` (`commands.md`) on the chat pane used last — its shown tab's consultation,
  never a separate one-shot call — and reads the answer with `inlineFixResult` (`client/shared/inline-fix.ts`); `preview`
  is the chat's `MarkdownMessage` (raw HTML dropped, no remote images: `chatMarkdownSafety`). The editor imports no chat
  part; `FEATURE_IMPORT_EXCEPTIONS` unchanged. No chat pane → 「相談の欄が開いていない…」.
- **What the AI gets** (`InPlaceSurface.selectedPassage` / `passageAt`, `milkdownAiFix.ts`): the top-level blocks holding the
  selection (a list item → its whole list; a selection ending where the next block's first words start — inside a list
  or quote, deeper than its start — does not take it), byte for
  byte as the file holds them (`SplicedDocument.passage`, the write-back's own offsets), and at most 600 characters before
  and after, cut at a line, never the `---` block (`contextAround`); the file's name, not its folder. Never the whole file
  (a passage over 6,000 characters is refused on screen; the command's zod limits refuse it too). Only what is written can
  be taken (a change still being taken back has no passage). How it is worded: `chat-and-agents.md` "In-place fixes".
- **Shown in the document's flow**, right under the passage (`showBelow`: a ProseMirror widget, `fixBelowPlugin`; never
  part of the text, never written), not a floating box: `AiFixCard` (the AI colour set) — 「相談の AI に頼んでいます」 with
  ［やめる］, then 直したあとの見た目 and the file's lines adopting would replace and add (`previewFix`), ［やめる］［採用］, or
  a plain sentence with ［閉じる］ (busy, stopped, failed, no ```` ```acb-fix ```` block, not writable, changed). One
  request at a time (`hooks/useAiFix.ts`); the answer of a request put away is dropped (its id).
- **Adopting goes through the write-back** (`adoptFix`): refused when the file's text or the shown document changed since the
  passage was taken (`fixedDocument`: 「AI に頼んでいる間に文書が変わったため…」), when the fix holds a block kind the
  editor does not keep or text it would lose (`SplicedDocument.read`: footnotes …), raw HTML tags the passage did not
  have (`htmlTags`: the preview never shows them — a tracking image, a hidden link), or is empty. Two faithful ways are
  tried — the AI's Markdown as written over the passage (`writeSource`: reads back as the screen shows, neighbours keep their
  bytes) and the write-back's smallest edit (`write`) — and the one changing fewer lines is written (a tie: the AI's), so a
  list the AI rewrote with `-` bullets changes only the line whose words changed, and a table is written as the AI wrote
  it. The tracker writes it like typing, with the write chosen for exactly that document (`adopted`); saving, ⌘S and the
  external-change band as for typing. The file changed from outside while asked (the document opens afresh) → 「AI に頼んでいる間に文書がほかから
  変わったため…」 above it; the answer is dropped. `〔〕` in the answer become the passage's `【】` again when the passage had
  `【】` and no `〔〕` (`restoreBrackets`: outside text reaches the AI with them replaced).
- **A comment is never resolved for the member** (owner): adopting a comment's fix says 「コメントは解決にしていません…」 with
  ［レビューに戻る］ (`review.viewReview`); nothing is written to the review or reply files.
- **Kept in the consultation**: the request is a message the app sends in the member's place (`appSent`, the shape it is
  stored in already) and the AI's reply follows it (`chat-ui-and-history.md`). Whether a fix was adopted is not recorded.
- Tests: `markdownSplice.test.ts` (the passage of a nested list byte for byte, ≤ 600 around, no frontmatter; a selection to
  the next block's start and to a list's first words; a `-` list fix written as its one `*` line; 「表にして」 written as
  the AI wrote it, only the paragraph's lines; changed meanwhile / footnote / new raw HTML / empty refused, nothing written; a comment's quote → its block; the card
  shown in the flow and not written), `tests/inline-fix.test.ts` (the message's outside-text blocks, a passage that spells a
  footer, the ask as a quoted line, the comment as outside text, the command's limits, `contextAround`, the answer's
  block, `restoreBrackets`, the pane's answer read strictly, a turn answering only its own request),
  `tests/ui/editor-ai-fix.spec.ts` (asking hands over the passage only and the card stands right after the list;
  ［採用］ writes one line; the fix drawn without raw HTML or script; ［やめる］ before and after the answer, the dropped answer,
  a refusal; typing meanwhile and a change from outside refused; a completed review's comment → its words handed over, the
  fix adopted, no reply file, the review file byte for byte, ［レビューに戻る］), `tests/ui/chat-panel.spec.ts` 「chat.askToFix…」
  — each guard mutation-checked (the staleness check, the kept kinds, no new HTML, the outside-text wrapping, the limits, the line cut,
  the next-block rule, the fewer-lines choice, the request id, the busy refusal, the chat's renderer, the comment left
  unresolved, the lost notice).

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
  outside the computer; state in `hooks/useMarkdownReview.ts` (the selection that starts a comment is
  the editor's: `features/editor/hooks/useTextSelection.ts`, the box reached through the selection
  slot, "The selection bubble"); banners, side panel, popover, history and the snapshot diff in
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
