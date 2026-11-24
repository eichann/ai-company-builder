---
paths:
  - "server/src/routes/private-folders.ts"
  - "server/src/services/private-folders.ts"
  - "server/src/adapters/private-folders.ts"
  - "server/src/lib/private-folders.ts"
  - "server/src/lib/git-server/scope-repo.ts"
  - "server/src/lib/client-version.ts"
  - "server/src/routes/permission-rules.ts"
  - "server/src/adapters/orphaned-scopes.ts"
  - "shared/types/private-folders.ts"
  - "shared/core/reserved-paths.ts"
  - "server/tests/**/private-folders.test.ts"
  - "server/src/services/holding-tickets.ts"
  - "server/src/lib/reader-change-gate.ts"
  - "server/src/ports/holding.ts"
  - "server/src/adapters/sqlite/holding.ts"
  - "server/src/db/schema/holding.ts"
  - "server/tests/**/holding-tickets.test.ts"
  - "server/src/services/private-holding.ts"
  - "server/src/routes/private-holding.ts"
  - "server/src/adapters/holding-blobs.ts"
  - "shared/types/private-holding.ts"
  - "server/tests/**/private-holding.test.ts"
  - "server/src/services/holding-review.ts"
  - "server/src/routes/holding-review.ts"
  - "server/tests/**/holding-review.test.ts"
  - "admin/src/lib/private-folders.ts"
  - "admin/src/lib/private-folder-help.ts"
  - "admin/src/app/**/private*/**"
  - "admin/src/app/**/folders/**"
  - "admin/src/components/folders/**"
---

# Private folders (server, stage 3a)

Read restriction exists only for **private folders**, which are private from the start (no
carve-out of existing folders; move files into a new private folder instead). Each one is its own
bare repository (a "scope repository"); its path is reserved in the company repository. The
contract for clients and UIs is `shared/types/private-folders.ts`. Code: `routes/private-folders.ts`
(HTTP, the `/paths/check` budget) → `services/private-folders.ts` (rules, views, first-folder
gate under the company lock) → the company handle's `PrivateFolderRepository` (`adapters/private-folders.ts`: the
rows and the create / make-public / delete steps; it uses `lib/private-folders.ts`, which has no
database: paths, company-repository lookups, archive files, pushes in flight, the folder browser).
`canWriteInPrivateFolder` lives in `shared/core/permissions.ts`. Client side:
`private-folders-client.md`. Full text and history: `docs/architecture/private-folders.md`.

A company without the shared folder (`server.md` "Companies without a shared folder") has none:
`POST /private-folders` answers 409 `NO_COMPANY_FOLDER` (after the `PRIVATE_FOLDERS_UNAVAILABLE`
check), git-http 404 for its scope repositories; the admin console hides 「フォルダ」. Its read
restriction is a **read-restricted place** instead (a department or a place inside one whose rules
deny `everyone` read; no repository): the same gate in `resolveAccess` (`isGate`) and the same
name rule below, in `server.md` "Groups and read-restricted places". A company with the shared
folder keeps refusing `read: false` outside private folders exactly as described here.


## Names never leak (owner decision B)

Someone who cannot read a private folder must not learn its name, that it exists as private,
or who can see it. So:

- Admin console: 「フォルダ」 (`/companies/:id/folders`, 管理画面の見直し 2-3) holds what were the
  pages 「権限」 (tab 「だれが変えられるか」, `components/folders/permissions-view.tsx`) and
  「非公開フォルダ」 (`?tab=private`, 「見られる人を決めたフォルダ」, `private-folders-view.tsx`);
  `/permissions` and `/private-folders` redirect there.
- Departments, stats and folder sizes read the company repository, which never holds private
  content. `/me/write-access` omits unreadable private folders. `/permissions*`, `/overview`,
  `/push-rejections`, `/private-folders*` are owner/admin/manager-only, and managers see only
  their departments'. Orphan warnings never consider private folders or rules inside them.
- `[RESERVED_PATH]` and 409 messages name only what the caller typed:
  「『<path>』というフォルダ名は使えません。別の名前にしてください。」
- `/me/scopes` sends nothing about unreadable folders (salted hashes were dropped on
  2026-10-22: short Japanese names were brute-forceable). `company_path_salts` stays in the
  schema, unused.
- Company-files views treat an unreadable private folder exactly as a nonexistent path
  (`company-files.md`). So does placing a server record (`folder` on create / share): inside a
  private folder, unreadable or missing → one 400 `FOLDER_NOT_PLACEABLE` (audit B-M1, `records.md`
  "Where a record may be placed"). The one exception: a task shown to (or made for) the 案件・プロジェクト
  it links to takes that 案件's private folder, for a reader of the 案件 only (`records.md` "A task and
  its 案件・プロジェクト"); the refusal for anything else stays the same one answer.
- A 非公開 案件・プロジェクト (`records.md` "Private 案件・プロジェクト") is a まとまり placed exactly in its own
  private folder, made only by who may manage that folder (owner/admin, the department's managers). Its
  参加者 are the folder's readers, changed through `PUT /private-folders/:scopeId/members` from the 案件's
  card; 見られる人 says 「『<title>』の参加者（N人）」 to its readers only. An existing public one becomes one
  through 「非公開にする」 (`records.md` "Making a 案件・プロジェクト private"): only into an empty private folder
  directly inside its department, by the same people; every other folder → the one `FOLDER_NOT_PLACEABLE`.
- A record's 判断の材料 and attached versions (`records.md` "Evidence"): a file inside a private
  folder is never evidence of a record outside it (one answer with an unreadable file), and 経緯
  shows each reader only the evidence they read now — a private folder's file is left out for
  anyone outside it.
- 見られる人 (`POST /viewers`, `records.md` "Who can see it") names a private folder
  (「『<path>』を見られる人（N人）」) only to its readers: an unreadable record is left out, and a
  path inside an unreadable folder is answered as if the folder did not exist.

## Data and permissions

- A private folder = a `scopes` row (`kind 'folder'`) whose `repo_id` points at `scope_repos.id`.
  Rules on it: `everyone: no read, no write` + one user rule per viewer (`read`; `write` for
  editors). Owners/admins always read and write. (Not so for owner-only records, which are not
  folders: only their owner sees one — owners and admins neither; `records.md` "Owner-only
  records". A private folder stays readable by owners/admins.)
- A private scope never inherits (clearing / removing its last rule is refused). Rules deeper
  inside only narrow: in `resolveAccess` (`shared/core/permissions.ts`), read/write inside also
  needs read of the folder itself; a private scope without rules denies. `read: false` is
  accepted on a private folder itself only.
- The permission editor (`PUT /permissions/scopes/by-path`, `POST /permissions/rules`, `PATCH
  /permissions/rules/:id`) requires `read: false, write: false` for `everyone` / role rules on
  the folder itself (400 `PRIVATE_FOLDER_RULE`); only user rules grant access, and an editor must
  also read — so a manager cannot open their private folder to the company. Edits inside one go
  against its scope repository, skip the outdated-app guard, and moving rules into/out of one is
  refused. `GET /permissions/folders` lists private folders only to those who may edit them.

## Access removed: holding tickets (owner decision 2026-11-23 「B」, stage S1)

Someone who stops reading a private folder may hold work for it on their PC that never reached
the server; their app removes the folder (owner decision Q1). The plan (design memo
`docs/private-folder-holding-design.md`, internal): before it does, the app hands that work to a
server-side holding place for the folder's managers to take in or discard. S1 (this) is the
server's record of who may do so; the upload that reads it is S2 ("Holding: the member's upload"
below). The app still deletes as before (C1 not yet).

- **A ticket** (`holding_tickets`, behind the handle `holding`: `ports/holding.ts`,
  `adapters/sqlite/holding.ts`) per member × private folder whose read access ended: `scope_id`,
  `repo_id`, `folder_path` (server-only — never to be answered to that member), `cause`
  (`readers` taken off its readers, `left-company`, `folder-deleted` (owners / admins and the
  deleter included: the folder is gone for all), `role` (an owner/admin demoted reads only the
  folders a rule names them on), `rules` (the permission editor)), `state` open / used /
  cancelled / expired, `expires_at` = 30 days. One open ticket per member and folder (partial
  unique index): losing it again while one is open renews it. Reading the folder again cancels
  the open one, on every path: added back to its readers or by a rule, made public (everyone who
  reads it now; a former member keeps theirs), or joining the company again (`POST /members`, an
  accepted invitation — an owner / admin reads every private folder; a plain member reads none
  until added, their rules went when they left). A folder made public is no loss; an editor made
  a viewer still reads.
- **Written in the same transaction as the change**, by the one wrapper
  `services/holding-tickets.ts` `track(companyId, { cause, byUser }, mutate)`: who reads each
  private folder (`canReadPrivateScope` over the members) before and after, the difference
  becomes tickets / cancellations, each recorded in `permission_history` (`holding-ticket`:
  `ticketId`, `scopeId`, `path`, `userId`, `cause`, `expiresAt`; `holding-ticket-cancel`). Used by
  `PUT /private-folders/:id/members`, `DELETE /private-folders/:id` and `POST
  /private-folders/:id/make-public` (the port's `delete` / `makePublic` take `trackRows`: their
  one row transaction, after the archive / the company commit, runs inside it), `DELETE
  /members/:userId`, `PUT /members/:userId/role`, `POST /members`, accepting an invitation,
  creating a company, and every rule change of the permission editor (`recordChange`). A refused
  or failed change rolls back with its tickets. A `track` inside another of the same company joins
  it (one comparison over the whole change, each ticket written once, the outer cause).
- **The gate** (`lib/reader-change-gate.ts`, made once by the composition root): the storage
  steps that can take reading away — `scopes.replaceRules` / `upsertRule` / `updateRuleAccess` /
  `deleteRule` / `clearRules` / `deleteUserRules`, `privateFolders.replaceRules`, the rows of
  `privateFolders.delete` / `makePublic`, `memberships.insert` / `updateRole` / `delete` — throw
  `UntrackedReaderChangeError` outside `track` of that company. A new path that forgets the
  wrapper fails in its first test (500, nothing changed) instead of leaving a member without a
  ticket. Handles built without the gate (operator commands, unit tests) are not asked; that the
  composition root passes it is itself tested (the composed storage refuses outside `track`).
- Expiry: the server clock (`expireHoldingTickets`, every company, records on or off) closes open
  tickets past `expires_at`; running twice changes nothing more.
- Tests: `server/tests/unit/holding-tickets.test.ts` (each gated step refuses outside `track`;
  renew / cancel / made public / joining again / nested `track` / rollback / other company /
  expiry and the clock), `server/tests/integration/holding-tickets.test.ts` (`READER_CHANGES`: one
  row per route that can take a private folder away — a new such route gets a row; changes that
  keep everyone reading leave none; access back cancels — readers, make-public, `POST /members`,
  an invitation; the composed storage refuses outside `track`, also a delete / make-public whose
  `trackRows` does not track). Each guard mutation-checked.

## Holding: the member's upload (stage S2)

With a ticket, and only with it, the member's app hands over what their PC never sent. These are
the first endpoints that take company data from someone who may no longer be a member. Contract
(released apps will call it; `protocol: 1`, fixed kinds and codes): `shared/types/private-holding.ts`.
Code: `routes/private-holding.ts` → `services/private-holding.ts` → the handle's `holding` /
`holdingItems` (`adapters/sqlite/holding.ts`) and the blob store (`adapters/holding-blobs.ts`).
The folder's managers review it through the admin endpoints of S3 ("Holding: review" below; the
console's 「預かり」 tab is A1), and no app calls it yet (C1).

- **Routes** (`/api/me/holding`, `signedIn`, **no membership**: a person removed from the company
  still hands over): `GET /tickets` (open ones and those closed in the last 90 days: `ticketId`,
  `companyId`, `scopeId`, `state` open / expired / cancelled — an open one past `expires_at` reads
  expired —, `expiresAt`, `limits`), `POST /tickets/:ticketId/items { deviceKey, baseCommit,
  manifest[] }` → `{ itemId, missing, namesOnly }`, `PUT /items/:itemId/blobs/:sha256` (raw body) →
  204, `POST /items/:itemId/finish` → `{ state: 'waiting' }`.
- **One entry check** (I3): the company is found from the caller's own tickets — the control-plane
  lookup `HoldingTicketLookup.ofUser` (by user id across companies; `UNSCOPED` in
  `company-scoped-sql.test.ts` with its reason) — then everything through that company's handle; an
  item only among the caller's own tickets' companies, its `user_id` the caller's. A ticket or item
  that is not the caller's, unknown, or another company's → the same 404 `{ error: 'Not found' }`.
  Expired (state, or `expires_at` passed before the clock closed it) → 410 `EXPIRED`; cancelled (they
  read the folder again) → 410 `CANCELLED`; only the ticket's own member gets either. Check order:
  rate → who → (an item already finished: 409 `ALREADY_RECEIVED`, whatever the ticket says now) →
  ticket state → body (one fixed 400 `INVALID`) → rules.
- **Nothing names the folder**: no answer carries `folder_path` (it stays on the ticket and item rows
  for S3), entry paths are never answered back (`namesOnly` are manifest indexes), the request log
  prints only `ticketId` / `itemId` (`OPAQUE_PARAMS`), and `permission_history` records ids and counts.
- **Manifest**: entries `{ path (relative to the folder, `normalizeRepoPath`, ≤ 1024, no control
  characters), kind, size, sha256 (content kinds only), label? (≤ 200) }`; kinds `changed`,
  `deleted`, `backup`, `personal` (`.personal/`), `names-only`. One content has one size. JSON body
  ≤ 1 MB (413 `TOO_LARGE`).
- **Caps** (owner decision, question 4; `HOLDING_LIMITS`, `HOLDING_COMPANY_BYTES`): 50 MB a file,
  500 MB an item, 5,000 entries (the rest names only) — over one the entry is `names-only` with
  `dropped: 'too-large'`. A ticket's **share** of 1 GB (all its PCs' items together, so one leaver
  cannot fill the company) is not such a cap: beyond it the entry has **no room now**, like the
  company's room below (`company-full`; the share frees up when the managers decide the member's
  other items — chosen over a name only, which would lose the member's work). The company's room, 2 GB, counts **only what is stored** (`total_bytes` = an item's
  distinct contents stored now, over the items still holding contents) — a manifest reserves
  nothing, so a large announcement never squeezes others out. Judged when the manifest arrives (in
  manifest order, each distinct content once, one transaction) and **every cap again when each
  content arrives** — the item's, the ticket's share and the company's room, on stored bytes, under
  the company's holding lock — so PCs or members announcing in parallel cannot pass them together
  (an item over its cap then: that entry a name only, 413 `TOO_LARGE`; no room: `COMPANY_FULL`). An entry with no room **now** is `dropped: 'company-full'` (kind
  and sha256 kept; answered in `companyFull`, PUT and `finish` → 409 `COMPANY_FULL`): **the app keeps
  its whole local copy, does not finish, and tries again later** with the same `deviceKey` (the next
  manifest judges every entry again; contents already stored stay) — the safe side for members' work
  (C1 must implement exactly this; never remove on `COMPANY_FULL`).
- **A blob is admitted before its body is read** (`putBlob`; the route hands over the body lazily,
  no body-limit middleware): rate, owner, item `receiving`, ticket open, the sha256 named and still
  wanted (dropped as a secret → 204; `company-full` → 409), `Content-Length` present (else 400
  `INVALID`), ≤ the file cap (else 413 `TOO_LARGE`) and equal to the entry's size (else 400
  `HASH_MISMATCH`), and room among the uploads running — 2 per member, 8 per server (else 429 `BUSY`
  + `Retry-After`). Only then does the body stream into a temporary file of its own
  (`<item dir>/.tmp-<random>`, 0600), hashed and scanned as it arrives (never held in memory; more
  bytes than announced → 400, nothing kept).
- **Never a received item without its content** (Codex P1/P2, 2026-11-24): naming a content and
  marking it stored run **under the company's holding lock** (one per company, in the service; the
  sweep and the erasure take it too), after the item and its entries are read again: a finished item,
  or a content no entry wants any more, makes the request remove **only its own temporary file**
  (`ALREADY_RECEIVED` / 404). `markStored` marks only not-dropped content entries and answers false
  when none was marked; a content then kept by no stored entry is removed. A stored entry whose file
  is gone from the disk (a restore from an older copy) takes the content again while the item is
  receiving.
- **No secret is kept** (I7, the server decides): an entry named `.env` / `.env.*` (not
  `.env.example` / `.env.sample`; `isSecretFileName`, `shared/core/secret-patterns.ts`) is a name only
  (`dropped: 'secret'`); **every** content — binary too: a false positive only makes it a name — is
  scanned with `secretIn` as it streams (latin1 view, each chunk with the previous 512 characters)
  and on a hit is never named: its entries become names only (sha256 kept, `dropped: 'secret'`) and
  the PUT answers 204.
- **Idempotent**: one item per (ticket, `deviceKey`) — at most 3 PCs per ticket (409
  `TOO_MANY_DEVICES`); a repeat while `receiving` replaces the manifest and keeps the contents
  already stored that it still names — with their **verified size**: a manifest naming a stored
  content with another size is refused (400 `INVALID`), and an upload whose entry was re-declared
  with another size meanwhile is not kept (400 `HASH_MISMATCH`); a finished one → 409 `ALREADY_RECEIVED` (also after the ticket
  expired: it was received). A blob PUT is by sha256 (bytes and size must match, else 400
  `HASH_MISMATCH`; one not named → 404; stored and on disk → 204 without reading the body).
  `finish` needs nothing `company-full` and every wanted content stored **and on the disk** —
  under the company's holding lock each content marked stored is looked for, and one that is gone
  (a restore of `HOLDING_DIR` from an older copy) is unmarked and wanted again (409
  `MISSING_FILES` with `missing`; the manifest's answer reports `missing` the same way), then `receiving → waiting` (compare-and-set) with `permission_history`
  `holding-received` (ids, counts, bytes); again while waiting → the same 200; after a decision or
  expiry → 409 `ALREADY_RECEIVED`. The ticket stays open (other PCs) until it expires or is cancelled
  (`used` is never set in S2).
- **Rate limit** per member and hour (in memory): 6,000 blob PUTs (a whole item fits), 120 item /
  finish requests → 429 `RATE_LIMITED` + `Retry-After` (`setHoldingRatesForTests`, also the uploads
  running at once).
- **Storage** (`db/schema/holding.ts`): `holding_items` (ticket, user, device key, scope, the
  ticket's folder path, base commit, state receiving / waiting / taking / taken / discarded /
  expired, `total_bytes` = distinct contents stored, times, decision columns for S3,
  `blobs_deleted_at`; UNIQUE (company, ticket, device key)), `holding_files` (index, path, kind,
  size, sha256, label, stored, dropped `too-large` / `secret` / `company-full`). Contents:
  `HOLDING_DIR` (`lib/config.ts`, default `<DATA_DIR>/holding`) `/<companyId>/<itemId>/<sha256>`,
  directories 0700, files 0600; never served by path. No encryption at rest (open question 11).
- **Retention** (I8; the server clock's `sweepHolding`, every company, records on or off, under the
  company's holding lock): a `receiving` item created 2 days ago is deleted with its rows (the app's
  next try starts again), a `waiting` one finished 30 days ago becomes `expired` (`holding-expired`,
  by `acb:clock`); then the contents of every item done with them (taken, discarded, expired) are
  deleted (`blobs_deleted_at`), any item directory no row holds contents for is removed, and in a
  live item's directory every content no stored entry names and every temporary file older than an
  hour. Rows stay (names, sizes, who). Running twice changes nothing more.
- **Archive and erasure**: `company-archive.ts export` lists the company's held item directories
  (`heldContents`, like kept private-folder archives: listed, not copied; the rows travel as every
  `company_id` table). `erase-content.ts holding <companyId> <itemId> <reason>`: the item's contents
  and file rows go, the item stays `discarded` and is marked `erased_at` (`migrateHoldingErased`),
  `holding-erased` in `permission_history`. **Owner decision L4 (2026-11-24, 「B」 + block)**: an item
  still `receiving` (the member's app is uploading) is **never erased** — refused in the erase's own
  transaction, nothing changed, the command says so in plain words (retry after it finishes, or cancel
  the ticket first); an item `taking` (a reviewer's take-in) likewise. And an erased item is never
  answered as received: its own member gets 410 `ERASED` from the manifest, a blob PUT and `finish`
  (the app keeps its copy; never `ALREADY_RECEIVED`), anyone else the same 404. Tests:
  `private-holding.test.ts` "refuses an item still being received", "told ERASED".
- S2 only normalises manifest paths; taking an item in judges them again as the reviewer's push
  ("Holding: review").
- Tests: `server/tests/integration/private-holding.test.ts` (every rule above through the real app,
  with bodies held open mid-upload for the races — a second PUT losing to a finished item, a manifest
  changed during an upload — and the admission checks asserted to never read the body; no holding
  answer or log line names the folder or an entry path; each guard mutation-checked),
  `permission-matrix.test.ts` (rows: any signed-in caller without a ticket 404, signed out 401;
  `CROSS`: another company's member's ticket / item = unknown), `company-scoped-sql.test.ts`,
  `request-log.test.ts` (a manifest with paths; only `ticketId` printed), `company-archive.test.ts`
  (`heldContents`).

## Holding: review (stage S3)

The folder's managers look at what was handed over and take it into the folder or discard it
(design memo §4; owner decisions 5, 6, 7, 12). Contract: the review section of
`shared/types/private-holding.ts` (not read by released apps: the admin console's 「預かり」 tab, A1,
below, is its caller). Code: `routes/holding-review.ts` → `services/holding-review.ts` → the handle's
`holdingItems` (review compare-and-sets), `privateFolders` (`filesAt`, `readBlob`,
`findCommitWithLine`, `commitFiles`: `adapters/private-folders.ts`) and the blob store.

- **Routes** (`/api/companies/:companyId`, `companyMember`): `GET /holding` (the items the caller may
  review: waiting or being taken in, with who, cause, when it arrived, `expiresAt` = 30 days after,
  counts by kind), `GET /holding/:itemId` (+ each entry's `standing` against the folder's tip —
  `unchanged` / `changed` since the member's base / `unknown` without a base — `inFolderNow`,
  `takeable`), `GET /holding/:itemId/files/:idx?version=held|base|current` (one entry's bytes, always
  `application/octet-stream` + `attachment` + `nosniff` + a sandboxing CSP, `no-store`; a held one is
  recorded `holding-downloaded`), `POST /holding/:itemId/take { files: idx[], whenChanged?:
  'alongside' | 'overwrite' }`, `POST /holding/:itemId/discard`. Zip download of a whole item: not
  yet (A1 may download entry by entry).
- **Who** (I5, one check `reviewable`): someone who reads the folder now (`canReadPrivateScope`) and
  is owner / admin or manages its path (`services/private-folders.ts` `canManagePath`, injected: a
  manager of its department); an item whose folder is no longer a private folder (deleted, or made
  public — owner decision on the safe side) → owners / admins only, and only download / discard (409
  `FOLDER_GONE` on take; owner decision 7). A receiving item, another company's item, or anyone else
  → the same 404 `{ error: 'Not found' }`, before the body is read. The list leaves such items out.
- **Taking in is the reviewer's own push** (I6): `PrivateFolderRepository.commitFiles` builds ONE
  commit on the folder's main (`lib/bare-commit.ts` `commitRootEditWithCommit` + `applyPathEdits`, no
  working tree, async git only) and pushes it from the repository to itself with the reviewer's
  permission snapshot (`preparePushCheck` with the pusher, scopes, managed folders and 「Skill を直せる人」 that
  git-http would use — composed in `composition.ts` `pushSnapshot` — plus `ACB_PUSHER_ROLE` / `_ID` /
  `ACB_NODE`; never `internalGitEnv`, the server marker and any inherited snapshot are removed). So
  write permission (`[WRITE_DENIED]` for a manager who only views), protected config, secrets
  (also a content changed on the server's disk since it was scanned), `.personal`, Windows names and
  look-alikes are judged on what is written now; paths stored at upload are never trusted. Before
  that the service refuses (400 `NOT_TAKEABLE`, with the indexes) `personal` and names-only entries,
  a content not held or gone from the disk, and a path with an empty / `.` / `..` / `.git` segment. A
  refusal → 409 `TAKE_REFUSED` with `refused` (the checker's markers and paths, relative to the
  folder) and a Japanese sentence; nothing lands, the item stays `waiting`. Registered as a push to
  the folder (`beginScopePush`), under the company lock (serialised with create / delete /
  make-public); a member's push in between → redone on the new tip.
- **Never over a later change** (owner decision 6), decided on the tip the commit is built on (again
  on a new tip): files matched by `pathKey`, written at the tip's spelling — an existing file's, and
  for a new file or an alongside copy the folders above it as the repository spells them (never a second
  spelling of one folder; Codex P2). A content entry: already
  so → `same`; absent → `placed`; unchanged since the member's base → `placed` (replaced); changed
  since or no base → `alongside` as 「<stem>（<member's name>さんの版 MM-DD）<ext>」 (MM-DD of arrival,
  Japan time; ` 2`, ` 3` when taken), or `overwritten` when the reviewer chose `overwrite`. A `backup`,
  a symlink / gitlink there, or a folder at the path: always alongside. A `deleted` entry: removed only
  when unchanged since the base, else `skipped` (`changed`, `absent`). A chosen content with no place
  now (a file where its folder was) refuses the whole take-in, 409 `PATH_TAKEN` with `files`, nothing
  committed, the item waiting — never `taken` with that content dropped (independent review). The
  take-in decides the whole item: unchosen entries are discarded with it.
- **Under the lock, read again**: the caller's membership and role (`memberOf`: an admin demoted while
  the request waited is not pushed as an admin — independent review), who reads the folder, the item.
- **Once** (I6, checklist 7): `waiting → taking` (compare-and-set, by the reviewer) under the company
  lock is the "done" guard; discard (`waiting → discarded`) and the clock's expiry (`waiting →
  expired`) are compare-and-sets from `waiting` too, so a second take-in or a discard → 409
  `ALREADY_DECIDED` (「ほかの人が先に決めました。」), an item past its 30 days → 410 `EXPIRED`. The
  commit message is 「<name>さんの預かりから取り込み（N件）」 + the line `ACB-Holding-Item: <itemId>`
  (the member's name, a count and an id; no content, no folder name). After the push: `taking →
  taken` with `decision_commit` and `holding-taken` in one transaction, then the contents are deleted.
  A take-in that did not finish is **settled by the folder's history** (`findCommitWithLine`, the last
  1,000 commits): an error after the push (before the item was marked) → looked for at once; an item
  found `taking` under the company lock (a stopped process: no take-in runs while the lock is held) →
  by take / discard, and by the server clock before its holding sweep. The line there → `taken`, none →
  `taking → waiting`; **the history unreadable → still `taking`** (a later settle asks again; take /
  discard answer 503 `BUSY`) — never given back to be taken in twice (Codex P2). A folder gone
  meanwhile → waiting.
- **Discard**: `waiting → discarded` + `holding-discarded`, then the contents are deleted (the sweep
  catches up when that fails).
- **Admin home** (owner decision 12): `attention.holding { waiting, expiringSoon }` — the items the
  caller may review and those the clock discards within 7 days (`services/admin-home.ts`, from
  `holdingReview.attention`); a 知らせ kind comes later.
- **Admin console 「預かり」** (A1; `admin/src/components/folders/holding-view.tsx`,
  `holding-item-dialog.tsx`, words and the request body in `admin/src/lib/holding.ts`): a third tab of
  「フォルダ」 (`?tab=holding`), shown only while `GET /holding` lists something for the caller (or the
  tab is open), with the count; the home's 「預かったファイルを確かめてください（N件）」 card from
  `attention.holding` (amber when some expire within 7 days) leads there. Everything shown is the
  review API's answer (the folder from `folderPath`, displayed with the department names only) —
  nothing is looked up elsewhere. Default ticks: `takeable` `changed` / `deleted` entries; backups not
  ticked, 本人のメモ and names only never tickable; the body carries only `takeable` ticked indexes and
  `whenChanged` always (`alongside` unless 「上書きする」 was chosen, offered only when a ticked content
  meets a later change); a folder gone → no 「フォルダに入れる」, download and 捨てる only. 捨てる opens
  the destructive `ConfirmDialog` (「元に戻せません」, the count). Downloads go through `fetch` and are
  saved as files, never shown in the page. Refusals in the console's own words
  (`describeHoldingError`): `ALREADY_DECIDED`, `EXPIRED`, 404, 410 → toast, close, list read again;
  `PATH_TAKEN` / `NOT_TAKEABLE` → those entries marked and unticked; `TAKE_REFUSED` → the server's
  sentence only when it is its fixed Japanese one; `BUSY` / 503, `FOLDER_GONE`, `INVALID` → a sentence;
  each refusal reads the item again. Test: `admin/tests/holding.test.tsx` (mutation-checked); the list's
  shape in `admin-contract.test.ts`.
- Not here (later stages): `HOLDING_CLIENT_COMMIT_DATE` for the console's old-app warning (needs the
  C1 build), the zip download, a side-by-side diff in the console, taking a deleted folder's item into
  another folder (question 7).
- Tests: `server/tests/integration/holding-review.test.ts` (who reviews and the one 404 for everyone
  else, a deleted folder, alongside / overwrite / deletions / one commit and its message, refusals by
  the push checker as the reviewer, the folders' spelling, `PATH_TAKEN`, a role changed while waiting,
  two take-ins at once, take-in racing discard, the clock and an item being taken in, settling by the
  folder's history both ways and an unreadable history, downloads, the admin home; no
  answer to a non-reviewer and no log line names the folder or an entry path; each guard
  mutation-checked), `permission-matrix.test.ts` (rows + `CROSS`: another company's waiting item =
  unknown).

## Repositories and git-http

- `server/src/lib/git-server/scope-repo.ts`: `<REPOS_DIR>/<companyId>.scopes/<repoId>.git`,
  configured exactly like the company repo (`BARE_REPO_CONFIG` + the same hook; startup
  re-configures them), created with one commit holding sync's essential `.gitignore`. `.scopes`
  is not `*.git`, so the company route can never reach it.
- `/api/git-http/<companyId>/scopes/<scopeId>.git` (scope id, not repo id). Fetch needs READ of
  the folder, push needs WRITE somewhere in it (403 otherwise). Non-member, non-reader, unknown or
  non-private scope: the same 404. The push snapshot carries `scopePath`; paths are write-checked
  as `<scopePath>/<path>` and every other rule runs as in the company repo.

## Reservation (`[RESERVED_PATH]`, push checker)

- Rejects, for everyone, any commit or net diff that adds/modifies a path at or under a private
  folder (NFC + A–Z folded; a rename into it counts on its new side; a file named like the
  folder counts), and a file, symlink or gitlink at any **ancestor** path of a private folder.
  Deletions are never refused. Each path is followed by the reason line
  `      （『<prefix as the pusher spelled it>』というフォルダ名は使えません。別の名前にしてください。）`.
- Reserved paths reach the checker only via the git-http snapshot (`reservedPathsFor`). The
  server validates its own operations: department create/rename refuse a reserved name.
- No race: git-http registers each company receive-pack (`beginCompanyPush`) before taking its
  snapshot; creating a folder, after writing its rows, waits for pushes registered earlier (60 s,
  else 503 `BUSY`, nothing created), re-checks the company repo and rolls back if one landed at
  the path. Test: `server/tests/integration/private-folders.test.ts` "a push racing the creation".

## API (`server/src/routes/private-folders.ts`, under `/api/companies/:companyId`)

- `POST /private-folders` `{ parentPath, name, viewers?, editors?, force? }` → 201
  `PrivateFolderDetail`. Owner/admin anywhere; a department manager only inside their department;
  others 403. Name: the department folder-name rule. Default viewers: creator + the department's
  managers (creator always added; owners/admins implicit). A taken path (anything in the company
  repo, any case/NFC, or a private folder at, above or below it) → 409 `FOLDER_NAME_UNAVAILABLE`
  with the sentence above. A parent inside an unreadable private folder answers like a missing
  parent (`PARENT_NOT_FOUND`); a readable one `ALREADY_PRIVATE`. Runs under the company lock.
- Version gate: the company's **first** private folder is refused with 409 `OUTDATED_CLIENTS`
  (`members`, `canForce`) while any member's app is not known to support private folders
  (`supportsPrivateFolders`, build commit date ≥ `PRIVATE_FOLDERS_CLIENT_COMMIT_DATE` =
  `20261022085300`, the 3b merge; unknown = not ready). Owner/admin `force: true` overrides; a
  manager's `force` → 403 `FORCE_NOT_ALLOWED`. Why: older apps never receive the folder and retry
  the `[RESERVED_PATH]` rejection forever. Tests use `setPrivateFoldersClientCutoffForTests`.
- `GET /private-folders` (owner/admin: all; managers: their departments'),
  `GET /private-folders/:scopeId`, `PUT /private-folders/:scopeId/members` `{ viewers, editors? }`
  (owner/admin and the department's managers; anyone else 404). Counts include owners/admins.
  A change of readers is recorded in `permission_history` (`private-folder-members`, before /
  after, in one transaction with the change; `server.md` "Groups and read-restricted places"), and
  so is a creation (`private-folder-create`, its first viewers and editors).
- `POST /private-folders/:scopeId/make-public` (owner/admin): refuse new pushes to the scope repo
  and wait for running ones, archive, write its tree into company `main` at the same path as ONE
  commit (compare-and-swap `update-ref`, retried; idempotent), then in one transaction make every
  rule there readable (write unchanged) and clear `repo_id`, then delete the scope repo.
- `DELETE /private-folders/:scopeId?confirm=<last path segment, NFC>` (owner/admin; else 400
  `CONFIRMATION_REQUIRED`): stop pushes, archive, remove rules/scopes at and under the path and
  the `scope_repos` row in one transaction (with every reader's holding ticket, "Access removed"
  above), then the repo → `{ path, archived: true }`.
- Archive (`archivePrivateFolder`, before delete and make-public; on failure nothing is removed):
  `git bundle create --all` into `PRIVATE_FOLDER_ARCHIVE_DIR` (default
  `<DATA_DIR>/backups/private-folders`)`/<companyId>/<time>_<action>_<scopeId>.bundle` + `.json`
  sidecar; dirs 0700, files 0600; a `private_folder_archives` row. Never served or named in a
  response; restore = `git clone <bundle>`.
- `GET /me/scopes` (any member, ETag/304) → `{ version, scopes: [{ scopeId, path, cloneUrl,
  clonePath, canWrite }] }`, readable folders only. `GET /me/private-folders`: the readable ones with `canWrite`, viewer count
  and the first viewers (named viewers before owners/admins).
- `POST /paths/check` `{ paths: string[], files?: string[] }` (any member, ≤ 50 paths, ≤ 60 per
  member per minute → 429 `RATE_LIMITED` + `Retry-After`) → `{ results: [{ path, usable }] }`.
  `usable: false` exactly when a push would get `[RESERVED_PATH]`: at or under a private folder
  the caller cannot read, or — for a path also in `files` — a strict ancestor of any private
  folder (`isPathUsable`, `shared/core/reserved-paths.ts`). Same shape and work for every path;
  never says which folder or why; paths are not logged. Older apps omit `files`.
- Departments containing a private folder cannot be deleted or renamed (409
  `PRIVATE_FOLDERS_INSIDE`).
- There is deliberately no MCP tool to create private folders: only people, through the admin
  console or the app's dialog. In the app, nothing the chat or an agent imports may reach
  `electron/private-folders-api.ts`, however indirectly (`client/tests/architecture-boundaries.test.ts`).
- Tests: `server/tests/unit/private-folders.test.ts`, `server/tests/integration/private-folders.test.ts`.
