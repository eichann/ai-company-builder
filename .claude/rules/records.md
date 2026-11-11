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
  - "client/src/features/search/**"
  - "server/src/services/record-find.ts"
  - "server/tests/unit/record-find.test.ts"
  - "server/tests/unit/record-linked-to-file.test.ts"
  - "client/tests/records-tools.test.ts"
  - "server/tests/integration/record-tokens.test.ts"
  - "server/src/ports/records.ts"
  - "shared/core/viewers.ts"
  - "shared/core/bundle-place.ts"
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

Everything is behind a per-company switch (`record_settings.enabled`): owner/admin
turn it on with `PUT /records/settings { enabled: true }`. A company created from 2026-11-02 starts
with it on (`services/companies.ts` `tryCreate`), and turning a business plugin on (its first
install too) turns it on (`plugins.ts` `recordsOn`), since minutes, tasks and business plugins
need it. Existing companies keep their value. The admin console shows the switch at the top of
「詳しい設定 › 仕事の進め方」 (「記録とやることの一覧を使う」, owner/admin, `RecordsSwitchCard` in
`admin/src/components/advanced/task-settings-page.tsx`; added 2026-11-03 because an existing
company had no way to turn it on): on at once, off after a confirmation that says records are
kept (off only stops reading and answering; nothing is deleted). While off, every card of that
page says 「記録をオンにすると使えます」 and stays editable; the 詳しい設定 list counts off as
「変えています」 (the starting value is a new company's, on: `admin/src/lib/advanced.ts`
`workChanged`). Tests: `admin/tests/task-list.test.tsx`, `admin/tests/advanced.test.ts`. While off, nothing is indexed (pushes
schedule nothing) and every route except the settings answers 404 `RECORDS_DISABLED`. The one
thing that applies to every company is the push checker's rule on `.acb/types/` (below): nobody
used that folder before, and a type someone added while the switch was off would steer the
engine the day it is turned on.

## Features on and off (「使う機能」, owner decisions 2026-11-07)

The record types stay in the core and are always installed; what a company switches is a
**feature**, one switch each, all **on** by default (a company that never chose sees no change).
One copy of the rules: `shared/core/features.ts` (`FEATURE_IDS`, `featuresFrom` — lenient: anything
missing or not `false` is on —, `TYPE_FEATURE`, `FEATURE_TOOLS`, `FEATURE_NOTICE_KINDS`,
`noticeTurnedOff`, `noticeKindsShown`, the words `FEATURE_WORDS` / `FEATURE_OFF_NOTE` /
`FEATURE_OFF_CONFIRM` / `FEATURE_OFF_SETTINGS_LINE`).

| feature | id | its types (「見るだけ」 while off) | what stops |
|---|---|---|---|
| やることの一覧 | `taskList` | — (`task` is the core's) | the app's やること tab (`tasks-ui.md` "Features on and off") |
| 会議と議事録 | `meetings` | `meeting` | discovery (clock + `POST /me/minutes/check`), arrivals, reading / まとまり / skip / auto-series routes, `minutes_arrived`, the AI's `minutes_read` / `minutes_link_bundle`, 「今日の予定」 in the app (`minutes.md` "Switches") |
| 受信の振り分け・返事のお願い | `inbox` | `interaction`, `reply_request` | the mail poll, Slack's signals, our replies into threads, 「返事を待つ」 (`offersAwait`), the AI's judgement / reply check, 引き受ける, 受信を読む (off for everyone, as the company's own switch), the inbox's notices and tools (`inbox.md`) |
| 決めたこと | `decisions` | `decision` | `POST /records/decisions` (person and AI: 409 `FEATURE_OFF`), the approval's 「〇〇を承認」 decision (skipped, the approval stands), `decisions_record` and its instructions |
| プロジェクト | `projects` | `project` | creating a `project` (person and AI), 「どの〇〇の会議ですか？」 where no business kind exists, `GET /records/bundle-kinds` says `coreOff: true` |

- **Storage and API**: table `company_features` (one JSON object per company, behind the handle's
  `tasks`; no row = all on), apart from the task settings so an older admin console's whole-document
  PUT never turns a feature back on. `GET /features` (any member, `FeaturesView` in
  `shared/types/features.ts`, + `canEdit`), `PUT /features { feature, on }` (owner / admin, one switch;
  403 otherwise, 400 for a bad body) — `services/features.ts`, `routes/task-settings.ts`. A change sends
  the `records` signal to every member (the apps read again). The same `features` rides on
  `GET /records/types` (session and the AI's token): an older app ignores it, a newer app reads an
  older server's answer without it as all on.
- **「見るだけ」** (records made before the switch-off): still readable everywhere (detail, query,
  探す, links), but out of 「あなたの番」 / 「AI の番」 / the morning summary, `aiTurnOf` says
  `not-ai-turn` (no run can be claimed), and no create, action, undo, file or record link change
  (409 `FEATURE_OFF`; `whoMay` answers null, so a screen offers nothing). The engine asks
  `RecordEngineDeps.featureOff` (`refusals.ts` `featureOffRefusal`); the **service writer** refuses a
  create or a transition of such a type (`feature-off`) — the backstop under every service and the
  server clock (a 返事のお願い whose wait is over is not moved). Exception: a sent mail's receipt
  (`SERVICE_RECEIPT_TYPES`, `interaction`) is still written while the inbox is off (sending stays on).
  Turning the feature on again continues from where it stopped: nothing was changed meanwhile.
- **Notices**: none of a feature's own kinds, and none about a 「見るだけ」 record
  (`NotificationServiceDeps.noticeOff` → `noticeTurnedOff`, applied before every insert). The bell's
  「知らせの設定」 lists no kind of a feature that is off (`noticeKindsShown`; the member's stored choice
  is left as it was).
- **Combinations**: 決めたこと off with 会議 on — the minutes reading gets no `decisions_record`, its
  instructions and first message drop the decision part — the manual start (［AI に読ませる］ /
  自分で読み取る) and the automatic 「AI の番」 alike (`AiTurnStepDefinition.firstMessage` gets the
  features, `useAiTurnRunner`'s `features`) —, the approval step is skipped. プロジェクト off —
  no `project` made, no まとまり question without a business kind (`meetingAsksBundle`'s
  `bundleKindInUse`). 受信 off — no 「返事を待つ」, nothing comes in. 会議 off — the business plugin's
  「会議のあと自動で」 cannot start (a meeting can no longer become read); its button still works.
- Existing switches keep their meaning: `record_settings.enabled` is still the whole records switch
  (off = 404 everywhere); `taskListDepartmentIds` still says which departments show the list when
  やることの一覧 is on; `readIncoming.allowed` is kept as stored and only *read* as off while the inbox
  is (`composition.ts` `settingsWithFeatures`).
- Admin console: 詳しい設定 › 「使う機能」 (`/companies/[id]/advanced/features`,
  `admin/src/components/advanced/features-page.tsx`): the five switches with one line each on what
  turning it off does; off asks first and says past records stay to read. A settings card of a
  feature that is off keeps its title and shows only 「この機能は今オフです（使う機能で切り替えられます）」
  (`FEATURE_OFF_SETTINGS_LINE`, `admin/src/components/advanced/feature-off.tsx` `WhenFeatureOn`; owner
  decision 2026-11-08, one way everywhere; its stored answers are saved unchanged): 仕事の進め方's
  受信を読む and 返事の目安 (受信), 会議から AI が作るやること (会議), 束ねるものの名前 (プロジェクト), やることの一覧を使う部署
  (やることの一覧); 来た連絡の決まり (受信); つなぎ先 › Google's 会議の記録 period (会議). Unknown switches (an
  older server, an error) read as all on.
- Tests: `server/tests/unit/features.test.ts` (who changes them, the view-only rules per feature,
  back on, the receipt exception, the clock, notices, minutes discovery / arrivals, the まとまり
  question, `coreOff`), `inbox.test.ts` 「使う機能」, `client/tests/records-tools-features.test.ts`,
  `client/tests/features-screens.test.ts`, `tests/ui/tasks-layout.spec.ts` / `record-card.spec.ts`
  (「使う機能」), `tests/ui/title-bar-notices.spec.ts` (知らせの設定), `admin/tests/features.test.tsx`,
  `admin/tests/feature-off-settings.test.tsx` — each guard mutation-checked.

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
  5"), `proposal_states` (proposals: nobody's turn — "Task version 11"), `actions` (from / to / who / notify / attach / note / history_line /
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
- **A company without the shared folder** (`folderKind: none`, `server.md` "Companies without a
  shared folder"): no repository is read — only the core and plugin types, no `.acb/types/` and no
  record files (`RecordIndexerDeps.hasCompanyFolder`). Nothing pushes there, so the core types are
  made when the company is created (`tryCreate` → `indexRecords`) and at every server start
  (`services.indexCompaniesWithoutFolder`, `index.ts`).

### Links to files (owner decision 10/29)

- A link whose target is a file is stored as a company path (`record_links.target_path`). The
  indexer reads each repository's diff with git's rename detection (`diff-tree -M`, any file
  type, `lib/record-files.ts` `renames`) and points every link to a renamed or moved file at its
  new path (`followRename` / `retargetFileLinks`) — after the record files of the same push, so a
  record file re-read there (its own text may still name the old path) ends on the new one; the
  next edit of that file restores what its text says (file records are a company's own types
  only). Exact path matches only — and **a folder moved or renamed by a member** comes as a rename
  of its own (owner decision 2026-11-03, 「フォルダもつなげる」): `folderMoves` (`lib/record-files.ts`,
  pure) finds, for each folder above a renamed file, the one new folder every rename `P/x → Q/x`
  under it agrees on (renames that do not keep their place below P say nothing; two different Qs
  → none; at most 5000 candidates), and `readRecordFiles` keeps the ones gone at the tip, so a
  link to P (or to a folder inside it) follows to Q by the same `followRename` rules. A folder
  that still exists (only some files moved out) keeps its links. A department renamed by the
  server follows through `moveFolder` (below).
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
  tell). The app says 「つながりが切れています」. A path where a **folder** is now also says
  `folder: true` (the object's type: `existing` answers file or folder); the app shows it as a
  folder row.
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
A company without the shared folder (`server.md`) refuses every new company path — linked here, on
create, as an attached version or a decision's file material — with 409 `NO_COMPANY_FOLDER`
(`fileLinksUnavailable`, `RecordEngineDeps.hasCompanyFolder`): a path on one member's PC means
nothing to anyone else. It links a Drive file or a file of the member's own PC instead ("File links
without the shared folder" below). Removing a link is never refused.

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
- The consultation AI: a consultation about a task (its topic, `tasks-ui.md` "Consultations centre
  on the task") gets the files the AI newly creates linked as the AI (`RecordTools.linkNewFile`:
  `file-links` with the turn's act token at the version read, note 「AI が相談の中で作ったファイル」,
  once more on `VERSION_CONFLICT`; a read token links nothing). `records_get` returns the file links (`path`,
  `broken`) and its description and `RECORDS_INSTRUCTIONS` tell the AI to check a task's linked
  files there (except when a record the member dropped on the input came with its one-time summary:
  answer from that first, `RecordTools.readDroppedRecord`, `chat-ui-and-history.md` "A record dropped
  on the input") and read the ones it needs with its normal file tools — names only, never contents,
  through the API.

### Links into .personal/ (owner decision 2026-11-03)

A file or folder inside any `.personal/` folder (`isPersonalPath`, `shared/core/records.ts`; any
depth, A–Z folded) is on one member's Mac only, never synced, and its name can itself be private. A
link to one is **its maker's alone**: everyone else — owners and admins included — gets no trace of it.

- `record_links.created_by` (nullable, `migrateRecordLinkCreator`) keeps who made a file link: the
  member of a `file-links` link or a create's file link — their AI counts as them (the consultation
  AI's `linkNewFile` links as the member) — and an undo that brings a link back gives it to the
  entry's actor (only its maker could see it to take it off). Rewrites of a record's links keep it
  (`withLinkTargets` matches each target to the row it had). A row with no maker (a record file's
  link, a link made before the column): shown only to the owner of an owner-only record, else to
  nobody (a members-only record's listed members included: there is no maker to match).
- `fileLinkShown(viewer, source, link)` decides, in every answer: the detail (`GET /records/item/:id`,
  the AI's `records_get`), `linkedToFile` (a record counts only where the caller made the link), 探す's
  file counts (`record-find.ts`), 経緯 and a replay (`record-engine/personal-links.ts`: someone else's
  `.personal/` paths are dropped from `links.*` before / after, and an entry left saying nothing is
  left out; the paths a member linked themselves stay visible to them).
- Another member's `.personal/` link is not there for `file-links`: removing it answers 404
  `LINK_NOT_FOUND` as for any link that is not there, and linking the same path (two members' 今日のフォルダ
  can hold the same name) makes a link of their own.
- Test: `server/tests/unit/record-personal-links.test.ts` (detail, linkedToFile, 経緯, replay, 探す;
  unlink / link by another; kept through others' changes and undo; links without a maker) —
  mutation-checked.

### File links without the shared folder (owner decisions 2026-11-07/08)

No general upload (ACB does not rebuild Drive). A company without the shared folder (`folderKind:
none`) links exactly two other kinds of file; a company with it keeps company paths, unchanged (both
kinds → 409 `FILE_LINK_KIND_NOT_HERE`, and Google is not asked). The kinds (`FileLinkKind`,
`shared/core/records.ts`) live in the one target string of `record_links.target_path` and the
ledger's `links.<name>` arrays — `fileLinkPath` refuses `<letters>:`, so none is ever taken for a
company path:

- **`drive:<fileId>`** — a Google Drive file. `POST …/file-links { target: { kind: 'drive', fileId },
  expectedVersion }` (session only). **Every record check comes first** (who → body → rules:
  `recordEngine.fileLinkBeforeDrive` — records on, the record exists and is readable, the body, the
  version current, not linked already, a company without the shared folder, a person); any refusal or
  `changed: false` is answered with Google asked nothing. Only then does the route ask the Google
  connector (`services/google-drive.ts` `linkable`, `google-drive.md` "Linked to a record"), which
  checks the file is **the member's own live pick** and reads it with **their own** `drive.file`
  permission; the engine takes only that answer (`VerifiedDriveFile`, never a body: without it 403
  `DRIVE_NOT_PICKED`). Kept beside the row (`record_links.target_meta`, JSON, `DriveLinkMeta`):
  revision (`headRevisionId`, or `version:<n>` for a Google document), the name as picked, the sha256
  of the content ACB read (null when it could not be read), the MIME type, when. **Every reader of the
  record gets the row** (`RecordLinkView.drive { fileId, mine }`, opened in Drive, which decides who
  may see it); **the name and the rest only the member who linked it** (`mine`) — anyone else is shown
  「Google Drive のファイル」. Owner decision (asked 2026-11-08): only the linker can be checked with
  `drive.file`, so ACB never calls Drive with another member's token to look at a linked file, and
  never shows the picked name to others. A Drive link brought back by an undo has no kept facts (the
  linker then sees 「Google Drive のファイル」 too).
- **`local:<owner id>:<path>`** — a file of the member's own working folder (`path` relative to it,
  checked like a company path; never an absolute path, so no user name leaves the PC). `{ target: {
  kind: 'local', path } }`. **Its owner's alone**, like a `.personal/` link but decided by the owner
  id in the target itself (`fileLinkShown`, `localLinkOwner`): nobody else — owners and admins
  included — gets the row, its path or a count of it through any answer: the detail (the card, the
  AI's `records_get`), 探す's counts (`record-find.ts`), 経緯 and a replay (`personal-links.ts`: an
  entry that only linked or took off someone else's PC file is not there at all), the entry answered
  by someone else's link change or undo (scrubbed: `fileLink`, `undo`), and an undo (an entry that
  adds or removes a PC file the caller cannot see answers 404 `ENTRY_NOT_FOUND` — also for an
  admin, who may undo anyone's entries). Two members' files of the same name are two links.
  `linkedToFile` cannot name one (`fileLinkPath`).
- **People only**: the member's AI gets 403 `TYPED_LINK_PERSON_ONLY` for either kind (the AI reads a
  Drive-linked file only through `drive_read`, which needs the member's own pick, and a PC file with
  its ordinary file tools in the working folder). **One exception** (owner decision 2026-11-09): the file
  the member's own Drive put just made in a consultation about the record is linked by the server, as
  the AI (`recordEngine.linkDrivePut`, only from the Google connector's put route with facts from the put
  receipt, every other check of `fileLink` kept; `google-drive.md` "The AI's routes"). A person may also
  link a file their own put made (`linkable`). Removing either: `…/file-links/remove { target }`
  (a Drive link: any reader, as for company paths; a PC file: its owner — anyone else gets 404
  `LINK_NOT_FOUND`).
- **Materials and attached versions** (`act.ts`): `decision.materials` may name `{ kind: 'drive',
  fileId }` and `attachments` `{ link, target: { kind: 'drive', fileId } }` — a Drive file the record
  links; the ledger keeps `{ fileId, revisionId, sha256 }` from the link (the body's are never taken),
  and a link whose content ACB could not read (no sha256 or no revision) → 400
  `DRIVE_VERSION_NOT_FIXED`. **Those values enter the ledger and are visible to every reader of the
  record** (経緯, `versions/:version`, the AI's `records_history`): the fileId, the revisionId and the
  sha256 — never the file's name, which stays the linker's alone. A PC file is never material or an attachment (400
  `LOCAL_FILE_NOT_SHARED`: nobody else could check it). The old `{ path, commit }` forms stay 409
  `NO_COMPANY_FOLDER` here; `drive` ones in a company with the shared folder → 409
  `FILE_LINK_KIND_NOT_HERE`. Approval requests take no file materials yet (`approvals.md`).
- The app: `tasks-ui.md` "Linking files". Mail attachments stay as they are (`outbound-mail.md`).
- Tests: `server/tests/unit/record-typed-links.test.ts` (a PC file through detail, 経緯, replay, 探す,
  someone else's unlink / undo / answers; two owners of one name; the path checks; the Drive name only
  to the linker; the connector's check and people only; materials / attachments; a company with the
  shared folder unchanged), `server/tests/integration/google-drive.test.ts` 「a picked file linked to a
  record」 (the pick checked with the linker's permission, revision and sha256, no Google call for
  anyone else or for a company with the shared folder) — every guard mutation-checked.

### Task version 12: 返事待ち says until when (owner decision 2026-11-03 「②」)

- `wait` (返事待ちにする) gains the arg `wait_until` (kind `date`): the 見込み is set with the wait, in
  one entry. **Left out or null** (an app released before 12, the AI giving none) the engine fills it
  (`ARG_DEFAULTS` + `argDefaultValue` in `shared/core/core-types.ts`, applied in
  `record-engine/act.ts`): a 見込み still ahead of the company's now stays (an older client that ran
  `set_wait_until` first), anything else — none, or one that passed (「もう少し待つ」 after the clock
  gave it back) — becomes **3 business days** after the company's today (weekends, public holidays and
  the company's own holidays skipped: `business-days.ts` `addBusinessDays`; the engine dep
  `companyDay` = the company's now + `TaskSettings.companyHolidays`, composition.ts; without it the
  default zone and no company holidays). `ARG_DEFAULTS` is the core's only: a type file cannot say it.
  Its sibling **`ACTOR_ARGS`** (`isActorArg`, same file and place): an argument the engine fills with
  the person acting — today only `interaction` `settle`'s `settled_by` (inbox.md "Core types"); the app
  may leave it out, a value naming anyone else → 400 `BAD_VALUE`. Core only, like `ARG_DEFAULTS`.
- When it passes, the server clock gives it back (`WAIT_OVER.task`, `notifications.md` "The server
  clock"), its 経緯 note 「返事の見込み（11/6）を過ぎました」 (`waitOverNote`). **「あなたの番」 marks it**:
  `waitCameBack { waitedSince, overAt }` on a record in `WAIT_OVER[type].personTurn` whose newest state
  change is the clock's `wait_over`, or whose only later state changes went from the AI's turn back to
  the person (the AI handed the nudge draft over) — `waitCameBack` in core-types; a person's move,
  a reassignment accepted back, a `wait_over` by anyone but the clock → not marked. A waiting task
  without `wait_until` (waited before 12) is never moved nor marked.
- The AI's tool `task__wait` (`client/electron/records/tools.ts`): `wait_until` optional in the
  schema with a description telling the AI to always give it (left out → the default); only defaulted
  args are optional (`set_wait_until` still requires its date).
- Migration: `TASK_VERSION` 12 (below). Tests: `server/tests/unit/record-task-wait-until.test.ts`
  (default skipping public and company holidays; an old body; a 見込み ahead kept, a passed one
  replaced; moved exactly once, never before, with the line; もう少し待つ; the mark; old waiting tasks
  untouched; `waitCameBack` cases) — mutation-checked; `server-clock.test.ts`, `ai-runs.test.ts`.

### Task version 13: the meeting's slot (owner decision 2026-11-06 「出どころの枠」 §10)

Additive over version 12 (three fields, one action, a wider `who`, one new who-entry kind):

- **`link:<name>` in `who`** (generic, `LINK_WHO_RE` / `linkWhoName` in `shared/core/record-types.ts`):
  a member who reads the record this record's link `<name>` points to (their own reader, a link that
  may be followed — `linkAllowed`). The parser accepts only a record link of the type (a file link or
  a missing one is an error). The engine (`act.ts` `readsLink`, passed to `mayAct`) asks it only when
  `who` names one; a delegate qualifies only on their own reading (the absentee path gets none, fails
  closed); never the AI unless `who` lists `ai`. The app evaluates it from what the server answered
  (`task-card.ts`: an out link of that name with its record; `proposalMay`: the list came through the
  meeting).
- `adopt` / `dismiss` / `propose_again` gain **`link:meeting`**: every reader of the task's meeting —
  attendees, invited members — besides `requested_by`, `dept_manager`, `admin`. Proposals inherit the
  meeting's members-only list ("Members-only records"), so the readers of a proposal are the
  meeting's readers plus the people it names; an assignee who did not attend reads the task but not
  the meeting and gets nothing new. A task with no meeting is not widened. `dismiss` from 未着手 /
  引き受け待ち of a meeting's task (made at once by 「自動で作る」, or adopted) is the meeting readers' too.
- Fields `basis` (long_text: the minutes quote, the candidate's identity — minutes.md "Outputs made
  once"), `similar_to` (record → task: an earlier candidate whose title is close; written only by the
  slot — a create naming it, or `apart_by`, is 400 `BAD_VALUE`), `apart_by` (person). Action
  `keep_apart` (別のもの: from `proposed`, no state change, the same `who`, arg `apart_by` filled with
  the person acting — `ACTOR_ARGS`); the app hides it on the task card (`NOT_ON_CARD`: it belongs to
  the review list).
- **A person's create and share** (no type change): never a candidate; the answer may add
  `similar: { id, title }` (「似ているやることがあります」, minutes.md "Outputs made once") — a hint, nothing
  written. ［まとめる］ in the app is the person's `dismiss` (案・未着手・引き受け待ち) or `cancel` (other open
  states) of the **new** one with the note 「「<既存の件名>」とまとめたため」 (`slotMergedNote`), undone
  with the generic undo; the earlier item is never touched.
- Migration: `TASK_VERSION` 13 (the "Task version 9" mechanism: the core definition stored once, every
  task's index row moved, no ledger entry). Tests: `server/tests/unit/source-slot-candidates.test.ts`,
  `meeting-proposals.test.ts` — mutation-checked.

### Task version 11: the AI's proposals (案) and 「議事録を確認する」 (owner decision 2026-11-02, plan F)

Additive over version 10 (two states, one field, three actions, a wider `dismiss`):

- **Proposals**: state `proposed` (案), listed in the new generic key **`proposal_states`**
  (`TypeDefinition.proposalStates`): not final, but nobody's turn — `noTurnStates` (final ∪ the
  AI's turn ∪ proposals) is what 「あなたの番」 (`waitingFor`), `turnHolder`, Slack's turn DMs and
  the create's notice leave out; an action into a proposal state tells only whom it names, never
  `next_actor`. The app's open-task queries list states explicitly and so never include it.
- **Who proposes** (`PROPOSALS` in `shared/core/core-types.ts`, engine `create.ts`): a task the
  member's **AI** creates with its `meeting` link starts in `proposed` when the company proposes
  (`TaskSettings.meetingTasks` `propose`, the default; `tasks.md`), as before (`todo`) when it
  creates (`create`) — through `deps.proposesFromMeeting`. A person's create never proposes (it
  may still start in `proposed` itself: `create_states`). The made-once rule is unchanged and
  runs first (minutes.md "Outputs made once"): reading again finds a proposal, even a put-away
  one, and does not propose it again.
- **Taking it up** — people only (`who: [requested_by, dept_manager, admin]`, never the AI; since
  version 13 also `link:meeting`, every reader of the meeting):
  `adopt` (足す: proposed → todo, `hand_to` / `notify` the assignee; acceptance applies as for any
  request), `dismiss` (要らない: proposed / todo / awaiting_acceptance → `dismissed`, final, kept —
  never deleted; also a task the AI made at once), `propose_again` (案に戻す: dismissed →
  proposed). The meeting duplicates list leaves `dismissed` out like `cancelled`.
- Field `task_kind` (choice `minutes_review`): 「議事録を確認する」, made by the server
  (minutes.md "The review task") through the service writer, which may now also create `task`
  (`SERVICE_MADE_TYPES`).
- Test: `server/tests/unit/meeting-proposals.test.ts` (proposal or task by the setting, a
  person's never; nobody's turn and nobody told; adopt / dismiss by people only, the assignee told;
  a second reading reuses the put-away one; the review task once, linked as origin, open until
  completed) — mutation-checked.

### Linking records later, and where a record came from (owner decision 2026-11-02)

「つなぐ・外す」 for record links, the same shape as files ("Linking files later"):
`POST /records/item/:recordId/record-links` (+ `/remove`) `{ link, target, expectedVersion, note? }`
(session only; contract `RecordLinkRequest` / `RecordLinkResult`), engine `recordLink`
(`services/record-engine/record-links.ts`). 取り消す is the generic undo of its entry.

- **Origin links** (出どころ): a link definition may say `origin: true` — where the record came
  from, which is history rather than filing. Core: task v10 `meeting` (もとの会議), `interaction`
  (もとの連絡), `prepared` (AI が用意したもの); decision v5 `meeting`, `approval`; reply_request v3
  `interaction`, `prepared` (v4 also `task`, the やること a mail we sent first came from). They are set when the record is made (create, the service writer, the
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
  `migrateCompanyTaskVersion`, `TASK_VERSION` = the core task version, 13 since "Task version
  13"): at startup, every company whose map has the task type stores that core version when
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
- **Not a line of 経緯** (owner 2026-11-02: tags organise, they are not work). The ledger keeps
  every tag change as an engine entry (undo, replay, audit unchanged; nothing is dropped on the
  server); the app's 経緯 leaves out entries of an action that only sets `tags` fields
  (`labelOnlyEntry`, `client/shared/record-views.ts`; `tasks-ui.md` "Tags on the card").
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

The business plugin 「法人営業」 (corporate-sales 0.3.0, private repository) implements them: `deal` v3
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
  company's plugin and records decide nothing. Only records the member reads count (a restricted
  department's records never tell them what kind it makes; the answer is per member).
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
POST    /records/item/:recordId/share          the owner / a listed member shows an owner-only / members-only record to a folder (session only)
POST    /records/item/:recordId/members        a listed member adds people / groups / departments to a members-only record (「招待する」, session only)
POST    /records/item/:recordId/members/remove a listed member takes people / groups / departments off it (「見る人を減らす」, session only)
GET     /records/item/:recordId/members/choices the groups / departments the caller may add, and the list's (session only)
POST    /records/item/:recordId/opened         the app opened it: the turn-holder's first opening kept ("Whose turn it was")
POST    /records/find              any member: 探す { text, today } → hits with department / mine / 案件, hub summaries ("探す" below)
POST    /records/find-home         any member: 探す with nothing typed { today, from, to }
POST    /records/query             any member: { type?, implements?, state?, fields? (value | { in } | { contains } | { gte?, lt? }), linkedTo?: { id, hops: 1|2 },
                                   link?: { name, id }, linkedToFile?, sort?: { field, order? }, finishedSince?,
                                   text?, limit ≤ 200, offset ≤ 10000, countOnly? } → { total, records }
GET     /records/item/:recordId    any member: the record + its readable links (both directions)
```

- **No leaks** (0.13-1, 4-2): a record is readable exactly when its file is (`resolveAccess`
  read; inside a private folder also `canReadPrivateScope`), a server-only record when its
  folder is (none = everyone; in a company without the shared folder a read-restricted place —
  a department or a place inside one, people / groups / departments named by its rules — gates it
  like a private folder: `server.md` "Groups and read-restricted places") — and an owner-only
  record by its owner alone, a members-only record
  by its listed members alone ("Owner-only records", "Members-only records" below). Answers, `total`, link lists and traversals all apply it, so an
  unreadable private record is identical to a nonexistent one (same 404 body). `total` counts up
  to `MAX_CANDIDATES` (20,000) rows.
- Records imported through an earlier connection of an outside system are marked
  (`fromOldConnection`, `notice`) and left out of the query unless `includeOldConnection: true`
  and out of 「あなたの番」 (`plugins.md` "Connections").
- **Order**: most recently changed first — the later of the record's own time and its state's
  (an action changes only the state; a task archived today sorts first, the app's 「アーカイブ」
  pages by it: `tasks-ui.md` "The archive") — then the id; each answer's `updatedAt` is that time.
  Test: `tests/unit/record-query-order.test.ts`.
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
  private folder — except the folder of the 案件・プロジェクト the task links to, or `toBundle`: "A task and
  its 案件・プロジェクト"; for a deal, the deal's folder), required (400 `FOLDER_REQUIRED`).
  **Where a record may be placed (audit B-M1)**: a `folder` inside a private folder (readable or
  not), one the member cannot read, and one that is not a folder of the company repository's shared
  branch all get **one** answer, 400 `FOLDER_NOT_PLACEABLE` (`placeFolder`, and the routes'
  `recordEngine.checkPlace` before `create` / `createByAi` / `share`, which asks the repository —
  `folderExists`; not known, e.g. no repository: left to the engine). So the answer never tells
  whether a private folder of that name exists (owner decision B). Replaces `PRIVATE_PLACE` /
  403 「You cannot read that folder」. Test: `record-ai-placement.test.ts` "a private folder's name
  is never confirmed by the answer" (mutation-checked). In a company without the shared folder the
  places are its departments: a department's folder or a path below it is placeable, anything else
  `FOLDER_NOT_PLACEABLE` (composition's `folderExists` from the rows; who sees the record is still
  the scopes' rules, owner-only and members-only lists — nothing depends on a repository:
  `company-without-folder.test.ts`). Clears
  `personal_owner`, sets `folder` (`RecordRepository.setPlace`); ledger action `share`, state
  unchanged, changes `place.personal_owner` / `place.folder` before / after, version + 1
  (`VERSION_CONFLICT`). A task linked to a meeting answers `similar` when a live item of that meeting
  the member reads has a close title ("Task version 13": a hint, never a refusal). Already shared → 409 `NOT_PERSONAL`. **Never undone** (`NOT_UNDOABLE`:
  the folder's readers may have seen it); `place.*` changes never land in the server fields.
- Tests: `server/tests/unit/record-personal.test.ts` (another member, a manager, an admin and the
  company owner get a missing record's answers on every route; query / count / text / my-turn
  exclude it; links to it refused alike and links from it hidden; `set_bundle` into an owner-only
  bundle and `link:` / `finishedSince` / `sort` queries for anyone else; cross-company; existing rows
  unchanged and the column migration; share only by the owner, its ledger entry, never undone —
  mutation-checked), permission matrix rows + `CROSS`.

### Members-only records (「この人たちだけ」, owner decision 2026-11-04)

The fourth way a record is seen (design: 会議の記録と「参加した人だけ」の見え方, §3/§5/§7): **a list of
members** — those members only. The same rule as owner-only, for more than one person: **not owners,
admins or department managers either unless listed**; for everyone else it is a record that does not
exist (the same 404 body), through every caller of `recordReader` (its branch sits right after the
owner-only one, before every role or folder rule).

- Storage: `record_viewers (company_id, record_id, user_id, added_at, added_by)` (+ index
  `(company_id, user_id)`; `migrateRecordViewers`, additive). The record is marked by `@members` in
  `records.personal_owner` — an older server build reads that as an owner nobody is, so it shows
  the record to nobody (fails closed). The adapter alone knows the marker: rows come out as
  `personalOwner: null, members: [...]` (`RecordRow` / `RecordAccessRow.members`, null = not
  members-only; a marked record with no rows is read by nobody). `upsert` marks a new row (insert
  only), the caller adds the list with `addMembers` in the same transaction; `setPlace` ends it
  (drops the rows). Asking for a list on an existing row that is not members-only, or `addMembers`
  on one, throws inside the caller's transaction (never quietly wider). The service writer's
  `transition` takes `addMembers` (a meeting's attendees the calendar added later, `minutes.md`):
  ledger `place.members` before / after; refused (`bad-place`) on a record that is not members-only
  or with a non-member. A member removed from the company is taken off every list in the same
  transaction as their rules (`forgetMember`, `services/companies.ts` `removeMember`), so joining
  again starts from nothing.
- **Create** (`POST /records/item`, the AI's `records_create`): `members: string[]` (≤ 200; the
  creator is added). Refused with `personal` / `folder` (400 `MEMBERS_WITH_PLACE`), for a business
  plugin's type (400 `MEMBERS_NOT_FOR_TYPE`), with a non-member (400 `BAD_MEMBER`); an assignee /
  reviewer not listed → `ASSIGNEE_CANNOT_READ` / `REVIEWER_CANNOT_READ`. The summary carries
  `membersOnly: true` (no names); the answer's `placed` adds `membersOnly: true`. The AI's create
  with `members` gets none of its placement defaults (`aiPlacement`).
- **Made from a members-only meeting** (`record-engine/members.ts`, used by create and the service
  writer): a record linked to one (any record link whose target is a `meeting` with a list) is
  members-only by itself — the meeting's list (several meetings: who is on all of them) plus the
  creator and every person its fields name (an assignee who was not there must see their own task).
  A `folder` with it is refused (create: 400 `MEMBERS_WITH_PLACE`; service writer: `bad-place`;
  decisions: `DECISION_PLACE_REFUSED`, and `folder` may be left out). The AI's meeting outputs get
  this too (`aiPlacement` leaves meeting outputs alone). With an explicit `members` the AI may only
  narrow: everyone listed must be on the meeting's list or named by the record (400
  `MEMBERS_NOT_IN_MEETING`); a person may widen (it is their act). Only meetings are inherited from:
  a record linking someone's owner-only record stays where it was put (an established pattern,
  "Owner-only records": the link is hidden from the others); the mail service places by its source
  instead (below).
- **Invite** 「招待する」: `POST /records/item/:recordId/members { add, expectedVersion, note? }`
  (contract `InviteRecordMembersRequest`), **session only**. Any listed member (nobody else finds it:
  404 `RECORD_NOT_FOUND`); not members-only → 409 `NOT_MEMBERS_ONLY`; each a member (400
  `BAD_MEMBER`, ≤ 200). Ledger action `invite`, change `place.members` before / after (ids,
  comma-separated), version + 1 (`VERSION_CONFLICT`), answer `added` (the newly listed). **Never
  undone** (`place.*`). No notice kind: the `records` signal reaches the added. Groups, departments
  and removing: "Groups and departments on the list" below. The app: the meeting card's ［招待する］
  (`minutes:invite`, `minutes:inviteChoices`, `minutes.md` "In the app").
- **Share** 「部署に出す」 (`share`, "Owner-only records"): also from members-only, by any listed
  member; ledger `place.members` (the list → null) and `place.folder`. Its assignee / reviewer must
  read the folder (400 `ASSIGNEE_CANNOT_READ` / `REVIEWER_CANNOT_READ`). The folder's readers then see
  the record and its 経緯, including who was on the list: intended (owner decision 2026-11-04) —
  sharing is the listed member's own act, and the ledger must be accurate, so `place.members`
  before keeps the previous list.
- **Places copied from a record** go through `placeOfRow` (`record-engine/service-writer.ts`:
  folder | owner | members) — the mail draft (an owner-only / members-only 連絡, meeting or やること
  keeps its place whatever the まとまり), the sent mail's やりとり (with or without 「返事を待つ」 when the
  mail's record is restricted; `outbound-mail.ts`) and the inbox's 返事のお願い (`inbox.ts`). Copying
  `folder` alone would place it company-wide.
- **Elsewhere**: the inbox joins a message to a members-only やりとり's thread only when it reached
  someone on the list (`inbox.md`); a members-only (or owner-only) meeting, or one inside a private
  folder or a read-restricted place, is not named in the note of its まとまり's step move
  (`plugin-steps.ts`, 「会議を読んだあと」).

- 見られる人 (`services/viewers.ts`): judged by its own list before the per-place cache (every such
  record has folder null; the cache would hand one record's readers to another), with the existing
  phrases (「あなただけ」「あなたと〇〇さん」「N人が見られます」…), names only to listed callers.
- Acceptance's personal rule (`act.ts`, "Acceptance") stays owner-only. Delegates and approvals:
  nothing special (listed under "Not yet").

#### Groups and departments on the list (owner direction 2026-11-08)

A record's exception is written in **a place rule's subjects**: people, groups (見える人のまとまり) and
departments (所属), so a group changed once applies to its places and its records alike. **Still one
decision, two layers**: `recordReader` takes the record's own exception first (owner-only, then the
list), then the place's rules. The list's matching is `listIncludes` (`shared/core/permissions.ts`),
which runs the core's `applicableRules` — the matching `resolveAccess` uses — over the list as rules
that grant read; no role or `everyone` subject exists on a list, so **owners, admins and managers are
included only when listed** (strict, as before; a group never includes them by itself). `onList`,
`listedUserIds`, `listSubjectsOf` (`services/record-access.ts`) are the only server helpers over it.

- **Storage**: people stay in `record_viewers`, untouched; groups and departments in
  `record_viewer_sets (company_id, record_id, subject_type group|department, subject_id, added_at,
  added_by)` (`migrateRecordViewerSets`, additive: an older build ignores it and reads such a record by
  its people alone — narrower, never wider). Triggers: the subject must be of the row's company
  (another company's id throws, like a missing one), rows are never updated, deleting a group or a
  department takes it off every list (narrower). Who is in a group / department is read with the row
  (`RecordRow.memberSets[].memberIds`, never stored — like a rule's `memberIds`), so joining or
  leaving applies at once on every path. A row without groups or departments has **no `memberSets`
  key** (existing data reads exactly as before).
- **Both kinds of company**: records live in the database for a company with or without the shared
  folder and nothing of a list reaches the repository, the push checker or the app's sync, so groups
  and departments are allowed on lists in every company (place rules keep groups for companies
  without the shared folder only, groups PR).
- **Invite** (`add`): a plain string is a person (older apps), `{ subjectType: user | group |
  department, subjectId }` the subject form. People: any listed member (unchanged). **A group or a
  department** (it widens to whoever joins later): only the record's 責任者 (its `assignee`, or a
  まとまり's `owner`), a 部署の管理役 (of any department) or an owner / admin — each also on the list, since
  nobody else finds the record — else 403 `LIST_WIDENING_NOT_ALLOWED`; unknown or another company's →
  400 `BAD_GROUP` / `BAD_DEPARTMENT`. Answer adds `addedSets`. Ledger `place.members` lists people,
  then `group:<id>` / `department:<id>` (`listLedgerValue`).
- **Narrowing** 「見る人を減らす」 (`POST …/members/remove { remove, expectedVersion, note? }`): any
  reader (owner direction: narrowing is free); 400 `NOT_ON_LIST` (none of them is on it),
  `LIST_WOULD_BE_EMPTY` (no member of the company would read it), `NAMED_PERSON_CANNOT_READ` (someone a
  person field names would lose it). Ledger action `remove_members` (never undone: `place.*`); answer
  `record: null` when the caller took themself off.
- **Choices** (`GET …/members/choices`, contract `RecordMemberChoices`): `maySets` and, only then, the
  company's groups and departments (a member never gets the groups' names otherwise), plus the list's
  groups / departments by name.
- **permission_history**: every invite that added something and every narrowing, action
  `record-members` (`{ recordId, via: invite | remove, added | removed }`; no titles).
- **Copied lists**: one meeting's list is inherited as written (its groups too: `meetingMembers`
  returns `{ users, sets, readers }`; several meetings → who is on all of them now, as people);
  `placeOfRow` copies `memberSets`; the service writer takes `memberSets` only with `members`
  (else `bad-place`). Inbox threads, `bundle-place` representatives and the まとまり chooser of a meeting
  use `onList` / `listedUserIds`. **Stays people-only on purpose**: a meeting's attendee steps
  (`isAttendee`: ［AI に読ませる］, the text, 自動で読む) and 「議事録が届きました」 (`listedRecordIds`) — someone
  who reads through a group did not attend.
- Tests: `server/tests/unit/record-member-subjects.test.ts` — the **equivalence matrix** (companies
  with and without the shared folder × 7 roles × people-only lists, owner-only records, server records in
  every kind of place, file records in and out of a private folder: the new reader and `recordReaders`
  equal a frozen copy of the reader before this change, and people-only rows carry no new key), a
  group / department joined and left on every read path (detail, history, query, count, text, linkedTo,
  探す, 「あなたの番」, 見られる人, notices, `recordReaders`, the push signal), the group / department deleted,
  who may widen, narrowing's guards, ledger and history, another company's subjects, inheritance and
  copies, `bundle-place` — 25 guards mutation-checked; `client/tests/meetings-app.test.ts`,
  `src/features/minutes/model.test.ts`, `tests/ui/meetings.spec.ts` (the dialog).
- Tests: `server/tests/unit/record-members.test.ts` (same-department member, manager, admin, company
  owner: a missing record's answers on every route; query / count / text / link / finishedSince /
  sort / linkedTo / linkedToFile / 探す / 「あなたの番」 / 「AI の番」 exclude it; links to it refused
  like missing, links from it hidden; `set_bundle`; another company; marked without rows = nobody;
  create refusals; inheritance meeting → task (+ assignee), decision, review task, mail draft;
  invite and share rules (share: assignee / reviewer must read the folder); 見られる人; the push
  signal; a member leaving; migration twice; a sent mail's やりとり without 「返事を待つ」; a members-only
  やること's mail in a まとまり; the AI's create with `members`; the AI narrowing only; an existing row
  never quietly made members-only — mutation-checked: the reader branch, the viewers cache bypass,
  the `placeOfRow` copies, the inheritance in create and the writer, the writer's folder refusal,
  `forgetMember`, `NOT_MEMBERS_ONLY`, each fix of the leak review), `inbox.test.ts` (a members-only
  やりとり's 返事のお願い; its thread and DM only for the listed), `plugin-steps.test.ts` (no meeting
  named), permission matrix rows + `CROSS`.

### Where the AI puts a request (owner decision 2026-11-03)

A task the consultation AI made once landed company-wide with nobody assigned (no turn, not in
the department's list). Now `POST /api/records-ai/item` (tool `records_create`) runs
`recordEngine.createByAi` (`services/record-engine/create.ts` `aiPlacement`), which fills the
defaults before the ordinary `create` (and its checks) — only for a type implementing `request`
with a server `assignee`, and never for a meeting's output (`links.meeting`: minutes.md keeps its
own place). A person's create (session) gets no defaults. A request made for a 案件・プロジェクト
(`links.bundle`) gets no `defaultFolder` (it takes the 案件's place), and a new 案件・プロジェクト without a
folder the creator's own department ("A task and its 案件・プロジェクト").

- **About the member alone** — no `personal`, no `folder`, and no assignee or the member
  themself → `personal: true` (owner-only, above), assignee = the member (their turn). A business
  plugin's type is never made owner-only (it falls to the next rule).
- **Another person, or a department asked for** — an assignee other than the member, or
  `personal: false` (「部署のやることにして」) → `folder` = the one the AI named, else the app's
  `defaultFolder` (the department on screen when the message was sent: `chat-server.ts` passes
  `activeDepartment.folder` to the record tools, which add it to the body; 全社 = none = the whole
  company); assignee as said, else the member. The default folder is checked like any `folder`
  (`placeFolder`: a private one is refused, `FOLDER_NOT_PLACEABLE` — never placed company-wide instead); an assignee who
  cannot read it is refused (`ASSIGNEE_CANNOT_READ`).
- A request made with an origin link to a message (a task's `interaction`) always gets a `due`: the
  AI's, else the company's reply 目安 (`messageDue`; `inbox.md` "A task from a message").
- The answer carries `placed: { personal, folder }` (every create's), and the tool adds
  `tellMember` — 「あなただけに見えるやることに入れました（部署に出すときはカードの［部署に出す］から）」 /
  「「コンテンツ」のやることに、<担当>さんの担当で入れました」; the tool's description tells the AI
  when to name someone or a department and to always say where it went.
- Tests: `server/tests/unit/record-ai-placement.test.ts` (defaults, nobody else sees the personal
  one — owner and admin included, the department and 全社 cases, the private default refused, a
  person's create untouched), `client/tests/records-tools.test.ts` (`defaultFolder` sent, the
  description, `tellMember`).

### Who can see it (見られる人, plan「新しい画面のデモ」K サーバー乙 ②, owner decision 2026-11-02)

- `POST /api/companies/:id/viewers { records?: string[], files?: string[] }` (any member, ≤ 200
  of each, 400 beyond) → `ViewersAnswer` (`shared/types/viewers.ts`): per record id and per company
  path a `ViewersLabel { kind, text, count }`. The phrase is `shared/core/viewers.ts`
  `viewersLabel`, first that fits: 「『<案件>』の参加者（N人）」 (a 非公開 案件・プロジェクト, "Private
  案件・プロジェクト") → 「あなただけ」 (owner-only, or nobody else reads it) →
  「あなたと〇〇さん」 → 「会社のみんな」 → 「『<private folder path>』を見られる人（N人）」 →
  「〇〇部のみんな」 (exactly the people who belong to the department holding it, owners / admins
  aside) → 「N人が見られます」. `count` includes owners and admins. Never 「公開」「権限」「スコープ」.
- Who reads = `recordReader` evaluated for every member (`services/viewers.ts`), once per set of
  folders above the item (a list costs a few evaluations, not one per row).
- **No leaks** (owner decision B; asked and confirmed 2026-11-02: the name is shown only on the
  readers' screens): a record the caller cannot read is **left out** of `records` (an owner-only
  or members-only record too — owners and admins included; a members-only record is judged by its
  own list, outside the per-place cache: "Members-only records"); files are judged over the folders the caller can
  see — an unreadable private folder (and every rule inside it) is treated as not there, so a
  path inside it is answered exactly like a path that does not exist (asking cannot tell it is
  private or name it). Test: `server/tests/unit/viewers.test.ts` (mutation-checked: dropping the
  record check or the unreadable-folder filter fails it).
- **Who cannot open a linked file** (owner decision 2026-11-03: 「〇人はこのファイルを開けません」):
  the body may add `linked: { record, paths }` (≤ 200 paths); the answer then has
  `cannotOpen: { <path>: n }` — for a record the caller reads and only paths the caller reads
  (anything else left out, as above), the number of members who read the record but not the path
  (counts > 0 only; an owner-only record → none). A number, never names or places. Same test.
- App: IPC `viewers:get(companyId, { records?, files? })` → `ViewersResult`
  (`client/electron/features/viewers/ipc.ts`, `client/shared/viewers.ts`;
  `client/tests/viewers-ipc.test.ts`).

### A task and its 案件・プロジェクト (projects that span departments, owner decision 2026-11-06)

No new kind of permission: a task is seen by the readers of its own 見える範囲 (the whole company, a
department folder, a private folder's readers, owner-only, members-only), and **a task that belongs to
a まとまり is never seen by more people than the まとまり** (`services/record-engine/bundle-place.ts`).
Words on screen: 見える範囲 / 見られる人, never 置き場所.

- **"Wider"** is the existing reader evaluation (`placeWithin`): the task is within the まとまり when
  every member who reads the task (`recordReader`) also reads the まとまり. Instead of every
  membership it asks representatives that cover every distinct answer: each user a rule names, each
  member of a department a rule names, both records' lists and owner, plus one plain member and one
  owner/admin nothing names. An owner-only task is never wider (its owner reads the まとまり to link it;
  the explicit branch is also covered by the general rule). A members-only task is within when all its
  members read the まとまり. Only `task` (`BUNDLE_PLACED_TYPES`); meetings and other types keep their own
  rules.
- **Made for a まとまり** (create with its `bundle` link — the list's line, the card's 「頼む」, the AI's
  `records_create`): no place given → the まとまり's (`placeOfRow`: folder, private folder included,
  owner, list); `personal: true` stays owner-only (the owner wants personal tasks linkable to a
  project; the AI's 「about the member alone」 default still applies); a place given (a folder, a list,
  a meeting's list) that is wider → 400 `WIDER_THAN_BUNDLE`. The AI's create with a `bundle` link gets
  no `defaultFolder`. The app's 「頼む」 with a まとまり sends no folder (`tasks:create`).
- **Linked later** (`record-links` link of the `bundle` link, the action `set_bundle`): a wider task →
  400 `WIDER_THAN_BUNDLE`, nothing written. The person may ask to narrow (`narrow: true`, the card's
  「〇〇と同じ人たちだけに見えるようにしますか？」): the task takes the まとまり's place in the same entry as
  the link (`place.*` + `links.bundle`, so **never undone** — undoing would widen it again). Refused
  when someone the task names (担当・頼んだ人・確かめる人…) could not read it there (400
  `NAMED_PERSON_CANNOT_READ`), and toward a members-only まとまり (a list cannot be given to an existing
  record: `WIDER_THAN_BUNDLE`). `set_bundle` (the AI's tool) never narrows.
- **Widening is the person's own act** — ［〇〇の人に見せる］ on an owner-only / members-only task that
  links to a まとまり: `share` (session only) with the まとまり's folder, or `toBundle: true` (its place: its
  folder or the whole company; none linked → 400 `NO_BUNDLE`, a まとまり shown to a list or its owner
  only → 409 `BUNDLE_NOT_PLACED`). `placeFolder` takes a private folder **only** when it is the folder of
  the まとまり the task links to and the member reads that まとまり; anything else inside a private folder
  keeps the one answer `FOLDER_NOT_PLACEABLE` (a member taken off the participants gets it too). The
  route's first check (`checkPlace`) leaves a private folder the member reads to the engine (it is not in
  the company repository); an unreadable one still answers like a missing folder.
- **The department a new まとまり belongs to** (`defaultBundleFolder`, `shared/core/bundle-place.ts`, one
  copy for the server and the app): the creator's own department (所属) — the one on screen when it is
  theirs, else their first in the tabs' order; belonging to none (an owner) or not known → the one on
  screen (全社 = the whole company). The AI's create of a type implementing `bundle` without a folder
  gets it (`aiPlacement`, `defaultFolder` = the screen's); the app's 「新しい〇〇にする」 shows 「〇〇部の
  案件」 with ［変える］ (`tasks-ui.md`).
- **No leaks**: a まとまり the member cannot read answers as missing everywhere (`BAD_LINK`, the create's
  link check run first), and every refusal above names no place or title.
- Tests: `server/tests/unit/record-bundle-place.test.ts` (the default department, inherit on create, an
  owner-only task stays owner-only, wider refused or narrowed, named people kept, set_bundle, the share
  to the まとまり's folder for a linked task of a reader only, no name to a non-reader, the route's first
  check) — mutation-checked; `client/src/features/tasks/model.test.ts` (`bundlePlacesOf`),
  `client/tests/ui/task-card.spec.ts` (the dialog's department, the narrowing question, ［〇〇の人に見せる］).

### Private 案件・プロジェクト (非公開（参加者だけ）, owner decision 2026-11-06)

A 案件・プロジェクト whose 見える範囲 is **its own private folder**, with today's private-folder rights — no
new permission. Its 参加者 are that folder's readers (owners / admins always read it).

- **Made** from 「新しい〇〇にする」 (`tasks-ui.md`): the app first creates the private folder through the
  existing `POST /private-folders` (inside the 案件's department, named after it by the department
  folder-name rule, `-2`… when taken; default readers the creator + the department's managers; the first
  private folder's outdated-app gate as always), then the まとまり with `folder` = that folder. The
  engine places a まとまり there only for **a person** (session) who **may manage that private folder**
  (owner / admin, or a manager of the department holding it — who may create a private folder there),
  **exactly at the folder** and **only a type implementing `bundle`** (`create.ts` `ownPrivate`); anyone
  else, the AI, a task, a folder deeper inside → the one `FOLDER_NOT_PLACEABLE`.
- **Read** like any server record in a folder (`recordReader`: the folder's readers). Its tasks follow "A
  task and its 案件・プロジェクト" (made for it → its folder; wider ones narrowed or refused), so they are
  the participants' too. `GET /records/item/:id` adds `privateFolder: { scopeId, path }` on a まとまり placed
  exactly in a private folder (its readers read that folder; absent otherwise).
- **見られる人**: 「『<title>』の参加者（N人）」 (`viewersLabel` `privateProject`, before the other phrases);
  its tasks keep 「『<folder>』を見られる人（N人）」. `services/viewers.ts` judges whether the caller reads a
  record over **every** folder (it used to judge over the folders the caller can see, which made a
  server record inside an unreadable private folder look like everyone's).
- **参加者** are changed with the existing private-folder editor (`GET /private-folders/:scopeId`, `PUT …/members`:
  owners / admins and the department's managers; the app's ［参加者を足す］ / 外す, `tasks-ui.md`); taking
  someone off removes their clone by the existing mechanism (`private-folders-client.md` "Access changes").
- Not yet: linking files inside its own folder to it (a server record still never links a private
  folder's file); changing a 案件's 見える範囲 afterwards (part C).
- Tests: `server/tests/unit/record-private-projects.test.ts` (who may make one, the AI / a task / deeper
  refused alike; a non-participant sees neither it nor its tasks nor its title in query or 見られる人; a
  participant added sees them, taken off no more; the phrase and `privateFolder`) — mutation-checked; the
  permission matrix row of `PUT …/private-folders/:scopeId/members` (who may change participants).

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
  the drafts its AI made). Version 5 (2026-11-03, `outbound-mail.md` "Waiting for their answer") adds `expects_reply`, `reply_wait_until` and the link `task`.
- `decision` (決めたこと, server — version 6 (2026-11-07): what the AI records is 「決めたことの案」 until a
  person confirms it, "Decisions" below; version 5 marks `meeting` / `approval` as origin links; version 1 was a file):
  `recorded_by` [ai, human], `important`, `exception` (例外（この件だけ）, version 4), `decided_by` (the person
  who confirmed it, null until then), `owner` (残した人: the member who recorded it, only for a decision
  with no meeting; null with one), `source_key`, `why` (long_text), `source`, `said_by` (text: who said
  it, as the minutes name them — content store), `objection` (choice none / raised / unknown); links
  `bundle`, `meeting`, `approval`. unconfirmed → confirmed / retracted: `confirm` (決めたことにする — the
  app's ［そうです］; arg `decided_by`, filled with the confirmer: `ACTOR_ARGS`), `reject` (違う, from
  unconfirmed, note optional), `retract` (取り消す, from confirmed, note required), all decisions, and
  `set_exception` (args `exception: boolean`, no state change) — each `who: [link:bundle.owner,
  dept_manager, admin]`, `who_fallback: [link:meeting, owner]`, never the AI.

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
private folder; or `personalOwner`, or `members` — each a member, not with a folder — and a record
linked to a members-only meeting is members-only by itself, a folder then `bad-place`: "Members-only
records"); `check(companyId, input)` is the same validation without writing (ask it before
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
field-only or link change → `not-service-owned`; a note alone that changes nothing is allowed — the
inbox's 「返事は済み」): the server clock's 「見込みの日時が過ぎた」 moves (waiting →
preparing / todo, ledger action `wait_over`, actor `CLOCK_ACTOR` = kind `external`, id
`acb:clock`; `notifications.md` "The server clock"), and the inbox's reply check (todo / in_progress /
waiting → done as the member's AI, owner FB #19, `inbox.md` "Tasks made from that message"). A
transition whose actor is a member's AI and whose `notify` names that member tells them too (the
writer otherwise never tells the actor).

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
  `dept_manager` (manages the department holding the record's path or folder), `anyone`; `system`
  (2026-11-05) — only the server's own services move it through the service writer: the engine
  refuses it to every member and AI, and no screen (`recordActionChoices`) or AI tool offers it
  (`isSystemOnly`). First use: interaction v8's `left_inbox`. `link:<name>` (task version 13) — a
  member who reads the record that link points to ("Task version 13"). `link:<name>.<field>` (decision
  version 6) — the member held in person field `<field>` of the record that link points to, only for
  a link to an interface and a person field that interface requires (`link:bundle.owner`: the まとまり's
  責任者); read from the stored value (whether there is a 責任者 is the same answer for everyone), a
  delegate standing in like for a person field. The action key **`who_fallback`** (decision version 6)
  lists entries that qualify only while none of `who`'s own people — its person fields and
  `link:<name>.<field>` entries — names a member who can read the record (`ownPeopleOf`,
  `whoWithFallback` in `record-engine/act.ts`); the parser allows it only with such an entry in `who`.
  Roles do not bypass `who`. The member's **AI** may act only where `who` lists `ai`, and then only for a
  member who qualifies on their own — so the AI cannot complete a task. When `who` is `[ai]`
  alone, only the AI of the record's own people: `assignee`, `next_actor` (the 「AI の番」 rule) or
  `requested_by` (a task the member's consultation made in 準備中) is the member — never another
  member's or another department's record, owners and admins included (audit B-M4,
  `AI_ONLY_OWNER_FIELDS` in `record-engine/act.ts`; a plugin's create, with no record yet, is not
  limited by it). Tests: `record-task-v5.test.ts` "an AI-only action is the AI of the record's own
  people only", `inbox.test.ts` "a department message taken by Bob …". `ok_from` widens `who` for a person who states whose OK it was (above), never
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
  owner/admin — or the record's assignee for a server service's entry listed in `UNDO_BY_ASSIGNEE`
  (`core-types.ts`, 2026-11-05: the inbox's `left_inbox` / `archived_there`, each told with
  ［元に戻す］; `inbox.md` "Mail archived in the mailbox"). After an undo the engine runs `afterAct`
  too (the inbox puts a mail back in the mailbox).
- **Replay** (§13.11): `replayRecordState(entries, n)` folds entries 1..n; it throws on a gap or a
  version that does not exist rather than describe another version. `GET …/versions/:version`
  answers the values plus `origin` (action, actor, kind, at, provenance of entry n).
- **Assignee must see the record**: setting `assignee` (on create, or as an action's argument)
  to a member who cannot read the record's place (private folder, scope rules — their own
  `recordReader`) → 400 `ASSIGNEE_CANNOT_READ` 「この人はこの記録を見られないため、担当にできません。…」,
  which never names the place. Test: `server/tests/unit/record-engine.test.ts` "an assignee must
  be able to see the record".
- **Notify** (duty 4): the notices go to the members named by the action's `notify` and the new
  `next_actor`, never the actor. The push channel's `records` event (kind + version only, a fresh
  value, addressed by company × member, `agent-stop.md`) goes to **every member who reads the
  record now**, named or not (`recordChanged`, `notifications.md` "The push signal"). The app refetches; it never acts on the
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
  summary, optional folder (not inside a private folder, except a task's 案件・プロジェクト's own: "A
  task and its 案件・プロジェクト"), server fields, links; the id is
  `<type>-<16 hex>`; `requested_by` defaults to the creator and `next_actor` to the assignee.

## Execution runs (stage 2 S10b, owner decision 2026-11-01)

Conversations stay on the PC; **the execution state of 「AI の番」 lives on the server**, which only
stores and checks (the AI never runs on the server). One **run** per record × AI step
(`ai_runs`, behind the company handle `aiRuns`; rules `services/ai-runs.ts`, words and classes
`shared/core/ai-runs.ts`, contract `shared/types/ai-runs.ts`). The app's side: `ai-turns.md`.

```
GET  /ai-runs                                    the member's open runs of records (session; never another subject kind)
POST /ai-run-claims                              { recordId, step, deviceId, conversationId, pluginVersion?, stepsVersion? } → a record's run
GET  /ai-runs/:runId
POST /ai-runs/:runId/renew                       { generation }
POST /ai-runs/:runId/finish                      { generation, outcome: done | failed, failure?: { class, code? } }
POST /ai-runs/:runId/retry                       「もう一度」 (a meeting's ［AI に読ませる］ does the same: ai-turns.md "Asked again")
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
  `runId` comes from the token, never a body; or, for the server's own run of a scheduled job, from
  the runner — the service writer keeps `runId` only for an AI actor or an `acb:` actor, `jobs.md` "The
  runner"). `ledgerCause` (`shared/core/record-ledger.ts`):
  `person` (a session), `ai` (the member's AI in a consultation), `run` (an automated run under
  the member's authority), `system` (`acb:` actors: the server clock, `acb:job` with its run's id), `outside` (seen in an
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
- **A run's subject kind and its state changes** (B PR 2, `ai_runs.subject_kind`, `ai_run_events`):
  `ai-turns.md` "Execution runs on the server" — what stays record-only, and the events kept.
- **The emergency stop** (`agent-stop.md` "Runs with no person present"): while the member's stop
  policy has the whole AI or a `write` / `web` / `mcp-external` kind stopped, a claim answers 503
  `AI_STOPPED` before the record is read and before anything is made or pinned (not `command`) — it
  reads only the member's own open run of that step, to keep one `refused_stopped` event for it once per
  generation (`ai-turns.md` "Each state change of a run is kept"); while the whole AI is stopped
  for the member, every call of a run-bound token answers the same (`authenticate`, after the fence).
  Renew, finish, retry and reconcile are never refused.
- Test: `server/tests/integration/ai-runs.test.ts` (the emergency stop: company-wide, one member,
  the kinds, the run's token, renew — mutation-checked; two devices → one claim; the older
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
- **A working folder** (no git): the version is the Skill shelf's (`plugins.md` "The Skill shelf in
  the app"), `dirty` when the files differ from it; only delivered Skills are reported.
- **Version** (`client/electron/services/skill-use-reporter.ts`, main): the folder is
  `.claude/skills/<name>/SKILL.md` in the working folder or a parent up to the company folder;
  version = the git tree id of that folder at HEAD (`rev-parse HEAD:<rel>` + `cat-file -t` =
  tree; the same on every PC with the same synced content) and `dirty` = `status
  --no-optional-locks --porcelain` of the folder is not empty (the tree id then names what it
  started from). **Nothing is reported** for a skill inside a private folder (a `.git` on the way:
  its name never leaves the PC, `private-folders.md`), one not in HEAD (only on this PC, e.g.
  kept private on this computer through `.git/info/exclude`), one found in two places on the way or shadowed by the
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
  403 `ACB_STOPPED`, and while the whole AI is stopped for the token's member a run-bound token
  gets 503 `AI_STOPPED` (`agent-stop.md` "Runs with no person present").
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
- **Tool search** (incident 2026-11-03: asked to add a やること, the AI searched with ToolSearch,
  got five read look-ups and told the member `records_create` was not provided). Claude Code
  defers MCP tools behind ToolSearch when there are many (the member's claude.ai connectors and
  `.mcp.json` count too), and a keyword search returns only the first few matches. So Claude gets
  every record tool with the SDK's per-tool `alwaysLoad` (`_meta['anthropic/alwaysLoad']`) except
  `onDemand` ones — the actions of types other than `task` (`ALWAYS_LOADED_ACTION_TYPES` in
  `tools.ts`; ~half the tool text on a company with the business types). The `acb_records`
  server's MCP instructions (`recordsToolSearchInstructions`, `agents/claude.ts`) name each
  on-demand tool exactly for `ToolSearch` `select:` and tell the AI never to say a record tool
  is missing before trying it. A tool without `onDemand` (connectors', plugin operations) is
  always loaded. Codex is unchanged (loopback server as before; read look-ups only). Test:
  `client/tests/claude-tool-search.test.ts` (mutation-checked).
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
`recordViews:search` / `card` / `forFile` / `topics`; shapes and wording in `client/shared/record-views.ts`,
`topics` in `client/shared/consultation-topics.ts`).
Main only reshapes the server's answers — nothing is filtered or added on the app's side.

- **Kinds** people see (`recordKindOf`): まとまり (any type implementing `bundle`: a 案件, a 企画),
  やること (`task`, `approval`), 決めたこと (`decision`), やりとり (`interaction`, `meeting`,
  `outbound_message`), そのほか (search's grouping, to be replaced by kind chips).
- **Words and icons** (言葉の決まり, owner 2026-11-02): one plain name and one icon per kind of
  thing, the same on every screen — `client/shared/thing-words.ts` (`thingName`: やること, 議事録を確認する,
  会議の記録, 来た連絡, 送るメールの下書き / 送る Slack の返事 / 送ったもの, 承認のお願い, 返事のお願い; a bundle or
  a company's type by its own label, never its id; `stateWord` per type — every state of every core
type has a word (来た連絡: 届いた・対応済み・確認待ち・部署の番・やることにしなかった; a task's AI の案;
test: no raw state of a core type); `CALM` for waiting, empty and
  failing; `NEXT_STEP`, `turnWords`, `TURN_ASKS`) and `src/shared/ui/ThingIcon.tsx` (`ThingIcon`,
  `RecordIcon`, `SourceIcon`, `SeenBy`). No 「型」, category word (やりとり, まとまり) or machine name on a
  member's screen (`tests/thing-words.test.ts`). 「確かめる」 is only a task's checker's word: a
  承認のお願い says 承認待ち・承認する・断る (owner 2026-11-02; 「阿部さんの承認待ち」). `typeLabel` / `stateLabel` in the views and the task list
  carry these words; machinery fields (hashes, outside ids,
  pointers, `next_actor`) are not on the card; person fields show the member's name
  (`GET /companies/:id/members`).
- **探す** (the left tab; never 「検索」 on screen; owner-approved redesign 2026-11-03). ⌘K opens what
  the member can name; this tab is for what they half remember. Server: `POST /records/find
  { text (1–100), today }` (`services/record-find.ts`) → `{ total, hits (newest 200), hubs (≤ 5) }`:
  each hit is a readable record with its **department** (first part of its path, or of a server-only
  record's folder; null = the whole company), **mine** (owner-only for them, a `person` field of its
  type holds them, or a meeting's `attendees`) and its **案件** (outgoing `bundle` link, only when
  readable and followable, `linkAllowed`); a **hub** is a hit implementing `bundle` / `counterpart`
  whose title holds the words, summarised over what the caller reads: open やること, meetings,
  decisions, readable file links, 案件 (for a 相手, also what is in its 案件), the next `meeting_at`
  ≥ `today`, the newest change, and the ids of its readable やること / 案件 (`memberIds`, ≤ 300). `POST
  /records/find-home { today, from, to }` → the caller's unfinished 案件 (≤ 5, with their hub) and
  their meetings with `meeting_at` in [from, to) (≤ 5). Everything goes through the reader: an
  owner-only record, a private folder's record or file is never a hit, never counted in `total` or a
  hub (`server/tests/unit/record-find.test.ts`). Main: `recordViews:find` / `recordViews:findHome`
  (reshaped by `findHitView`, nothing filtered or added). Renderer (`src/features/search/`):
  `find.ts` (pure: one row per thing — record, file, consultation —, cards for the hubs, then
  名前で見つかったもの, then 中身で見つかったもの; best sentence; kinds and chips named like everywhere,
  bundles by `GET /records/bundle-kinds`' names; scope = the department on screen with things of no
  department kept, other departments counted for 「ほかの部署にも N件」; period 1週間 / 1か月 by the
  record's last change or a file's mtime; 「自分が関わった」 keeps `mine` only, so files and other
  people's records drop out), `findRunner.ts` (one search at a time: records, `git:grep` in the
  scope's folder, file names, consultations; an older search's answers are dropped), `hooks/` (the
  runner, the empty tab), `components/` (SearchPanel, FoundRows, FindEmpty). Consultations come from
  this PC's history and are matched through `consultationLinkedRecord`
  (`client/shared/consultation-topics.ts`, `recordViews:topics`, the same answers 「AIへの相談」 reads).
  Tests: `src/features/search/find.test.ts`, `findRunner.test.ts`, `client/tests/ui/search-panel.spec.ts`
  (preview `client/tests/search-panel-ui.html`). Records off for the company: no records shown.
- **The card** (`src/features/records/components/RecordCard.tsx`): kind, state, title, summary,
  fields, 経緯 (the ledger, newest first: who・what・note) and 「つながっているもの」 (records by kind,
  files; a file link marked `broken` says 「つながりが切れています」). Following a link runs
  `record.open` / `file.open` (`commands.md`), so ← → work (`files-and-editor.md` "Places").
  Generic and without actions: a task opens in the task card with actions instead (`tasks-ui.md`).
- **A file's 「つながっているもの」**: `linkedToFile` with the open file's company path.
- **What was shown comes back at once** (owner FB #14, 2026-11-04: 「タブを切り替えるたびに『読み込み中』と
  出るのがうざい」): the middle shows only the active tab's card, so switching tabs mounts it again.
  The record card, the task card (`tasks-ui.md`) and a file's 「つながっているもの」 start from what they
  showed last and read again at once (stale-while-revalidate): `src/shared/lib/shownCache.ts`
  (`createShownCache`, one per view, ≤ 200 entries, least recently used out) through
  `src/shared/hooks/useShown.ts`. 「読み込んでいます」 only when nothing was shown before. **Renderer memory
  only** (never disk, localStorage or main); one company at a time (another company's key never
  answers), and every cache is forgotten (`forgetAllShown`) when the company changes or the member
  signs out (`appStore.setCurrentCompany`, which sign-out calls with none). An answer read as gone
  (`notFound`: deleted or no longer readable) replaces the card and is forgotten; an offline failure
  keeps what is shown. Freshness: a mounted task card re-reads on `records:changed` as before; any
  view not mounted is re-read the moment it mounts again, so a stale card shows for one read at most.
  Tests: `src/shared/lib/shownCache.test.ts` (hit, newer replaces, gone forgotten, company switch and
  sign-out, the bound), `tests/ui/tasks-layout.spec.ts` 「a task tab switched back to shows its card at
  once…」 (no 「読み込んでいます」, then the server's newer card).

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
important?, exception?, key?, quote?, said_by?, objection? }` → 201 `{ record, created: true }` (200 `created: false` for a known key; an
AI's decision with a meeting link is a candidate of the meeting's slot, the same basis `quote` answering the
existing one: `minutes.md` "Outputs made once"; a person's key with a meeting link is that meeting's).
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
  for two calls at once. Only a decision the member reads counts: one with the key they cannot read
  does not exist for them (no 409 `KEY_TAKEN`, which once told it existed) — theirs is made under an
  id of its own and found by their next call (`tests/unit/hidden-record-ids.test.ts`).

### A person confirms it (decision version 6, owner decision 2026-11-07 「決めたことを人が確かめる」)

Production had 0 decisions; once members-only meetings could record theirs (#643), the AI would read
「それでいいんじゃない？」 as decisions. Now **the AI only proposes; the person who decides makes it a decision**.

- **What the AI picks up** (the tool description, `minutesFirstMessage`): both A (someone with authority
  said it) and C (someone said it and nobody objected), with `said_by` (who said it, as the minutes name
  them, ≤ 60 characters on one line — outside text: brackets neutralized like every outside text,
  `neutralizeOutsideText`, and kept in the content store) and `objection` (`none` / `raised` /
  `unknown`). Never a postponement (「次回決めよう」「検討しよう」) or an expectation (「たぶん A 社」).
- **Who says 「そうです」** (`confirm`) and 「違う」 (`reject`): the **責任者 of the linked まとまり** — the
  `bundle` interface's `owner` (`link:bundle.owner`: the プロジェクト's 責任者, a 案件's `owner`; the core names
  no business type — implementing `bundle` already promises `owner`, so a business plugin declares its
  責任者 by what it maps into `owner`) — a department manager or an admin, as before. With **no
  まとまり, a まとまり without a 責任者, or a 責任者 who cannot read the decision** (`who_fallback`): every
  reader of its meeting (`link:meeting`, as a meeting's proposals), and for a decision with no meeting
  whoever recorded it (`owner`, 残した人). **The meeting's assignee has no part of it** any more (before,
  `owner` was the assignee). Never the AI.
- **決めた人** (`decided_by`) is the person who confirmed it (`ACTOR_ARGS`: the engine fills it; a body
  naming anyone else → 400 `BAD_VALUE`); null at creation, for a person's decision too.
- **While unconfirmed it is not a decision**: every summary the AI reads (`recordSummaries`: get, query,
  the turn lists) carries `proposalNotice` (`DECISION_PROPOSAL_NOTICE`, 「まだ確かめていない案…前例や根拠と
  して使わないでください」), and `RECORDS_INSTRUCTIONS` says never to use one as a precedent. The app names
  it 「決めたことの案」 (`thingName`, `DECISION_PROPOSAL_NAME`) apart from confirmed ones (`tasks-ui.md`
  "The minutes review card").
- **Never widened** (members-only meetings, "Members-only records"): who reads the decision is
  unchanged. A 責任者 who is not on the meeting's list cannot read it, so cannot confirm — and counts as
  no 責任者, so the meeting's people decide (otherwise nobody could: owners and admins are not on the list
  either). The screen says so: `GET /records/item/:id` adds `decisionChecks` (`DecisionCheck`, for the
  record itself when a decision and for every decision among its links): `may` (confirm / reject /
  retract — the engine's own answer, `recordEngine.whoMay`, duties 1 and 2), `responsible` (the
  責任者 who read it) and `cannotRead` (a 責任者 who cannot) — ids given only to a caller who reads that
  まとまり, since they are its field. The card: 「〇〇さんはこの会議を見られません。決めたことの案は、この
  会議を見られる人が確かめます。」 (`cannotReadLine`).
- **Migration**: `DECISION_VERSION` 6 (`migrateDecisionVersion` → `migrateCompanyDecisionVersion`, the
  "Task version 9" mechanism generalized as `migrateCompanyCoreTypeVersion`): the core definition stored
  once, every decision's index row moved, no ledger entry. Additive (fields, an action, `who` changed,
  `retract`'s `from` narrowed — not breaking). Decisions made before keep their `owner` (the meeting's
  assignee then): it only counts in `who_fallback`, where that person reads the meeting anyway.
- Test: `server/tests/unit/decision-confirm.test.ts` (the 責任者 confirms and is 決めた人; the meeting's
  assignee and its other readers cannot while there is one; the 責任者's delegate; a meeting reader with
  no まとまり or no 責任者; without a meeting the recorder only, and not with a 責任者; 違う / 取り消す notes;
  a members-only meeting's 責任者 not on the list cannot, the attendees decide, nothing widened, the card
  told — the 責任者 named only to a reader of the まとまり; `proposalNotice`; `said_by` / `objection`; the
  parser's rules; the migration once) — each guard mutation-checked; `record-service-types.test.ts`,
  `client/tests/records-tools.test.ts` (the tool's fields and words, `RECORDS_INSTRUCTIONS`, the first
  message), `client/tests/task-card.test.ts`, `meetings-app.test.ts`, `thing-words.test.ts`,
  `tests/ui/task-card.spec.ts`.

## Not yet

The plugin-SDK / admin-API surfaces, attachments sent by the AI tools,
the app's id assignment and duplicate repair, archiving finished tasks (0.6).
Members-only records ("Members-only records"): the app's screen for taking someone off a list (the
server has it); delegates (代わりの人) reading a list they are not on; approvals placed by a
members-only record; the label of members-only cards — the server's label text already reaches old apps.
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
やることにしなかった; v8 adds the system's `left_inbox`) and `reply_request` v1 (返事のお願い: service-owned, the one type whose AI may
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
