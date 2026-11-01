---
paths:
  - "shared/core/yaml-lite.ts"
  - "shared/core/record-types.ts"
  - "shared/core/records.ts"
  - "shared/core/record-ledger.ts"
  - "shared/core/core-types.ts"
  - "shared/types/records.ts"
  - "server/src/routes/records.ts"
  - "server/src/services/records.ts"
  - "server/src/services/record-index.ts"
  - "server/src/services/record-access.ts"
  - "server/src/services/record-engine.ts"
  - "server/src/services/decisions.ts"
  - "server/src/services/record-ai-tokens.ts"
  - "server/src/routes/records-ai.ts"
  - "client/electron/records/**"
  - "client/electron/features/tasks/**"
  - "client/shared/task-links.ts"
  - "client/src/features/tasks/**"
  - "client/shared/record-actions.ts"
  - "client/tests/records-tools.test.ts"
  - "server/tests/integration/record-tokens.test.ts"
  - "server/src/ports/records.ts"
  - "server/src/ports/record-files.ts"
  - "server/src/adapters/sqlite/records.ts"
  - "server/src/adapters/record-files.ts"
  - "server/src/lib/record-files.ts"
  - "server/tests/unit/record-*.test.ts"
  - "server/tests/integration/records.test.ts"
  - "server/tests/integration/record-links.test.ts"
  - "server/tests/unit/push-channel.test.ts"
---

# Records: types, the company map and the state engine (light ontology, stage 4-1 … 4-5)

The core foundation of the light ontology (owner design 「段4 本体の土台」, decisions 0.18–0.23):
types are defined in files; **record data lives only on the server** (owner decision 2026-11-01:
tasks, decisions, deals, interactions, minutes, approvals, outbound mail — every core and plugin
type is `storage: server`), while what people write (quotes, plans, scripts, procedures) stays
ordinary files that records link to by company path. Record files remain only for a company's own
`.acb/types/` type with `storage: file` (the parser's default; no core or plugin type uses it). The
server keeps the **company map** — an index of every record, its links and its server-sourced state —
answering a fixed-shape query filtered by what the caller may read — and the **state engine**,
the only writer of a record's server values, with its append-only ledger — and the typed tools
(4-6) the AI changes records with.

## Off per company

Everything is behind a per-company switch (`record_settings.enabled`, default off): owner/admin
turn it on with `PUT /records/settings { enabled: true }`. While off, nothing is indexed (pushes
schedule nothing) and every route except the settings answers 404 `RECORDS_DISABLED`. The one
thing that applies to every company is the push checker's rule on `.acb/types/` (below): nobody
used that folder before, and a type someone added while the switch was off would steer the
engine the day it is turned on.

## Type definitions (`shared/core/record-types.ts`)

- One file per type at `.acb/types/<name>.md` in the company repository (direct children; not
  in private folders' repositories); the definition is the YAML frontmatter, the body is for
  people. Keys are English, `label`s Japanese (0.24-7). YAML is the strict subset of
  `shared/core/yaml-lite.ts`: no anchors, aliases, tags, block scalars, merge keys, duplicate
  keys or prototype keys — every reader (server, push checker, app) gets the same meaning.
- A definition can say only what the engine does (案 B, ontology §17.7): `fields` (kind,
  `source: file | server`; a choice may add `option_labels: { <option>: <shown as> }` — display
  only, values stay the options), `links` (target type or `file`, cardinality, inverse label),
  `states`, `initial`, `actions` (from / to / who / notify / attach / note / history_line /
  decision / approval / args), `implements` (interfaces, `INTERFACES`: `request` needs
  `requested_by`, `assignee`, `next_actor`, `waiting_on`, `due` on the server), `storage`
  (`file` / `server` / `either`). Any other key is an error — there is no place for an
  expression, computed field, cascade, timer or outside send. `args` name server fields of the
  same kind (an action sets them; nothing is computed).
- Versions (0.18-3): `compareTypeDefinitions` — adding is free but a changed definition needs a
  higher `version`; removing or renaming a field / link / state / action / interface, or
  changing a field's kind / source / target, a link's target / cardinality, or `storage`, is
  **breaking** and refused until a migration tool exists. Every accepted version is kept
  (`record_types`); a record remembers the version it was indexed under.
- Who: only owner/admin change `.acb/types/` (0.23-3), enforced by the push checker
  (`push-check.md`): non-admins get `[PROTECTED_CONFIG]` (own sub-list, existing client
  recovery); a breaking change is refused for owner/admin too (a reason line under the path).
  Deleting a definition file is accepted; the index keeps the definition in force and reports
  `type_file_removed`. Invalid YAML is accepted by the checker and reported by the index (the
  last valid version stays). No screen creates types yet (0.23-4).

## Record files (`shared/core/records.ts`) — a company's own `storage: file` types only

- Frontmatter holds only `id`, `type`, `links` (0.3-8): state, assignee, due… live on the server.
  Other keys are ignored and reported (`ignored_keys`), never read — so an AI writing
  `state: done` into a file changes nothing. Title = first `# ` heading (else the file name),
  summary = the first paragraph after it (≤ 300 characters); those two are what text search
  reads (0.23-1).
- Ids: `<type>-<6–32 [0-9a-z]>` (`RECORD_ID_RE`, `newRecordId`). Records name people and
  customers by id, never by name (13.10). Link values are record ids, or company paths for
  links whose target is `file`.

## The company map (server)

Tables (all `company_id`, all behind the company handle `records` — `ports/records.ts`,
`adapters/sqlite/records.ts`): `record_settings`, `record_types`, `records` (index: id, type,
type version, scope id, path or null = server-only, folder, title, summary, removed_at),
`record_links`, `record_state` (state, server fields JSON, version — **not rebuildable**, covered
by the backups; written only by the engine, 4-3), `record_index_heads` (last commit indexed per
repository), `record_index_problems` (for owners/admins). Ids are bound as one JSON array
(`IN (SELECT value FROM json_each(?))`).

### Indexing (`services/record-index.ts`, git in `lib/record-files.ts`)

- After every accepted push over git-http (company or private-folder repository:
  `services.records.afterPush`), when the switch is turned on, and on `POST /records/reindex
  { full: true }`. One run per company at a time; pushes meanwhile fold into one more run. Each
  repository is read from its last indexed commit (`diff-tree`), or in full (`git grep` for files
  with `id:` and `type:` lines, plus `.acb/types/`) the first time or when that commit is gone.
  Files over 1 MB are not records. Never in the request: a failure is logged (`logError`) and the
  next push retries from the last indexed commit. The server's own commits (departments) are
  picked up by the next diff.
- Safety, the only thing the server refuses (4-1); the rest is reported for the app to fix:
  - **id hijack**: a file claiming the id of another live record is not indexed
    (`duplicate_id`; the app gives the copy a new id); a move in the same push keeps the record;
    a removed record comes back when its file does (same repository); a server-only record gets
    its file only from the company repository, inside its folder. A record never crosses into or
    out of a private folder by id (`moved_across_folders`) — except a folder **made public**,
    whose records the company repository adopts at the same path.
  - a record's `type` never changes (`type_changed`).
  - **server-only types never come from files**: a file whose `type` is in force with storage
    `server` / `either` (every core type: a `type: task` or `type: decision` file an AI or an
    older build wrote) is not indexed and is reported (`server_only_type`); it stays an ordinary
    file and no record changes (a row indexed from that same file before is left as it was).
    Nothing adopts a file into a server record any more. Test: `tests/unit/record-index.test.ts`
    "server-only types never come from files".
  - **public → private links** are stored but never shown or followed, for anyone
    (`linkAllowed`): a record outside a private folder never reveals or reaches one inside it.
- A removed file marks the record removed (`removed_at`); its state is kept.

### Links to files (owner decision 10/29)

- A link whose target is a file is stored as a company path (`record_links.target_path`). The
  indexer reads each repository's diff with git's rename detection (`diff-tree -M`, any file
  type, `lib/record-files.ts` `renames`) and points every link to a renamed or moved file at its
  new path (`followRename` / `retargetFileLinks`) — after the record files of the same push, so a
  record file re-read there (its own text may still name the old path) ends on the new one; the
  next edit of that file restores what its text says (file records are a company's own types
  only). Exact path matches only: a link to a folder follows a department rename (below), not
  a member's folder move.
- Never across a private folder's edge (`followRename`): both paths in the same place (company
  repository or one private folder), and the new path one the source may link to at all
  (`linkAllowed`) — a record outside a private folder never gets a path inside it (a rename
  inside the folder leaves its link on the old path), and a move into or out of one is a delete
  plus an add in two repositories anyway. Such a link stays and reads as broken.
- A department renamed by the server (`services/departments.ts` update, same transaction as the
  scopes): `records.moveFolder` moves server records' readers' `folder` (else they would take the
  old path's rules), links to files at or under it and the minutes folder. Departments with a
  private folder inside cannot be renamed, so nothing private moves.
- Linking later (below) keeps the same rule: a server record never gets a path inside a private
  folder.
- A deleted file's link stays. The detail (`GET /records/item/:recordId`, the AI's `records_get`)
  marks each file link it shows `broken: true | false` — whether a file or folder is at that path
  on the shared branch now (`RecordFileSource.existing`, `lib/repo-paths.ts`; the private folder's own repository for a
  path inside one; only paths already shown to the reader are looked up; absent when git could not
  tell). The app says 「つながりが切れています」.
- Tests: `tests/unit/record-file-links.test.ts` (linking later, below), `tests/unit/record-link-renames.test.ts` (rename, move, swap, never into a private
  folder for an outside record nor across its edge, department move with `_` in names,
  cross-company), `tests/integration/record-links.test.ts` (real git rename detection, broken
  flag, department rename through the service) — mutation-checked.

### Linking files later (owner decision 2026-11-01)

`POST /records/item/:recordId/file-links` (session) and `POST /api/records-ai/item/:recordId/file-links`
(act token, tool `records_link_file`) `{ path, link?, expectedVersion, note? }` link a file or folder
to a record after it was made; `…/file-links/remove` (tool `records_unlink_file`) removes the link.
Engine `fileLink` (`services/record-engine.ts`), generic: any type with a `file` link (`link` may
be left out when the type has one; task: `files`). Contract `FileLinkRequest` / `FileLinkResult`.

- Who: anyone who reads the record (as reading it) and **reads the file** (`reader.file`). The
  member's **AI** only on types whose definition lets the AI act at all (some action's `who` lists
  `ai`: task yes; a type with only `anyone` actions no) — no new type syntax. Codex's read tokens
  get 403 `READ_ONLY_TOKEN`. Not on `SERVICE_STATE_TYPES` (403 `STATE_CHANGED_BY_SERVICE`) nor on
  a company's own file record (400 `FILE_RECORD`: its links are its text).
- **Never into a private folder from outside it** (`linkAllowed`, a server record is outside every
  private folder): a file the member cannot read and a file inside a private folder answer the same
  400 `FILE_NOT_LINKABLE`, naming no place. The same check now runs on a create's file links.
- Ledger: action `link_file` / `unlink_file`, state unchanged, one change `links.<name>` whose
  before / after are the link's whole target list (file links: a JSON array of company paths;
  record links keep the service writer's comma-joined ids; null = none). The version goes up
  (`expectedVersion` → 409 `VERSION_CONFLICT`); a file already linked answers `changed: false` with
  no entry; removing one not linked → 404 `LINK_NOT_FOUND`. Nobody is notified.
- Undo (people only, as every undo) restores the link rows: a `links.*` change is compared with
  the current rows (not the replay — a rename the indexer followed changed them without an entry,
  so such an undo answers `CHANGED_SINCE`) and never lands in the server fields. A replay
  (`versions/:version`) shows `links.<name>` as of that version.
- No existence check: a path not synced yet links and reads `broken` until it arrives.
- The app's entrance (milestone 5 brings the task card): the file tree's right-click item
  「やることにつなぐ…」 (`src/features/files/contextMenuItems.tsx`, shown when `FileTreePanel` gets
  `onLinkToTask`; `src/app/FilesPanel.tsx` composes) opens `src/features/tasks/components/LinkToTaskDialog.tsx`
  (`hooks/useLinkToTask.ts`): the member's open tasks — non-final states, where they are
  assignee, requester, reviewer or next actor — searched by title, soonest due first; choosing one
  links the file's company path and shows 「「<file>」を「<task>」につなぎました。」. IPC `tasks:open` /
  `tasks:linkFile` (`client/electron/features/tasks/`, with the session in main; one retry at the
  server's version on `VERSION_CONFLICT`), pure parts `client/shared/task-links.ts`. UI test:
  `client/tests/ui/file-tree.spec.ts` 「やることにつなぐ…」.
- The consultation AI: no consultation is linked to a task in the app yet (only a minutes
  consultation stores `minutesId`, `minutes.md`). `records_get` returns the file links (`path`,
  `broken`) and its description and `RECORDS_INSTRUCTIONS` tell the AI to check a task's linked
  files there and read the ones it needs with its normal file tools — names only, never contents,
  through the API.

### Due with a time (task version 3)

A value of kind `date` is `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM` (the company's clock, no zone;
`isDateValue` / `DATE_VALUE_RE` in `shared/core/record-types.ts`, used by the engine and the app's
tool schemas). Both sort correctly as text, so stored date-only values stay valid; the kind did not
change (no breaking change). `set_due` is 「延ばす」: the ledger keeps the earlier value (before /
after), and since task version 3 it has `notify: requested_by` — the requester is told through the
push channel (kind + version only) unless they did it themselves. Who may set it is unchanged
(`requested_by`, `assignee`, `ai`). The push signal only makes the app re-ask; a screen that shows
the requester the change comes with milestone 5. A plugin's own `date` fields still write
date-only values outside (`shared/core/plugins.ts`).

### Reading (`services/records.ts`, `services/record-access.ts`; contract `shared/types/records.ts`)

```
GET|PUT /records/settings          owner/admin
GET     /records/problems          owner/admin (paths may be private: owners/admins read all)
POST    /records/reindex           owner/admin, { full: true }
GET     /records/types             any member: definitions in force + stored versions
POST    /records/item/:recordId/file-links (+ /remove)   link a file later ("Linking files later")
POST    /records/query             any member: { type?, implements?, state?, fields?, linkedTo?: { id, hops: 1|2 },
                                   text?, limit ≤ 200, offset ≤ 10000, countOnly? } → { total, records }
GET     /records/item/:recordId    any member: the record + its readable links (both directions)
```

- **No leaks** (0.13-1, 4-2): a record is readable exactly when its file is (`resolveAccess`
  read; inside a private folder also `canReadPrivateScope`), a server-only record when its
  folder is (none = everyone). Answers, `total`, link lists and traversals all apply it, so an
  unreadable private record is identical to a nonexistent one (same 404 body). `total` counts up
  to `MAX_CANDIDATES` (20,000) rows.
- Records imported through an earlier connection of an outside system are marked
  (`fromOldConnection`, `notice`) and left out of the query unless `includeOldConnection: true`
  and out of 「あなたの番」 (`plugins.md` "Connections").
- Fixed shape only — no free SQL (0.23-1): type or interface, states, server-field equality (`{
  in: [...] }`), links up to 2 hops (traversal passes only through readable records), substring of
  title / summary. With `type`, field names must be server fields of it.
- Cross-company: the handle is `member.companyId`; another company's record id is a record that
  does not exist (permission matrix `CROSS` row, `tests/unit/record-index.test.ts`).
- The detail route is `/records/item/:recordId`, not `/records/:recordId`: a parameter next to the
  static `/records/settings` etc. made Hono fall back from RegExpRouter to TrieRouter, under which
  `/api/auth/**` stopped matching (the permission matrix's auth rows caught it).

## Core types (4-5, `shared/core/core-types.ts`)

`task` (タスク: implements `request`; storage `server` — version 2 (2026-11-01; version 1 was
`either`, a file adopted once it had content, 0.6-1), version 3 (2026-11-01: `set_due` notifies
the requester; the due may carry a time, above), `purpose` a server field; the content
people write is an ordinary file linked through `files`; states todo / in_progress / review /
waiting / done / cancelled, final done / cancelled; actions start, request_review (attach files,
notify the reviewer, hand to them), send_back (note required, decision), assign (note required,
undoable approval tier, decision), wait, set_due, complete (requested_by / reviewer only — not AI;
attach, decision), cancel (note required, decision), reopen) and
`interaction` (やりとり: server only, no body — summary, channel, counterpart, pointer to the
original; version 2 adds a `deal` link; outbound mail records one per sent mail, `outbound-mail.md`). Stored per company with source `core` by every index run
(`ensureCoreTypes`) unless a version at least as new is there; a company extends one with its
own `.acb/types/task.md` (higher version, additive only; a company file still saying `storage:
either` is now a breaking change against the core version 2 and is reported, the core definition
staying in force — unless that file's version is already ≥ 2, in which case it stays in force:
`ensureCoreTypes` only adds a core version above every stored one). Definitions may also say `final`
(states where nobody's turn is waiting) and, per action, `hand_to` (the person field or argument
copied into `next_actor`; only for types implementing `request`).

Milestone 4 adds four (people by id in person fields):

- `minutes` (議事録, server): `meeting_at`, `assignee` (organizer or first discoverer),
  `attendees` (text: JSON array of member ids — no person-list kind exists), `external_count`,
  `source_ref` (opaque pointer, no text), `doc_version`, `summary_text` (long_text; ≤ 300 is the
  intake's rule); links `deal`, `customer`. received → reading → read / skipped / failed:
  `start_reading`, `finish_reading` (arg `summary_text`), `fail_reading` are `who: [ai]` —
  received is the example of 「AI の番」 (no separate reader AI: the consultation AI reads, owner
  §11); `retry` (reading / failed → received, also for "reading > 30 min") and `skip` are
  assignee / admin.
- `approval` (承認のお願い, server, implements `request` → the approver's 「あなたの番」):
  `approver_rule` [self, dept_manager, admin], `operation`, `payload_hash`, `payload_version`,
  `reason`, `result_operation_id`; links `about` (target `deal`), `minutes`. pending → approved /
  sent_back / stale / withdrawn / failed; sent_back → withdrawn (version 2: `sent_back` is not
  final, so a sent-back request is the requester's turn again). **No actions.** Its service:
  `approvals.md`.
- `outbound_message` (送るメール, server): `requested_by` / `assignee` (the author), `subject`,
  `payload_hash`, `payload_version`, `sent_at`, `provider_message_id`, `channel` [email]; links
  `about`, `minutes`. draft → sent / unknown / discarded; unknown → sent or back to draft
  (送られていた／送られていなかった). **No actions.**
- `decision` (決めたこと, server — version 2; version 1 was a file, "Decisions" below):
  `recorded_by` [ai, human], `important`, `decided_by` (null when the AI recorded it), `owner`
  (the linked minutes' assignee at creation, else the member — `who` cannot name "the minutes'
  assignee"), `source_key`, `why` (long_text), `source`; links `deal`,
  `minutes`, `approval`. unconfirmed → confirmed / retracted: `confirm` (note optional), `retract`
  (note required), both `who: [owner, dept_manager, admin]`, decisions.

A link's `target` is a label, not a check: `deal` / `customer` come from a business plugin (「法人営業」) and may not
exist in a company; the parser and the engine accept a link to a type that is not defined.

### Service-owned types (`SERVICE_OWNED_TYPES`, `shared/core/core-types.ts`)

`minutes`, `approval`, `outbound_message`, `decision` are made only by the server's own services:
the generic create (`POST /records/item`, the AI's `records_create`) answers 400
`TYPE_CREATED_BY_SERVICE`, and the app's `records_create` tool never offers them. Of those,
`SERVICE_RECEIPT_TYPES` (`interaction`) the service writer may also create — a receipt of what a
service did outside (a sent mail), still creatable through the generic routes. Of those,
`SERVICE_STATE_TYPES` (`approval`, `outbound_message`) change state only through their service
(approving checks the content hash and runs the operation; sending reaches outside): the generic
action and undo routes answer 403 `STATE_CHANGED_BY_SERVICE` even if a company's own definition
adds an action, and the app generates no action tools for them. Tests:
`server/tests/unit/record-service-types.test.ts`, `record-tokens.test.ts` (an AI token creating
an approval), `client/tests/records-tools.test.ts` — mutation-checked.

### Service writer (`createServiceRecordWriter`, `services/record-engine.ts`)

The engine's entry for the core services (approvals G6, minutes G7, mail G8, decisions). Like the
external writer, composition.ts hands it to those services only (`serviceRecords`, not in
`services`). `create(companyId, { type, id?, title, summary?, folder?, fields, links, actor,
note? })` — service-owned types only, server records only (`folder`: the readers' place, never a
private folder); `check(companyId, input)` is the same validation without writing (ask it before
outside work, e.g. the minutes intake). `transition(companyId, { recordId, action, expectedVersion, to | null, fields?, links?,
actor, note?, decisionReason?, notify? })` — the state only along `SERVICE_TRANSITIONS` (next to
the types; `serviceTransitionAllowed`), `to: null` changes fields only; `links` replaces the named
links (ledger change `links.<name>`, ids before / after — the minutes' deal, `minutes.md`). Both: values checked by kind,
every person field set must be able to read the record (`assignee-cannot-read`, never naming the
place), state + ledger in one transaction with a compare-and-set (`stale`), the ledger actor is
the one passed (human / ai / external), assignee / next actor / `notify` told (kind + version
only). Results `{ ok: true, record, entry }` or `{ ok: false, reason }`. Whether that actor may
do it (the approver approving) is the calling service's rule.

## The state engine (4-3, `services/record-engine.ts`)

Exactly five duties (ontology §17.7): (1) the action's `from` states, (2) its `who`, (3) state and
ledger written in one transaction, (4) tell whom it names, (5) a milestone line. Nothing else:
arguments are copied into the server fields of the same name, `hand_to` copies one person into
`next_actor`; no expressions, cascades, timers or outside sends.

- **Who**: a person field of the record whose value is the member, `admin` (owner/admin role),
  `dept_manager` (manages the department holding the record's path or folder), `anyone`. Roles do
  not bypass `who`. The member's **AI** may act only where `who` lists `ai`, and then only for a
  member who qualifies on their own (or any member when `who` is `[ai]` alone) — so the AI cannot
  complete a task. Whether it is the AI is decided by the credential (next section), never by the
  request body (an `actor` field there is ignored). `external` is reserved for server-side
  integrations.
- **Concurrency**: every request carries `expectedVersion`; a stale one → 409 `VERSION_CONFLICT`
  「ほかの人が先に変えました…」 with the current version, nothing written (checked again inside
  the write: `writeState` is a compare-and-set on the version).
- **Ledger** (`record_ledger`, `shared/core/record-ledger.ts`; never updated or deleted): record,
  version (the record's version after it), action, from → to, actor id + kind (human / ai /
  external) + source, at, note (required where the action says `note: required`), before/after of
  the state and **every server field changed**, attached file versions (`attachments`: link, path,
  commit — checked to exist in the repository at that commit, else 409 `ATTACHMENT_NOT_SYNCED`:
  the app pushes the linked files first, 0.18-1), decision fields when the action is a decision
  (`reason` = the note, `materials` as references — a file at a commit or a record at a version
  it has had, both readable by the actor —, `policyVersion`, `precedents`, `supersedes`; §13.2 案
  Y, only the container for now), the type version.
- **Provenance** (owner: light and reversible; columns `proposed_by`, `conversation_id` added by
  `migrateRecordLedgerProvenance`, nullable): `proposed_by: 'ai'` when a person confirms an action
  their AI suggested in a consultation (`proposedBy: 'ai'` in the session route's body; actor kind
  stays `human`), `conversation_id` the consultation (the body's for a person, **the token's** for
  the AI — the AI routes ignore both body fields; `proposed_by` stays null for the AI, whose actor
  kind already says ai). **Informational only**: the client can report anything, so nothing
  authorizes on them (`selfReportedProvenance`, `services/record-engine.ts`). Shown in the history
  and in `GET …/versions/:version` (`origin`: the entry that made that version). The command
  `records.runAction` carries both for the confirm screen of milestone 5. Test:
  `server/tests/integration/record-tokens.test.ts` "provenance in the ledger".
- **Undo** (`POST …/undo { version, expectedVersion }`): a new `undo` entry with the reversed
  changes (`reversesVersion`); refused when a later entry changed the same values
  (`CHANGED_SINCE`), for `create` / `undo` entries, and for anyone but the entry's actor or an
  owner/admin.
- **Replay** (§13.11): `replayRecordState(entries, n)` folds entries 1..n; it throws on a gap or a
  version that does not exist rather than describe another version. `GET …/versions/:version`
  answers the values plus `origin` (action, actor, kind, at, provenance of entry n).
- **Assignee must see the record**: setting `assignee` (on create, or as an action's argument)
  to a member who cannot read the record's place (private folder, scope rules — their own
  `recordReader`) → 400 `ASSIGNEE_CANNOT_READ` 「この人はこの記録を見られないため、担当にできません。…」,
  which never names the place. Test: `server/tests/unit/record-engine.test.ts` "an assignee must
  be able to see the record".
- **Notify** (duty 4): the members named by the action's `notify` and the new `next_actor`, never
  the actor, through the push channel's `notify` — event `records`, kind + version only (a fresh
  value), addressed by company × member (`agent-stop.md`). The app refetches; it never acts on the
  event itself (0.18-1, SSE rule). The app's one listener is 「議事録が届きました」: a `records`
  event only makes main ask the server again for the member's received minutes (`minutes.md`
  "The app").
- **Milestone line** (duty 5, `history_line: true`, file records only — a company's own
  `storage: file` type; no core type has one any more): appended to the file's
  「## 経緯」 section (created at the end when missing) as the server's own commit
  (`lib/bare-commit.ts` `commitFileEdit`: trees along the path rewritten, pushed to itself under the
  company lock, so the push checker runs; redone on a new tip). Line: `<date> <action label>（<member
  id>[・AI 経由]）：<note>` — ids, never names (13.10). After the state is written and outside it:
  a failure is logged, the state stands.
- Server-only records (`POST /records/item`, types with storage `server` / `either`): title,
  summary, optional folder (not inside a private folder yet), server fields, links; the id is
  `<type>-<16 hex>`; `requested_by` defaults to the creator and `next_actor` to the assignee.

## Who is acting: the credential decides (owner requirement, 2026-10-31)

"Human or AI" is never self-declared by the app:

- The member's own screens call `/api/companies/:id/records/…` with the member's **session** →
  actor kind `human`.
- The member's AI calls `/api/records-ai/…` (`routes/records-ai.ts`) with a **record token**
  (`Authorization: Bearer acb_rec_<company id>.<64 hex>`, `services/record-ai-tokens.ts`,
  table `record_ai_tokens`, only its sha256 stored) → actor kind `ai`, source = the agent the
  token was issued for. These routes never accept a session.
- The app's main process gets the token per chat turn with the session (`POST
  /me/record-tokens { conversationId, agent, scope }`, ≤ 50 live per member, 120 minutes) and
  revokes it when the turn ends (`DELETE /me/record-tokens/:tokenId`, the member's own only). The
  AI process never receives the session: Claude's record tools run in main (in-process MCP), Codex
  reaches them through a loopback endpoint that main serves (`client/electron/records/`).
- `scope`: `read` (look up) or `act` (also create / run actions). The app asks `act` only for
  agents with registry `recordActions` (Claude Code; owner decision 0.3-3: Codex reads only), and
  the server refuses an action with a read token (403 `READ_ONLY_TOKEN`). Defence in depth: the
  server grants `act` only to agents in `RECORD_ACTION_AGENTS` (`shared/types/records.ts`; any
  other agent asking for `act` gets — and is told — `read`), pinned to the registry by
  `client/tests/records-tools.test.ts`. The agent name is the app's word, so this stops a
  mistaken app, not a forged one.
- The company id in the token only chooses which company's handle to look the digest up in:
  another company's id finds nothing (no `UNSCOPED` lookup across companies). The holder must
  still be a member; while the company's whole AI is stopped (`agent-stop.md`) every token gets
  403 `ACB_STOPPED`.
- No undo for the AI (people undo).
- Tests: `server/tests/integration/record-tokens.test.ts` (a token call is recorded as ai and
  cannot run an action without `ai` even when the body claims human; a session call is recorded
  as human even when the body claims ai; read scope, forged company, revoked, removed member,
  stop, session refused — each mutation-checked).

## Typed tools in the app (4-6, `client/electron/records/`)

- `api.ts`: the token per turn (above). `tools.ts`: MCP server `acb_records`, generated from the
  company's type definitions at the start of each turn — look-ups (`records_my_turn`,
  `records_ai_turn`, `records_query`, `records_get`, `records_history`, `records_types`) and,
  with an `act` token, `records_create` (not for service-owned types), `decisions_record`,
  `records_link_file` / `records_unlink_file` (types with a file link that let the AI act), and
  one tool per type × action (none for `SERVICE_STATE_TYPES`) (`task__request_review`: `id`,
  `expectedVersion`, `note` — required where the type says —, the action's arguments). Wired like
  the company-files tools: Claude in-process (in `allowedTools`: the type's `who` and the server
  decide, nothing is asked), Codex as a loopback endpoint; registry `recordsMcp` /
  `recordActions`. The system prompt says records (tasks, decisions…) live only on the server —
  never make a record file; content people write is an ordinary file the record links to — and
  person fields take member ids, while replies to the member call a record by its title and
  distinguishing details (担当, 金額, dates) and show internal ids (record ids, outside ids,
  operation ids) only when asked — the tools keep the ids (`RECORDS_INSTRUCTIONS`).
  Category `app-tool` in the action log. Not in the
  private-read guard's app list: after the conversation read a private folder, a record tool call
  asks the member first (a note could carry private content to a shared record).
- The chat write guard (`write-guard.ts`, `chat-write-guard.md`): `.acb/types/` for owners /
  admins only (guard reason `type-definition`), and `decideRecordEdit` refuses a Write / Edit /
  MultiEdit that adds or changes a frontmatter key other than id / type / links in a record file,
  or changes / removes an existing record's id or type (`recordFileEditProblem`,
  `shared/core/records.ts`; guard reason `record-file`). Bash writes are not inspected (the
  server never reads state from files anyway).
- Commands (E1, `commands.md`): `records.runAction` (class outbound) for the screens to come;
  `client/shared/record-actions.ts` `recordActionChoices` lists the actions that can start from a
  record's state. The push channel's `records` event reaches the app's `onRecords` listener
  (`wireAgentControl`), which only re-asks for received minutes (`minutes.md` "The app").
- Connector plugins' operations become tools on the same server (`hubspot__update_deal`; writes
  only with an `act` token) and an update's outcome a card in the reply: `plugins.md` "The app".
- Not done (TODO): the plugin-SDK and admin-API surfaces of the same definitions (stages 5 / 7);
  pushing an action's attached files before calling it (0.18-1 — the tools send no
  `attachments` yet); the app assigning ids to new record files and repairing duplicates.

## Outside systems (milestone 3, `plugins.md`)

- `createExternalRecordWriter` (`services/record-engine.ts`) is the engine's one entry for what a
  connector plugin read from or wrote to an outside system. composition.ts hands it to the plugin
  services only (not in `services`, so no route, screen or AI reaches it). Same duties as the
  engine — state + ledger in one transaction with a compare-and-set on the version (P6 writes
  pass `expectedVersion`), tell the assignee / next actor — and nothing else: it sends nothing
  outside and **never writes a file** (imported records are server-only, `path` null; owner rule
  §8-3). Values are checked by the type's field kinds; a person must be a member.
- Ledger: actor kind `external` (source = the plugin id) for an observed change; for a plugin's
  write (P6) the person or AI it was done for (`receipt.kind: written`, the operation id), with the
  note and — for a `decision: true` operation — `isDecision` and the reason; P6 passes
  `expectedVersion`. Column `receipt` (additive,
  `migrateRecordLedgerProvenance`; `ExternalReceipt` in `shared/core/record-ledger.ts`): plugin,
  version, fingerprint, mapping version, connection, outside account, object, outside id, the
  outside last-modified time, operation id, `kind` observed / written, and (milestone 4) the
  person who approved it (`approvedBy`; the actor stays the requester, the entry a decision with
  the approver's reason).
- Milestone 4 creates (`plugins.md` "Creates"): a deal created outside becomes a record through
  this entry (`recordId: null`, the requester as actor, a decision when approved); a meeting
  logged on a deal adds an entry **without field changes** (`entryWithoutChanges`) to the deal's
  ledger, its receipt naming the meeting — the version goes up, nothing else changes.
- A business plugin's types (`plugins.md` "Two roles"; written by its connector's import) are stored with source `plugin` (`record_types.source`; a table made
  before is rebuilt once by `migrateRecordTypeSources`); a company still extends one with its own
  `.acb/types/<name>.md` (higher version, additive).

## 「あなたの番」 (4-4) and 「AI の番」 (milestone 4)

`GET /records/my-turn`: records of every type implementing `request` whose `next_actor` is the
member, or with no `next_actor` and the member as `assignee`, not in a `final` state, readable by
them. Types are not named: a new request type shows up without changing the list.

`GET /records/ai-turn` (session) and `GET /api/records-ai/ai-turn` (record token, tool
`records_ai_turn`): records whose current state has an action with `who` exactly `[ai]` (from
null = every non-final state), where the member is `assignee` or `next_actor`, readable by them
(design q16: no new type syntax). Takes no object id (no `CROSS` row).

## Decisions (`services/decisions.ts`, design §3-3)

`POST /records/decisions` (session) and `POST /api/records-ai/decisions` (act token, tool
`decisions_record`): `{ folder, title, why, source, links?: { deal?, minutes?, approval? },
important?, key? }` → 201 `{ record, created: true }` (200 `created: false` for a known key).
- A server record (owner decision 2026-11-01): no file, no commit. The service writer creates the
  row (`path` null, `folder` = the department folder) and its state `unconfirmed`, with `why` /
  `source` as server fields (the summary is the start of `why`, what text search reads). Earlier
  builds wrote `<department>/意思決定/<id>.md`; such files stay ordinary files (`server_only_type`).
- Place and readers: `folder` must be a department folder (`departments.folders()`) the member may
  write, not a private folder nor inside one (q14), and inside every linked server record's
  folder. The folder decides who reads the decision (those who can read it, like every server
  record). Every refusal is 400 `DECISION_PLACE_REFUSED` with the same words, never naming the
  place.
- Names are allowed (the old `NAME_IN_DECISION` refusal protected the repository's history, which
  a server record does not have; visibility is by the reader's permissions).
- Links: readable records of this company of the link's type (else 400 `BAD_LINK`).
- `key` (e.g. `minutes-…:decision:2`): the id is derived from it (sha256) and it is stored in
  `source_key`; a known key answers the existing record, so the same item is written once even
  for two calls at once.

## Not yet

The screens (milestone 5), the plugin-SDK / admin-API surfaces, attachments sent by the AI tools,
the app's id assignment and duplicate repair, archiving finished tasks (0.6).

## Tests

`server/tests/integration/record-tokens.test.ts` (the credential decides human / ai),
`client/tests/records-tools.test.ts` (token not session on AI calls, revoked at turn end, tools
from definitions, read scope / Codex without actions, schema refusals, write guard, action
choices), `server/tests/unit/record-service-types.test.ts` (service-owned types refused by the generic
create, no generic action / undo on approvals, the writer's transition table and CAS, 「AI の番」
own + readable only, decisions: a server record readable by its folder's readers only, private
folder, key, links — each mutation-checked),
`server/tests/unit/record-file-links.test.ts` (linking a file later: ledger, undo, the AI only
where the type lets it, unreadable and private-folder files refused alike without a place,
cross-company; due with a time, the requester told — each mutation-checked),
`server/tests/unit/record-engine.test.ts` (from / who incl. AI, notes, ledger before/after,
concurrency, undo, replay, notify targets, history line, attachments, decisions, 「あなたの番」,
cross-company), `server/tests/unit/push-channel.test.ts` (records notices reach only the named
members of that company), `server/tests/unit/record-types.test.ts` (YAML subset, definitions, versions, record files),
`server/tests/unit/record-index.test.ts` (hijack, moves, private ↔ public, type versions, read
filtering incl. counts and links, cross-company), `server/tests/integration/records.test.ts`
(switch, full index, a member's push over git-http indexed, `.acb/types/` push rules, a task
through the engine over HTTP with a real attached commit and the history line committed through
the push checker for a company's own file type, a decision with no commit and an old decision
file left an ordinary file),
permission matrix rows + `CROSS`.
