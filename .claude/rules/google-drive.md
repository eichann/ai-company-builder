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
  - "client/tests/google-drive-tools.test.ts"
---

# Google Drive through the Google connection (feature `drive`, `drive.file`)

The first sales experience: 「○○社の提案書を作って」 in a consultation → the company's skill
reads the Gemini minutes (ACB's minutes tools), past proposals / notes the member picks in Drive,
makes the proposal as HTML + PDF locally, and ACB puts it into the Drive folder the member chose.
Owner decisions 2026-11-01: output stays HTML / PDF (no Slides generation) — 2026-11-11: HTML / Markdown may
also become a **Google document**, and a file ACB made may be **overwritten as a new revision** ("Google documents
and overwriting") — 2026-11-12: Markdown and plain text may also be put **as they are** (`.md` / `.txt`, "Markdown and
text as they are"); a scheduled job may put into one folder its responsible person picked (`jobs.md` "A deliverable
place outside"); Drive belongs to the
Google **connector** (connection only) — never a core role, no core 「file storage」 role;
least privilege: **`drive.file` + Google Picker only, never `drive` / `drive.readonly`**;
per-member grant; the AI never sees a token; every call through the one Google client
(`google-connector.md`: operator stop, company Google off, vault, grant, scope).

## Where it lives (the stage-3 move into the connector plugin stays mechanical)

Everything is in the Google connector's files: `shared/core/google-drive.ts` (rules),
`shared/types/google-drive.ts` (contract), server `services/google-drive.ts`,
`routes/google-drive.ts`, `ports|adapters/sqlite/google-drive.ts` (behind the company handle
`googleDrive`), app `client/electron/features/google/drive.ts` (the Picker opens in the
member's browser through the shell's `openExternal`). The core only gives seams: `routes/record-ai-auth.ts` (record-token auth + S10b's `keyedWrite`, shared with
`records-ai.ts`), the tool providers (`client/electron/records/tool-providers.ts`: a connector's tools on `acb_records`, merged by `createRecordTools`), the
shell's `openExternal`, and `drive-put` in S10b's `outcomeOf` / `replayReadPath`.

## Scopes

Feature `drive` = `drive.file` (`GOOGLE_FEATURE_SCOPES`); offered by the company only once the
Picker is registered, then asked with the other features in 「仕事の道具をつなぐ」's one consent, or
**when first used**: the first
`drive_pick_*` opens 「Google で許可」 in the system browser with `features: ['drive']` (the
already-granted features are added by the server) and waits ≤ 2 minutes for the grant.
`GOOGLE_NEVER_SCOPES` lists what ACB never asks or stores (`drive`, `drive.readonly`, …; test).

## Picker and its token (the one Google token handed out to a browser)

**What real Google showed (production, 2026-11-12):** Google Picker needs a browser that is
**signed in to Google**. In the app's own Electron window (an empty session partition) Google showed
「Google アカウントにログイン / このコンテンツにアクセスするにはログインする必要があります」, and its
［ログイン］ opens a popup — which the window denied — and Google blocks signing in inside embedded
browsers (Electron / CEF) anyway. So the Picker is **not usable inside Electron**: it opens in the
member's **system browser** (already signed in), like 「Google で許可」, with a one-time pick ticket.
Also learned: the page's `Referrer-Policy` (`strict-origin-when-cross-origin`) lets Google see only
the origin, so the API key's website restriction must allow `<origin>/*` (the page's full address
never matches).

- Admin 「つなぎ先」→「Google」→「Google Drive のファイル選び」: API key (password field; stored
  as is — Picker's developer key is sent to the page by design; answers show its last 4) and
  the Cloud project number (`appId`), `PUT /google/picker { apiKey?, appId }` (owner/admin;
  `appId: null` removes both). The page shows **`<origin>/*`** with 「コピー」 to add to the key's
  website restriction (`drivePickerReferrerPattern(view.picker.pageUrl)`, test
  `admin/tests/integrations.test.tsx`), and says the choosing screen opens in the member's browser. The
  admin also enables Google Picker API + Drive API and adds `drive.file` to the OAuth consent screen.
- **The pick ticket** (`google_drive_pick_tickets`, behind the handle's `googleDrive`): `POST
  /me/google/drive/pick-tickets { mode, fileIds? }` (**session only**): operator stop → Picker
  registered (409 `DRIVE_PICKER_NOT_CONFIGURED`) → the member's grant active with `drive.file` (else 409
  `GOOGLE_CONSENT_NEEDED`, `needsGoogleConsent: 'drive'`) and `drive` not turned off (409
  `GOOGLE_FEATURE_OFF`) → Google on (`GOOGLE_STOPPED`) → at most `DRIVE_PICK_TICKETS_OPEN_MAX` (5) open
  tickets of the member (429 `PICK_TICKETS_TOO_MANY`); nothing is asked of Google. Answers `{ ticketId,
  ticket, expiresAt }` once: `ticket` = 64 hex (`ids.newToken`, 256 random bits; `DRIVE_PICK_TICKET_RE`);
  only its **sha256** is stored (unique), with the member, the mode, its maximum (folder 1, files
  `DRIVE_PICK_MAX_FILES`), the preselected `fileIds` (files only, `drivePreselectIds`) and **10 minutes**
  (`DRIVE_PICK_TICKET_TTL_MS`). The public routes find a ticket by its sha256 in the control plane
  (`PickTicketDirectory`, `sqlitePickTicketDirectory`, like a key-broker token; `company-scoped-sql`
  `UNSCOPED`), then read it through that company's handle. A ticket's row (and a result the app has not
  read) is pruned only `DRIVE_PICK_TICKET_KEPT_AFTER_MS` (grace + 5 minutes) after its end, at a start.
- **The app** (`createDrivePicking().pick`, main) opens `drivePickerPageUrl(server, ticket)` =
  `<server>/api/google-picker#t=<ticket>` through the shell's `openExternal` (only that address, built
  in main from a ticket of the right shape: `isDrivePickTicket`), then waits: `GET
  /me/google/drive/pick-tickets/:ticketId` with the session every 2 s (no push channel; each request has
  its own 15 s limit and the AI's stop signal) → `{ state: 'waiting', opened, saving? }`, or `picked` (the
  picks, `refused`) / `cancelled` / `expired` / `failed` (`error`, a fixed sentence). A final state can be
  read again (a lost answer loses nothing) until the app acknowledges it with `DELETE
  /me/google/drive/pick-tickets/:ticketId`. The member's own ticket only (another member's or company's id
  → 404 `PICK_TICKET_NOT_FOUND`). **The server ends the wait**: an open ticket is `expired` at its end; a
  pick still being kept (`saving`) is waited for `DRIVE_PICK_SAVING_GRACE_MS` (2 minutes) more. The app
  stops by itself only when: the AI's turn is stopped (checked before and after every request — a stop
  wins over a `picked` answer that arrived meanwhile), the page never took its config within 2 minutes
  (`opened` false: 「ブラウザで Google Drive から選ぶ画面が開かれませんでした…」), a 401 (log in again), or
  its backstop (10 minutes + the grace + 1 minute) for a silent server; each closes the ticket (`DELETE`,
  best effort). The app never holds the Picker's token; the ticket is never logged and never reaches the
  renderer or the AI.
- **The page** `GET /api/google-picker` (public, static, no secret; strict CSP with the inline script's
  hash, `connect-src 'self'` for its two calls; `no-store`; `Referrer-Policy:
  strict-origin-when-cross-origin`): reads the ticket from the **URL fragment** (never sent to a server,
  in a Referer or a request log) and takes it off the address (`history.replaceState`); `POST
  /api/google-picker/config { ticket }` (public, the ticket is the proof): the company from the ticket,
  the row by its sha256 inside that company only, open and unexpired, **the config handed out once**
  (`claimPickTicketConfig`, atomic) → still a member → operator stop → Picker registered →
  `googleClient.pickerToken`: a **fresh** token from the refresh token with `scope=drive.file` (RFC 6749
  §6 subset — never the cached token, which holds every granted scope); Google's answer must carry
  **exactly** `drive.file` (`isDrivePickerTokenScope`), else 503 `DRIVE_PICKER_SCOPE` and nothing handed
  out. Not cached, not logged (one AI-action-log line `google:drive.picker.token`). A refusal after the
  claim closes the ticket as `failed` with its sentence (the app shows it). **After Google answered, the
  ticket is read again**: closed by the app meanwhile → 410 and the token goes nowhere. Answers the
  token, key, app id, script origin, mode, MIME types, `maxItems`, `fileIds` and `account` (the grant's
  Google email). Any ticket that cannot be used (unknown, expired, used, closed) → the one 410
  `PICK_TICKET_GONE`.
- **The Google account**: the page calls `PickerBuilder.setAuthUser(account)` when Google's Picker has
  it, and says 「Google アカウント「…」で選んでください（…切り替えてください）」 — a browser signed in to
  several accounts may otherwise show another one. Unverified against real Google: that `setAuthUser`
  exists and selects the account (if not, the sentence is what helps).
- `POST /api/google-picker/result { ticket, action: picked | cancel, mode?, ids? }` (public): once per
  ticket. `cancel` (the Picker's 「キャンセル」, or the page closed: `pagehide` sends it with
  `keepalive`) → `cancelled`. `picked` only after the config was handed out, `mode` must be the
  ticket's (400), 1 … the ticket's maximum of `isDriveId` ids (400) → the ticket moves to `saving`
  (atomic) → **checked for the ticket's member exactly as `POST /me/google/drive/picks` checks** (the one
  `checkPicks`: each id opened with Google, folder / file kind, `refused` counted) → kept only through one
  synchronous compare-and-set `saving → picked` followed by the write (`keepPicks`): a ticket the app
  closed meanwhile keeps nothing and the page gets 410. The body names no member. The page posts the
  result with **`keepalive`** (a tab closed right after 「選択」 still delivers it), tries a failed post once
  more (a retry told `PICK_TICKET_GONE` just says 「アプリに戻ってください。」: the first try may have arrived), then posts a cancel; it then says 「選びました。アプリに戻ってください。（このタブは閉じて
  かまいません）」 / 「選ぶのをやめました。…」.
- **Accepted residual risk** (owner's safe-side choice): the ticket is not bound to the browser, and the
  first address `…#t=<ticket>` may stay in that browser's history (and its sync) until the page takes it
  off — the ticket is usable only once (the config), only for 10 minutes, and a result is taken only
  after the config; someone who read it from the history after that could at most cancel the pick or
  send Drive ids the member's own `drive.file` token opens, kept as that member's picks.
- **Released apps** (≤ release-20261109, the Electron Picker window): `POST /me/google/drive/picker
  { mode }` **fails closed** — 409 `DRIVE_PICKER_APP_UPDATE_NEEDED` 「Google Drive のファイル選びは、
  新しいアプリで使えます（ブラウザで選ぶ形になりました）。アプリを新しくしてから、もう一度お試しください。」
  (a bad body still 400). Their window could not sign in to Google anyway; no token goes out on it.
  The app's Picker window and `picker-preload.ts` were removed.
- Unverified against real Google (no real accounts in tests): that Google honours the narrowed
  refresh (if not, Drive picking is refused — safe).
- **Tabs** (owner report 2026-11-12: a single `FOLDERS` view with `setEnableDrives(true)` opened under 「共有アイテム」 or a
  flat folder list, not My Drive): the page adds one `DocsView` per place, the first being the tab the Picker opens on —
  「マイドライブ」 (`setParent('root')`), 「共有ドライブ」 (`setEnableDrives(true)`), 「共有アイテム」 (`setOwnedByMe(false)`,
  only when the Picker has it) — each with `setIncludeFolders(true)` and the mode's MIME types (folder mode also
  `setSelectFolderEnabled(true)`), `setLabel` when present. `setParent`, `setEnableDrives` and `setOwnedByMe` are never
  combined on one view; a pasted link stays one view with `setFileIds` alone. Test 「the Picker opens on My Drive…」.
  **Unverified against real Google** until the owner tries it: that `setParent('root')` opens My Drive, that `setLabel`
  names the tabs, and that `setOwnedByMe(false)` shows folders shared with the member in folder mode.
- Staging: the fake Google serves a stand-in Picker at `<practice origin>/js/api.js`, which the page
  loads in the browser as it would Google's (lists the account's Drive files, marks the click as
  picked — `/__picker/*`; `setFileIds` narrows the list); test 「staging's stand-in Picker…」.
- **A pasted / dropped Drive link** (owner decision 2026-11-09): the ticket may carry `fileIds`
  (files mode only) and the config hands them to the page, which calls `DocsView.setFileIds` (Google's
  Picker reference: "Sets the file IDs included in the view", comma-separated; not combined with
  `setEnableDrives`, which it then skips), so the chooser shows just that file and one 「選択」 picks it.
  Only Drive ids get there: the renderer reads them with `driveFileIdsFromText` / `driveFileIdFromLink`
  (`shared/core/google-drive.ts`: `https:` only, no user / password / port, the host exactly
  `drive.google.com` or `docs.google.com`, a file path — Docs / Sheets / Slides / `file/d`, `open?id=`,
  `uc?id=` — never a folder, the id `isDriveId`), main again with `drivePreselectIds`
  (`tasks:linkDriveFiles`' optional 4th argument, `createDrivePicking().pick(…, { fileIds })`), the
  server once more when it makes the ticket, and the page filters once more. A pasted id opens nothing
  by itself (drive.file): nothing is read or linked outside the Picker, and what is linked is what the
  member picked there. Unverified against real Google: that `setFileIds` shows a file not yet granted
  to the app under `drive.file` (Google announced it for that, 2024-11); if not, the member sees an
  empty chooser and cancels.

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
  marked as outside text — Markdown as `text/markdown` (ACB's own puts) or `text/x-markdown` (what Drive has reported
  for an uploaded `.md`) — (`DRIVE_TEXT_HEADER` / `FOOTER`, `instructionLike` from `outsideTextFlags`;
  the text's `【】` → `〔〕`, server and app, `shared/core/outside-text.ts`), ≤ 200 000
  characters; a PDF (≤ 10 MB) as base64 — the app saves it at
  `.personal/google-drive/<id16>-<name>.pdf` (never synced) and returns the path.
- `POST /put` (act token) `{ folderId, name, kind: pdf|html|markdown|text, as?: file|google_doc, sha256, contentBase64,
  requestKey, updateFileId?, recordId? }`: checks in order: form allowlist (`drivePutForm`: a PDF / HTML / Markdown /
  text as a file, HTML / Markdown as a Google document — nothing else) → name (one segment; a file keeps the kind's extension, a
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
  may act on, not linked already — in every company, owner decision 2026-11-13) at the version current now, as
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
  names it), not in a folder left out on this computer, PDF / HTML / Markdown / text ≤ 10 MB with the content
  check (Markdown a Google document unless `as: 'file'`); `requestKey = drivePutRequestKey(folder, name, sha256, { as,
  updateFileId })` (same content, folder, name, form and target → the same key: never two copies of identical
  content; a plain new file keeps the key it always had). **Whether a file is new or updated is only `updateFileId`**,
  and the tool's description says so in both languages (incident 2026-11-10: the AI told a member that the same name
  would not duplicate): without it every edited file is a new Drive file (and a new link); with it, the same file gets
  a new revision. `drive_picked` lists `putFiles` (the status's `puts`: the member's own done puts, once per file, newest
  first — what `updateFileId` may name). Unattended runs see none of these tools (their allowlists) — except a
  scheduled job's run with a deliverable place, which gets `drive_picked` and `drive_put` only (`jobs.md`). After a
  job's 「もう一度」, the retried run's turn resolves an earlier run's put id to its file (`madeFile`: the member's own
  done receipt, written by one of the occurrence's runs, whose recorded folder is the job's chosen one → `{ id: fileId,
  name }`), so it can name that file in `updateFileId` (`jobs.md`
  "「もう一度」").

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
- **Review of #678** (each a guard with its test):
  - **Nothing fetched from outside** — an allowlist that fails closed (`driveDocFetchesOutside`,
    `shared/core/google-drive.ts`; the re-review showed a tag / attribute blocklist was bypassable): in the text as
    written and with character references decoded, every URL-like token is refused (`scheme://`, `//` or `\\` starts,
    `scheme:` other than `data:` / `mailto:`), except the `href` value of an `<a>` tag (that value only) and, in Markdown,
    an inline non-image link `[text](url)` (no title, not inside another bracket); CSS (`<style>`, `style=`), `srcset`,
    `http-equiv` and Markdown reference definitions (`[ref]: …`) are refused outright. 400 `DRIVE_EXTERNAL_RESOURCE` (the
    app says so first). Refused, never rewritten; a plain URL in a report must be written as a link.
  - **Changed in Drive since ACB's last put**: 409 `DRIVE_FILE_CHANGED_SINCE` — nothing overwritten; put a new file. A
    file with binary content (PDF, HTML, `.md`, `.txt`): its head revision is not the latest receipt's. A Google
    document: its text is not what it was ("A Google document's own changes" below) — never its `version`.
  - **A Google document's own changes** (real Google, 2026-11-12: the owner opened an imported document once and closed
    it without typing; its 変更履歴 showed one version, the import, yet the update was refused `DRIVE_FILE_CHANGED_SINCE`):
    Drive's `version` counts every change on the server, "even those not visible to the user" (opening, post-import
    processing), so it is never used as a "someone edited it" signal. Owner rule: **a person's change is never
    overwritten**; when in doubt, refuse.
    - **The baseline** (`google_drive_puts.doc_fingerprint` / `doc_revision` / `doc_revision_at` / `doc_baseline_at`, additive
      `migrateDrivePutDocFingerprints`; never answered; `DriveDocBaseline`) is taken **only inside the put / update request
      itself**, right after Drive answered it (`keepDocBaseline`), and only when **all** of these hold:
      - (a) two `text/plain` exports `settleMs` apart give the same text (not a stale or half-processed one; each export
        is tried once more after a failure);
      - (b) **the observation**: Drive's processing after the import is watched to its end. Nothing is read until
        `quietMs` after the upload answer (default 8 s; real Google moved the times 3–4 s after it, so two early reads
        could both see the time from before the move); then `revisions.list` (every page,
        `revisions(id,modifiedTime,lastModifyingUser(me))`) and `files.get` (`modifiedTime,lastModifyingUser(me)`) are
        read, and again `gapMs` later (default 2 s), until two reads agree on the newest revision's id and `modifiedTime`,
        the count and the file's `modifiedTime` and last modifier. Still changing `budgetMs` after the answer (default 25 s)
        or after `DOC_BASELINE_MAX_READS` (12) reads → `still-settling`. Timings: `driveDocTiming` (`lib/config.ts`,
        `ACB_DRIVE_DOC_SETTLE_MS` / `_QUIET_MS` / `_GAP_MS` / `_BUDGET_MS`, read per use), measured on the server's
        monotonic clock; the worst case stays well inside the app's 120 s put timeout;
      - (c) **every** revision was made last by the member's own account (`lastModifyingUser.me`; ACB writes with their
        token), and so was the file's last change (`files.get`, a witness that does not rest on the revision list);
      - (d) **exactly one revision is new**: a new document has exactly one revision (the import); an update has exactly
        one after the previous baseline's revision, which must still be listed (`base-revision-gone` otherwise). A second
        revision — even the member's own (a change of look right after the put) — or an import Docs merged into the
        revision before (none new) keeps none;
      - (e) the file's `modifiedTime` and the newest revision's are both within `DOC_BASELINE_WINDOW_MS` (30 s: the
        observation's longest budget and a little more) **after** the upload answer's `modifiedTime`, never before it, and
        shaped like RFC 3339 UTC (anything else is outside).
      The newest revision's id and `modifiedTime` **as observed once settled** are kept (not the upload answer's); the
      baseline's own time stays the upload answer's (comments are compared from it: the earliest moment ACB's text
      existed). The file's observed time is not kept (nothing compares it later). Anything else keeps none. A put found
      after a lost answer (`reconcile`: a repeat of the request, `GET /puts/:id`, any time later) never gets one — the
      document may hold a person's edit by then.
    - **Why a window and not equality** (real Google, 2026-11-12, the owner's practice document, a new put; #683's log
      line `modified-moved upload=…53:51.481Z file=…53:55.615Z newest-revision=…53:54.702Z revisions=1`): every revision
      and the file were the member's, the two exports matched, there was one revision (the import), and Drive's processing
      after the import moved the file's `modifiedTime` ~4 s and that revision's ~3 s after the upload answer with nobody
      editing. The exact `modifiedTime === upload answer` check (#683) could never pass, so no document could ever be
      overwritten.
    - **What the window lets through** (decided 2026-11-13 after Codex's review of #684; in "Decisions for the owner"):
      - **Covered**: another account's edit that stays a revision of its own is refused by (c) (also on a later page, or
        without its author); a second visible revision of anyone is refused by (d); the file's last change by someone
        else is refused by (c); a time outside the window by (e).
      - **Not covered — the accepted residual**: an edit Docs **merges into the member's revision** during the observation
        (from the upload answer to the agreeing reads). Google documents that revisions may be merged and that
        `lastModifyingUser` names only the **last** modifier, so a colleague's edit followed by the member's own in one
        revision passes (b)–(e), and the baseline then holds the colleague's text; a later update may overwrite it.
        Accepted as the same family as the update's If-Match race ("Residual race" below): an edit typed in the seconds
        around ACB's write. On a new file, another person would have to find it and edit within seconds of its creation.
        The member's own edit in those seconds is also taken in — **owner decision 2026-11-12: the writer's own edits may
        be overwritten**. The window is kept as short as the observation allows (30 s) for this reason. Test: 「an edit
        merged into the member's revision during the observation is the accepted residual」 (documents the behaviour).
    - **Diagnostics** (`log.warn`, `[google-drive]`; never a file id, put id, name, text or token — only step names,
      counts and timestamp-shaped values): a baseline not kept → `document baseline not kept: <step>`, `no-upload-time` |
      `export-failed` | `export-differs` | `no-revision` | `file-unread` | `still-settling (reads: n)` | `not-me
      (revisions: n, not the member's: n, the newest the member's: true|false)` | `base-revision-gone (revisions: n)` |
      `revision-count (revisions: n, new: n)` | `file-not-me` | `outside-window upload=<t> file=<t> newest-revision=<t>
      revisions=<n>` (the upload answer's, `files.get`'s and the newest revision's `modifiedTime`; a time not shaped
      like an RFC 3339 UTC timestamp is logged as `unusual`); an update refused by the comparison → `document update refused: changed
      since the baseline (text | revision-id | revision-time | comment)`.
    - **Before an update**, with the member's own `drive.file` token (allowed on a file ACB made; the one `drive()`
      helper with `GOOGLE_SCOPE.driveFile`): the text export again → its sha256 must equal the baseline's; the newest
      revision's id **and** `modifiedTime` must be the baseline's (formatting, images, a chart, a suggestion change no text
      but make a revision — or, merged by Docs into the newest one, move its time: Docs merges one account's edits close
      together and ACB writes as the member, so the member's bold right after ACB's put lands in ACB's revision); no
      comment made or changed since the baseline's time (`comments.list` `startModifiedTime`, deleted ones included).
      Different → 409 `DRIVE_FILE_CHANGED_SINCE` (a comment: its own sentence). **Fails closed** → 409
      `DRIVE_FILE_NOT_VERIFIABLE` 「…Google Drive で直されていないか確かめられないため、上書きしません。新しいファイルとして置いてください。」,
      nothing sent: no baseline (every receipt from before this rule, a put found after a lost answer, a baseline not
      proven), or the export, the revisions or the comments unreadable now.
    - `text/plain` rather than `text/markdown`: the long-standing export `drive_read` uses, and it carries no image
      addresses (an export with images names short-lived `googleusercontent` URLs that would differ every time); the
      revision covers what the text misses. Both are needed: Docs merges edits close together into one revision, so an
      edit may leave the newest revision id as it was — the text then tells.
    - **A later time on the same revision is refused** (owner decision pending; the safe side by default): if Drive's
      post-import processing also moved the newest revision's `modifiedTime` *after* the baseline was read, every update
      would be refused (`revision-time` in the log). It is not accepted even when that revision is the member's and the
      text and comments are unchanged: the member's own bold merged by Docs into ACB's revision looks exactly the same,
      and a person's change is never overwritten.
    - **To confirm on real Google** (if any is wrong, updates are refused — the safe side; the log lines tell which):
      - that the post-import move ends within the quiet period and stays within the window (`outside-window` /
        `still-settling`), also after an update (`revision-count`: whether an update makes exactly one new revision);
      - whether the newest revision's time also moves *after* the baseline's reads (`revision-time` on the next update);
      - that `lastModifyingUser.me` is answered on revisions and on the file under `drive.file` (confirmed 2026-11-12 on a
        new put);
      - that `revisions.list` and `comments.list` answer under `drive.file` for a file ACB made (`revisions.list`:
        confirmed 2026-11-12);
      - that opening and closing a document (the owner's case) moves neither the newest revision's id nor its
        `modifiedTime` (the owner's 変更履歴 showed one version).
    - **Residual race** (accepted): Drive's `files.update` has no If-Match, so an edit typed between these checks and the
      write is lost from the document's current text; it stays in the document's own version history (変更履歴).
    - The fake moves a document's `version` on every export and on `openDriveFile`; `editDriveFile` / `formatDriveFile`
      add a revision (by `SOMEONE_ELSE` unless given an account), `editDriveFileMerged` changes the text in the newest
      one, `commentOnDriveFile` adds a comment; each revision records its author and `revisions.list` answers
      `lastModifyingUser.me` only when `fields` asks for it; faults `failNextExports`, `staleNextExport`,
      `editBeforeNextExport(content, by?, omittedFromRevisions?)` (queued: several edits before the next export; omitted:
      the text and the file's last modifier change, the revision list does not show it), `moveTimeAfterNextImport({ ms,
      revisionMs, fileTimeAs })` (the post-import move: answered time, then the file's — and optionally the newest
      revision's — time later; real Google's ~4.1 s / ~3.2 s; `fileTimeAs` a malformed time or a function of the answered
      one; `afterMs`: the move happens that much real time after the answer, applied before the next request — the quiet
      period's and the gap's tests: real time, scaled down per test through the timing variables), `settleRevisionAfterNextLists(count, ms)` (the newest revision's time moves again after a list was answered),
      `reshapeRevisionsAfterNextImport('extra-own' | 'merged' | 'pruned')` (a second revision by the uploader, the import
      merged into the revision before, the older revisions dropped), `editAfterNextImport([{ content, by?,
      omittedFromRevisions? }])` (edits right after the import: a colleague's then the member's, merged),
      `settleFileAfterNextGets(count, ms)` (the file's time moves again after a `files.get`), `pageRevisions(size)`, `failNextRevisionLists(count,
      afterPages?)`, `failNextFileGets` (a document's metadata), `failNextFileSearches`. Staging reproduces it.
  - **The replaced revision is kept**: before the update, a binary file's head revision gets `keepForever` (`PATCH
    /drive/v3/files/<id>/revisions/<rev>`, a `drive.file` call); refused or unanswered → 409 `DRIVE_REVISION_NOT_KEPT`,
    nothing overwritten. A Google document's revisions cannot be kept that way (Drive keeps them itself), so **a file a
    decision or an attachment rests on is never overwritten** (`RecordRepository.driveFileFixed`: a ledger entry naming
    it), 409 `DRIVE_FILE_FIXED`, before Google is asked — for every kind.
  - **The request key of an update names the revision it replaces** (`drivePutRequestKey(…, { updateFileId,
    baseRevision })`, from the status's `puts[].revisionId`): A → B → A is three operations, a repeat of one is not. The
    app sends an update only for a file the status lists (`putFiles`).
- Unverified against real Google (the fake converts and updates in place): that Drive converts `text/markdown` into a
  document (Google added Markdown import in 2024), and that `files.update` with HTML / Markdown media on a Google
  document replaces its content as a new version (the Drive API documents media upload on update for Workspace
  types); the document baseline's assumptions ("A Google document's own changes": to confirm); that `keepForever` on a
  revision is answered as the fake does.

## Markdown and text as they are (owner request 2026-11-12)

- `kind: 'markdown', as: 'file'` puts a `.md` file (`text/markdown`), `kind: 'text'` a `.txt` file (`text/plain`;
  never a Google document) — uploaded with that MIME type in the metadata, so Drive converts nothing. The name keeps the
  kind's extension (`.md` / `.markdown`, `.txt`). Every other put check holds: the picked folder, a job's one folder
  (`DRIVE_FOLDER_NOT_GRANTED`), the outside-sharing refusals, the size and content checks (UTF-8 without NUL).
- **Which form** (the tool's description and `DRIVE_INSTRUCTIONS`, both languages): Markdown without `as` is a Google
  document (a report people read and edit; the app sends `as: 'google_doc'`); the AI passes `as: 'file'` when the member
  asks for `.md` / Markdown as it is, or the file is material for an AI or a Skill to read later, and never says a `.md`
  cannot be put. The API's own default (`as` absent) stays `file` for every kind.
- **Overwriting** keeps the form: `DRIVE_UPDATE_KIND_MISMATCH` compares the receipt's `mimeType` (a document's is the
  Docs type, a `.md`'s `text/markdown`, a `.txt`'s `text/plain`), so a document and a `.md` never replace each other.
  A `.md` / `.txt` is a binary file in Drive's terms: it has a `headRevisionId`, which is kept forever before it is
  replaced (`DRIVE_REVISION_NOT_KEPT`), and `DRIVE_FILE_CHANGED_SINCE` applies as for a PDF.
- **No outside-resource check** (`driveDocFetchesOutside`) for a file put as is (PDF / HTML already were not): it exists
  because Drive's conversion into a document fetches images and stylesheets; a file is stored as its bytes and Drive's
  preview shows Markdown and text as text, so nothing is fetched. Material for an AI is full of URLs, which the
  allowlist would refuse. A program that later renders the downloaded file is the reader's own act.
- A scheduled job's deliverable stays a Google document (`jobDeliveryHowTo` says `as: "google_doc"`); the server does
  not force it (as for a PDF), so a job's AI could put a `.md` if its procedure asked for one.
- Unverified against real Google: that Drive keeps the metadata's `text/markdown` as the file's `mimeType` (if it
  reported another type, an overwrite would be refused `DRIVE_FILE_REFUSED` — the safe side).
- Staging: the fake's seed has a `text/x-markdown` file (`GOOGLE_SEED.salesNotesMd`, 「営業の型.md」) to pick and read.
- Test (`google-drive.test.ts` 「Markdown and text as they are」, mutation-checked): a `.md` / `.txt` put as is, names and
  content refused, the same folder rules, kind mismatch both ways (and text onto `.md`) refused before Google is asked,
  `keepForever` before an overwrite and its refusal, changed since, a picked `.md` read (both MIME types); app
  (`google-drive-tools.test.ts`): `as: 'file'` keeps a `.md`, a `.txt` never a document, the description's guidance.

## Linked to a record (every company, owner decision 2026-11-13; `records.md` "Drive and PC file links")

`linkable(member, fileId)` — asked only by the records session route `POST …/file-links { target: {
kind: 'drive', fileId } }`, in a company with or without the shared folder, and only **after every record
check passed** (`recordEngine.fileLinkBeforeDrive`: records on, the record exists and is readable, the
body, the version, not linked already; a refusal there asks Google nothing): the member's own live
pick of a file, or a file **their own** put made (`putOfFile`: ACB created it, so `drive.file` opens it;
another member's put is not theirs) (else 403 `DRIVE_NOT_PICKED`, nothing asked of Google), `files.get` with **their own**
token (`id,name,mimeType,trashed,headRevisionId,version`), then the content read as `read` does
(export / download, ≤ 10 MB) only to compute its sha256 — nothing of it kept or logged. Never called
for anyone but the member linking, never to look at a file someone else linked: other readers get
the row without its name and open it in Drive. The app's 「Google Drive のファイルをつなぐ」 (on every company's task card) first offers
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

`server/tests/integration/google-drive.test.ts` (fake Google, practice redirect; 「a picked file linked to a record」, including 「every record check comes first」; 「a put in a consultation about a task」: the receipt's facts, the AI as the actor, the name to the linker only, a replay never links again, a failed record check keeps the put done, the own-files list and another member's refusal; 「Google documents and overwriting」: HTML / Markdown as a document and every other form refused, an update keeps the id and link with a new version and is never sent twice, the key reused with another target, not the member's own put / another folder / another kind / another member — refused before Google is asked, a file moved away or shared outside by itself refused with nothing sent, a lost answer found, the task's link following the newest revision; the document baseline: kept after real Google's post-import move (file +4 s, its one revision +3 s, as observed after settling) and an untouched document updated again and again; not kept when a time is outside the 60 s window after the upload or before it (the file's or the newest revision's; a time not in RFC 3339 UTC form), the newest revision keeps moving (`still-settling`), a second new revision (even the member's own), an import merged into the revision before or the previous baseline's revision gone, the newest revision's or the file's time still moving (the read limit and the time budget), the quiet period (a move after it is seen; half of it is not enough) and the gap between reads (real-time moves), the merged colleague-then-member edit documented as the accepted residual, or any revision is not the member's (also under the member's own newer one, on a later page, without its author) or the file's last modifier is not, or a later page is unreadable; each dropped step and each refused part logged with nothing of the file and a malformed time as `unusual`, a later time on the same revision refused — mutation-checked (each of (a)–(e), the quiet period and half of it, the gap, the budget, the read limit, the file's time in the agreement, the observed time kept); not reachable, kept as defence: an
update's `fileId` taken from the receipt rather than Google's answer, and the link following only a changed revision) and
`server/tests/integration/job-deliverables.test.ts` (a job's run: `jobs.md`) and
`server/tests/unit/google-drive-core.test.ts` (the link parser: Google's hosts only, look-alikes,
other schemes, folders, bad ids refused); `client/tests/google-drive-tools.test.ts`;
`admin/tests/integrations.test.tsx` 「Drive の ファイル選び」 (`<origin>/*`). The pick ticket
(`google-drive.test.ts` 「the Picker in the member's browser」, mutation-checked): no ticket without the
permission, stored as its sha256, the config once, expiry (page and app), another company's or a forged
ticket, a member who left, another member cannot read / close it and the picks are the ticket member's,
a pick only after the config, the ticket's mode, at most its maximum, Drive ids only, checked and
counted by `savePicks`, closed after the result, the app's cancel, a released app's route fails closed,
the fragment taken off the address, `connect-src 'self'`, the page end to end and with staging's
stand-in; in the app (`google-drive-tools.test.ts`): only the server's page with a ticket of the right
shape is opened, the ticket in no AI output / record-token request / log, the session to start and wait,
cancelled / failed / the AI stopped (also while a `picked` answer was in flight) / the page never opened
/ a 401 / the backstop, a pick being kept past ten minutes waited for, a stalled request ended by its
limit or a stop, each result acknowledged — the client's shape check and `drivePickerPageUrl`'s are
each other's back-up (one mutated alone survives). Also (server): the ticket found by its hash and
served from its own company, the saving grace, results kept until acknowledged and through a later
start's pruning, the open-ticket cap, `drive` turned off, the app closing the ticket while Google was asked
for the token or about the picks (nothing handed out, nothing kept), the full CSP, the result's
`keepalive`, one retry then a cancel, the close-tab cancel, `setAuthUser`. Mutation-checked: the Picker
token's scope check and the narrowing parameter, `drive.file` before asking Google, the Picker
registration, picks verified with Google, folder picks are folders, read / put only picks of
the right kind, the act token, the MIME / name / content / sha checks, the outside-sharing
refusal, the receipt's idempotency and key reuse, the lookup after a lost answer, the put's link only
for a new put, a link refusal never failing the put, own puts only (list and `linkable`); in the app:
tools only when available, put only with act, consent before the Picker, preselected ids only as
Drive ids and only for files (the ticket, `typed-file-links.test.ts` for main, the page's own
filter and mode check in `google-drive.test.ts`, which also checks the CSP hash is the script served), the path checks
(outside, link, `.git`, nested repository, private list, left out), kind and content, the
picked ids filter, the request key, the topic's record id on a put (never the AI's).
