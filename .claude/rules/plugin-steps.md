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
---

# A plugin's steps run as AI turns (stage 4a, lane C: C5)

A contract-2 business plugin declares `steps` (`plugins.md` "Contract 2": target type and state,
`start`, procedure, tools, connector roles). When a record is at a step's (type, state):
`start: ai_turn` → the member's app runs the AI turn on the member's PC with only that step's tools;
`start: person` → a button on the record's card opens a consultation with the step's procedure.

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
  fall-back).
- **A person's start**: `GET /me/plugin-steps/records/:recordId` (the steps at the record's state,
  for its card; each with the work's `pin` — null before its first run — and the step it runs:
  `procedure` file and tools of the pinned version, narrowed; the app's automatic run reads it after
  its claim), `POST /me/plugin-steps/records/:recordId/:pluginId/:step/start` (only a `start:
  person` step, 404 otherwise; the record at the step's state, else 409 `NOT_AT_STEP`): pins and
  answers `{ pin, tools, connectorRoles, … }` (`PluginStepStartView`). A consultation started this
  way is the member's own (no run): its ledger entries have no procedure (a Skill it loads through
  the Skill tool is recorded by #403).
- Another company: the record and the plugin are the same 404 as none; no turns.
- Test: `server/tests/integration/plugin-steps.test.ts` (pin at the first claim, kept after a newer
  install, the gate following the pin, a new work on the new version, the pinned version listed,
  `upgrade.at` / `upgrade.from`, the operator's stop of a pinned version, a Skill pinned by tree id
  and kept after the Skill changes, not overridable refused, a person's start only for `person`
  steps at the state, the turns, another company) — mutation-checked; permission matrix rows +
  `CROSS`.

## The app

Not yet (the next PR): the runner's queue from `GET /me/plugin-step-turns`, the step kind
`client/shared/ai-turn-steps/plugin.ts`, loading the procedure from
`<userData>/plugins/<id>@<version>/steps/…` (`pluginPackages.folderOf`) or the company Skill at the
pinned tree, and the card's button.

Ready from C4 (`plugins.md` "The gate of a step's run"): claim a step's run as
`<pluginId>__<step>` (`parsePluginRunStep`; `AI_RUN_STEP_RE` allows 40 characters); the server then
lets its tokens call only that plugin's operations the step allows and the step's connector roles.
