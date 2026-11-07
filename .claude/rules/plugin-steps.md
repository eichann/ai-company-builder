---
paths:
  - "client/shared/ai-turn-steps/plugin.ts"
  - "client/electron/features/ai-turns/**"
  - "server/src/services/ai-runs.ts"
  - "server/src/services/plugin-steps.ts"
  - "server/src/routes/plugin-steps.ts"
  - "server/src/ports/plugin-steps.ts"
  - "server/src/adapters/sqlite/plugin-steps.ts"
  - "server/src/db/schema/plugin-steps.ts"
  - "server/src/lib/skill-trees.ts"
  - "server/tests/integration/plugin-steps.test.ts"
  - "admin/src/app/companies/*/integrations/step-skills.tsx"
  - "admin/src/app/companies/*/integrations/step-runs.tsx"
  - "shared/core/plugin-step-runs.ts"
  - "client/electron/features/plugin-steps/**"
  - "client/shared/step-deliverables.ts"
  - "client/tests/plugin-step-auto-start.test.ts"
  - "client/tests/step-deliverable*.test.ts"
  - "client/tests/step-continue.test.ts"
---

# A plugin's steps run as AI turns (stage 4a, lane C: C5)

A contract-2 business plugin declares `steps` (`plugins.md` "Contract 2": target type and state,
`start`, procedure, tools, connector roles). When a record is at a step's (type, state):
`start: ai_turn` → the member's app runs the AI turn on the member's PC with only that step's tools;
`start: person` → a button on the record's card opens a consultation with the step's procedure
(the app's instruction to the AI: sent, shown only as 「この手順についての相談：…」, `tasks-ui.md`
"Consulting about a task").

## Server (`services/plugin-steps.ts`, wired in `composition/plugins.ts`)

- **Whose turn**: a record at an `ai_turn` step's state, readable by the member, the member (or an
  absentee they cover, `actsFor`) its `assignee` or `next_actor` — `turnOf`, used by the claim of
  an execution run named `<pluginId>__<step>` (`POST /ai-run-claims`, `ai-runs.ts`
  `usePluginSteps`) instead of a type's AI-only action. A `__` step name with the lane unbound is
  nobody's turn. `GET /me/plugin-step-turns` lists the member's such records (the app's queue).
- **Pinned per work** (owner decision 2026-11-01 night, plan §5-9): the step's first run for a
  record (the first claim, or a person's start) stores a pin in `plugin_step_pins` (one per record
  × plugin × step): the installed version + its shelf fingerprint, or — when the step is
  `overridable` and the company chose one of its Skills for it — `{ company_skill, skill, tree id }`
  (the Skill folder's git tree on the shared branch, `lib/skill-trees.ts`: the same id #403 records
  for consultations). A race of two first runs keeps one (`INSERT OR IGNORE`, read back). Later runs
  use the pin. It moves to the installed version only when that version's `upgrade.at` holds the
  record's (type, state) and the pin's version is at least `upgrade.from` (compare-and-set). A Skill
  pin never moves (a later Skill change applies to work whose first run comes later).
- **The pin is the run's procedure**: the claim puts it in `ai_runs.procedure.pin`
  (`AiRunProcedure`, `shared/core/ai-runs.ts`), so every ledger entry written in the run copies it
  (`records.md` "Which procedure": the ledger's existing copy at write time). The claim's answer
  (`run.procedure.pin`) is what the app loads.
- **The ceiling**: the installed version's step, narrowed by the pinned version's (`tools` and
  `connector_roles` both; never widened) — `stepOfRun`, bound into the C4 gate
  (`pluginOperations.usePinnedSteps`, `createPluginRunGate({ runStepOf })`). A company Skill pin
  gets the installed step's tools: a Skill never adds any. `GET /api/records-ai/plugins` still lists
  by the installed step (the gate decides each call).
- **The operator's stop overrides pins**: the installed version stopped → no claim, no start
  (409 `PROCEDURE_STOPPED`); the pinned version stopped or gone from the shelf → the same, and the
  gate refuses every call of a run pinned to it (`NOT_IN_STEP`). A replaced package under the same
  version → 409 `PROCEDURE_UNAVAILABLE`.
- **The shelf keeps pinned versions**: C2's `pinnedVersions` is bound to `pinnedVersions` here —
  plugin pins of records that still exist and are not in a final state of their type; listed only
  while on the shelf with that fingerprint and not stopped (`plugin-distribution.ts`).
- **The company's Skill per step** (owner / admin; `plugin_step_skills`): `GET
  /plugins/:pluginId/step-skills`, `PUT /plugins/:pluginId/step-skills/:step { skill | null }` —
  refused for a step that is not `overridable` (400 `STEP_NOT_OVERRIDABLE`,
  `companySkillOverrideProblem`) and for a Skill not on the shared branch (409
  `STEP_SKILL_MISSING`). Unreadable at a first run → 409 `STEP_SKILL_MISSING` (never a silent
  fall-back). A company without the shared company folder has no company Skills yet: the app
  shows `STEP_SKILL_NOT_HERE` instead of the server's 「…置いて同期して…」 for a person's start
  (`features/plugin-steps/ipc.ts`; test `ipc-company-without-folder.test.ts`). The admin console sets it in 「つなぎ先」 → the business → 「手順を会社のスキルで」
  (`admin/src/app/companies/[id]/integrations/step-skills.tsx`; only overridable steps are shown, a
  Skill name typed per step, empty = the business's own procedure).
- **A person's start**: `GET /me/plugin-steps/records/:recordId` (the steps at the record's state,
  for its card; each with the work's `pin` — null before its first run — and the step it runs:
  `procedure` file and tools of the pinned version, narrowed; the app's automatic run reads it after
  its claim), `POST /me/plugin-steps/records/:recordId/:pluginId/:step/start` (only a `start:
  person` step, 404 otherwise; the record at the step's state, else 409 `NOT_AT_STEP`): pins and
  answers `{ pin, tools, connectorRoles, … }` (`PluginStepStartView`). A consultation started this
  way is the member's own (no run): its ledger entries have no procedure (a Skill it loads through
  the Skill tool is recorded by #403).
- **A person step's consultation keeps the step's plugin power** (coordinator decision 2026-11-02):
  `POST /me/plugin-steps/consultations { conversationId, recordId, pluginId, step }` (the app sends
  it before the consultation's first turn) binds the member's consultation to the step, for good
  (`plugin_step_consultations`; never rebound — 409 `CONSULTATION_BOUND`; only a `start: person`
  step whose work was started (pinned) on a record the member reads, else 404). The member keeps
  their ordinary consultation tools, but the C4 gate treats every token of that consultation like
  the step's run (`boundStepOf` in `plugin-operation-checks.ts`: the operations gate, the connector
  roles and `GET /api/records-ai/plugins`): only that plugin's operations the step allows and its
  connector roles, narrowed by the pinned version; a company Skill pinned as its procedure never
  widens it.
- **After a meeting is read** (coordinator decision 2026-11-02; `afterAct`, bound to the record
  engine's after-action seam `useAfterAction` in `composition/plugins.ts`): when a meeting becomes `read`
  by `finish_reading` (not `fail_…` / `skip_…`), or a まとまり is linked to a meeting already read
  without one (the minutes service's `link_bundle`, told through `afterAction`; the meeting stays
  read, `minutes.md` "A まとまり chosen later"; a person's choice moves it as their AI), its `bundle` link's record —
  readable by the member — moves to a business plugin's `ai_turn` step: an enabled, not stopped
  contract-2 business plugin with an `ai_turn` step whose `for.type` is that record's type, and
  **exactly one** action of that type with `to` = one of those steps' states, the current state in
  `from` and `ai` in `who`. It runs through the engine as the same AI for the member who read the
  meeting (`who` / `mayAct`, the delegate rule, the compare-and-set), note 「会議「…」（meeting-…）を
  読んだあと」. Nothing (no guessing) when: no まとまり, the まとまり already at an `ai_turn` step's
  state (it is the AI's turn already), zero or two or more such actions, the member may not, a
  version conflict. A failure never changes the meeting's answer. The step then appears in the
  member's `GET /me/plugin-step-turns`. The core's minutes reading writes nothing of a business
  plugin (`minutes.md`).
- Another company: the record and the plugin are the same 404 as none; no turns.
- Test (after a meeting): `plugin-steps.test.ts` "a meeting read moves its まとまり…" (read → the
  deal at the step's state by the AI for the reader, its note naming the meeting — an owner-only or
  members-only meeting, or one inside a private folder or a read-restricted place, is not named: 「会議を読んだあと」, the deal's readers are not its readers — the step in the
  turns; the まとまり chosen later by a person the same — the meeting stays read, no run, once; no まとまり / already the AI's turn
  / not the assignee / two AI ways → nothing; a person-only way is not a second way) and "the core's
  minutes reading writes nothing…" (a minutes-reading run reads the deal, cannot update it) —
  mutation-checked.
- Test (person consultations): `plugin-steps.test.ts` "a person's consultation" (an ordinary
  consultation unchanged; only a started person step binds; bound → no plugin operation or role
  beyond the step's, with a company Skill as procedure; never rebound; another member's consultation
  of the same id not bound) — mutation-checked.
- Test: `server/tests/integration/plugin-steps.test.ts` (pin at the first claim, kept after a newer
  install, the gate following the pin, a new work on the new version, the pinned version listed,
  `upgrade.at` / `upgrade.from`, the operator's stop of a pinned version, a Skill pinned by tree id
  and kept after the Skill changes, not overridable refused, a person's start only for `person`
  steps at the state, the turns, another company) — mutation-checked; permission matrix rows +
  `CROSS`.

While 会議と議事録 is turned off (「使う機能」, `records.md` "Features on and off") a meeting cannot
become read (its actions are refused), so 「会議を読んだあと」 never starts a step by itself; a step's
［ボタン］ still works.

## Starting by itself (owner decisions 2026-11-06, 「仕事から Skill で成果物まで」)

A step declared `start: person` stays a button unless the company chooses 「自動で始める」 for it;
the declaration never changes. First use: div's 法人営業 `prepare_proposal` (提案書を用意する) with
the company Skill `sales-proposal-v1`.

- **The setting** (owner / admin; `plugin_step_settings`, one row per company × plugin × step:
  `auto_start`, `deliverable_folder`): `PUT /plugins/:pluginId/step-settings/:step { autoStart?,
  deliverableFolder? }` (a value left out is kept; another key → 400). `autoStart: true` only for a
  `start: person` step (400 `STEP_NOT_PERSON`); the folder one folder name
  (`deliverableFolderProblem`, `shared/core/plugin-step-runs.ts`; 400 `DELIVERABLE_FOLDER_INVALID`),
  null = from the step's label. `GET /plugins/:pluginId/step-skills` answers both with each step
  (`start`, `autoStart`, `deliverableFolder` in force, `deliverableFolderChosen`). **Default: the
  button.** Admin: 「つなぎ先」 → the business → 「手順の始め方と置き場所」
  (`admin/src/app/companies/[id]/integrations/step-runs.tsx`: 始め方 ボタンで始める / 自動で始める, and
  the folder).
- **What asks for it**: a meeting read (the same `afterAct` as "After a meeting is read") writes a
  request for every chosen step whose `for.type` is its まとまり's type (`plugin_step_requests`, one
  per record × step; a later meeting opens it again). The step is the member's 「AI の番」 only while a
  request is open, the record is at the step's state (for 法人営業: back at `open` after
  `reflect_meeting`) and the member (or whom they cover) is its assignee / next actor — `turnOf`, and
  `GET /me/plugin-step-turns` lists it with `start: 'person'`, **`auto: true`** (an app that does
  not know `auto` skips it: its parser takes only `ai_turn`). A run finished `done` answers the
  request made at or before the run's creation (`afterDoneRun`, from `ai-runs.ts` `finish`); a
  failed run leaves it open (retried as any run). Turning the setting off: no turn, no claim
  (`NOT_AI_TURN`), even with a request open.
- **The automatic ceiling** (`automaticStepCeiling`, one copy): it reads outside text (minutes)
  with nobody watching, so it never gets a tool that reaches outside — `web_research` is dropped and
  only connector roles that only read stay (`mail.read`, not `mail.send` / bare `mail`). Applied in
  the turn list, by `stepOfRun` for every run of a `start: person` step (the C4 gate: operations and
  roles), and in the app's tool mapping. Sending stays a person's (drafts only, `outbound-mail.md`);
  HubSpot writes go through the plugin's operations and their field policies as in any run.
- **Gates kept**: the step's tools are still the ceiling (a Skill adds nothing), the run is an
  ordinary execution run (one claim per record, the operator's stop, the pin), the member's
  「自動で進める」 and the company's daily limit count it like every 「AI の番」 (`ai-turns.md` "The
  rules"), the emergency stop refuses its claim.

## The deliverable folder (owner decision 2026-11-06 ③)

Whatever runs a business plugin's step — its automatic run, or a person's consultation started
from it — **writes files only under `<department>/.personal/<folder>/`**: the member's own,
never synced (`[PERSONAL_PATH]`), e.g. `法人ソリューション/.personal/提案書/2026-11-06_A社/` (the
Skill's own rule). `<folder>` is the company's setting, else the step's label when it is a folder
name, else the step's name (`deliverableFolderOf`). `.personal` never reaches the server, so the
line is drawn in the app: the chat write guard's `writeArea` (`chat-write-guard.md`). The server
gives the folder with the step (`deliverableFolder` on every step view) and, for a person's
consultation, `GET /me/plugin-steps/consultations/:conversationId` → `{ step: { recordId,
pluginId, step, deliverableFolder } | null }` (only the member's own binding; anyone else's, or
another company's, is null). The app (`electron/features/plugin-steps/write-areas.ts`): an automatic
run's folder from main's own claim; a consultation's asked once per app run and kept (not readable
→ none this turn, nothing kept). The chat server applies it to every turn of that consultation, and
refuses a business plugin step's automatic turn with no folder held (400 `AI_TURN_NOT_SUPPORTED`).
The first message (automatic) and the person's first message say where to save.

## What the step made (the card)

A step hands over what it made as **one やること** for the member, linked to the record: the AI's
`records_create` of a `task` with `links.bundle` = the record, `links.prepared` = its mail draft
(the files it could make attached from the deliverable folder, `outbound-mail.md` "Attachments"), `fields.prep_summary`
= 確かめる点, and its files linked (`records_link_file`) — existing types, links and tools, no new
syntax (`deliverablesReport` in `client/shared/ai-turn-steps/plugin.ts` tells the automatic run).
Its `.personal/` file links are the maker's alone (`records.md` "Links into .personal/"). The
automatic run is `done` only when a やること linked to the record, with a non-empty `prep_summary`,
changed after the claim (the server's claim time; `madeSince` in `claims.ts`), else `UNFINISHED`
(retried, then a person). The
record's card shows the newest open one with a preparation at its top (`pluginSteps:deliverables`,
`client/shared/step-deliverables.ts`; `StepDeliverables` in `src/features/plugin-steps/`, above
`RecordCard`, `tasks-ui.md`): 確かめる点, the files (open in the app) and the mail draft
(`PreparedMailCard`, with its PDF).

- Tests: `server/tests/integration/plugin-steps.test.ts` "a person's step the company starts by
  itself" (the button by default, only owner / admin, only a person's step, folder names, the turn
  only after a meeting and at the state, the assignee only, no sending role through the gate, done
  answers it, a new meeting asks again, a failure leaves it, off → never, another company; what the
  run hands over reaches the deal, its `.personal` file for the member only) and "a person's
  consultation" (`consultationOf` for its own member only) — mutation-checked; permission matrix
  rows; `client/tests/plugin-step-auto-start.test.ts` (only `auto` turns queued, the automatic
  ceiling and the folder held, settle by what was made, a consultation's folder asked once, the chat
  server never runs a step without its folder), `client/tests/step-deliverable-folder.test.ts`
  (inside allowed, everything else refused, a link cannot lead out), `client/tests/step-deliverables.test.ts`
  (the card gets the newest open やること's 確かめる点, files and draft; nothing otherwise),
  `admin/tests/step-runs.test.tsx` — mutation-checked.

## Prepare only, then 「続きをする」 (owner decision 2026-11-06, option B)

An automatic run has no shell, so it cannot run a procedure's scripts (a company Skill's PDF build).
It **only prepares**, and the member finishes in their own consultation.

- **What the core tells the run** (`client/shared/ai-turn-steps/plugin.ts`, generic for every
  business plugin step; the company Skill is passed on unchanged and overridden only in what the run
  cannot do anyway): every automatic plugin step run gets `AUTOMATIC_NO_SHELL_RULE` (no scripts or
  commands, skip such parts of the procedure); a person's step run by itself also gets
  `PREPARE_ONLY_RULE` (gather the materials, write the draft — e.g. the HTML — into the deliverable
  folder, write 確かめる点, one of which says plainly that the rest — scripts, the PDF — needs
  「続きをする」 by the person).
- **The mark** (no new field): the やること's first ledger entry carries the `runId` of the run that
  made it (`records.md` "Execution runs"), and that run's step is `<pluginId>__<step>`. `GET
  /me/plugin-steps/records/:recordId` answers, beside `steps`, **`continuation`**
  (`PluginStepContinuationView`: `recordId` = the deal, `pluginId`, `step`, `label`, `taskId`) for a
  deal or for the やること itself: the newest open (not done / cancelled / dismissed) やること linked
  by `bundle` with a `prep_summary`, made by a run of an installed `start: person` step **on that
  deal**, while the deal is at the step's state and the member reads both (`continuationOf` in
  `services/plugin-steps.ts`). A consultation's やること (no run), an `ai_turn` step's run, a finished
  やること or a deal moved on → null.
- **The button** 「続きをする」 (`CONTINUE_LABEL`; `ContinueStepButton` in
  `src/features/plugin-steps/`, above the deal's card and above the やること's `TaskCard` in AppShell;
  read through `pluginSteps:continuation`, again on every records signal). Pressing it:
  `pluginSteps:continue` (main; the company folder validated by `AllowedRoots` before any server
  call) = **the person's start of that step on the deal** (`POST …/start`, the work's pin, the
  procedure read on this PC) plus what the run left — the やること, its files, 確かめる点 and mail
  drafts (`pluginStepContinueMessage`) — and `pluginStep`, which `chat.newConsultation` binds on the
  first turn (`POST /me/plugin-steps/consultations`), so the C4 gate and the deliverable folder guard
  hold as for any person's start. The member's consultation has their normal tools: the procedure's
  scripts run with the person there. No new runtime.
- Tests: `server/tests/integration/plugin-steps.test.ts` 「続きをする」 (only after an automatic
  run's やること, on the deal and on the やること; none for a consultation's or an `ai_turn` run's;
  none when the deal moved on or the やること is done; the person's start of the step works with its
  folder), `client/tests/step-continue.test.ts` (the automatic first message's no-shell and
  prepare-only rules, the procedure unchanged; the continuation parsed strictly; 「続きをする」 starts
  the same step on the deal, bound, with the folder and what the run left; nothing offered or
  started without a continuation; an outside company folder refused first),
  `client/tests/plugin-step-auto-start.test.ts` (done only with a `prep_summary`) — mutation-checked.

## The app

`ai-turns.md` "A business plugin's steps": the runner's queue from `GET /me/plugin-step-turns`,
the step kind `client/shared/ai-turn-steps/plugin.ts` (the app parses these answers itself), the
procedure read from `<userData>/plugins/<id>@<version>/steps/…` (`pluginPackages.folderOf`) or the
company Skill at the pinned tree, the tool ceiling per consultation, and the card's button for
`start: person` steps.

Ready from C4 (`plugins.md` "The gate of a step's run"): claim a step's run as
`<pluginId>__<step>` (`parsePluginRunStep`; `AI_RUN_STEP_RE` allows 40 characters); the server then
lets its tokens call only that plugin's operations the step allows and the step's connector roles.
