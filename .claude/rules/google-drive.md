---
paths:
  - "shared/core/google-drive.ts"
  - "shared/types/google-drive.ts"
  - "server/src/services/google-drive.ts"
  - "server/src/routes/google-drive.ts"
  - "server/src/routes/record-ai-auth.ts"
  - "server/src/ports/google-drive.ts"
  - "server/src/adapters/sqlite/google-drive.ts"
  - "server/tests/integration/google-drive.test.ts"
  - "server/tests/unit/google-drive-core.test.ts"
  - "client/electron/features/google/drive.ts"
  - "client/electron/picker-preload.ts"
  - "client/scripts/check-preloads.mjs"
  - "client/tests/google-drive-tools.test.ts"
---

# Google Drive through the Google connection (feature `drive`, `drive.file`)

The first sales experience: 「○○社の提案書を作って」 in a consultation → the company's skill
reads the Gemini minutes (ACB's minutes tools), past proposals / notes the member picks in Drive,
makes the proposal as HTML + PDF locally, and ACB puts it into the Drive folder the member chose.
Owner decisions 2026-11-01: output stays HTML / PDF (no Slides generation) — 2026-11-11: HTML / Markdown may
also become a **Google document**, and a file ACB made may be **overwritten as a new revision** ("Google documents
and overwriting"); a scheduled job may put into one folder its responsible person picked (`jobs.md` "A deliverable
place outside"); Drive belongs to the
Google **connector** (connection only) — never a core role, no core 「file storage」 role;
least privilege: **`drive.file` + Google Picker only, never `drive` / `drive.readonly`**;
per-member grant; the AI never sees a token; every call through the one Google client
(`google-connector.md`: operator stop, company Google off, vault, grant, scope).

## Where it lives (the stage-3 move into the connector plugin stays mechanical)

Everything is in the Google connector's files: `shared/core/google-drive.ts` (rules),
`shared/types/google-drive.ts` (contract), server `services/google-drive.ts`,
`routes/google-drive.ts`, `ports|adapters/sqlite/google-drive.ts` (behind the company handle
`googleDrive`), app `client/electron/features/google/drive.ts`, the Picker window
(`electron-adapter.ts` `createDrivePickerWindow` + `picker-preload.ts`). The core only gives
seams: `routes/record-ai-auth.ts` (record-token auth + S10b's `keyedWrite`, shared with
`records-ai.ts`), the tool providers (`client/electron/records/tool-providers.ts`: a connector's tools on `acb_records`, merged by `createRecordTools`), the
`DrivePickerWindow` port, and `drive-put` in S10b's `outcomeOf` / `replayReadPath`.

## Scopes

Feature `drive` = `drive.file` (`GOOGLE_FEATURE_SCOPES`); offered by the company only once the
Picker is registered, then asked with the other features in 「仕事の道具をつなぐ」's one consent, or
**when first used**: the first
`drive_pick_*` opens 「Google で許可」 in the system browser with `features: ['drive']` (the
already-granted features are added by the server) and waits ≤ 2 minutes for the grant.
`GOOGLE_NEVER_SCOPES` lists what ACB never asks or stores (`drive`, `drive.readonly`, …; test).

## Picker and its token (the one Google token on a client)

- Admin 「つなぎ先」→「Google」→「Google Drive のファイル選び」: API key (password field; stored
  as is — Picker's developer key is sent to the page by design; answers show its last 4) and
  the Cloud project number (`appId`), `PUT /google/picker { apiKey?, appId }` (owner/admin;
  `appId: null` removes both). The page shows `<PUBLIC_URL>/api/google-picker` to allow in the
  key's website restriction. The admin also enables Google Picker API + Drive API and adds
  `drive.file` to the OAuth consent screen.
- `POST /me/google/drive/picker { mode }` (**session only**): switches → Picker registered (409
  `DRIVE_PICKER_NOT_CONFIGURED`) → `googleClient.pickerToken`: grant active with `drive.file`
  (else 409 `GOOGLE_CONSENT_NEEDED`, `needsGoogleConsent: 'drive'`, nothing asked of Google), then
  a **fresh** token from the refresh token with `scope=drive.file` (RFC 6749 §6 subset — never the
  cached token, which holds every granted scope); Google's answer must carry **exactly**
  `drive.file` (`isDrivePickerTokenScope`), else 503 `DRIVE_PICKER_SCOPE` and nothing handed
  out. Not cached, not logged (one AI-action-log line `google:drive.picker.token`). `no-store`.
- The app (main) opens Google Picker in a **window of its own**: the server's static page
  `GET /api/google-picker` (public, no secret, strict CSP with the inline script's hash; the
  Picker's origin is the one the admin allows), its own preload (`picker-preload.ts`: `config()`
  / `done()` only), its own session partition, sandboxed, no popups, no navigation away. The
  config (token, key, app id) is answered **once**, on that window's own IPC
  (`webContents.ipc`, no global channel), only to its main frame while it shows the Picker page
  (`isDrivePickerPage`); back come only Drive ids (`readDrivePickerResult`). 10 minutes, closing
  = cancel; the token is dropped with the window. It never reaches the renderer, the AI, a
  record-token request or a log.
- `picker-preload.js` must be **CommonJS**: a sandboxed preload is a classic script, and an
  ES-module one (a top-level `import`) fails silently, so the page finds no `window.acbPicker` and
  shows 「この画面はアプリの中でだけ使えます。」 (release-20261109). vite-plugin-electron builds
  every entry as `es` because `client/package.json` is `"type": "module"`, overriding
  `rollupOptions.output.format`; `commonJsPreload()` in `vite.config.ts` sets the lib format for
  both preloads. `client/scripts/check-preloads.mjs` loads each built preload as Electron's
  sandbox would (function wrapper, `require` of `electron` only) and checks it exposes its bridge;
  it runs in CI "Renderer bundle size (Linux)" and in `pnpm build` before packing. Keep the window
  `sandbox: true`.
- Unverified against real Google (no real accounts in tests): that Google honours the narrowed
  refresh (if not, Drive picking is refused — safe), and that Picker works in an Electron
  window without a Google sign-in cookie in that partition (Google may block a sign-in inside
  embedded browsers; fallback then: the same page in the system browser with a one-time code).
- Staging: the fake Google serves a stand-in Picker at `<practice origin>/js/api.js` (lists the
  account's Drive files, marks the click as picked — `/__picker/*`; `setFileIds` narrows the list).
- **A pasted / dropped Drive link** (owner decision 2026-11-09): the config may carry `fileIds`
  (files mode only): the page calls `DocsView.setFileIds` (Google's Picker reference: "Sets the file
  IDs included in the view", comma-separated; not combined with `setEnableDrives`, which it then
  skips), so the chooser shows just that file and one 「選択」 picks it. Only Drive ids get there:
  the renderer reads them with `driveFileIdsFromText` / `driveFileIdFromLink` (`shared/core/google-drive.ts`:
  `https:` only, no user / password / port, the host exactly `drive.google.com` or
  `docs.google.com`, a file path — Docs / Sheets / Slides / `file/d`, `open?id=`, `uc?id=` —
  never a folder, the id `isDriveId`), main again with `drivePreselectIds` (`tasks:linkDriveFiles`'
  optional 4th argument, `createDrivePicking().pick(…, { fileIds })`), and the page filters once
  more. A pasted id opens nothing by itself (drive.file): nothing is read or linked outside the
  Picker, and what is linked is what the member picked there. Unverified against real Google:
  that `setFileIds` shows a file not yet granted to the app under `drive.file` (Google announced
  it for that, 2024-11); if not, the member sees an empty chooser and cancels.

## Picks (`google_drive_picks`)

`GET /me/google/drive/files` (session): the member's **own** live file picks and the files their
puts made (done), with names, newest first, ≤ 30 (`ownFiles`; nothing asked of Google; empty while
Drive is not available) — what the app's 「Google Drive のファイルをつなぐ」 offers before the Picker.
Only the caller's rows: another member's names never reach them (test 「the member's own files for
「つなぐ」」).

`POST /me/google/drive/picks { mode, ids }` (session; folder: 1 id, files: ≤ 10): each id is
opened with Google first (`drive.file` answers only for files picked for this app); a folder
must be a folder the member can add to, a file a readable type (`DRIVE_READ_AS`); anything else
is counted `refused`, not kept. Kept 90 days (folders) / 7 days (files); a re-pick renews.
The AI reads and writes **only** the member's own live picks.

## The AI's routes (`/api/records-ai/google/drive`, record token) and tools

- `GET /status` → `{ available (Google on + Picker registered), granted, picks }` — the app adds
  the Drive tools only when available. `POST /read { fileId }` (picked file only, else 403
  `DRIVE_NOT_PICKED`): Docs / Slides → text/plain export, Sheets → text/csv, text files as is,
  marked as outside text (`DRIVE_TEXT_HEADER` / `FOOTER`, `instructionLike` from `outsideTextFlags`;
  the text's `【】` → `〔〕`, server and app, `shared/core/outside-text.ts`), ≤ 200 000
  characters; a PDF (≤ 10 MB) as base64 — the app saves it at
  `.personal/google-drive/<id16>-<name>.pdf` (never synced) and returns the path.
- `POST /put` (act token) `{ folderId, name, kind: pdf|html|markdown, as?: file|google_doc, sha256, contentBase64,
  requestKey, updateFileId?, recordId? }`: checks in order: form allowlist (`drivePutForm`: a PDF / HTML as a file,
  HTML / Markdown as a Google document — nothing else) → name (one segment; a file keeps the kind's extension, a
  document none) → key / sha / `updateFileId` shapes → size → sha256 matches → content (`%PDF-`, UTF-8 without NUL)
  → a scheduled job's run: its one folder (`DRIVE_FOLDER_NOT_GRANTED`, below) → folder is a live folder pick → an
  update's file (below) → **receipt first** (`claimPut`, unique per member + requestKey; same key with
  other content 409 `DRIVE_PUT_KEY_REUSED`; done / unknown → answered as is, `existing: true`,
  nothing sent) → folder still a folder the member can add to → **for the AI, nobody outside
  the company's domain sees the folder** (`permissions.list` + `driveFolderReachesOutside`;
  anyone-link, another domain, an outside person/group → 403 `DRIVE_FOLDER_SHARED_OUTSIDE`;
  unreadable → 403 `DRIVE_FOLDER_SHARING_UNKNOWN`) → multipart upload with
  `appProperties.acbPutId = <put id>`, **never retried**. 2xx → `done` with `fileId`,
  `revisionId` (`headRevisionId`, or `version:<n>` for a Google document: `driveRevisionOf`) and `link`. Lost answer / 5xx → `unknown`, looked up at once
  by `acbPutId` (found → `done`, reason `found-by-correlation`), and again on every
  `GET /puts/:putId` and repeat; never re-sent. Refused / not sent → the receipt is removed.
  An AI put's receipt copies the Skills its consultation had used (`skills`, records.md "Which
  Skill"); `drive_put` waits for a Skill report still in flight (`records/api.ts` `beforeWrite`).
- **Linked to the consultation's やること** (owner decision 2026-11-09): with `recordId` (the app sets it
  from the consultation's topic, `taskTopicOf`, read at each put — never from the AI's input; the tool's
  schema is strict), once a **new** put is `done` (`existing: false`; a replay links nothing, even after
  the member took the link off) the route links its file to that record: `putLinkable` builds the
  `VerifiedDriveFile` from **the member's own receipt** (fileId, revision, the name as put, the sha256 of
  the bytes uploaded — Google is not asked again; no body's file id is ever taken), and
  `recordEngine.linkDrivePut` runs every record check of `fileLink` (records on, readable, a type the AI
  may act on, a company without the shared folder, not linked already) at the version current now, as
  the AI (the one Drive link the AI may make). Answered as `linkedTo: { recordId }`; any refusal or
  error is logged with its code only and **never fails the put**. The tool says the file was linked.
  The server cannot tell which record the consultation is about (topics live on the PC): it trusts the
  app's `recordId` only as far as any act-token write — the member's AI could link that member's own new
  put file to any record it may act on, nothing more.
- Confirmation: putting into the member's **own / internal** folder they picked is not sending
  outside — the pick is the person's choice of destination, so no per-file confirmation; a
  folder visible outside the company is sending outside, which stays a person's act
  (outbound-mail's rule), so the AI is refused.
- S10b: inside an execution run `POST /put` goes through `keyedWrite` (Idempotency-Key);
  `outcomeOf` reads `drivePut` (unknown → the run waits for reconcile; ref kind `drive-put`,
  replay read `GET /puts/:id`).
- Tools (`createDriveTools`, on `acb_records`): `drive_pick_folder`, `drive_pick_files` (open
  the Picker for the person and wait), `drive_picked` (live picks), `drive_read`, `drive_put`
  (act only). `drive_put` reads the local file in main: inside the consultation's company folder
  by name and real location (`PathGuard`), no `.git` segment, not inside a private folder (a
  nested repository on the way, or a readable private folder path — one sentence that never
  names it), not in a folder left out on this computer, PDF / HTML ≤ 10 MB with the content
  check (Markdown too, always as a Google document); `requestKey = drivePutRequestKey(folder, name, sha256, { as,
  updateFileId })` (same content, folder, name, form and target → the same key: never two copies of identical
  content; a plain new file keeps the key it always had). **Whether a file is new or updated is only `updateFileId`**,
  and the tool's description says so in both languages (incident 2026-11-10: the AI told a member that the same name
  would not duplicate): without it every edited file is a new Drive file (and a new link); with it, the same file gets
  a new revision. `drive_picked` lists `putFiles` (the status's `puts`: the member's own done puts, once per file, newest
  first — what `updateFileId` may name). Unattended runs see none of these tools (their allowlists) — except a
  scheduled job's run with a deliverable place, which gets `drive_picked` and `drive_put` only (`jobs.md`).

## Google documents and overwriting (owner decisions 2026-11-11, 統合版 §12-6 E)

- **A Google document**: `as: 'google_doc'` with `kind: html | markdown` uploads the text with the Docs MIME type in
  the metadata (Drive converts it); the receipt's `mimeType` is `application/vnd.google-apps.document`, its revision
  `version:<n>`, its `sha256` the bytes uploaded. The name has no extension (a trailing `.html` / `.md` is taken off).
- **Overwriting** (`updateFileId`): only a file **this member's own put made** (`putOfFile`: their done receipt for
  that file id — ACB made it, so `drive.file` opens it; a file they only picked, another member's put, an unknown id →
  403 `DRIVE_FILE_NOT_OURS`), **in the same folder** as that put (403 `DRIVE_FILE_NOT_IN_FOLDER`), of **the same kind**
  (a document by a document, a PDF by a PDF: 400 `DRIVE_UPDATE_KIND_MISMATCH`) — all before Google is asked and before
  a receipt is written. After the receipt and the folder's checks, Google is asked for the file
  (`id,mimeType,trashed,parents,capabilities(canEdit)`): still there, still in that folder, still that kind, editable
  (else 403 `DRIVE_FILE_REFUSED`); **for the AI, the file's own sharing too** (a file can be shared outside by itself,
  whatever its folder says: `DRIVE_FILE_SHARED_OUTSIDE` / `DRIVE_FILE_SHARING_UNKNOWN`). Then `PATCH
  /upload/drive/v3/files/<id>?uploadType=multipart` with only `appProperties.acbPutId` (the lookup after a lost answer
  finds the update by it) and the content; the name is not changed (the receipt keeps the file's). The receipt says
  `updatedFileId` (`google_drive_puts.updated_file_id`, additive `migrateDrivePutUpdates`); the same request key with
  another target is `DRIVE_PUT_KEY_REUSED`; never retried, a lost answer is `unknown` and found by `acbPutId` as for a new
  file. The record link **follows the newest revision**: a put that updated a file this member linked from an earlier
  put (the same `drive:<fileId>` link, made by them) replaces the link's kept facts (revision, sha256, when) in a
  `link_file` entry noted 「Google Drive のファイルを上書きしたので、新しい版につなぎ直しました」 (`file-links.ts`
  `follows`; records.md); anything else already linked stays as it is.
- Unverified against real Google (the fake converts and updates in place): that Drive converts `text/markdown` into a
  document (Google added Markdown import in 2024), and that `files.update` with HTML / Markdown media on a Google
  document replaces its content as a new version (the Drive API documents media upload on update for Workspace
  types).

## Linked to a record (a company without the shared folder; `records.md` "File links without the shared folder")

`linkable(member, fileId)` — asked only by the records session route `POST …/file-links { target: {
kind: 'drive', fileId } }`, only for a company without the shared folder, and only **after every record
check passed** (`recordEngine.fileLinkBeforeDrive`: records on, the record exists and is readable, the
body, the version, not linked already; a refusal there asks Google nothing): the member's own live
pick of a file, or a file **their own** put made (`putOfFile`: ACB created it, so `drive.file` opens it;
another member's put is not theirs) (else 403 `DRIVE_NOT_PICKED`, nothing asked of Google), `files.get` with **their own**
token (`id,name,mimeType,trashed,headRevisionId,version`), then the content read as `read` does
(export / download, ≤ 10 MB) only to compute its sha256 — nothing of it kept or logged. Never called
for anyone but the member linking, never to look at a file someone else linked: other readers get
the row without its name and open it in Drive. The app's 「Google Drive のファイルをつなぐ」 first offers
the member's own files (`createDrivePicking().ownFiles` → `tasks:driveChoices`; `tasks-ui.md` "Linking
files"; `tasks:linkDriveFiles(…, { chosen })` links them without the Picker) and otherwise is this
connector's Picker flow (`createDrivePicking().pick(companyId, 'files')`, composed in `main.ts` into
`tasks:linkDriveFiles`; a pasted link: `{ fileIds }`, "Picker and its token" above, straight to the
Picker). The card's button is off with
「…会社の管理者による準備が必要です…」 while `MyGoogle` says Google is unavailable or `drive` is not in
`companyFeatures` (the Picker not registered; `driveLinkView`, `client/shared/google.ts`, from
`google:status`; stopped by the operator or the server not ready → the app's usual `GOOGLE_UNAVAILABLE_TEXT`
instead), says before the first press that Google will ask, for the chosen files only, and ignores a
pasted / dropped link — and does not open its own list — while the chooser is already open (no second window).
The AI reads a linked file only with `drive_read` (its member's own picks).
When a linked Drive file is used as a decision material or an attachment, its fileId, revisionId and
sha256 enter the record's ledger and are visible to every reader of the record; the file's name is not
included (it stays the linker's).

## Not yet

A person-side put (session route + card), a record ledger entry linking a put to a まとまり (a put in a consultation about a やること is linked to that やること, above), and
`features_off` toggles (`member-oauth.md`). Spreadsheets and Slides output; another connector's file storage (OneDrive,
Box: its own `deliveryPlaces` kind, `connector-roles.md`).

## Tests

`server/tests/integration/google-drive.test.ts` (fake Google, practice redirect; 「a picked file linked to a record」, including 「every record check comes first」; 「a put in a consultation about a task」: the receipt's facts, the AI as the actor, the name to the linker only, a replay never links again, a failed record check keeps the put done, the own-files list and another member's refusal; 「Google documents and overwriting」: HTML / Markdown as a document and every other form refused, an update keeps the id and link with a new version and is never sent twice, the key reused with another target, not the member's own put / another folder / another kind / another member — refused before Google is asked, a file moved away or shared outside by itself refused with nothing sent, a lost answer found, the task's link following the newest revision — mutation-checked, 12 guards; not reachable, kept as defence: an
update's `fileId` taken from the receipt rather than Google's answer, and the link following only a changed revision) and
`server/tests/integration/job-deliverables.test.ts` (a job's run: `jobs.md`) and
`server/tests/unit/google-drive-core.test.ts` (the link parser: Google's hosts only, look-alikes,
other schemes, folders, bad ids refused); `client/tests/google-drive-tools.test.ts`;
`admin/tests/integrations.test.tsx` 「Drive の ファイル選び」. Mutation-checked: the Picker
token's scope check and the narrowing parameter, `drive.file` before asking Google, the Picker
registration, picks verified with Google, folder picks are folders, read / put only picks of
the right kind, the act token, the MIME / name / content / sha checks, the outside-sharing
refusal, the receipt's idempotency and key reuse, the lookup after a lost answer, the put's link only
for a new put, a link refusal never failing the put, own puts only (list and `linkable`); in the app:
tools only when available, put only with act, consent before the Picker, preselected ids only as
Drive ids and only for files (window config, `typed-file-links.test.ts` for main, the page's own
filter and mode check in `google-drive.test.ts`, which also checks the CSP hash is the script served), the path checks
(outside, link, `.git`, nested repository, private list, left out), kind and content, the
Picker page check and id filter, the request key, the topic's record id on a put (never the AI's); the
preload's format (`check-preloads.mjs` fails on the build without `commonJsPreload`).
