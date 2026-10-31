---
paths:
  - "client/electron/sync/sparse.ts"
  - "client/electron/sync/first-setup.ts"
  - "client/electron/sync/not-downloaded.ts"
  - "client/electron/sync/outside-checkout.ts"
  - "client/electron/sync/folder-sizes.ts"
  - "client/electron/sync/company-folder.ts"
  - "client/electron/sync/remote.ts"
  - "client/shared/sparse-paths.ts"
  - "client/electron/features/download-choices/**"
  - "client/electron/features/company-setup/**"
  - "client/src/components/settings/**"
  - "client/src/features/settings/**"
  - "client/src/features/company/components/CompanySelector.tsx"
  - "client/src/lib/download-selection.ts"
  - "client/src/features/company/folderPlan.ts"
  - "client/src/lib/restore-company.ts"
  - "client/src/shared/hooks/useSparseCheckout.ts"
  - "client/src/shared/lib/exclusionChanges.ts"
  - "client/src/features/sync/hooks/useDepartmentDownload.ts"
  - "client/src/features/sync/components/DepartmentDownloadPrompt.tsx"
  - "client/src/features/workspace/hooks/useDepartmentAvailability.ts"
  - "client/src/shared/ipc/download-choices.ts"
  - "client/tests/download-folders-ui.*"
  - "client/tests/sync/partial-clone.test.ts"
  - "client/tests/sync/folder-exclusions.test.ts"
  - "client/tests/sync/outside-checkout.test.ts"
  - "server/src/lib/folder-sizes.ts"
  - "server/src/routes/folder-sizes.ts"
  - "server/src/lib/git-server/repo-config.ts"
---

# First setup, partial clone, and what each computer downloads

A member downloads only some folders; everything else stays on the server and is still visible.
The guards that keep this safe are in `sync-guards.md` (remote / sparse / not-downloaded section).
Background and the rejected cone-mode design: `docs/architecture/download-choices.md` (internal).

## First setup (`sync/first-setup.ts`, `features/company-setup/ipc.ts`)

- In a **fresh folder** the member picks departments first (`CompanySelector`:
  「所属する部署を選んでください。他の部署はあとから設定でダウンロードできます」). Then
  `git:setupCompanyRemote` → `checkoutSelectedDepartments`: `fetch --filter=blob:none` → persist
  the exclusions (the departments *not* picked) and set the patterns → checkout (downloads only
  the checked-out blobs, in one batch). Nothing picked → full clone. Existing clones are never
  converted to partial clones.
- Both selector paths (「既存のフォルダを開く」 = the folder, 「新しく作成」 = `<folder>/<company>`)
  first ask `git:inspectCompanyFolder` (`sync/company-folder.ts`, read-only; renderer
  `src/features/company/folderPlan.ts`):
  - empty folder (OS files such as `.DS_Store` ignored), or this company's origin with nothing
    checked out → picker + partial setup;
  - a clone of this company with commits → opens as before;
  - a clone of another remote (origin compared by path `/api/git-http/<id>`, so a moved server
    still matches) → refused;
  - the member's own files, or a repo with its own history, while the company has content →
    refused, nothing deleted (checkout would stop on a shared name or mix unrelated files in);
  - a company without content yet → the folder becomes its first commit (owner).
  `git:setupCompanyRemote` repeats the check as a backstop (`refused: true`) and inits a repo at
  the folder itself, never re-pointing a parent repository's origin. Offline only a clone of
  this company opens.
- The setup screen shows bytes received (`setup:progress`, same pack-size watcher as
  `sparse:progress`); reopening a clone does not say 「初回」.
- After login the remembered company (`localStorage lastCompany:<userId>`) opens directly:
  `src/lib/restore-company.ts` registers its folder as an allowed root **before** `fs:exists`
  (main answers only for registered roots; checking first always said "missing").

## Partial clone

- Server: `configureBareRepo` sets `uploadpack.allowFilter` and
  `uploadpack.allowReachableSHA1InWant` (`server/src/lib/git-server/repo-config.ts`). git-http
  does not forward `Git-Protocol`, so upload-pack speaks v0, which refuses lazy fetches without
  the latter. `allowAnySHA1InWant` is not needed.
- Later fetches keep the filter (`remote.origin.promisor` / `partialclonefilter`; see the origin
  guard). Blobs git needs outside the checkout (a rebase over a teammate's rename, restoring a
  server version, adding a folder, `git log -p`) are fetched lazily, authenticated through the
  environment `createGit` sets (`GIT_ASKPASS` + `GIT_TOKEN`). The token is never written to disk,
  so git run outside the app (a terminal, or the chat agent's `git show` on another department)
  fails with an auth error and changes nothing.
- Adding a folder in settings downloads it. Offline, `sparse-checkout set` rolls its patterns
  back and `applySparseSelection` restores the previous exclusions; the panel says
  「インターネットにつながっているときにダウンロードできます」. Offline sync behaves as for a full clone.

## Exclusion model (`client/shared/sparse-paths.ts`, `sync/sparse.ts`)

- `.git/acb-sparse-config.json` `{ excluded: ['営業部', 'コンテンツ/動画'] }`: repository-relative
  folders at any depth, spelled as in the tree; everything else is downloaded. Applied as a
  **non-cone** sparse checkout: `/*` then `!/<folder>/` per exclusion (wildcards escaped;
  Japanese names written in NFC and NFD, since git matches index bytes). So a folder a teammate
  creates outside an excluded folder downloads automatically, and a folder the member creates is
  always inside the checkout. Cone mode cannot express this without listing every sibling. The
  sparse index (cone-only) is not used; at ~6.5k files performance is not a concern.
- No re-including inside an excluded folder: an exclusion covers its subtree;
  `normalizeExclusions` folds nested entries, and the settings tree disables the children of an
  unchecked folder. Re-includes would make "where may I write" depend on pattern order.
- Migration: members still on cone mode get `sparse-checkout set --no-cone …` once at sync's
  reconcile — same files, no download, no deletion. Until then the readers understand the cone
  file (`appliedExclusions`, `notDownloadedFolders`). Harness: "migration (full | partial clone)".
- Stale exclusions (the folder exists neither on `origin/main` nor in `HEAD`) are dropped at the
  reconcile, so a folder created later at that path is shared normally. Private folders'
  exclusions are never dropped as stale (they are not in the company tree).
- "Not downloaded" means listed **and** excluded by the applied patterns (`appliedExclusions`
  with git; `notDownloadedFolders` from files under `.git/` alone — git writes
  `core.sparseCheckout` to `config.worktree`). Compare in NFC with A–Z folded.

## Writes into a not-downloaded folder are refused in three layers

1. App file operations (`fs:writeFile`, `fs:createDirectory`, targets of `fs:rename` / `fs:move`
   / `fs:moveFromExternal` / `fs:copy`) refuse in main (`notDownloadedRefusal`); the renderer
   disables those actions with the same explanation (`notDownloadedUserMessage`).
2. The chat's PreToolUse write guard (`chat-write-guard.md`).
3. Sync's outside-checkout hold-back (`sync-guards.md`).

Leaving out a folder with uncommitted changes (`uncommittedChangesIn`,
`git:sparseUncommittedChanges`) is confirmed in the settings panel first: git leaves those files
on disk and the next sync moves them to `.backups/<ts>_outside_checkout/`.

## Folder sizes and settings UI

- Sizes come from the server: `GET /api/companies/:companyId/folder-sizes?path=&measure=…`
  (`server/src/lib/folder-sizes.ts`: one `ls-tree -r -l` of the shared branch per commit,
  cached; any member). A partial clone cannot compute them (`ls-tree -l` would lazily download
  every blob). `git:folderSizes` (`sync/folder-sizes.ts`) falls back to local trees (names only,
  `offline: true`) and adds readable private folders (no size). `git:sparseSetExclusions`
  reports bytes arriving in `.git/objects/pack` as `sparse:progress`.
- `client/src/components/settings/DownloadFoldersSection.tsx` (logic `src/lib/download-selection.ts`):
  tri-state tree (one level per expand) with sizes; summary
  「6.5 GB をダウンロード済み（全体 10.4 GB）」 + bar + size after applying; search over loaded
  folders; sticky footer — changes are a draft until 適用 (取り消す drops it); applying asks
  first about uncommitted changes and shows bytes received. Offline: sizes 「—」, the draft is
  kept. The settings panel has a left section nav and shares `settings/ui.tsx` (neutral zinc,
  one indigo accent, light and dark). The panel reaches the main process only through
  `src/features/settings/api.ts`: `FolderSizeReads` (sizes from the server), `DownloadChoiceReads`
  (uncommitted changes, progress), and separate ports for the company `.env` (status only),
  `.gitignore`, the AI's environment-variable list and the git binary status. The 同期 group
  also holds 「自動同期」 (`src/features/settings/components/AutoSyncSettings.tsx`; behaviour in
  `sync.md` "Automatic sync").
- File tree: a not-downloaded folder stays visible as a muted placeholder (dashed icon,
  「未ダウンロード」, 「ダウンロード」 on hover/focus and in its context menu) so nobody recreates
  it; it does not expand and is not a drop target. A failed download shows why (`role="alert"`
  under the button). `useSparseCheckout` instances refresh each other via `acb:sparse-changed`.
  Changes run one at a time per company folder and each is built from the list as it is when its
  turn comes (`change(current => …)`, `src/shared/lib/exclusionChanges.ts`); main also runs
  `git:sparseSetExclusions` in turn per folder. Two quick 「ダウンロード」 clicks once put the first
  folder back on the list. Tests: `exclusionChanges.test.ts`, `ipc-git.test.ts` 「download choices
  applied at the same moment…」.
  It goes through `src/shared/ipc/download-choices.ts`: `ExcludedFolderReads` (the list) and
  `DownloadChoiceOutbound` (applying downloads from the server and syncs a left-out private
  folder one last time, so it is not a plain write).
- A department tab whose folder is not on this computer (left out, or missing on disk:
  `src/features/workspace/hooks/useDepartmentAvailability.ts`) shows
  `src/features/sync/components/DepartmentDownloadPrompt.tsx` over the still-mounted left panel;
  「ダウンロードして同期を開始」 (`hooks/useDepartmentDownload.ts`) downloads that one folder. Offline it
  says 「インターネットにつながっているときにダウンロードできます。何も変更していません。」 and keeps the
  prompt; another department starts without the old error (`client/tests/ui/skill-layout.spec.ts`).
- Preview: `client/tests/download-folders-ui.html?view=settings|filetree&theme=light|dark&state=normal|offline|slow|confirm|applyOffline`
  (serve with `npx vite -c tests/ui/vite.config.ts`; see `testing.md`).
