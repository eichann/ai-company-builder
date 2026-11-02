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
  - "server/src/services/record-engine/**"
  - "server/src/services/decisions.ts"
  - "server/src/services/record-ai-tokens.ts"
  - "server/src/routes/records-ai.ts"
  - "client/electron/records/**"
  - "client/shared/record-actions.ts"
  - "client/shared/record-views.ts"
  - "client/electron/features/record-views/**"
  - "client/src/features/records/**"
  - "client/src/features/search/components/RecordHits.tsx"
  - "server/tests/unit/record-linked-to-file.test.ts"
  - "client/tests/records-tools.test.ts"
  - "server/tests/integration/record-tokens.test.ts"
  - "server/src/ports/records.ts"
  - "shared/core/viewers.ts"
  - "shared/types/viewers.ts"
  - "server/src/services/viewers.ts"
  - "server/src/routes/viewers.ts"
  - "server/tests/unit/viewers.test.ts"
  - "client/shared/viewers.ts"
  - "client/electron/features/viewers/**"
  - "client/tests/viewers-ipc.test.ts"
  - "server/src/ports/record-files.ts"
  - "server/src/adapters/sqlite/records.ts"
  - "server/src/adapters/record-files.ts"
  - "server/src/lib/record-files.ts"
  - "server/tests/unit/record-*.test.ts"
  - "server/tests/unit/core-types-interfaces.test.ts"
  - "server/tests/integration/records.test.ts"
  - "server/tests/integration/record-links.test.ts"
  - "server/tests/unit/push-channel.test.ts"
  - "server/src/services/task-acceptance.ts"
  - "shared/core/record-contents.ts"
  - "server/src/adapters/sqlite/record-contents.ts"
  - "server/src/ports/record-contents.ts"
  - "shared/core/skill-uses.ts"
  - "server/src/services/skill-uses.ts"
  - "server/src/routes/skill-uses.ts"
  - "server/src/ports/skill-uses.ts"
  - "server/src/adapters/sqlite/skill-uses.ts"
  - "server/src/db/schema/skill-uses.ts"
  - "server/tests/integration/skill-uses.test.ts"
  - "client/electron/services/skill-use-reporter.ts"
  - "client/tests/skill-uses.test.ts"
  - "server/src/services/record-contents.ts"
  - "server/src/cli/erase-content.ts"
  - "server/tests/unit/record-contents.test.ts"
  - "shared/core/absences.ts"
  - "shared/types/absences.ts"
  - "server/src/services/absences.ts"
  - "server/src/routes/absences.ts"
  - "server/tests/unit/absences.test.ts"
  - "client/electron/features/absences/**"
  - "client/src/features/absences/**"
  - "client/shared/absences.ts"
  - "shared/core/ai-runs.ts"
  - "shared/types/ai-runs.ts"
  - "server/src/services/ai-runs.ts"
  - "server/src/routes/ai-runs.ts"
  - "server/src/ports/ai-runs.ts"
  - "server/src/adapters/sqlite/ai-runs.ts"
  - "server/src/db/schema/ai-runs.ts"
  - "server/tests/integration/ai-runs.test.ts"
  - "shared/core/record-turns.ts"
  - "server/tests/unit/record-turn-opens.test.ts"
  - "client/tests/record-views-opened.test.ts"
  - "server/tests/unit/record-outside-time.test.ts"
---

# Records: types, the company map and the state engine (light ontology, stage 4-1 … 4-5)

The core foundation of the light ontology (owner design 「段4 本体の土台」, decisions 0.18–0.23):
types are defined in files; **record data lives only on the server** (owner decision 2026-11-01:
tasks, decisions, deals, interactions, meetings, approvals, outbound mail — every core and plugin
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
  only, values stay the options; kind `tags` is server-only, "Tags" below; a server `number` may
  say `money: true` — written only through an approval request: no action's `args` may name it,
  a create may not fill it (400 `MONEY_NEEDS_APPROVAL`), removing it is breaking — `plugins.md`
  "Money", tests `tests/unit/record-types.test.ts`, `record-money-field.test.ts`), `links` (target type
  or `file` — or `interface: <name>` instead of `target`, "Links to an interface" below —,
  cardinality, inverse label, `origin: true` — "Linking records later"),
  `states`, `initial`, `create_states` (states a create may start in instead — "Task version
  5"), `actions` (from / to / who / notify / attach / note / history_line /
  decision / approval / args / ok_from — "Completing on someone's OK" — / who_unless — "Task
  version 9" — / links — record links the action sets, "Task version 5"), `implements` (interfaces, `INTERFACES`, "Core interfaces"
  below: `request` needs `requested_by`, `assignee`, `next_actor`, `waiting_on`, `due` on the
  server; `bundle` (まとまり) needs `owner` (person) and `purpose` (text) on the server and final
  states; `counterpart` (相手) needs `counterpart_kind` (choice offering company and person),
  `domain` and `email` (text) on the server; `prepared` (AI が用意したもの) needs `requested_by` and
  `assignee` (person) — `outbound_message` and `approval` implement it; `outside_event` (外で起きたこと)
  needs `occurred_at` (datetime) on the server — "Outside time"; `interfaceProblems`), `storage`
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
Engine `fileLink` (`services/record-engine/file-links.ts`), generic: any type with a `file` link (`link` may
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
- The core app's entrances (owner decision 2026-11-01: the task list is the core's, and linking
  comes back with it — not from a plugin): the file tree's 「やることにつなぐ…」, dragging a file
  from the tree onto a task row or the task card, and the card's 「＋ファイルをつなぐ」 / 「外す」,
  all through `tasks:linkFile` / `tasks:unlinkFile` with the session (`tasks-ui.md` "Linking
  files"); the AI links with `records_link_file` / `records_unlink_file`.
- The consultation AI: no consultation is linked to a task in the app yet (only a minutes
  consultation stores `minutesId`, `minutes.md`). `records_get` returns the file links (`path`,
  `broken`) and its description and `RECORDS_INSTRUCTIONS` tell the AI to check a task's linked
  files there and read the ones it needs with its normal file tools — names only, never contents,
  through the API.

### Linking records later, and where a record came from (owner decision 2026-11-02)

「つなぐ・外す」 for record links, the same shape as files ("Linking files later"):
`POST /records/item/:recordId/record-links` (+ `/remove`) `{ link, target, expectedVersion, note? }`
(session only; contract `RecordLinkRequest` / `RecordLinkResult`), engine `recordLink`
(`services/record-engine/record-links.ts`). 取り消す is the generic undo of its entry.

- **Origin links** (出どころ): a link definition may say `origin: true` — where the record came
  from, which is history rather than filing. Core: task v10 `meeting` (もとの会議), `interaction`
  (もとの連絡), `prepared` (AI が用意したもの); decision v5 `meeting`, `approval`; reply_request v3
  `interaction`, `prepared`. They are set when the record is made (create, the service writer, the
  action that makes them — `finish_prep`'s `prepared`) and are never linked or removed through these
  routes: 400 `LINK_IS_ORIGIN`, nothing written. Adding or dropping the mark is not breaking. The
  filing links (bundle, counterpart, related, files) can be.
- Who: anyone who reads the record; the member's AI only where the type lets the AI act (no AI
  route yet). Not on `SERVICE_STATE_TYPES` (403 `STATE_CHANGED_BY_SERVICE`) nor a company's own
  file record (400 `FILE_RECORD`).
- Linking: the target must be a live record the caller reads, of the link's type or implementing
  its interface, that the record may reach (`linkAllowed`) — another type, an unreadable record,
  another company's and a missing id get one answer, 400 `BAD_LINK`. A `one` link (bundle) is
  replaced (「変える」); already linked → `changed: false`, no entry. Removing: a target not linked
  and one the caller cannot see get the same 404 `LINK_NOT_FOUND`. Only the link changes: the other
  record is never touched (「相手の記録は消えません」).
- Ledger: action `link_record` / `unlink_record`, state unchanged, change `links.<name>` (ids
  comma-joined, before / after), version + 1 (`VERSION_CONFLICT`). Nobody is told.
- The detail (`GET /records/item/:recordId`) marks each link that cannot be removed by hand with
  `fixed: true` — an origin link, a link of a `SERVICE_STATE_TYPES` record or of a file record —
  on both sides (the meeting's view of a task's `meeting` link too), so the screen offers
  「…」→「つながりを外す」 only where it works.
- Test: `server/tests/unit/record-record-links.test.ts` (removing and undoing, the other record
  untouched; a `one` link replaced; stale version; origin refused both ways with nothing written;
  `fixed` on both sides; which core links are origins; one answer for unseen targets both ways) —
  mutation-checked. Permission matrix rows + `CROSS`.

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

### Completing on someone's OK (task version 4, owner decision 2026-11-01)

Creative work is done when the boss (or a customer) said OK, and making the boss press 完了 is a
burden: the **assignee** may complete a task themselves, saying whose OK it was. Generic syntax
(no type-specific code in the engine): an action's `ok_from: [<person fields>]` lets the holder of
one of those fields **also** run it when they are not already in `who`, with a body `ok: { by?,
note? }` — `by` a member id, `note` (≤ 500 characters) for an OK from outside ACB (「先方からメールで
了承」, where it came from); at least one. The type must have server fields `ok_by` (person) and
`ok_note` (text) (`OK_FIELDS`, parser error otherwise); the engine writes the statement into them.
Task: `complete` has `ok_from: [assignee]`, `notify: [requested_by, ok_by]`; `reopen`'s `who` is
`[requested_by, ok_by, admin]` — reopen is the OK-giver's 「取り消す」 (no new action).

- Refusals (`services/record-engine/act.ts` `act`): no statement → 400 `OK_REQUIRED`; `ok.by` the actor
  → 400 `OK_BY_SELF`; `ok.by` someone who cannot read the task **or not a member of this company**
  → one answer, 400 `OK_BY_CANNOT_READ`, naming no place; a statement where none is needed (the
  requester / reviewer, who complete as before) → 400 `OK_NOT_EXPECTED`.
- **Never the AI**: the OK path is for a person's session only; the AI's tool has no `ok` and its
  description says the member may do it on someone's OK and the AI may suggest it, never do it.
- Ledger: the `complete` entry is a decision (`decision: true`) whose changes carry `ok_by` /
  `ok_note` (before / after) — the OK-giver is in the ledger. The OK-giver is told through the
  push channel (as every `notify`), never the actor.
- An OK belongs to the state change it was given for: **any other action that changes the state
  clears `ok_by` / `ok_note`** (a reopen; in the ledger as before / after), so an earlier OK-giver
  cannot reopen a task completed or cancelled later.
- Screens: `recordActionChoices` gives each action's `okFrom`; command `records.runAction` takes
  `ok`. Version 4 only adds (two fields, `ok_from`, a wider `notify` / `who`): tasks indexed under
  version 3 stay valid. Test: `server/tests/unit/record-task-ok.test.ts` (each refusal, AI
  refused, requester unchanged, OK-giver told and reopening, cleared on reopen, cross-company,
  v4 additive — mutation-checked).

### Task version 9 (owner decision 2026-11-02 「着手しないで完了にできる」)

完了 no longer waits for 着手, and who confirms the end is said by the task (「終わったら」).
Additive over version 8 (who / from / notify / labels widened, one field, two actions):

- **完了 from any state but 準備中** (`complete` from todo / in_progress / review / waiting /
  awaiting_acceptance / declined). 準備中 is the AI's turn: 「自分で進める」 (`take_over`) first.
  `start` stays, labelled 「進めている印をつける」 — optional. **No start is ever made up**: the
  ledger of a task completed from 未着手 is create → complete; a measurement of such a task takes
  creation → completion.
- **`when_done` (終わったら)**, choice `notify` (知らせるだけ) / `check` (確かめてから); empty reads as
  `notify` (the default when asking). `reviewer` is 確かめる人 (label only changed).
  - `notify`: the assignee completes (`who: [assignee, requested_by, reviewer]`); the requester
    (and a reviewer) are told and the requester may `reopen` (やり直す) — `reopen`'s `who` now
    also has `reviewer`.
  - `check`: generic action key **`who_unless`** — `complete: { who_unless: { assignee: {
    when_done: check } } }` drops the assignee from `who` while the field holds that option
    (parser: an entry of `who`, a server choice field, one of its options; `actionWho` in
    `shared/core/record-types.ts` is the one evaluation, used by the engine — also for a delegate —
    and by the app's card). The assignee's main action is then `request_review`
    (「終わったので見てもらう」, now from todo / in_progress / waiting / awaiting_acceptance, `hand_to`
    the checker) and the checker's (or the requester's) `complete` is the OK.
  - **One line with version 4's OK**: `ok_from: [assignee]` stays on `complete`, and since the
    assignee is in `who` it only matters when `who_unless` took them out — i.e. only on a task to
    be checked first, when the checker said OK elsewhere (口頭・Slack・先方のメール): the assignee
    completes stating whose OK (`ok_by` / `ok_note`), the OK-giver is told and may reopen, exactly
    as "Completing on someone's OK". On a 知らせるだけ task an OK statement is `OK_NOT_EXPECTED`.
  - `set_when_done` (args `when_done`) and `set_reviewer` (args `reviewer`): the requester or an
    admin, never the assignee or the AI, from every non-final state but review.
  - **確かめる人 must be able to open the task**: a `reviewer` set on create, by `set_reviewer` or
    by `request_review` who cannot read the record → 400 `REVIEWER_CANNOT_READ` (as the assignee's
    `ASSIGNEE_CANNOT_READ`; never names the place, nothing written), so the checker's turn is
    never a record they cannot open.
- **完了 from 引き受け待ち** by the assignee (or their delegate) also records 「引き受けた」: the same
  entry carries `accepted_by` (`ACCEPTANCE.finishes`, `services/record-engine/acceptance.ts` with
  the action's `fromState`). The requester completing it does not.
- **Migration** (`migrateTaskVersion` in `db/index.ts` → `adapters/sqlite/records.ts`
  `migrateCompanyTaskVersion`, `TASK_VERSION` = the core task version, 10 since "Linking records
  later"): at startup, every company whose map has the task type stores that core version when
  nothing as new is stored, then every task's index row says it (`type_version`). No value changes, so no ledger entry. Idempotent.
- Test: `server/tests/unit/record-task-v9.test.ts` (from 未着手 with no start made up, requester
  told and reopening; never from 準備中; the AI never; 確かめてから hands over from 未着手 and the
  checker completes; only the requester decides 終わったら; a checker who cannot read it refused; 引き受けた recorded with the 完了 by the
  assignee only; `who_unless` parsing; the migration once, no entry, a company without tasks
  untouched) — mutation-checked. `record-task-ok.test.ts` runs the OK path on a `check` task.

### Tags (stage 2 S1, owner decision 2026-11-01: 「何個も値を持てる項目」を1つ足す)

Field kind `tags` — the one list-valued kind: short words (タグ) on a record.

- Definition: `source: server` only (a file-sourced one is a parser error; record files hold id /
  type / links only), no `options` / `target`. An action's `args` may set one (same kind).
  Adding a tags field is additive; changing a field to or from `tags` is a kind change (breaking).
- Value (`normalizeTagsValue`, `shared/core/record-types.ts`; the engine's `checkValue` for every
  writer: create, action args, service and external writers): an array of strings; each NFC,
  trimmed, inner whitespace one space, 1–`TAG_MAX_LENGTH` (40) characters, no control or line
  separator characters; repeats dropped (first kept, order kept); at most `TAGS_MAX_COUNT` (20).
  Anything else → 400 `BAD_VALUE`, nothing written. Stored — and in the ledger, before / after —
  as the **JSON text** of the array (`["急ぎ","見積"]`; none = null), so every record value stays
  one scalar (replay, undo and equality unchanged). `RecordSummary.fields` carries that text;
  readers use `parseTagsValue`. The app's tools take a list (`kindSchema`).
- Query: `fields: { <tags field>: { contains: "<tag>" } }` (one tag, normalized like a stored one).
  Only types whose field of that name is `tags` are searched (another type's text field of the same
  name never is); with `type`, a non-tags field → 400, and equality / `in` on a tags field → 400.
  It narrows the SQL candidates like any filter; read access is applied afterwards as always, so
  records and `total` (also `countOnly`) hold only what the caller reads, and the company handle
  keeps it inside the company.
- A plugin mapping cannot map a tags field (`plugins.md`).
- Test: `server/tests/unit/record-tags-bundle.test.ts` (bad values refused with nothing written,
  normalization, contains never returns or counts an unreadable record, never another company's,
  never a non-tags field, equality refused), `record-types.test.ts` — mutation-checked.

### Core interfaces (owner decision 2026-11-01 night: 本体は業務の型を名指ししない)

The core never names a business plugin's type. Two interfaces stand for the things every company
has, and core types link to them instead of to `deal` / `customer`:

- **`bundle`** (まとまり — 案件・企画・取り組み): `owner` (person), `purpose` (text), and final
  states (whether it is finished).
- **`counterpart`** (相手 — 顧客・ゲスト・受講企業・応募者): the record's title is its display name;
  `counterpart_kind` (choice offering at least `company` and `person`), `domain`, `email` (text;
  the keys later 名寄せ uses — either may be empty).

The set is fixed and small (`INTERFACES`, `shared/core/record-types.ts`): with `request` and
`prepared` (turns, not things) and `outside_event` (when a thing happened outside, "Outside time")
these five are all there is. **No plugin or company type defines an
interface** (no key for it; an unknown name in `implements` or `interface:` is a parser error) and
there is no inheritance — an interface is only a promise of a few required fields, which the
parser checks (`interfaceProblems`) wherever a definition is read: core, a plugin package on the
shelf (`validatePluginPackage`), a company's `.acb/types/` file (the index reports it and keeps the
last valid version).

Core links (versions of 2026-11-01 night): task v6 `bundle`, `counterpart` (only for a task with
no まとまり — it reaches its customer through its bundle; the `customer` link is gone); interaction
v3 `bundle`, `counterpart` (its text field is `counterpart_text`); meeting v1 `bundle`,
`counterpart`; approval v4 `bundle` (the record when it is a まとまり), `meeting`; outbound_message
v3 `bundle`, `meeting`; decision v3 `bundle`, `meeting`, `approval`. Where-it-came-from is a
`meeting` link (the one origin there is today) rather than a generic origin link: a link targets
one type or one interface, and an origin interface would be a fifth one; stage 3's mail / Slack
intake adds an `interaction` link the same way (additive).

The business plugin 「法人営業」 (`acb-plugin-corporate-sales`, corporate-sales 0.3.0) implements them: `deal` v3
`implements: [bundle]` (adds `owner`, `purpose`; final won / lost), `customer` v3
`implements: [counterpart]` (adds `counterpart_kind`, `email`; `domain` as before). Until a company
moves to it, its deals are not まとまり (minutes candidates, approval / decision `bundle` links
leave them out).

**Migration** (staging only — production had no record data): at startup, every company,
idempotently (`migrateCoreInterfaceLinks` in `db/index.ts` → `adapters/sqlite/records.ts`
`migrateCompanyCoreInterfaceLinks`): `minutes` records become `meeting` (ids kept), the core link
rows are renamed (`customer` → `counterpart`, `deal` / `about` → `bundle`, `minutes` → `meeting`),
an interaction's `counterpart` field becomes `counterpart_text`, the stored core `minutes`
definitions are dropped. The ledger is not rewritten (an old `links.deal` entry is history; undoing
it answers `CHANGED_SINCE`). This is the one breaking reshape of core types so far (removed
links); an older server build does not understand a migrated database.

Tests: `server/tests/unit/core-types-interfaces.test.ts` (no core link targets a business type;
the interface set is fixed; a plugin package or company file claiming an interface without its
fields is refused; `bundle` takes a 案件 and a 企画 but not a 相手 or a memo, `counterpart` a 顧客
and a guest but not a まとまり; unreadable / another company's / missing get one answer; the
migration, once, per company), `record-types.test.ts` (each interface's fields, choice options,
final states; no interface of one's own), `record-service-types.test.ts` (a decision's `bundle`
takes any まとまり) — mutation-checked.

### Bundle kinds (束ねる種類, owner decision 2026-11-02)

What a department makes as its 束ねるもの is decided **without a setting** (`services/bundle-kinds.ts`,
`GET /records/bundle-kinds`, any member, contract `BundleKindsResult`):

- A department where an **enabled business plugin's** type implementing `bundle` lives (案件
  `deal`, 番組…) makes that kind. "Lives" = the plugin's current mapping places that type's
  records at or under the department folder (`visible_to_folder` of an object whose `record_type`
  it is — read from the mapping's text, the connector's package is not needed), or live records
  of that type are there already. Two business kinds in one department: the one with more
  signals, then the type name. There is **no "use both" setting** (owner: no more admin screens;
  a company needing both is the plugin's question then).
- Every other department makes the core's ordinary kind, core type **`project`** (version 1,
  implements `bundle`: `owner`, `purpose`, `due`; links `counterpart`, `files`; active → done /
  cancelled and back, by the owner, an admin or the department's manager; anyone may create one),
  `CORE_BUNDLE_TYPE`.
- Names: a business kind keeps its type's label; the core kind is called by the company's
  `TaskSettings.bundleName` (`tasks.md`; default 「プロジェクト」, one per company — not per
  department). Screens never say 「まとまり」 (the code's word, `bundle`).
- The answer: `core` (the core kind under the company's name), `departments` (each department's
  id, folder and kind) and `kinds` (every kind in use, for places where kinds mix — the company-wide
  list 「案件・プロジェクトごと」, searching across departments). A turned-off plugin, another
  company's plugin and records decide nothing.
- Test: `server/tests/unit/bundle-kinds.test.ts` (no business kind → the core's under the
  company's name; mapping placement and records each decide; off and other companies decide
  nothing; records off → `RECORDS_DISABLED`; the name's checks and default) — mutation-checked.
  Permission matrix row.

### Outside time (owner decision 2026-11-01 「流れを測れる記録」)

Something that happened outside ACB (a mail or call received, a meeting) has two times: when it
happened there and when ACB learned of it. One field holds the first for every such type: the
interface **`outside_event`** (外で起きたこと) requires `occurred_at` (datetime, server). When ACB
learned of it is the record's `create` entry's `at` (always there). Core: `interaction` version 4
(implements it; `occurred_at` was there from version 1), `meeting` version 2 (adds `occurred_at`;
`meeting_at` stays, the intake writes both — `services/minutes.ts`, which also stores the core
types before writing, so a company not indexed since the update gets version 2 first). A business
plugin's or a company's type of incoming things may claim it (the parser checks the field); the
corporate-sales types (deal, customer) are not outside events and are unchanged.
`outbound_message` is not one (ACB made it; `sent_at` stays) — the mail's `interaction` receipt
carries `occurred_at` = the send time.

**Migration** (additive, no breaking change: both versions only add over the old ones): at startup
(`db/index.ts` `migrateOutsideTimes` → `adapters/sqlite/records.ts` `migrateCompanyOutsideTimes`),
every meeting with `meeting_at` and no `occurred_at` gets it as a **ledger entry** (action
`carry_outside_time` = `OUTSIDE_TIME_ACTION`, actor `MIGRATION_ACTOR` `acb:migration` — cause
`system`; compare-and-set on the version; the index row's `type_version` becomes 2), so the ledger
still replays to the stored values. Idempotent, per company. The app's 経緯 shows it as
「外で起きた日時を共通の欄に写しました」.

Tests: `server/tests/unit/record-outside-time.test.ts` (which core types claim it; a type claiming it
without the field refused; the new versions additive; the carry-over once, per company, as an entry
that replays, leaving others alone), `server/tests/integration/minutes.test.ts` (the intake writes
`occurred_at`, apart from the create time), `core-types-interfaces.test.ts` (the set) —
mutation-checked.

### Links to an interface (stage 2 S1, owner decision 2026-11-01: 取り組みを最初から)

A link may target an interface instead of one type: `links: { bundle: { label: まとまり,
interface: bundle, cardinality: one } }` — any record whose type implements it (a core 取り組み
— S9 —, a business plugin's 案件 or 企画). `LinkDef` keeps `target: <interface name>` plus
`targetIsInterface: true` (absent on every other link, so stored definitions compare equal).

- Parser: `interface` and `target` exclude each other; an interface not in `INTERFACES` is an
  error (a type target stays a label that may name an undefined type). Switching a link between a
  type and an interface is breaking, even for the same name.
- Engine (unlike type targets, which are labels): an interface link holds only live records of
  this company whose type implements it. The generic create also requires the creator to read the
  target; a record of another type, an unreadable one, another company's and a missing id all get
  the same 400 `BAD_LINK` (nothing about the target leaks). The service writer (create /
  transition) refuses (`bad-value`); the external writer drops such a target. A company's own
  record file's links are stored as its text says, as every file link (the read side filters).
- `POST /records/query { implements: bundle }` finds every bundle, whatever its type.
- Test: `server/tests/unit/record-tags-bundle.test.ts` "a link to an interface",
  `record-types.test.ts` (unknown interface refused, `bundle` needs its fields, breaking
  changes) — mutation-checked.

### Task version 5 (stage 2 S2, owner decisions 2026-11-01 §11-12/16/19/35/37)

Additive over version 4 (tasks indexed under 4 keep their `typeVersion` and run every action;
`server/tests/helpers/task-v4.ts` keeps the version 4 text). Adds:

- Fields `tags` (kind `tags`, "Tags"), `wait_until` (kind `date`, day or day + time: when a reply
  or delivery is expected — what 追いかけ looks at: the server clock moves a `waiting` task whose
  `wait_until` passed to the AI's or the assignee's turn, `notifications.md` "The server
  clock"), `prep_summary` (long text: what the AI
  checked and made). Links `bundle` (`interface: bundle`, one) and `prepared` (`interface:
  prepared`, many: the mail drafts / approval requests the AI made — 「AI が用意したもの」).
  Actions `set_tags`, `set_wait_until`, `set_bundle` (requester / assignee / AI; an action
  arg is required, so a value is cleared with `[]` for tags only).
- **Preparing, the AI's turn** (§11-35): state `preparing`; `create_states: [preparing]` lets a
  create (`POST /records/item { state: 'preparing' }`, the AI's `records_create`) start there —
  any other state → 400 `BAD_STATE`. `finish_prep` (`who: [ai]`, arg `prep_summary`, links
  `prepared`, `hand_to` / `notify` the assignee) moves it to `todo`. A record created in an
  AI-turn state tells nobody, and 「あなたの番」 leaves out every AI-turn state
  (`aiTurnStates`, `shared/core/record-types.ts`: a state some `who: [ai]` action starts from —
  the same rule as 「AI の番」), so the person sees it when it is ready. **Preparing never hides
  the work** (owner, 2026-11-01): `hand_over` (`who: [ai]` — the AI, also the AI-turn runner of
  S10 —, note required: due soon, the preparation failed, information missing; links `prepared`
  for whatever is ready) hands it to the assignee early; `take_over` (`who: [assignee,
  requested_by]`, never the AI) lets a person take it from the AI at any time; both go to `todo`
  as the assignee's turn and tell them. `cancel` also starts from `preparing` (the requester
  stops it).
- **受けられない** (`decline`): from todo / in_progress / waiting, `who: [assignee]` only (never
  the AI, never the requester), note required, `hand_to` and `notify` the requester → state
  `declined`, **not final**: the requester's turn, who `assign`s someone else, `cancel`s or
  `reopen`s it (back to the same assignee). The AI never completes or declines.
- **Action links** (generic syntax `links: [<record link>]` on an action; never a file link —
  those are "Linking files later"): body `links: { <name>: id | [ids] | null }`, a link left out
  stays. Each target must be a live record of this company that the actor reads, of the link's
  type or implementing its interface; another type, an unreadable record, another company's and
  a missing id get one answer, 400 `BAD_LINK`. An action with no `to` and no args needs a link
  (400 `LINKS_REQUIRED`). Ledger change `links.<name>` (ids comma-joined, before / after),
  undone like every link change.
- `TypeDefinition.createStates` and `ActionDef.links` are absent when empty, so stored
  definitions of other types compare equal.
- Tests: `server/tests/unit/record-task-v5.test.ts` (the AI cannot complete or decline, the
  requester cannot decline; decline needs a note and tells only the requester; preparing tells
  nobody and stays out of 「あなたの番」, `prepared` refuses alike; `hand_over` needs a reason and
  `take_over` is a person's, never the AI's; the query's additions never
  return or count an unreadable record; a version 4 task keeps working — mutation-checked).

### Acceptance (引き受け, task version 7, owner decision 2026-11-01)

「頼んだ」 and 「引き受けた」 are told apart. Version 7 adds state `awaiting_acceptance`
(引き受け待ち), field `accepted_by` (person: who accepted), link `meeting` (もとの会議: the meeting a
task is homework of) and action `accept` (引き受ける: from `awaiting_acceptance` to `todo`, `who:
[assignee]` — never the AI, never the requester —, `hand_to` the assignee, `notify` the requester);
`decline`, `assign` and `cancel` also start from `awaiting_acceptance`. Additive: tasks indexed
under version 6 keep it and never wait (`since: 7`).

- **The rule** (`ACCEPTANCE` in `shared/core/core-types.ts`, applied by
  `services/record-engine/acceptance.ts` in the generic create and in every action — the service
  and external writers never touch it): when a create or an action would leave the task in a
  working state (todo / in_progress / review / waiting) or in 引き受け待ち with an assignee other
  than `accepted_by`, then (1) an owner-only task, (2) a **person** acting as the assignee —
  themselves, or their delegate during the absence (`onBehalfOf`, the one `actsFor` point:
  "Absence and the delegate") — or (3) the asker being the assignee accepts it at once
  (`accepted_by` = the assignee); else (4) the company's setting decides
  (`deps.autoAccepts` → `services/task-acceptance.ts`, `tasks.md` "Acceptance"): accepted, or the
  state becomes `awaiting_acceptance` with `next_actor` = the assignee (their 「あなたの番」). The
  asker is the actor when the action changed the assignee (create: the creator — a
  `requested_by` in the body never makes it the assignee's own), else `requested_by`. The AI
  acting for the assignee (their own AI's `finish_prep`) is **not** accepting. Entering
  `declined` forgets `accepted_by` (a `reopen` asks again); an `assign` from `declined` asks the
  new assignee like a new request (to `todo` or 引き受け待ち — before version 7 it stayed `declined`).
- `accepted_by` is the engine's: a create naming it → 400 `BAD_VALUE`; no action has it as an
  argument. Undo reverses it with the state like any field.
- Homework: the AI's minutes instructions (`client/electron/records/tools.ts`,
  `client/shared/minutes-app.ts`) put the meeting in `links.meeting`; the setting's homework case
  reads that meeting's `attendees`.
- The requester hears `request_accepted`; still waiting a business day later →
  `acceptance_waiting` (`notifications.md`). Screens: state label 「引き受け待ち」
  (`client/shared/record-views.ts`); the requester's line 「〇〇さんに頼んだ・引き受け待ち」 is the task list's
  (`tasks-ui.md`).
- Test: `server/tests/unit/record-task-acceptance.test.ts` (only the assignee — or their delegate
  only during the absence — accepts, never the requester or any AI; the AI's hand-over is not an
  acceptance; each automatic case follows its setting and is off when it is off; reassigning asks
  by the reassigner's departments; `accepted_by` on create refused; own and owner-only tasks never
  wait; another company's departments, settings and ids decide nothing; the business-day
  reminder once — mutation-checked; the owner-only branch is also covered by "the asker is the
  assignee", so removing it alone changes nothing).

### Reading (`services/records.ts`, `services/record-access.ts`; contract `shared/types/records.ts`)

```
GET|PUT /records/settings          owner/admin
GET     /records/problems          owner/admin (paths may be private: owners/admins read all)
POST    /records/reindex           owner/admin, { full: true }
GET     /records/types             any member: definitions in force + stored versions
POST    /records/item/:recordId/file-links (+ /remove)   link a file later ("Linking files later")
POST    /records/item/:recordId/record-links (+ /remove) link a record later ("Linking records later")
POST    /records/item/:recordId/share          the owner shows an owner-only record to a folder (session only)
POST    /records/item/:recordId/opened         the app opened it: the turn-holder's first opening kept ("Whose turn it was")
POST    /records/query             any member: { type?, implements?, state?, fields? (value | { in } | { contains } | { gte?, lt? }), linkedTo?: { id, hops: 1|2 },
                                   link?: { name, id }, linkedToFile?, sort?: { field, order? }, finishedSince?,
                                   text?, limit ≤ 200, offset ≤ 10000, countOnly? } → { total, records }
GET     /records/item/:recordId    any member: the record + its readable links (both directions)
```

- **No leaks** (0.13-1, 4-2): a record is readable exactly when its file is (`resolveAccess`
  read; inside a private folder also `canReadPrivateScope`), a server-only record when its
  folder is (none = everyone) — and an owner-only record by its owner alone ("Owner-only
  records" below). Answers, `total`, link lists and traversals all apply it, so an
  unreadable private record is identical to a nonexistent one (same 404 body). `total` counts up
  to `MAX_CANDIDATES` (20,000) rows.
- Records imported through an earlier connection of an outside system are marked
  (`fromOldConnection`, `notice`) and left out of the query unless `includeOldConnection: true`
  and out of 「あなたの番」 (`plugins.md` "Connections").
- Fixed shape only — no free SQL (0.23-1): type or interface, states, server-field equality (`{
  in: [...] }`), a tag (`{ contains }`, "Tags"), links up to 2 hops (traversal passes only through readable records), substring of
  title / summary. With `type`, field names must be server fields of it.
- Stage 2 S2 additions: a **range** `{ gte?, lt? }` (gte ≤ value < lt, compared as stored — a
  day sorts before its own times, so `{ due: { lt: '2026-11-06' } }` is "due by the end of
  11/5" with or without a time) and **`sort: { field, order? }`** (empty values last, then most
  recently changed) on date / datetime / number server fields only (only types where that field
  has such a kind are searched; with `type`, another kind → 400); **`finishedSince`** (now in a
  final state of its type, entered — a ledger entry into it from another state — at or after the
  time: 「今日終わったこと」); **`link: { name, id }`** (outgoing link `name` holds `id`: a
  bundle's tasks) — `id` must be a record the member reads (else the same 404 as a missing one,
  like `linkedTo`) and a link that may not be followed (public → private) never matches. All of
  them narrow the SQL candidates; read access is applied afterwards as always, so records and
  `total` (also `countOnly`) hold only what the caller reads.
- `linkedToFile` (a company path, `fileLinkPath`-checked; not with `linkedTo`): records with a file
  link to exactly that path — 「つながっているもの」 of a file. A file the caller cannot read answers
  `{ total: 0, records: [] }`, the same as a file nothing links to; a record outside a private
  folder never counts for a path inside it (`linkAllowed`: the link is stored but never shown),
  one inside shows to that folder's readers only. Test: `tests/unit/record-linked-to-file.test.ts`
  (each guard mutation-checked).
- Cross-company: the handle is `member.companyId`; another company's record id is a record that
  does not exist (permission matrix `CROSS` row, `tests/unit/record-index.test.ts`).
- The detail route is `/records/item/:recordId`, not `/records/:recordId`: a parameter next to the
  static `/records/settings` etc. made Hono fall back from RegExpRouter to TrieRouter, under which
  `/api/auth/**` stopped matching (the permission matrix's auth rows caught it).

### Owner-only records (「持ち主だけ」, owner decision 2026-11-01)

Who sees a record: **an owner** in `records.personal_owner` → that member only; **a folder** mark
→ the readers of that folder; **neither** (every record made before) → the whole company,
unchanged. Column added by `migrateRecordPersonalOwner` (nullable, no data migration).

- **Not owners or admins either** — the one exception to "owner/admin see everything" (CLAUDE.md
  Roles); not department managers, delegates or anyone moving tasks. One branch at the top of
  `recordReader.record` (`services/record-access.ts`), so every caller applies it: answers,
  `total`, link lists and `linkedTo` traversals, 「あなたの番」/「AI の番」, the AI's tools,
  actions, undo / reopen (an admin's included), history, versions, file links, and the services
  that read through the reader (approvals, minutes, decisions, mail, plugins). For anyone else it
  is a record that does not exist (the same 404 body).
- **Create** (`POST /records/item`, the AI's `records_create`): `personal: true` → owner = the
  creator (person or their AI). Refused with `folder` (400 `PERSONAL_WITH_FOLDER`), for a business
  plugin's type — any type with a stored `plugin` version (deal, customer: other records take
  their readers from them; 400 `PERSONAL_NOT_FOR_TYPE`); an assignee other than the creator
  cannot read it (400 `ASSIGNEE_CANNOT_READ`). The summary carries `personal: true` (only the
  owner ever sees it). Service-written records are never owner-only.
- **Links**: a record link on the generic create must name a live record the creator reads, else
  400 `LINK_TARGET_NOT_FOUND` — the same answer for a missing id, someone's owner-only record and
  an unreadable private one (this check is new with owner-only records; before, any id was stored).
  An interface link (`bundle`) is answered by its own check instead (400 `BAD_LINK`, one answer for
  missing / unreadable — owner-only included — / of another kind), so no link has two refusals
  that would tell an unseen record from a missing one.
  Links from an owner-only record to a shared one are shown to the owner only (the other side's
  readers never see the owner-only end).
- **Share** 「部署に出す／案件につなぐ」: `POST /records/item/:recordId/share { folder,
  expectedVersion, note? }` (contract `ShareRecordRequest`), **session only** (no AI route). Only
  the owner (nobody else finds it); `folder` as on create (a company path the owner reads, not in a
  private folder; for a deal, the deal's folder), required (400 `FOLDER_REQUIRED`). Clears
  `personal_owner`, sets `folder` (`RecordRepository.setPlace`); ledger action `share`, state
  unchanged, changes `place.personal_owner` / `place.folder` before / after, version + 1
  (`VERSION_CONFLICT`). Already shared → 409 `NOT_PERSONAL`. **Never undone** (`NOT_UNDOABLE`:
  the folder's readers may have seen it); `place.*` changes never land in the server fields.
- Tests: `server/tests/unit/record-personal.test.ts` (another member, a manager, an admin and the
  company owner get a missing record's answers on every route; query / count / text / my-turn
  exclude it; links to it refused alike and links from it hidden; `set_bundle` into an owner-only
  bundle and `link:` / `finishedSince` / `sort` queries for anyone else; cross-company; existing rows
  unchanged and the column migration; share only by the owner, its ledger entry, never undone —
  mutation-checked), permission matrix rows + `CROSS`.

### Who can see it (見られる人, plan「新しい画面のデモ」K サーバー乙 ②, owner decision 2026-11-02)

- `POST /api/companies/:id/viewers { records?: string[], files?: string[] }` (any member, ≤ 200
  of each, 400 beyond) → `ViewersAnswer` (`shared/types/viewers.ts`): per record id and per company
  path a `ViewersLabel { kind, text, count }`. The phrase is `shared/core/viewers.ts`
  `viewersLabel`, first that fits: 「あなただけ」 (owner-only, or nobody else reads it) →
  「あなたと〇〇さん」 → 「会社のみんな」 → 「『<private folder path>』を見られる人（N人）」 →
  「〇〇部のみんな」 (exactly the people who belong to the department holding it, owners / admins
  aside) → 「N人が見られます」. `count` includes owners and admins. Never 「公開」「権限」「スコープ」.
- Who reads = `recordReader` evaluated for every member (`services/viewers.ts`), once per set of
  folders above the item (a list costs a few evaluations, not one per row).
- **No leaks** (owner decision B; asked and confirmed 2026-11-02: the name is shown only on the
  readers' screens): a record the caller cannot read is **left out** of `records` (an owner-only
  record too — owners and admins included); files are judged over the folders the caller can
  see — an unreadable private folder (and every rule inside it) is treated as not there, so a
  path inside it is answered exactly like a path that does not exist (asking cannot tell it is
  private or name it). Test: `server/tests/unit/viewers.test.ts` (mutation-checked: dropping the
  record check or the unreadable-folder filter fails it).
- App: IPC `viewers:get(companyId, { records?, files? })` → `ViewersResult`
  (`client/electron/features/viewers/ipc.ts`, `client/shared/viewers.ts`;
  `client/tests/viewers-ipc.test.ts`).

## Core types (4-5, `shared/core/core-types.ts`)

`task` (タスク: implements `request`; storage `server` — version 5 adds preparing / decline /
tags / wait_until / bundle / prepared ("Task version 5"); version 2 (2026-11-01; version 1 was
`either`, a file adopted once it had content, 0.6-1), version 3 (2026-11-01: `set_due` notifies
the requester; the due may carry a time, above), version 4 (2026-11-01: the assignee completes on
someone's OK, above; fields `ok_by`, `ok_note`), `purpose` a server field; the content
people write is an ordinary file linked through `files`; states todo / in_progress / review /
waiting / done / cancelled, final done / cancelled; actions start, request_review (attach files,
notify the reviewer, hand to them), send_back (note required, decision), assign (note required,
undoable approval tier, decision), wait, set_due, complete (requested_by / reviewer, or the assignee
stating whose OK it was — never AI; attach, decision, notifies the requester and the OK-giver),
cancel (note required, decision), reopen (requested_by / ok_by / admin)) and
`interaction` (やりとり: server only, no body — summary, channel, `counterpart_text`, pointer to the
original; version 3 links `bundle` and `counterpart`, "Core interfaces"; version 4 implements
`outside_event`, "Outside time"; outbound mail records one per sent mail, `outbound-mail.md`). Task version 6
drops the `customer` link and adds `counterpart`; version 7 adds acceptance (引き受け待ち, "Acceptance"). Stored per company with source `core` by every index run
(`ensureCoreTypes`) unless a version at least as new is there; a company extends one with its
own `.acb/types/task.md` (higher version, additive only; a company file still saying `storage:
either` is now a breaking change against the core version 2 and is reported, the core definition
staying in force — unless that file's version is already ≥ 2, in which case it stays in force:
`ensureCoreTypes` only adds a core version above every stored one). Definitions may also say `final`
(states where nobody's turn is waiting) and, per action, `hand_to` (the person field or argument
copied into `next_actor`; only for types implementing `request`).

Milestone 4 adds four (people by id in person fields):

- `meeting` (会議, server; was `minutes`): internal and external meetings — `meeting_at` (and, version
  2, `occurred_at` — the same time, the common outside time: "Outside time"), `assignee`
  (organizer or first discoverer), `attendees` (text: JSON array of member ids — no person-list
  kind exists), `external_count`, `source_ref` (opaque pointer to its minutes documents, no text),
  `doc_version`, `summary_text` (long_text; ≤ 300 is the intake's rule); links `bundle`,
  `counterpart`. The 議事録 is its content, read where it is. Version 4 drops version 3's
  bundle_waiting / bundle_working (a まとまり chosen after the reading is only linked; meetings left
  there go back to read at startup, `minutes.md` "A まとまり chosen later"). received → reading → read / skipped / failed:
  `start_reading`, `finish_reading` (arg `summary_text`), `fail_reading` are `who: [ai]` —
  received is the example of 「AI の番」 (no separate reader AI: the consultation AI reads, owner
  §11); `retry` (reading / failed → received, also for "reading > 30 min") and `skip` are
  assignee / admin.
- `approval` (承認のお願い, server, implements `request` → the approver's 「あなたの番」):
  `approver_rule` [self, dept_manager, admin], `operation`, `payload_hash`, `payload_version`,
  `reason`, `result_operation_id`; links `bundle` (version 4: the record when it is a まとまり),
  `meeting`. pending → approved /
  sent_back / stale / withdrawn / failed; sent_back → withdrawn (version 2: `sent_back` is not
  final, so a sent-back request is the requester's turn again; version 3 implements `prepared`). **No actions.** Its service:
  `approvals.md`.
- `outbound_message` (送るもの, server; version 3): `requested_by` / `assignee` (the author), `subject`,
  `payload_hash`, `payload_version`, `sent_at`, `provider_message_id`, `channel` [email, slack —
  one type for every channel; Slack is not sent yet]; links `bundle`, `meeting`. draft → sent /
  unknown / discarded; unknown → sent or back to draft
  (送られていた／送られていなかった). **No actions.** Version 2 implements `prepared` (a task links
  the drafts its AI made).
- `decision` (決めたこと, server — version 5 marks `meeting` / `approval` as origin links; version 1 was a file, "Decisions" below):
  `recorded_by` [ai, human], `important`, `exception` (例外（この件だけ）, version 4), `decided_by` (null when the AI recorded it), `owner`
  (the linked meeting's assignee at creation, else the member — `who` cannot name "the meeting's
  assignee"), `source_key`, `why` (long_text), `source`; links `bundle`,
  `meeting`, `approval`. unconfirmed → confirmed / retracted: `confirm` (note optional), `retract`
  (note required), both `who: [owner, dept_manager, admin]`, decisions; `set_exception` (args
  `exception: boolean`, no state change, same `who` — never the AI).

A link's `target` (a type) is a label, not a check: the parser and the engine accept a link to a
type that is not defined (a company's own types). Core types link only to core types, files and
interfaces ("Core interfaces").

### Service-owned types (`SERVICE_OWNED_TYPES`, `shared/core/core-types.ts`)

`meeting`, `approval`, `outbound_message`, `decision` are made only by the server's own services:
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

### Service writer (`createServiceRecordWriter`, `services/record-engine/service-writer.ts`)

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
do it (the approver approving) is the calling service's rule. A type that is **not**
service-owned (`task`) changes only along its `SERVICE_TRANSITIONS` rows, state changes only (a
field-only change → `not-service-owned`): the server clock's 「見込みの日時が過ぎた」 moves (waiting →
preparing / todo, ledger action `wait_over`, actor `CLOCK_ACTOR` = kind `external`, id
`acb:clock`; `notifications.md` "The server clock").

## The state engine (4-3, `services/record-engine.ts`)

`services/record-engine.ts` is the one entry point (callers import only it); the parts are in
`services/record-engine/`: `types.ts` (deps, actor, `RecordChange`), `values.ts` (values by kind,
OK statements, materials, provenance), `refusals.ts`, `links.ts` (interface links, `links.<name>`
ledger values), `context.ts` (what the member-facing operations share), one module per operation
(`create.ts`, `act.ts`, `undo.ts`, `file-links.ts`, `share.ts`, `history.ts`), and the two writers
no route reaches (`external-writer.ts`, `service-writer.ts`).

Exactly five duties (ontology §17.7): (1) the action's `from` states, (2) its `who`, (3) state and
ledger written in one transaction, (4) tell whom it names, (5) a milestone line. Nothing else:
arguments are copied into the server fields of the same name, `hand_to` copies one person into
`next_actor`; no expressions, cascades, timers or outside sends (time-based moves are the server
clock's, a separate service writing through the service writer: `notifications.md`).

- **Who**: a person field of the record whose value is the member, `admin` (owner/admin role),
  `dept_manager` (manages the department holding the record's path or folder), `anyone`. Roles do
  not bypass `who`. The member's **AI** may act only where `who` lists `ai`, and then only for a
  member who qualifies on their own (or any member when `who` is `[ai]` alone) — so the AI cannot
  complete a task. `ok_from` widens `who` for a person who states whose OK it was (above), never
  for the AI. Whether it is the AI is decided by the credential (next section), never by the
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
  authorizes on them (`selfReportedProvenance`, `services/record-engine/values.ts`). Shown in the history
  and in `GET …/versions/:version` (`origin`: the entry that made that version). The command
  `records.runAction` carries both for the confirm screen of milestone 5. Test:
  `server/tests/integration/record-tokens.test.ts` "provenance in the ledger".
- **Undo** (`POST …/undo { version, expectedVersion }`): a new `undo` entry with the reversed
  changes (`reversesVersion`); refused when a later entry changed the same values
  (`CHANGED_SINCE`), for `create` / `undo` entries and a `share` (`place.*` changes), and for anyone but the entry's actor or an
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
  event itself (0.18-1, SSE rule). The app's listeners: received minutes (main asks the server
  again for the member's received minutes, `minutes.md` "The app") and the title bar's 「あなたの番」
  (`notifications.md`). `notify` also carries the ledger entry (`RecordChange`), from which the
  notices (知らせ) are written — never the actor, kind + record + version only
  (`notifications.md`).
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

## Execution runs (stage 2 S10b, owner decision 2026-11-01)

Conversations stay on the PC; **the execution state of 「AI の番」 lives on the server**, which only
stores and checks (the AI never runs on the server). One **run** per record × AI step
(`ai_runs`, behind the company handle `aiRuns`; rules `services/ai-runs.ts`, words and classes
`shared/core/ai-runs.ts`, contract `shared/types/ai-runs.ts`). The app's side: `ai-turns.md`.

```
GET  /ai-runs                                    the member's open runs (session)
POST /ai-run-claims                              { recordId, step, deviceId, conversationId, pluginVersion?, stepsVersion? }
GET  /ai-runs/:runId
POST /ai-runs/:runId/renew                       { generation }
POST /ai-runs/:runId/finish                      { generation, outcome: done | failed, failure?: { class, code? } }
POST /ai-runs/:runId/retry                       「もう一度」
POST /ai-runs/:runId/operations/:key/reconcile   { done }
```

- **Claim**: only a record in the member's 「AI の番」 (`records.aiTurnOf`: readable, an AI-turn
  state, the member its assignee / next actor; else 404 / 409 `NOT_AI_TURN`). At most one open
  run per record and step (unique index); a live claim of another app instance → 409
  `RUN_CLAIMED`. A claim lasts `AI_RUN_CLAIM_TTL_MS` (5 min) and is renewed while running.
  Every claim — a new run, or re-claiming one whose claim expired / was given back — raises the
  **generation**. The run keeps the device (app instance), the consultation, the member whose
  authority it runs under, and which procedure the claim runs ("Which procedure", below; the
  older self-reported `pluginVersion` / `stepsVersion` are still accepted and shown, nothing sends
  them).
- **Fencing**: `POST /me/record-tokens { …, run: { id, generation } }` binds the AI's token to
  the run (only the member's own run, claimed now at that generation for that consultation, else
  409 `RUN_SUPERSEDED`). `recordAiTokens.authenticate` refuses every call of a bound token once
  the run's generation moved on or it is no longer running (409 `RUN_SUPERSEDED`): a PC whose
  claim was taken over writes nothing. Renew / finish of an older generation: the same 409.
- **Idempotency key per outside operation**: with a run-bound token, the creates and outside
  operations of `/api/records-ai` (`POST /item`, `/decisions`, a plugin's write or create, `POST
  /outbound`, `PUT /outbound/:id`; a plugin read needs none) require an `Idempotency-Key` header
  (400 `OPERATION_KEY_REQUIRED`). `ai_run_operations` keeps, per run and key, the request's
  fingerprint, state and what it made (`ref`, never a body). The same key again answers `200 {
  replayed: true, operationKey, ref }` without running anything; another request with that key →
  409 `OPERATION_KEY_REUSED`; one still in flight → 409 `OPERATION_IN_PROGRESS`; a refused
  request (4xx, a plugin write `failed`) frees the key. A consultation's token (no run) is
  unchanged. HubSpot's `acb_operation_id` and outbound mail's states stay underneath. A Google
  Drive put (`POST /google/drive/put`, `google-drive.md`) is keyed too: its `drivePut.state`
  `unknown` counts as unknown, ref kind `drive-put`.
- **「結果が分からない」**: an answer ≥ 500, a thrown handler, a plugin write `sent-unknown`, or an
  operation still in flight when another PC re-claims → `unknown`. While any is unknown the run
  cannot be resumed: a re-claim moves it to `waiting_reconcile` (409 `RUN_NEEDS_RECONCILE`), a
  finish — even `done` — goes there, 「もう一度」 is refused, and the key answers 409
  `OPERATION_RESULT_UNKNOWN`. A person reconciles (`…/reconcile { done }`, after looking in the
  outside system): done → the key answers as done from then on; not done → the key may run
  again; with nothing unknown left the run is `open` again. A late answer settles it too.
- **Failures go to their own place** (`failureDestination`): temporary → `retry_later` (5, 10,
  20 … ≤ 60 min; after `AI_RUN_TEMPORARY_LIMIT` (3) in a row → `waiting_person`, code
  `REPEATED_TEMPORARY`); permission → `waiting_setup`; bad input → `waiting_person`; unknown
  result → `waiting_reconcile`. None goes back to 「AI の番」 by itself except temporary after its
  wait: the others wait for a person's 「もう一度」 (`retry`). A failure carries a short code
  (`FAILURE_CODE_RE`), never free text (a reason could name a customer). `classifyFailure` maps
  an HTTP answer to a class for the app.
- **Who caused a change**: ledger column `run_id` (also `plugin_operations.run_id`; the actor's
  `runId` comes from the token, never a body). `ledgerCause` (`shared/core/record-ledger.ts`):
  `person` (a session), `ai` (the member's AI in a consultation), `run` (an automated run under
  the member's authority), `system` (`acb:` actors: the server clock), `outside` (seen in an
  outside system). The history answers each entry's `cause` and `runId`. Putting a stuck step
  back is never the member's: a run finished as failed lets its step put the record back
  (`afterFailedRun`; minutes reading → `minutes.putBackAfterRun`, actor the member's AI with the
  run's id → `run`), and the 30-minute rule runs in `POST /me/minutes/check` as the server clock
  (`system`) (`minutes.md`).
- **Which procedure** (owner decision 2026-11-01 「流れを測れる記録」): each claim stores
  `ai_runs.procedure` (`AiRunProcedure`, `shared/core/ai-runs.ts`): `step`; `app` = the claiming
  request's `X-ACB-Client-Version` (version + commit + date, kept only when
  `parseClientVersion` reads it — the step's tools and first message are that build's code); and
  `plugins` = every plugin install turned on for the company at the claim, `{ id, version }`,
  **read by the server** (`plugins.installs()`), never taken from the app. Every ledger entry
  written with a run-bound token **copies** it (`record_ledger.procedure`, filled by the records
  adapter's `appendLedger` from the run in the same statement), so a later re-claim under a newer
  app or plugin never changes what an earlier entry says. The history answers `procedure` on run
  entries only; a person's or a consultation's entries have none (a consultation is the member's
  own conversation). **No company Skill** is recorded: an unattended step loads none
  (`ai-turns.md`, `settingSources: []`) — when a step starts using one, its name and the SKILL.md
  version join the procedure (a consultation's Skills: "Which Skill" below). Additive, nullable columns (`migrateAiRunColumns`).
- A run is its member's: anyone else, another company's id and a missing one get the same 404
  `RUN_NOT_FOUND` (permission matrix rows + `CROSS`).
- Test: `server/tests/integration/ai-runs.test.ts` (two devices → one claim; the older
  generation refused and nothing written after a re-claim; the same key → one effect, no key
  refused, a key never reused; in flight at a re-claim / a lost answer → no resume and no second
  send until reconciled; each failure class's place; the ledger's cause; which procedure each run
  entry used, unchanged by a later re-claim, none on a person's or consultation's entry, a plugin
  turned off or an unreadable app build left out; another member's /
  company's run missing — each guard mutation-checked).

## Which Skill a consultation used (owner decision 2026-11-01: compare work with Skill v1 / v2)

`shared/core/skill-uses.ts` (`SkillUse`, `readSkillUseReport`, `parseSkillUses`).

- **Seen in the app** (`client/shared/agent-events.ts` `skillLoadedBy`): an AI action log event
  of Claude Code's `Skill` tool that ran (`outcome` ok / unfinished; refused or failed calls,
  `plugin:skill` names and calls merely working inside a skill folder do not count).
  `chat-server.ts` `withSkillSightings` wraps the turn's host so every event still reaches
  `onToolEvent` and a loaded Skill also reaches `onSkillUsed` with the consultation (company,
  conversation, company folder, working folder) — not for an unattended step, a chat without a
  company folder or the API-key mode. **Codex: not recorded** — it has no Skill tool (its skills are
  instructions it reads with ordinary commands), so there is no reliable signal.
- **Version** (`client/electron/services/skill-use-reporter.ts`, main): the folder is
  `.claude/skills/<name>/SKILL.md` in the working folder or a parent up to the company folder;
  version = the git tree id of that folder at HEAD (`rev-parse HEAD:<rel>` + `cat-file -t` =
  tree; the same on every PC with the same synced content) and `dirty` = `status
  --no-optional-locks --porcelain` of the folder is not empty (the tree id then names what it
  started from). **Nothing is reported** for a skill inside a private folder (a `.git` on the way:
  its name never leaves the PC, `private-folders.md`), one not in HEAD (only on this PC, e.g.
  kept private by the root `.gitignore`), one found in two places on the way or shadowed by the
  member's own `~/.claude/skills/<name>` (which one ran is unknown), or an invalid name. Sent:
  `{ conversationId, name, tree, dirty }` only — no path, no content; once per version per
  consultation (in memory); failures logged once without names, never in the AI's path.
- **Before the AI writes**: `records/api.ts` `beforeWrite` waits (≤ 5 s) for the consultation's
  reports in flight before every non-GET call with the turn's token (record actions, creates,
  Drive puts), so the copy below sees them.
- **Server**: `POST /api/companies/:id/me/skill-uses` (session, any member, `routes/skill-uses.ts`
  → `services/skill-uses.ts`): 400 on a bad body (a path or a Japanese folder name is not a skill
  name; tree = 40 / 64 hex; dirty boolean). `consultation_skill_uses` (company, member,
  conversation, skill, tree, dirty, `first_used_at` = server time of the first report; a repeat
  changes nothing; ≤ `SKILL_USES_PER_CONSULTATION` (20) per consultation, more → `recorded:
  false`). Informational like provenance: the member reports for their own consultations only,
  nothing authorizes on it, the tree is not checked against the repository (it may not be pushed
  yet).
- **Copied at write time** (`adapters/sqlite/skill-uses.ts` `skillUsesJson`, same statement /
  transaction as the write): an AI ledger entry (`actor_kind = ai`, its token's conversation,
  `record_ledger.skills`) and an AI Drive put receipt (`google_drive_puts.skills`, answered as
  `drivePut.skills`) get the member's consultation's uses as they are then — a Skill used later
  never rewrites an earlier one; a person's entry (even naming the consultation), another
  member's uses under the same conversation id and a run with no reported use get none. The
  history answers `skills` on those entries. Additive, nullable columns (`migrateSkillUseColumns`).
- Tests: `server/tests/integration/skill-uses.test.ts` (refused names, first time kept, limit,
  copy at write time, member-scoped, none on a person's entry), `google-drive.test.ts` (the
  receipt's copy), `client/tests/skill-uses.test.ts` (only a Skill call that ran, the host still
  logs, tree id equal on a clone, dirty, nothing for private / not in HEAD / ambiguous / shadowed /
  plugin, no path sent, once per version, a write waits for a report in flight).

## The content store (中身の箱, owner decision 2026-11-01)

Text that easily holds personal data is kept apart from the append-only ledger so an operator can
erase it without rewriting history. Table `record_contents` (behind the company handle; SQL only in
`adapters/sqlite/record-contents.ts`; rules in `shared/core/record-contents.ts`).

- **What is content**: a record's `title` and `summary`; every `long_text` field (task `purpose` and `prep_summary`,
  decision `why`, minutes `summary_text`, approval `reason`, …); `ok_note` (any type with the OK
  fields); `EXTRA_CONTENT_FIELDS` (decision `source`, outbound_message `subject` — the same words as
  its title); every ledger `note` and `decision.reason` (send-back / decline / cancel / retract
  reasons, OK notes, approval reasons). Short scalars (state, due, people, amounts, choices, tags,
  links, ids) stay in the ledger as before. A field's kind never changes across type versions, so
  every stored version of the type decides.
- **References**: `records.title / summary`, `record_state.fields` and every `record_ledger` row
  hold `acb-content:<id>:sha256:<hex>` instead of the text. The records adapter stores on the way
  in (`upsert`, `writeState` — only when its compare-and-set wins —, `appendLedger`) and resolves
  on the way out (`find`, `byIds`, `states`, `ledger`, …), so services, routes, the AI's tools,
  text search, undo and replay see text exactly as before. A content id is
  sha256(record id, hash)[:32]: one row per distinct text of a record, so storing the same text
  again is a no-op — and **a text once erased stays erased** when the same words come back (an
  import, a re-index).
- **Who reads it** is who reads its record: there is no read of content by id, and the row copies
  no owner / visibility (it cannot drift from the record's). A reference resolves only to content
  of the same record of the same company (a reference copied into another record reads empty);
  the services' read checks (folders, private folders, owner-only records) apply to the record and
  so to its content. A value that is not a reference (a row written before the store) reads as it is.
- **Erased** content reads `消去済み（YYYY-MM-DD）` (`erasedText`) in every answer — detail,
  query, history, `versions/:version` replay (the other values of that version replay as before),
  the AI's tools. A later write carrying that marker stores the marker, never the old text.
- **Never rewritten** (trigger `record_contents_immutable`): no UPDATE of id, record, hash, class,
  times; the text is only cleared once, with `erased_at` / `erased_reason`. Rows go only with the
  company (cascade).
- **Search** (`text` of `POST /records/query`): the content rows of each candidate's title /
  summary (erased ones never match), then the read filter as always — a title is found only among
  records the caller reads.
- **Retention** (`retentionClassOf`): `standard` (until erased) or `incoming_3y` — records of type
  `interaction` (owner decision G-33: 3 years). A copy of such a text of at least 20 characters
  stored for another record of the company (same hash) inherits the original's expiry.
  `services/record-contents.ts` `eraseExpired()` erases what has expired in every company
  (reason `retention`); the server clock runs the eraser's `eraseExpired` per company every 5
  minutes (`notifications.md` "The server clock"); the operator can too (`erase-content.ts
  expired`).
- **Migration**: at startup (`db/index.ts` `migrateRecordContents`; the table in `db/schema/content-store.ts`) every company not yet marked
  (`record_settings.content_store`) gets its older titles, summaries, content fields, notes and
  reasons moved in; values already referencing their own content are skipped, so it is idempotent.
- Outbound mail's body and an approval's payload stay in `fixed_payloads` (approvals.md,
  outbound-mail.md: their own hash, 30-day mail retention); erasing a record also clears them.

### Erasing: the operator's runbook (no delete in the product)

There is no route, screen or AI tool that erases; the operator does it on the server, and the
request (who asked, why, when) is kept in the erasure log **outside the product**.

1. Find the record id and list its contents:
   `node --import tsx src/cli/erase-content.ts list <companyId> <recordId>` (ids, class, dates; no
   text).
2. Erase: `… erase-content.ts record <companyId> <recordId> <reason>` (every content of the record,
   plus the text of its fixed content — an approval's payload, a mail's body), or
   `… content <companyId> <reason> <contentId>…` for single pieces. `reason` is a short word
   (`request`, `ticket-123`; `ERASE_REASON_RE`), never a name.
3. Copy the printed `erased <companyId> <contentId>` lines into the erasure log.
4. **Backups**: a backup (restic) or a company archive taken before the erasure still holds the
   text. After any restore of the database or a company, re-apply every logged erasure since that
   backup: `… content <companyId> restore-reapply <contentId>…` (ids already erased are skipped).
5. Files are not content: a record's linked files, and a company's own `storage: file` record
   files, live in the repository — removing personal data there is a separate step.

Tests: `server/tests/unit/record-contents.test.ts` (no text in `records` / `record_state` /
`record_ledger`; erased reads as erased everywhere with its text gone and replay still working;
another company / a copied reference / the eraser given another company reach nothing; unreadable
records' content and titles stay out of search; retention and its copies; the startup move,
complete and idempotent; the immutability trigger — mutation-checked).

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
  `expectedVersion`, `note` — required where the type says —, the action's arguments, and
  `links` for an action with record links — `task__finish_prep`, `task__set_bundle`);
  `records_create` takes `state` (a `create_states` one) and `records_query` the ranges, `sort`,
  `finishedSince` and `link`. `RECORDS_INSTRUCTIONS` says how to prepare a task (create in
  `preparing`, then `task__finish_prep` with what was checked and the drafts) and that completing
  and declining are the member's. Wired like
  the company-files tools: Claude in-process (in `allowedTools`: the type's `who` and the server
  decide, nothing is asked), Codex as a loopback endpoint; registry `recordsMcp` /
  `recordActions`. The system prompt says records (tasks, decisions…) live only on the server —
  never make a record file; content people write is an ordinary file the record links to — and
  person fields take member ids, while replies to the member call a record by its title and
  distinguishing details (担当, 金額, dates) and show internal ids (record ids, outside ids,
  operation ids) only when asked — the tools keep the ids (`RECORDS_INSTRUCTIONS`).
- **Names next to person ids** (staging FB 9, 2026-11-02): the AI's look-ups (`GET /my-turn`,
  `/ai-turn`, `POST /query`, `GET /item/:id`, `/item/:id/history` on `/api/records-ai`, and the
  inbox's `GET /items/:id`) add `people` (id → display name, first key so the app's output cut
  keeps it) for every string in the answer that is a member id of the **caller's company**
  (`services/people-names.ts`, `withPeople`). Anyone else — another company's account, a removed
  member, an account without a name — gets no entry; no email or other account field is added.
  The ids stay where they were and the tools still take ids; `RECORDS_INSTRUCTIONS` and the
  `records_get` / `records_history` descriptions tell the AI to call people by name and never guess
  a missing one. Test: `server/tests/integration/record-ai-people.test.ts` (membership check
  mutation-checked).
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
- A business plugin's use of its connector becomes tools on the same server (`corporate-sales__update_deal`, named by the business plugin; writes
  only with an `act` token) and an update's outcome a card in the reply: `plugins.md` "The app".
- Not done (TODO): the plugin-SDK and admin-API surfaces of the same definitions (stages 5 / 7);
  pushing an action's attached files before calling it (0.18-1 — the tools send no
  `attachments` yet); the app assigning ids to new record files and repairing duplicates.

## Outside systems (milestone 3, `plugins.md`)

- `createExternalRecordWriter` (`services/record-engine/external-writer.ts`) is the engine's one entry for what a
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
- A business plugin's types (`plugins.md` "Two roles"; written when it is turned on, and by its import for a newer version) are stored with source `plugin` (`record_types.source`; a table made
  before is rebuilt once by `migrateRecordTypeSources`); a company still extends one with its own
  `.acb/types/<name>.md` (higher version, additive).

## The app's views (milestone 5 U8, design §7)

Read only, with the member's session in main (`client/electron/features/record-views/ipc.ts`:
`recordViews:search` / `card` / `forFile`; shapes and wording in `client/shared/record-views.ts`).
Main only reshapes the server's answers — nothing is filtered or added on the app's side.

- **Kinds** people see (`recordKindOf`): まとまり (any type implementing `bundle`: a 案件, a 企画),
  やること (`task`, `approval`), 決めたこと (`decision`), やりとり (`interaction`, `meeting`,
  `outbound_message`), そのほか (search's grouping, to be replaced by kind chips).
- **Words and icons** (言葉の決まり, owner 2026-11-02): one plain name and one icon per kind of
  thing, the same on every screen — `client/shared/thing-words.ts` (`thingName`: やること, 議事録を確認する,
  会議の記録, 来た連絡, 送るメールの下書き / 送る Slack の返事 / 送ったもの, 承認のお願い, 返事のお願い; a bundle or
  a company's type by its own label, never its id; `stateWord` per type; `CALM` for waiting, empty and
  failing; `NEXT_STEP`, `turnWords`, `TURN_ASKS`) and `src/shared/ui/ThingIcon.tsx` (`ThingIcon`,
  `RecordIcon`, `SourceIcon`, `SeenBy`). No 「型」, category word (やりとり, まとまり) or machine name on a
  member's screen (`tests/thing-words.test.ts`). 「確かめる」 is only a task's checker's word: a
  承認のお願い says 承認待ち・承認する・断る (owner 2026-11-02; 「阿部さんの承認待ち」). `typeLabel` / `stateLabel` in the views and the task list
  carry these words; machinery fields (hashes, outside ids,
  pointers, `next_actor`) are not on the card; person fields show the member's name
  (`GET /companies/:id/members`).
- **検索**: `POST /records/query { text, limit: 100 }` next to the file search, grouped by kind,
  `total` as the server counts it (only readable records). Records off for the company: nothing
  shown.
- **The card** (`src/features/records/components/RecordCard.tsx`): kind, state, title, summary,
  fields, 経緯 (the ledger, newest first: who・what・note) and 「つながっているもの」 (records by kind,
  files; a file link marked `broken` says 「つながりが切れています」). Following a link runs
  `record.open` / `file.open` (`commands.md`), so ← → work (`files-and-editor.md` "Places").
  Generic and without actions: a task opens in the task card with actions instead (`tasks-ui.md`).
- **A file's 「つながっているもの」**: `linkedToFile` with the open file's company path.

## 「あなたの番」 (4-4) and 「AI の番」 (milestone 4)

`GET /records/my-turn`: records of every type implementing `request` whose `next_actor` is the
member, or with no `next_actor` and the member as `assignee`, not in a `final` state nor in an
AI-turn state (task `preparing`, "Task version 5"), readable by them. Types are not named: a new request type shows up without changing the list.

`GET /records/ai-turn` (session) and `GET /api/records-ai/ai-turn` (record token, tool
`records_ai_turn`): records whose current state has an action with `who` exactly `[ai]` (from
null = every non-final state), where the member is `assignee` or `next_actor`, readable by them
(design q16: no new type syntax). Takes no object id (no `CROSS` row).

Both lists also hold what waits for a member the caller covers today ("Absence and the
delegate", below), marked `actingFor: <absentee>`, read with the caller's own reader.

## Absence and the delegate (代わりの人, stage 2 S4, owner decision 2026-11-01 §9-2 / 棚卸し §3-③)

A member has absence periods (whole days `from`..`until` in company time, `member_absences`
behind the handle `tasks`, `ports/task-settings.ts`), each with **one** delegate. During it the
absentee's turn, the approvals they may approve and their notices also reach the delegate. **Only
"whose list it appears in" changes**: the delegate acts with their own login and is checked with
their own permissions — what they cannot read stays unreadable (owner-only records of the absentee
included) and stops with 「権限が足りない」, the department manager told. Never the absentee's
mailbox, never their role.

- **One resolution point**: `shared/core/absences.ts` `delegation(periods, day)` → `actsFor(user)`
  / `coverOf(absentee)`, built per company and day by `services/absences.ts` (`actsFor`,
  `coverOf`, `managersOf`). composition.ts injects `actsFor` / `coverOf` into 「あなたの番」 and
  「AI の番」 (`services/records.ts`), the engine's `who` (`record-engine/act.ts`), approvals'
  `qualifies` (`approvals.md`) and the notices (`notifications.md`). Nothing else decides it; the
  AI-turn runner (S10) runs what `ai-turn` gives the delegate's app, and an execution run may be
  claimed by the delegate (`aiTurnOf`, "Execution runs") — their token, their permissions.
- **The engine's `who`**: the member first; failing that, for each absentee they cover, `mayAct`
  as that absentee with role `member` (a value naming them, `dept_manager` of their department —
  never their admin role). The entry keeps `actorId` = the delegate and **`onBehalfOf`** = the
  absentee (`record_ledger.on_behalf_of`, additive) — 「代わりに（本来は X）」. Every read check
  (the record, links, attachments, materials) stays the delegate's. Plugin operations
  (`plugin-operation-checks.ts`) do not take a delegate yet.
- **No chains**: a delegate who is absent too covers nobody (`coverOf` → `stopped`,
  `delegate-absent`), and a period naming a delegate already absent on one of its days is refused
  (409 `DELEGATE_ABSENT`). The stop is told to the managers (notices `delegate_stopped`).
- **API** (`routes/absences.ts`, contract `shared/types/absences.ts`): `GET /absences?userId=`
  (absences not yet ended, `covering` = whom the caller covers today, `today`), `POST /absences`
  `{ userId?, from, until, delegateId }` → 201 `{ absence, delegateCannotRead }`, `DELETE
  /absences/:absenceId`. Who: the member, owners / admins, and managers of a department the member
  **belongs to** (所属, `tasks.md`); anyone else 403. Check order who → body → rules: dates
  (`parseAbsenceInput`: real dates, not ended, ≤ 366 days), delegate not self and a member of this
  company (another company's id = nobody, 400 `DELEGATE_NOT_MEMBER`), no overlap with the member's
  own periods (409 `ABSENCE_OVERLAP`), ≤ 20 open. `delegateCannotRead` counts the absentee's
  waiting items the delegate cannot read — only those the setter may read (no count of the
  unreadable). Removing a member stops their absences and those they cover. **Absences are
  history** ("Whose turn it was"): `DELETE` and a member's removal mark the period
  (`removed_at`, `removed_by`), never delete it; a trigger lets a row change only from standing to
  removed (`migrateMemberAbsenceHistory`).
- **UI**: the app's settings 「不在と代わりの人」 (own absences; `client/src/features/absences/`, IPC
  `absences:get|add|remove` with the session in main); department managers set their members'
  in the admin console (task-list page, 「不在・代わりの人」; `tasks.md`). The approval card shows
  「Aさん（代わりに承認・本来は Bさん）」.

## Whose turn it was (流れを測れる記録, owner decision 2026-11-01)

From stored data alone, per record: when it became whose turn, when that person first opened it,
and (with the ledger's actions) when it finished. Nobody presses 着手 for it.

- **The ledger says whose turn** (`shared/core/record-turns.ts`): `turnHolder` is the rule of
  「あなたの番」 (`next_actor`, else `assignee`; nobody in a final or AI-turn state; types implementing
  `request` only); `turnsOf(def, ledger)` folds the entries into stretches `{ holder, sinceVersion,
  since }` — a new stretch at each entry that changes the holder, so work by the holder (start,
  wait, tags) keeps the turn. Every change of those values is already an engine entry (actions,
  `assign`, the server clock's `wait_over`, the service writer).
- **Absence is not rewritten into it**: an absence changes who acts, not the holder. Rather than
  writing ledger rows for every affected record when an absence starts or ends (a fan-out at day
  boundaries the server clock would have to drive), absence periods are **append-only history**
  (above): `delegationAsOf(periods, day, at)` (`shared/core/absences.ts`) uses the periods known at
  `at` (set at or before it, not removed by then), and `services/absences.ts` `coverAt(companyId,
  userId, at)` answers who covered the holder at any past moment — the same answer after the
  period is taken back. A change of the company's time zone shifts which day a moment falls on
  (not recorded; whole-day periods).
- **The turn-holder's first opening** (`record_turn_opens`, one row per record × turn: `turn_version`
  = the turn's `sinceVersion`, `holder_id`, `opened_by` — the delegate when they covered —,
  `opened_at`; insert-or-ignore, never updated). The app's record card (`recordViews:card`) sends
  `POST /records/item/:recordId/opened` (session only; not awaited, nothing shown) after the card
  loaded; `services/records.ts` `opened` keeps it only when the current turn's holder is the caller
  or an absentee they cover today. Not a view log: one timestamp per turn, later openings and
  anyone else's change nothing. **In no API answer** (the reply is `{}` whether kept or not), read
  only by the operator / a later measurement screen (an owner decision); owner-only records are
  their owner's (the reader's 404 first). Not in the ledger on purpose: an entry would raise the
  record's version (others' `expectedVersion` would conflict) and fill 経緯 with 「開いた」.
- Not yet: the approval card in a consultation does not send `opened` (the record card and the
  task card do); a measurement screen reading these.
- Tests: `server/tests/unit/record-turn-opens.test.ts` (turns from the ledger; kept once per turn
  by the holder only, a new turn its own; the delegate during the absence; final / AI turn keep
  nothing; owner-only, another company's and a missing record the same 404),
  `server/tests/unit/absences.test.ts` "whose turn it was" (a period taken back or a member
  removed still answers the past; rows cannot be rewritten),
  `client/tests/record-views-opened.test.ts` (the card sends it once with the session, not when
  it could not be shown) — mutation-checked.

## Decisions (`services/decisions.ts`, design §3-3)

`POST /records/decisions` (session) and `POST /api/records-ai/decisions` (act token, tool
`decisions_record`): `{ folder, title, why, source, links?: { bundle?, meeting?, approval? },
important?, exception?, key? }` → 201 `{ record, created: true }` (200 `created: false` for a known key, or the
same title of the same meeting: `minutes.md` "Outputs made once"; a key with a meeting link is that meeting's).
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
- Links: readable records of this company of the link's type — `bundle`: of any type implementing
  it (a 案件, a 企画) — else 400 `BAD_LINK`.
- 例外（この件だけ） (owner decision 2026-11-01): `exception: true` marks a judgement that applies
  only to its linked thing (「今回の見積は特別に20%値引きしてよい」) and must never be generalized.
  Set at creation (person or AI) or changed later with `set_exception` by those who may confirm /
  retract (the AI cannot). Every summary of such a decision (`recordSummaries`: get, query, the
  turn lists — what the AI reads) carries `exceptionNotice` (`DECISION_EXCEPTION_NOTICE`,
  `shared/types/records.ts`), and `RECORDS_INSTRUCTIONS` / the tool description tell the AI never
  to apply it as a precedent to other cases and to mark one-off judgements it records
  (`server/tests/integration/records.test.ts` 「例外（この件だけ）」).
- `key` (e.g. `meeting-…:decision:2`): the id is derived from it (sha256) and it is stored in
  `source_key`; a known key answers the existing record, so the same item is written once even
  for two calls at once.

## Not yet

The plugin-SDK / admin-API surfaces, attachments sent by the AI tools,
the app's id assignment and duplicate repair, archiving finished tasks (0.6).
A money field (`money: true`) of a company's own type is written only by a plugin operation
(through an approval request): the engine has no approval path of its own, so no action or create
writes it (coordinator decision 2026-11-02: acceptable for now).

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
`server/tests/unit/record-task-ok.test.ts` (completing on someone's OK, above),
`server/tests/unit/record-task-v9.test.ts` (task version 9, above),
`server/tests/unit/absences.test.ts` (the delegate only during the absence, the ledger's
`onBehalfOf`, the delegate's own reader incl. owner-only records, the manager told, no chains,
cross-company, who sets — each mutation-checked),
`server/tests/unit/record-task-v5.test.ts` (task version 5 and the query's additions, above),
`server/tests/unit/record-task-acceptance.test.ts` (task version 7: acceptance, above),
`server/tests/unit/record-contents.test.ts` (the content store, above),
`server/tests/unit/record-tags-bundle.test.ts` (tags and links to an interface, above),
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

## Business roles in `who` and approvals (plan C3)

A type's action may name `role:<name>` in `who` (`ROLE_REF_RE`); the engine meets it through the
one resolution of role holders (`plugin-roles.md`), a delegate standing in for an absent holder.
The `approval` core type is **version 5**: `approver_rule` gains `role`, with `approver_role` naming
it (additive). Details: `plugin-roles.md`, `approvals.md`.

## Incoming messages (来た連絡, stage 3 B2: `inbox.md`)

The inbox writes `interaction` v5 (implements `request` and `outside_event`; 確認待ち / 部署の番 /
やることにしなかった) and `reply_request` v1 (返事のお願い: service-owned, the one type whose AI may
end it — `ai_close`); task v8 adds the `interaction` link. Unlike every earlier service record,
an individual's mail is **owner-only**: the service writer's `personalOwner` (with `state` and
`quiet`) — so "Service-written records are never owner-only" above holds for every service but
the inbox. Details, routes and tests: `inbox.md`.

## A plugin step's procedure on the ledger (plan C5)

A run of a business plugin's step (`<pluginId>__<step>`) adds `pin` to its `procedure`: the plugin
version + fingerprint, or the company Skill + tree id, the work is pinned to — so its ledger
entries say which procedure (or Skill) made them, copied as in "Which procedure" above. Details:
`plugin-steps.md`.

## The engine's `afterAct` (lane B)

`RecordEngineDeps.afterAct(companyId, change)` runs after an action is committed (never throws
into the engine; nothing is undone when it fails). One user: the inbox drops a 返事のお願い's reply
drafts on the person's 「もう返した」 (`inbox.md`). Test: `server/tests/unit/inbox.test.ts`.

## After an action: the reaction with its actor (plan C5)

`recordEngine.useAfterAction(f)` (bound once, `composition/plugins.ts`): after an action's state and
ledger are written (and after lane B's `afterAct` above), the engine awaits `f(member, actor, {
recordId, type, action, toState })` — it needs the acting member and actor, which `afterAct` does not
carry; a failure there never changes the action's answer. Today it moves a meeting's まとまり to its business
plugin's step (`plugin-steps.md` "After a meeting is read").

## Where an action may be called from (`via`, plan 4b B6)

An action may say `via: [screen, plugin, run]` (absent = `[screen, run]`; `plugin` never with
`approval: prior`). The engine refuses a call from elsewhere with 403 `NOT_VIA` (`callVia`: a
plugin's screen when the actor carries `via`, a run when the AI's token is bound to one, else the
core's screens). A change through a plugin's screen keeps `record_ledger.via` (`{ plugin, version }`)
and its cause is `plugin`. The bridge, its rules and tests: `plugin-frame.md`.
