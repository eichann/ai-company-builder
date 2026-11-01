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
  - "client/tests/google-drive-tools.test.ts"
---

# Google Drive through the Google connection (feature `drive`, `drive.file`)

The first sales experience: 「○○社の提案書を作って」 in a consultation → the company's skill
reads the Gemini minutes (ACB's minutes tools), past proposals / notes the member picks in Drive,
makes the proposal as HTML + PDF locally, and ACB puts it into the Drive folder the member chose.
Owner decisions 2026-11-01: output stays HTML / PDF (no Slides generation); Drive belongs to the
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
`records-ai.ts`), `RecordToolsOptions.extraTools` (a connector's tools on `acb_records`), the
`DrivePickerWindow` port, and `drive-put` in S10b's `outcomeOf` / `replayReadPath`.

## Scopes

Feature `drive` = `drive.file` (`GOOGLE_FEATURE_SCOPES`); asked **when first used**: the first
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
- Unverified against real Google (no real accounts in tests): that Google honours the narrowed
  refresh (if not, Drive picking is refused — safe), and that Picker works in an Electron
  window without a Google sign-in cookie in that partition (Google may block a sign-in inside
  embedded browsers; fallback then: the same page in the system browser with a one-time code).
- Staging: the fake Google serves a stand-in Picker at `<practice origin>/js/api.js` (lists the
  account's Drive files, marks the click as picked — `/__picker/*`).

## Picks (`google_drive_picks`)

`POST /me/google/drive/picks { mode, ids }` (session; folder: 1 id, files: ≤ 10): each id is
opened with Google first (`drive.file` answers only for files picked for this app); a folder
must be a folder the member can add to, a file a readable type (`DRIVE_READ_AS`); anything else
is counted `refused`, not kept. Kept 90 days (folders) / 7 days (files); a re-pick renews.
The AI reads and writes **only** the member's own live picks.

## The AI's routes (`/api/records-ai/google/drive`, record token) and tools

- `GET /status` → `{ available (Google on + Picker registered), granted, picks }` — the app adds
  the Drive tools only when available. `POST /read { fileId }` (picked file only, else 403
  `DRIVE_NOT_PICKED`): Docs / Slides → text/plain export, Sheets → text/csv, text files as is,
  marked as outside text (`DRIVE_TEXT_HEADER` / `FOOTER`, `instructionLike`), ≤ 200 000
  characters; a PDF (≤ 10 MB) as base64 — the app saves it at
  `.personal/google-drive/<id16>-<name>.pdf` (never synced) and returns the path.
- `POST /put` (act token) `{ folderId, name, kind: pdf|html, sha256, contentBase64, requestKey }`:
  checks in order: kind allowlist → name (one segment, the kind's extension) → key / sha
  shapes → size → sha256 matches → content (`%PDF-`, UTF-8 without NUL) → folder is a live
  folder pick → **receipt first** (`claimPut`, unique per member + requestKey; same key with
  other content 409 `DRIVE_PUT_KEY_REUSED`; done / unknown → answered as is, `existing: true`,
  nothing sent) → folder still a folder the member can add to → **for the AI, nobody outside
  the company's domain sees the folder** (`permissions.list` + `driveFolderReachesOutside`;
  anyone-link, another domain, an outside person/group → 403 `DRIVE_FOLDER_SHARED_OUTSIDE`;
  unreadable → 403 `DRIVE_FOLDER_SHARING_UNKNOWN`) → multipart upload with
  `appProperties.acbPutId = <put id>`, **never retried**. 2xx → `done` with `fileId`,
  `revisionId` (`headRevisionId`) and `link`. Lost answer / 5xx → `unknown`, looked up at once
  by `acbPutId` (found → `done`, reason `found-by-correlation`), and again on every
  `GET /puts/:putId` and repeat; never re-sent. Refused / not sent → the receipt is removed.
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
  check; `requestKey = drivePutRequestKey(folder, name, sha256)` (same file, folder and name →
  the same key: never two copies). Unattended runs see none of these tools (their allowlists).

## Not yet

A person-side put (session route + card), a record ledger entry linking a put to a まとまり, and
`features_off` toggles (`member-oauth.md`).

## Tests

`server/tests/integration/google-drive.test.ts` (fake Google, practice redirect) and
`server/tests/unit/google-drive-core.test.ts`; `client/tests/google-drive-tools.test.ts`;
`admin/tests/integrations.test.tsx` 「Drive の ファイル選び」. Mutation-checked: the Picker
token's scope check and the narrowing parameter, `drive.file` before asking Google, the Picker
registration, picks verified with Google, folder picks are folders, read / put only picks of
the right kind, the act token, the MIME / name / content / sha checks, the outside-sharing
refusal, the receipt's idempotency and key reuse, the lookup after a lost answer; in the app:
tools only when available, put only with act, consent before the Picker, the path checks
(outside, link, `.git`, nested repository, private list, left out), kind and content, the
Picker page check and id filter, the request key.
