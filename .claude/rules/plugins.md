---
paths:
  - "shared/core/plugins.ts"
  - "shared/core/plugin-*.ts"
  - "shared/core/upstream-path.ts"
  - "server/tests/unit/plugins.test.ts"
  - "server/tests/fixtures/plugins/**"
  - "shared/types/plugins.ts"
  - "server/src/ports/plugins.ts"
  - "server/src/adapters/plugin-shelf.ts"
  - "server/src/adapters/plugin-collect.ts"
  - "server/src/cli/collect-plugins.ts"
  - "server/tests/unit/plugin-collect.test.ts"
  - "server/src/adapters/sqlite/plugins.ts"
  - "server/src/services/plugin-shelf.ts"
  - "server/src/services/plugins.ts"
  - "server/src/services/plugin-service-common.ts"
  - "server/src/services/plugin-evaluation.ts"
  - "server/src/services/plugin-views.ts"
  - "server/src/services/plugin-relay-scope.ts"
  - "server/src/services/plugin-ai-tools.ts"
  - "server/src/routes/plugins.ts"
  - "server/tests/unit/plugin-shelf.test.ts"
  - "server/tests/unit/plugin-contract-v2.test.ts"
  - "server/tests/integration/plugins.test.ts"
  - "server/src/adapters/upstream-practice.ts"
  - "server/src/services/plugin-connector.ts"
  - "server/src/services/plugin-import.ts"
  - "server/tests/unit/plugin-connector.test.ts"
  - "server/tests/unit/plugin-schema-migrations.test.ts"
  - "server/tests/integration/plugin-import.test.ts"
  - "server/tests/helpers/fake-upstream.ts"
  - "server/tests/helpers/plugin-packages.ts"
  - "server/tests/fakes/hubspot/**"
  - "server/tests/fakes/google/**"
  - "server/src/services/plugin-operations.ts"
  - "server/src/services/plugin-operation-*.ts"
  - "server/src/services/plugin-mapping-check.ts"
  - "server/tests/integration/plugin-mapping-check.test.ts"
  - "admin/src/app/companies/*/integrations/**"
  - "admin/src/lib/integrations.ts"
  - "admin/tests/integrations.test.tsx"
  - "server/tests/integration/plugin-operations.test.ts"
  - "server/tests/integration/plugin-run-gate.test.ts"
  - "client/shared/plugin-operations.ts"
  - "client/electron/features/plugin-operations/**"
  - "client/src/features/chat/components/PluginOperationCard.tsx"
  - "client/tests/plugin-tools.test.ts"
  - "server/src/services/plugin-distribution.ts"
  - "server/src/composition/plugins.ts"
  - "server/tests/integration/plugin-distribution.test.ts"
  - "client/electron/features/plugins/**"
  - "client/shared/plugin-packages.ts"
  - "client/tests/plugin-packages.test.ts"
---

# Connector and business plugins (milestone 3): declaration, mapping, field policies

Owner design 「節目3 プラグインの仕組みと HubSpot」 (2026-10-31, every §6 recommendation
approved, §8 rules 1–4). A connector plugin connects a company to an outside system (HubSpot
first); a business plugin is a piece of work (「法人営業」) that may use one. Screen plugins (tabs,
isolated views) are milestone 5 and not covered here.

## Two roles: a connector is a shared part, a business plugin uses it (owner, 2026-11-01)

The dependency points one way: **business → connector**. (#372's first cut had it the other way —
`maps_to`, installing HubSpot needed 法人営業 — and the owner found that 「明確におかしい」.)

- A **connector** (HubSpot) is a company-wide shared part, like Google: installed, turned on and
  stopped on its own; it knows nothing of business plugins. Its declaration (one with a `service`)
  holds the service, `base_url`, `account_info` (the account check), `scopes` /
  `operation_scopes`, its `objects` (calls) and its `operations` — generic windows on the service
  (`refresh_deal` read a deal, `update_deal` update a deal's properties, `log_meeting` / `add_note`
  create an engagement on a deal, `create_deal`) with what each needs (`kind`, `object`,
  `attach_to`, `reaches`, `undo`, `content`, `association_type`, `correlation_property`). The
  company's install of it holds the company key (key broker; never shown), the connection and
  account, the relay read scope and the relay's read-only switch. It refuses, naming where each
  belongs now: `types` / `types/`, `maps_to`, an object's `record_type`, an operation's `who` /
  `decision` / `note` / `policy` / `fields`, `field_policy_defaults`, `mapping.yaml`.
- A **business plugin** (「法人営業」, `corporate-sales`) owns its types (and, with milestone 5, its
  flows) and carries **how it uses the connector**:
  ```yaml
  types: [deal, customer]
  connector: hubspot >= 0.3.0          # the one connector it can use, and the oldest version it accepts
  objects:                             # connector object → its type (`{}`: used without a record, e.g. contacts)
    deal: { record_type: deal }
    company: { record_type: customer }
    contact: {}
  operations:                          # the connector operations it uses, and who may run them
    update_deal: { who: [assignee, dept_manager, admin, ai], note: optional, decision: true }
    log_meeting: { who: [assignee, dept_manager, admin, ai], policy: prior }
  field_policy_defaults: { next_step: auto, stage: prior, … }
  ```
  plus `types/<name>.md` and the recommended `mapping.yaml` (field mapping, fields written back,
  people tables, policies, approvers). `connector` is the only new key: `objects` / `operations` /
  `record_type` / `who` / `decision` / `note` / `policy` / `field_policy_defaults` moved here from
  the connector (§8-1); `maps_to` is gone and `fields: mapped` (it had one value) is implied. A
  business plugin without `connector` works inside ACB only (then `objects`, `operations`,
  `field_policy_defaults` and `mapping.yaml` are refused); one never has `service`, `base_url`,
  `scopes`, `operation_scopes` or `account_info`.
- **What runs is the combination** (`combineUse(business, connector)`, `shared/core/plugins.ts`):
  the connector's facts with the business plugin's choices, keyed by the business plugin (its id /
  version; the connector's label as the outside system's name). **Only the objects and operations
  the business plugin declared are in it**, each with its `who`, rules and policies, on its own
  types — two business plugins using one connector each get their own combination and never each
  other's permissions. Refused (→ `connector-mismatch`) when the connector is another id, older than
  `connector`'s version, or lacks a used object / operation, or a used operation's object is not
  one of the business plugin's types.
- **Keyed by the business plugin** (the server gate is the pair business plugin × connector
  operation): the mapping, acknowledgements, import, links (`plugin_external_links.plugin_id`),
  operation records, the ledger's `source` / `action`, routes `/plugins/<business>/…` and the AI's
  tools (`corporate-sales__update_deal`). The import skips an outside object another business plugin
  brought in (problem 「ほかの業務の記録」), and refresh / operations / similar records only use the
  plugin's own links (`NOT_LINKED`, nothing asked outside).
- **Turning a business plugin on stores its types at once** (`storeBusinessTypes`, source
  `plugin`), connector or not. Without its connector (not installed, off, stopped, too old, no
  key…) it still works inside ACB; only its connector-backed parts (import, relay reads it relies
  on, write-back) stop, and say so (`connector-*`, the admin's 「HubSpot との行き来は止まっています」).
  Turning a connector on never needs a business plugin.
- **One owner per type name**: the core's types (`CORE_TYPE_FILES`) cannot be a business plugin's
  (refused on the shelf); in a company, installing a business plugin owning a type another
  installed business plugin owns is 409 `TYPE_OWNED_ELSEWHERE`. Connectors own none.
- **Never reused or inherited** across slightly different work (owner): another kind of sales
  gets its own business plugin, copying a type is fine. The core keeps only generic links (a
  link's target is a label, `records.md`).
- The role is not a key: a declaration with `service` is a connector (`PluginManifest.role`).
- Old shapes: `hubspot@0.1.x` (types of its own) and `hubspot@0.2.0` (`maps_to`, record types,
  `who`) are refused on the shelf with the reason; an install of one shows `not-on-shelf` and every
  business plugin using it `connector-missing` until an owner / admin chooses a current version.
  Nothing is migrated (no production data).

## A plugin is data only

- A package = `plugin.yaml` (the **declaration**) + `types/<name>.md` (a business plugin's types,
  same format as `.acb/types/`) + optional `mapping.yaml` (a business plugin's recommended
  **mapping**, checked against its connector when it runs). No program:
  the core's one connector (P5) makes the calls the declaration describes. This keeps other
  people's code off the server (0.15) and the line between the AGPL core and paid plugins clear
  (0.17).
- Shape and rules: `shared/core/plugins.ts` (`parsePluginManifest`, `validatePluginPackage`,
  `parsePluginMapping`, `combineUse`) — the one entry point every package imports; the rules live
  in one module each (`plugin-declaration.ts` the parsed shape, `plugin-declaration-rules.ts`
  forbidden keys / type names / path templates, `plugin-manifest.ts` with
  `plugin-connector-declaration.ts` / `plugin-business-declaration.ts`, `plugin-package.ts`,
  `plugin-mapping.ts`, `plugin-policies.ts`, `plugin-values.ts`). YAML is the strict `yaml-lite` subset. Keys English,
  `label`s Japanese.
- **Unknown keys make the whole package unusable**, anywhere (top level, object, endpoint,
  operation, mapping). Keys someone might reach for get a specific reason
  (`FORBIDDEN_KEY_REASONS`): a program (`script`, `code`, `command`, `exec`, `run`, `start`,
  `tools`, `hooks`), a condition or expression (`when`, `if`, `expression`, `formula`), another
  destination (`url`, `host`, `hosts`, `redirect`), a key value (`key`, `api_key`, `token`,
  `secret`), approval rights (`approve`, `approver`).
- `contract` must be one of `PLUGIN_CONTRACTS` (1, or 2 — "Contract 2" below); another value →
  not used (0.17's plugin contract). A contract-1 package is read exactly as before.
- **One destination**: `base_url` through `parseRelayBaseUrl` (https, port 443, exact public host,
  no user / query / fragment). When `service` is a built-in broker service, the host must be one
  of its hosts. The key comes from the key broker's `service` (company key, P4/P5); the
  declaration never holds or sees a key value.
- **Fixed calls**: per object at most `get` GET, `search` POST, `update` PATCH, `create` POST,
  `archive` DELETE, `properties_list` GET, `stages_list` GET (`PLUGIN_ENDPOINTS`; the method is
  fixed per call). Paths (`checkPluginPathTemplate`): `[A-Za-z0-9/_.{}-]`, `{id}` the only
  placeholder (exactly once for get / update / archive, never for the others), no `?` / `#`, and
  the relay's own path rule (`shared/core/upstream-path.ts` `checkUpstreamPath`, the same
  function `services/broker-relay.ts` uses): no `//`, `..`, `%2f`, `\`, control characters.
- **Operations** (`kind` read / update / create; the connector declares them, the business plugin's
  `operations` adds who and the rules — "Two roles"): `who` (person fields of the record's type or
  `PLUGIN_ACTORS`: `viewer` = anyone who can read the record, `ai` = the member's AI — only on
  records its owner can read and only what its owner may do —, `dept_manager`, `admin`; a plugin
  never says `anyone`), `reaches` internal / external, `undo` (update: restore_previous / none;
  create: archive / none), `note`, `decision: true` (only on operations that write: the reason
  is part of the ledger entry and **the AI must give one** — a note drafted from the
  consultation, citing its basis; optional for people. `update_deal` is a decision,
  `refresh_deal` is not). An update
  writes only the mapping's `write: true` fields. A field of kind `tags` cannot be mapped at all
  (its stored JSON text would be written outside as is; `records.md` "Tags"), test
  `tests/unit/plugins.test.ts` "a tags field cannot be mapped".
- **Creates** (milestone 4, design §3-6): every create names `correlation_property` (a unique-value
  custom property the company makes in the outside system, e.g. `acb_operation_id`; the core writes
  the operation id there so a lost answer is looked up, never re-sent). Two shapes: **attached**
  (`attach_to` an object with a record type; `content { title | body | at | outcome: <outside
  property> }` — fixed slots, no expressions — and `association_type`, e.g. HubSpot's 212 meeting →
  deal: `log_meeting`, `add_note`), or **creating a record** of the object's type in the business
  plugin (no `attach_to`, the mapping's written fields, its title from the mapping's `title.from`:
  `create_deal`). The business plugin's use of a create may carry its own `policy` (default `auto`,
  `prior` when external or creating a record); the
  company overrides it in the mapping's `policy` by operation name (`log_meeting: auto`,
  `effectiveOperationPolicy(manifest, op, mapping)`). **Creating a record is never `auto`**
  (declaration, mapping, run time), like an external operation.

## Contract 2: steps, roles, settings, screens (plan C1, stages 4a / 4b)

The syntax of 4a and 4b is fixed here once (`shared/core/plugin-flow-declaration.ts`,
`plugin-settings.ts`, `plugin-fingerprint.ts`); later items add behaviour, **not keys**. Only a
business plugin saying `contract: 2` may write the flow keys; on contract 1 they are refused
(「contract: 2 の包みだけ」), on a connector always (「業務のプラグインだけ」), so contract-1 packages
keep working unchanged.

```yaml
contract: 2
types: [deal, customer]
connector: hubspot >= 0.3.0
operations:
  update_deal: { who: [assignee, role:sales_manager, ai], decision: true }   # amount: money (types/deal.md)
  issue_invoice: { who: [role:sales_manager], decision: true, moves_money: true } # moves money, writes no money field
field_policy_defaults: { confidence: auto, next_step: auto }   # 確度・次のアクションは自動、金額は承認
roles:                                   # the business declares; who fills it is the company's (C3)
  sales_manager: { label: 営業の責任者 }
settings:                                # rung ① below: typed parameters, never branches
  approval_amount: { label: 承認が要る金額, kind: number, default: 1000000, min: 0 }
  reply_within:    { label: 返事の目安, kind: duration, default: 1d, min: 1h, max: 14d }
  amount_approver: { label: 金額を承認する人, kind: role, default: sales_manager }
  mail_service:    { label: メールを送るサービス, kind: connector, connector_role: mail.send }
steps:
  prepare_proposal:
    label: 提案書を用意する
    for: { type: deal, state: open }     # the plugin's or a core type, a non-final state
    start: person                        # person: opens a consultation; ai_turn: automatic (C5)
    procedure: { default: steps/proposal.md, overridable: true }
    tools: [records, plugin_operations, files_read, files_write]
    connector_roles: [mail.read]
ui:                                      # shown by the app's four slots (4b A6, plugin-frame.md)
  bridge: 1
  tab: { label: 案件, icon: Briefcase, entry: ui/index.html }
  peek: { implements: request, state_group: mine }
  record_sections: [{ type: deal, label: 提案の材料, entry: ui/deal.html }]
  file_actions: [{ label: 案件の資料にする, entry: ui/attach.html, kinds: [pdf, document] }]
upgrade:                                 # where work pinned to an older version may move here
  from: 0.1.0
  at: [{ type: deal, state: open }]
```

- **Steps** run on the member's PC, always: there is no key that places anything on the server
  (`runs_on`, `server`, `runtime`… are refused with that reason) and the trigger is the record's
  state (`for`) only (`cron`, `schedule`, `when`, `if` refused). `tools` is a fixed list
  (`PLUGIN_STEP_TOOLS`: records, plugin_operations — only with a connector —, approvals,
  outbound_draft, web_research, files_read, files_write); `connector_roles` are role names
  (`mail.send`) resolved against the core's list of connector roles when the step runs (that list
  is lane B's `connector-roles.ts`, not this file). **No scripts in 4a** (§5-11): `scripts` in a
  step or at the top and a `scripts/` folder are refused.
- **Procedure** (coordinator, 2026-11-02): `default` is a file under `steps/`, always present;
  `overridable: true` lets a company map the step to one of its Skills (`.claude/skills/<name>/`;
  div's `sales-proposal-v1` for 「提案書を用意する」) — the company setting is `PUT
  /plugins/:pluginId/step-skills/:step` (C5, `plugin-steps.md`), checked with
  `companySkillOverrideProblem`. The declaration never names a company Skill. **The
  step's `tools` and `connector_roles` stay the ceiling** whichever procedure runs
  (`stepToolsFor`: what a Skill asks for is cut to the step's list).
- **Pinned per work** (owner decision 2026-11-01 night): a work's step runs with what was pinned at
  its first run — the plugin procedure at version + fingerprint, or the company Skill by its
  content fingerprint (the one #403 records in consultations): `PluginStepProcedurePin`, stored by
  C5 (`plugin_step_pins`, `plugin-steps.md`). Work moves to a newer version only at `upgrade.at` points, from `upgrade.from` on. An
  emergency stop of a version stops pinned work too.
- **Roles**: declared names; `role:<name>` in a business operation's `who`, a type's action `who`
  or a mapping's `approval_by` only for a declared role (refused on contract 1). Who holds them is
  C3's (`plugin-roles.md`): the engine's `who`, the approvers and an operation's `who` resolve them.
- **Money, per field** (`money: true` on a type's field — kind `number`, `source: server`; e.g.
  `amount: { label: 金額, kind: number, source: server, money: true }` in `types/deal.md`): any
  write of that field asks first, whichever operation writes it, in any step, through any
  mapping; the operation's other fields keep their own policy (one `update_deal`: 確度・次のアクション
  `auto`, 金額 an approval request). `auto` for it is refused where it is written — the plugin's
  `field_policy_defaults` (`validatePluginPackage`) and the company mapping's `policy`
  (`parsePluginMapping`) — and held to `prior` at run time (`effectiveFieldPolicy`, also for a
  field read from the same outside property). A type's action may not name it in `args` (so no
  `ok_from` reaches it) and the record engine's create may not fill it (`records.md`). **Not
  blocked: the external writer** (`createExternalRecordWriter`, imports and confirmed writes):
  the outside system is the source of truth for money, so a mirrored amount is created and
  updated freely — never extend the money block to it (`record-money-field.test.ts` fails).
  **One place** (`plugin-declaration.ts`): `moneyField` (the field) and `asksFirst` /
  `priorFieldWriters` (the operation), joined by `writeAsksFirst`, which `effectiveFieldPolicy`
  uses. Tests: `tests/unit/plugin-contract-v2.test.ts` "a field that holds money",
  `record-types.test.ts`, `record-money-field.test.ts` (mutation-checked). Fixture: `sample-flow`.
- **Money, per operation** (`moves_money: true` on a business operation that writes; contract 2
  only, refused on a connector — the business says what its use of an operation means; for an
  operation that moves money without writing a money field, e.g. issuing an invoice): the operation asks first
  exactly like one with `reaches: external` (`asksFirst` in `plugin-declaration.ts`): its fields
  and its create policy are never `auto`: written that way it is refused (owner: make the mistake
  impossible to write) — a field it writes as `auto` in `field_policy_defaults` (`combineUse`) or
  in the mapping's `policy` (`parsePluginMapping`, via `priorFieldWriters`), a declared create
  `policy: auto`; a create's default is `prior`; and `effectiveFieldPolicy` /
  `effectiveOperationPolicy` still hold them to `prior` at run time. In a step's run it is only an approval
  request. The connector's `reaches` stays the one place for "outside"; money is the business's.
- **Screens** (`ui`): `bridge` is the bridge version (1); entries are files under `ui/` (no URL,
  no `..`); the peek is drawn by the core (no `entry`); `connect`, `csp`, `permissions`,
  `preload` refused (the frame has no network and is given nothing). `file_actions` (added with
  A6, owner decision 節目5 §40: 「やることにつなぐ…」 is the task plugin's): at most
  `MAX_PLUGIN_FILE_ACTIONS` (3) right-click items, each `{ label (≤ 30), entry, kinds }`; `kinds`
  are the core's file kinds (`shared/core/plugin-file-kinds.ts`: `file`, `folder`, `markdown`,
  `text`, `pdf`, `image`, `spreadsheet`, `document`, `slides`), never extensions or paths; the
  menu, its icon and which file is which kind are the core's (`fileActionApplies`).
- **Where an operation may be called from** (`via: [screen, plugin, run]` on a business
  operation use, contract 2 only; absent = `[screen, run]`; copied by `combineUse`; plan 4b B6):
  the operation checks refuse another caller with 403 `NOT_VIA`; from a plugin's screen (the
  bridge) an operation is only ever an approval request. Details: `plugin-frame.md`.
- **Settings** are parameters only: `number` / `duration` (`30m`, `2h`, `3d`) with `min` / `max`,
  `choice` (`options`, `option_labels`), `boolean`, `role` (a declared role or `dept_manager` /
  `admin`), `connector` (which connected service serves a connector role; no default — the
  company chooses). Every one but `connector` has a default within its bounds. Keys that would
  branch the flow (`when`, `if`, `then`, `states`, `actions`, `steps`, `next`, `goto`, `selects`,
  `enables`…) are refused: a different flow is a different plugin. A company's value is checked
  with `settingValueProblem`; steps and approval rules read them (later items).
- **Package folders**: `steps/<name>.md` (flat; exactly the files the steps name), `ui/…` (html,
  js, mjs, css, json, svg, png, jpg, gif, webp, woff, woff2; at most three folders deep, 200 files,
  2 MB each, 10 MB in all), `signature.yaml`. Contract 1 and connectors may have none of them.
- **Fingerprint v2** (contract 2): each file's sha256 over its bytes, listed `<sha256>  <path>\n` in
  name order after `acb-plugin-fingerprint-v2\n`; the fingerprint is that listing's sha256
  (`pluginFingerprintV2`, hash injected — the app computes the same in C2). `signature.yaml` is not
  part of it. Contract 1 keeps v1 byte for byte (installs keep matching).
- **Signature slot** (§5-12): `signature.yaml` = `signer` (`div`, or `company:<id>` — that
  company's own key, only for `kind: company` with `available_to: [<that id>]`), `algorithm:
  ed25519`, `key_id`, `value` (base64) over `pluginSignedMessage(id, version, fingerprint)`.
  Shape-checked on the shelf and kept as `ShelfPackage.signature`; **not verified and not
  trusted** — verification (a public key the app carries) comes before packages go to outside
  companies.

### Fitting a company the plugin does not quite fit (owner's ladder)

① **settings** (above) → ② **role assignment** (C3) → ③ **a company Skill as a step's
procedure** (`overridable`) → ④ **a company extension of a plugin type** (`.acb/types/<name>.md`,
higher version, additive — `records.md`) → ⑤ **a separate business plugin** (copy, never inherit).
Try them in that order; a declaration key that would let a company change the flow is never the
answer.

④ and plugin upgrades (C2): a company's extension of a plugin type survives a newer plugin version.
`businessTypePlan` (`services/plugin-service-common.ts`) never stores a plugin type over one whose
definition in force is the company's (`record_types.source = 'file'`); it compares them with
`companyExtensionConflicts` (`shared/core/plugin-type-upgrade.ts`): the company's version no longer
higher, or the company's definition lacking / changing something the new plugin type has
(`compareTypeDefinitions` breaking, field / link / state / action / shared type / storage). Installing
another version while on, or turning on, with a conflict → 409 `TYPE_EXTENSION_CONFLICT` +
`conflicts` (Japanese sentences naming the type), nothing changed; the company (div's FDE) updates
its `.acb/types/<name>.md` first. The import's `storeBusinessTypes` skips such a type the same way.
Company fields are never dropped. Test: `tests/integration/plugin-distribution.test.ts` (mutation-checked).

## Handing packages to the app (plan C2 「配る道」)

- **The policy lists them**: `GET /me/agent-policy` (`services/agent-policy.ts`) carries `plugins:
  [{ id, version, fingerprint, use }]` (`DistributedPlugin`, `shared/types/plugins.ts`) from
  `services/plugin-distribution.ts` `pluginsFor`: every **contract-2 business plugin the company
  turned on** whose package may be used now — on the shelf for this company, not stopped by the
  operator, the fingerprint (v2) the company chose — as `current`, plus older versions some work is
  pinned to as `pinned` (§5-9; the `pinnedVersions` dependency, bound to C5's stored pins of open work, `plugin-steps.md`:
  listed only while on the shelf with the pinned fingerprint). **The operator's stop overrides
  pins** and turning the plugin off lists nothing. Contract-1 packages and connectors have nothing
  for the app. The list is in the policy's version (ETag), so a change reaches the apps by the push
  channel: `routes/plugins.ts` announces after an install / version change and on / off; the
  operator's stop file is read on every answer (an app sees it at its next refresh, ≤ 60 s).
  `agentPolicy.usePlugins` is bound once in `composition/plugins.ts`; `policyFor` is async.
- **The package route**: `GET /api/companies/:companyId/plugins/:pluginId/package/:version` — any
  member, only a version `pluginsFor` lists now (else the same 404 `PLUGIN_NOT_FOUND` as nothing;
  another company's package never); the files are read from disk again (`PluginShelfSource.files`,
  the shelf's own rules) and handed out only when their v2 fingerprint is still the listed one (else
  409 `PACKAGE_CHANGED`). Answer `PluginPackageDownload`: every file as base64, `signature.yaml`
  too (not verified yet).
- **The app** (main only; no renderer channel until the stage-2 IPC files are free):
  `features/plugins/fetch.ts` fetches with the member's session and keeps a package only when
  every path is a package path (`isPluginPackagePath`, `shared/core/plugin-package-paths.ts`) and
  the files' v2 fingerprint (`pluginFingerprintV2`, the server's computation) equals the one **the
  policy** listed — never the answer's own. `features/plugins/store.ts` writes it to
  `<userData>/plugins/.incoming-…` and moves it to `<userData>/plugins/<id>@<version>/`; it removes
  a folder no company of any account on the computer lists any more, and a kept folder whose
  listed fingerprint changed and could not be fetched again. `index.json` there: what each account ×
  company listed, and the fingerprint each folder was verified against. Wired in
  `features/agent-control/wire.ts` on the policy store's `onPolicy` (each answer, 304 included);
  an answer without `plugins` (an older server) or with a malformed one changes nothing
  (`client/shared/plugin-packages.ts`). `pluginPackages.folderOf(company, id, version)` is what C5
  runs steps from.
- Tests: `server/tests/integration/plugin-distribution.test.ts` (what is listed and to whom, the
  files and their fingerprint, 404 for anything not listed, the stop, a replaced package, pins, the
  type-extension conflict), `client/tests/plugin-packages.test.ts` (strict parse, paths and the
  policy's fingerprint, the session header, keep / remove across companies, nothing unverified
  kept), permission matrix row + `CROSS` — each guard mutation-checked.

## What we say, and what we do not claim (review §12, owner-approved wording)

- "No program in a package": **no arbitrary code runs**; communication, authorization and
  secrets are restricted by the core. Not "isolated".
- "The hash fixes the content"; where a package comes from is guaranteed by deployment (who may
  write `PLUGINS_DIR`), not by the hash.
- `reaches: internal` = the call **writes the CRM directly**; effects through the CRM's own
  automation (workflows, notifications) are checked separately — not "no one outside is reached".
- Reading just before a write **detects known differences**; without a conditional update in
  the outside API, a change made after that read can still be overwritten (P6).
- After a lost answer we **compare the outside state with our stored evidence** and keep
  success / failure / unknown apart (P5 / P6) — not "we check whether it arrived".
- 「変更前の値を書き戻す」 **when its conditions hold**; downstream side effects are not undone (P6).
- Names needed for the work (a customer company in a deal title) are handled with permissions
  and kept on the server only — not "a company name is not personal data, so it is fine".
- The AGPL core and paid packages are **technically separated**; terms of provision depend on
  the actual setup and rights, not on this design.

## Owner rules (§8)

1. **The declaration does not grow into a language.** A system it cannot describe (computed
   values, unusual paging or auth) gets the future second kind of plugin (a program in an
   isolated place, 0.15), never conditions or expressions here. Adding a key to the declaration
   needs that argument first.
2. **Type names carry no layer** (`typeNameLayerProblem`): a name of several `_` words may not
   use `TYPE_LAYER_WORDS` (core, base, pack, industry, company, custom, official, plugin, …) nor
   the plugin's id; `deal` and a type simply called `company` are fine. So a type can move
   between core, industry pack and company without renaming records.
3. **Imported records create no files**: a business package's types must be `storage: server`
   (`validatePluginPackage`); the import itself (P5) is tested for it too.
4. **Company-specific packages are div's (FDE) work**: companies never upload declarations.
   `kind: company` needs `available_to: [<company id>, …]` (unique, 1–200); `kind: official` may
   have it. Absent = every company may use the package (`pluginAvailableTo`). A company-specific
   mapping or use of a connector is such a business package (its `available_to` on its own; the
   connector it uses may be official).
   The shelf filters with `pluginAvailableTo` (P4, below): a company not listed neither sees the
   package in any answer nor can install or enable it (`tests/integration/plugins.test.ts`,
   `tests/unit/plugin-shelf.test.ts`, permission matrix `CROSS`).

## Field policies (0.21)

- `auto` (write at once, undoable), `prior` (a person approves first — milestone 3 refuses and
  writes nothing; milestone 4 makes an approval request instead: `approvals.md`), `off`. The business plugin's `field_policy_defaults`; the company's mapping
  `policy` overrides; unspecified = `prior`; a field the mapping does not write = `off`
  (`effectiveFieldPolicy`, `effectiveOperationPolicy`).
- **`stage` is written only after an approval** (`PRIOR_ONLY_FIELDS`; milestone 3 never wrote it,
  milestone 4 design §9 q2 allows `prior` because div's 確度 is HubSpot's stage): moving the stage
  can make a deal won / lost. A mapping may say `write: true`; an `auto` default or policy for it is
  refused; at run time it is at least `prior` whatever is stored, and so is any field read from the
  same outside property.
- **Who approves** a `prior` field or create (milestone 4, design §3-4 / §9 q3; `approverFor`,
  `shared/core/approvals.ts`): the mapping's `approval_by { <field or create op>: self |
  dept_manager | admin }`, else `DEFAULT_APPROVERS` (stage / confidence `self`, amount / closed
  `dept_manager`), else `dept_manager`; a create of a record `self`. The strictest field of a request
  wins; moving `stage` to one of the mapping's `closing_stages` needs at least `dept_manager`.
  `mayApprove`: a stricter role qualifies for a looser rule; a member alone only for `self`. The
  declaration still cannot name approvers (`approve` / `approver(s)` are forbidden keys there).
- **Judged on the outside property**: a written field's policy is at least as strict as that of
  every other field read from the same outside property (off > prior > auto), so an `auto`
  field cannot reach what a stricter one reads (`effectiveFieldPolicy`).
- **`auto` needs a recorded acknowledgement** (owner, 2026-10-31): saving (or restoring) a
  mapping in which a field would write automatically needs `acknowledgeAuto: [field…]` — the
  admin confirms 「この欄の変更をきっかけに動く HubSpot のワークフローがないか確かめました」
  (`AUTO_ACKNOWLEDGEMENT`); else 400 `AUTO_NEEDS_ACKNOWLEDGEMENT` with the fields. Stored per field
  and outside property with who and when (`plugin_policy_acks`, history `acknowledge`); a field
  moved to another property needs a new one. A plugin whose automatic field lacks one does not
  run (`auto-not-acknowledged`; e.g. the package's recommended defaults right after install).
  **A create that would run automatically** (milestone 4: `log_meeting: auto`) needs the same,
  named by the operation (`acknowledgeAuto: [log_meeting]`), stored with the "property"
  `create:<object>` (`AUTO_CREATE_PREFIX`): the admin confirms no HubSpot workflow starts when such
  an object is created.
  Reading HubSpot's workflows to check this automatically would need more key scopes — an option
  for later, not taken now.
- **An operation reaching people outside the company is never `auto`**: refused in the
  declaration (an external create with `policy: auto`, auto defaults while an external update
  exists), refused in a mapping (`policy: auto` on a field an external update writes), and
  clamped to `prior` at run time whatever is stored.

## The mapping (読み替え表)

- Per company and business plugin (versioned on the server, P4); the recommended one ships in the
  business package. Read against its use of the installed connector (saving needs that connector
  installed at a version it accepts, else 409 `CONNECTOR_REQUIRED` naming it). Top level: one key per
  object with a record type, plus `people` and `policy`.
- Per object: `visible_to_folder` (a company path; not a private folder — checked by the server in
  P4), `import { pipelines, updated_within_days (1–3650), max (≤ 10,000, default 500) }`,
  `fields: { <ACB field>: { from, write, values?, people? } }`, `links: { <link of the type>:
  { from_association } }` (the design's `customer: { from_association }` sits under `links`).
- Fields name the type's server fields (or `title` / `summary`, never written back). A choice
  field needs `values` (outside value → ACB option); a person field needs `people` (a table of
  outside id → member id; ids only, never names, 13.10). `write: true` needs an update operation
  for the object, and the translation must be reversible: values and people tables one-to-one,
  no two fields writing the same outside property.
- `checkMappingAgainstProperties` (「HubSpot に聞いて確かめる」, P8): unknown properties / values
  and writing a read-only property are errors; writing an `auto_properties` entry (a property the
  outside system sets itself, e.g. HubSpot's `hs_deal_stage_probability`) is a warning.
- Translation (`externalToAcb`, `acbToExternal`): the AI's tool arguments are ACB words; the
  mapping turns them into each company's outside values (one plugin, different mappings).
  Writing refuses as a whole when any field is not written back or a value has no translation;
  reading leaves untranslatable values out and reports the field name only, never the value.

## The shelf (P4, `adapters/plugin-shelf.ts`, `services/plugin-shelf.ts`)

- `PLUGINS_DIR` (`lib/config.ts`; outside `DATA_DIR`; unset = empty shelf), put there by the
  operator (div) with `cli/collect-plugins.ts` ("Where packages come from"): one folder per package named `<id>@<version>` of its declaration, holding
  exactly `plugin.yaml`, optional `mapping.yaml`, `types/<name>.md` (contract 2 also `steps/`,
  `ui/`, `signature.yaml`; `scripts/` refused by name). Read at startup
  (`index.ts` logs what was loaded and, per refused folder, its name and the rule's sentence —
  never a file's content). **Not used**: any other file or folder (a program has no place), a
  symbolic link, a file over 256 KB, a folder name that does not match, anything
  `validatePluginPackage` refuses. Never read from a company repository; never synced.
- **Fingerprint**: v1 (contract 1) sha256 over every file's path and content; v2 (contract 2,
  "Contract 2") over each file's hash in name order. The company's install records the
  fingerprint of the version an owner/admin chose; a package changed under the same version is
  not used for that company (`package-changed`) until they choose it again. The hash fixes the
  content; it does not prove who made it — where packages come from is guaranteed by who may
  write `PLUGINS_DIR` (the operator; read-only deployment; never replace a published version).
- **`available_to`** (§8-4): a package listed for other companies does not exist for this one —
  not in `GET /plugins`, and `GET|PUT /plugins/:id…` answer the same 404 `PLUGIN_NOT_FOUND` as an
  id that exists nowhere (permission matrix `CROSS` rows with a package only the other company
  may use).
- **Server-wide stop** (the operator, kill switch 1): `<PLUGINS_DIR>/stopped`, one `id` or
  `id@version` per line (`#` comments, `*` = every package), read on every plugin call; a file
  that exists but cannot be read stops everything (fails closed). Stopping a connector stops
  every business plugin's use of it (`connector-stopped`); stopping a business plugin stops its
  own use (`stopped`).
- Connectors and business plugins are read **on their own** (`services/plugin-shelf.ts`): a business
  plugin whose connector is not on the shelf is still used (inside ACB); its combination is
  checked when it runs. Old connector shapes are refused with the reason ("Two roles").

## Where packages come from (owner, 2026-11-02)

The real packages are not in this public repository. Each lives in a **private repository per
visibility boundary** (who may read it), one folder per version `<id>@<version>/` (exactly what the
shelf holds) and a tag `<id>@<version>` per published version: one **connectors repository**
(`hubspot@*`, shared by every business plugin) and **one repository per business plugin**
(「法人営業」 `corporate-sales@*`, 「番組企画」 `program-planning@*`; a new business plugin gets its own,
the owner approves merges there). The first, shared repository is archived. A published version's
folder never changes; a fix is a new version. **Never name these private repositories (or any other
private location) in this public repository** — code, tests, rules or comments (owner, 2026-11-03);
examples use `example-org/…`.

The operator fills `PLUGINS_DIR` with `server/src/cli/collect-plugins.ts`
(`adapters/plugin-collect.ts`), run where `git` and `gh` can read those repositories (not in the api
container), then restarts the api:

```bash
cd server && node --import tsx src/cli/collect-plugins.ts --lock <plugins.lock> --dir <PLUGINS_DIR> [--prune]
cd server && node --import tsx src/cli/collect-plugins.ts --fingerprint <package folder>   # for a new lock line
```

- `plugins.lock` (the operator's file, not in this repository): `<repo> <id>@<version> <fingerprint v2>`
  per line, `#` comments; `<repo>` is `owner/name` on GitHub (cloned with `gh auth git-credential`)
  or a git URL / path.
- All or nothing: every package is fetched at its tag and its fingerprint v2 (the shelf's,
  `pluginFingerprintV2` over every file) compared with the lock before anything is written; a
  mismatch, a missing folder or a version already on the shelf with other content refuses the
  whole run. Written through a dot folder in the shelf (skipped by the shelf) and renamed into place.
- Other folders stay; `--prune` removes only `<id>@<version>` folders the lock does not list (never
  `stopped` or anything else). Output is names and fingerprints only.
- Test: `server/tests/unit/plugin-collect.test.ts` (tag content byte for byte and the shelf's own
  fingerprint, refusal on a differing fingerprint with nothing written, no replacing a version,
  prune only unlisted packages, strict lock).

## A company's install, mapping and history (P4, `services/plugins.ts`)

Code: `services/plugins.ts` (install, on / off, read scope, mappings; composes the rest),
`plugin-evaluation.ts` (`active()`'s checks, an install's `problem`), `plugin-views.ts` (the
admin page's answers), `plugin-relay-scope.ts` (`relayPolicy`, the read scope), `plugin-ai-tools.ts`
(P7), `plugin-service-common.ts` (words, `ActivePlugin`, `storeBusinessTypes`).

Owner/admin only (others 403, non-members 404); routes (`routes/plugins.ts`, contract
`shared/types/plugins.ts`) under `/api/companies/:companyId`:

```
GET  /plugins                            the shelf as this company sees it + its installs (problem per install)
GET  /plugins/:pluginId                  install, mapping in force, versions, effective field policies, mapping errors, history (50)
PUT  /plugins/:pluginId                  { version, keyId } install or change (a connector: its key; a business plugin: keyId null,
                                         its first version with a mapping.yaml = mapping version 1)
PUT  /plugins/:pluginId/enabled          { enabled } on / off (a connector needs a read scope; a business plugin stores its types)
PUT  /plugins/:pluginId/read-scope       { departmentIds, userIds } a connector: who may read it through the relay (below)
PUT  /plugins/:pluginId/mapping          { text } a business plugin: a new mapping version (YAML; field policies are its `policy`)
POST /plugins/:pluginId/mapping/restore  { version } an earlier version saved again as the next one
POST /plugins/:pluginId/mapping/check    { text? } 「HubSpot に聞いて確かめる」 (P8, below)
```

- **Starting values** (管理画面の見直し 2-4, owner decision 2026-11-02; set once, never over what a
  company chose): a business plugin's **first install turns it on** at once when it can run (as
  `PUT …/enabled` would, history `enable` with `from: install`; one that cannot stays off), and
  turns the records feature on. The departments it is used in = the departments whose folders hold
  its mapping's `visible_to_folder`s (the recommended mapping at install, or the first saved
  mapping). With them, on a business plugin's first install / first mapping and on a connector's
  first install: the connector's relay **read scope, while empty**, becomes those departments
  (history `read-scope`, `from: starting-values`), and each role the business plugin declares,
  **while never assigned**, goes to those departments' 部署の管理役 (`plugin-roles.md`). Tests:
  `tests/integration/plugins.test.ts` 「starting values」, `plugin-roles.test.ts`.
- Tables (company handle `plugins`, `adapters/sqlite/plugins.ts`): `plugin_installs` (version,
  fingerprint, enabled, `key_id`, mapping version in force), `plugin_mappings` (every version's
  YAML), `plugin_history` (install / change / enable / disable / mapping / restore; JSON without
  any secret). Triggers (`db/schema/plugins.ts` `migratePluginTables`): `key_id` must be a **company key
  of the same company** (another company's key or a member's own key throws), a mapping only
  under its own company's install, no row moves to another company
  (`tests/unit/company-data.test.ts`).
- The key (a connector's): a company key (`scope: company`) of the declaration's `service`, chosen
  by id; its value is never read here. Another company's key, a member's own key, a key of another
  service or any key for a business plugin → 400 `KEY_NOT_USABLE`.
- Server checks of a mapping (on save and on every `active()`): `people` name members of this
  company; `visible_to_folder` is not a private folder nor inside one. → 400 `MAPPING_INVALID`
  with `errors` (Japanese sentences).
- **Turning a connector on** needs its package usable and its key (else 409 `PLUGIN_NOT_READY` +
  `problem`) — no business plugin, no mapping;
  it also turns the relay's **read-only switch on** for the plugin's service (owner 0.21: writes
  go only through the plugin's typed operations; recorded in the key broker's history as the
  admin's change; turning the plugin off leaves the switch as it is). It also needs a **read
  scope** (below; else 409 `READ_SCOPE_REQUIRED`, so a forgotten setting never opens the relay to
  everyone). A change of version or key
  on a plugin that is on must keep it running (409 `PLUGIN_WOULD_STOP`, nothing changed), and a
  connector's change must not stop a turned-on business plugin's use of it (409
  `PLUGIN_WOULD_STOP`, `problem: connector-mismatch`, `dependents`; turn that business plugin off
  first). **Turning a business plugin on** needs only its package (operator stop, shelf,
  fingerprint) and stores its types; turning it off always works. Its other answers: `NOT_A_CONNECTOR`
  for a key, read scope or `connection/renew`; a connector answers `NOT_A_BUSINESS` to a mapping
  and `not-a-business` to import / operations; a business plugin without `connector`
  `NO_CONNECTOR` / `no-connector`.
- **`active(companyId, businessPluginId)`** — the business plugin's use of its connector
  (`ActivePlugin`: the combined manifest, its types and mapping, the connector's key, connection
  and account, `fingerprint` = `<business>+<connector>`), for the connector (P5) and the typed
  operations (P6), re-decided on every call, so each kill switch acts from the next call: the
  business plugin's operator stop → `stopped`; its switch → `off`; its version not on the shelf for
  this company → `not-on-shelf`; changed package → `package-changed`; its connector not installed /
  not on the shelf → `connector-missing`; the connector's operator stop, switch or changed package →
  `connector-stopped` (collecting facts — reconcile — ignores both plugins' stops and switches);
  the connector too old or lacking what is used → `connector-mismatch`; key deleted / not a company
  key of the service → `no-key`; key stopped (「鍵を止める」, 「すべての鍵を止める」) →
  `key-stopped`; the key's hosts do not include the declaration's host → `key-destination`; mapping
  missing or no longer passing → `mapping-invalid`; an automatic field not acknowledged →
  `auto-not-acknowledged`. A connector's id → `not-a-business`; a business plugin without
  `connector` → `no-connector`. An install's `problem` in the answers is the same evaluation (for a
  business plugin: about its connector-backed parts — it may be on and in use meanwhile).

## The relay and a managed connection (review §5.1 / §5.2, P4)

A connector turned on at least once makes its service a **managed connection** for the company
(`plugin_installs.managed_since`, never cleared). From then on, on **every** relay call
(`services/broker-relay.ts` step 2a, `plugins.relayPolicy`), whatever the token's age or the
plugin's switch:

- **No writes**: only GET / HEAD and POSTs to the **declared search paths** of the installed
  version (exact path, not `*/search`); a method-override header is refused → 403
  `ACB_MANAGED_BY_PLUGIN`. Turning the plugin off does not bring writes back; the key broker's
  read-only switch cannot be turned off (409 `MANAGED_BY_PLUGIN`). Writes go only through the
  plugin's typed operations (P6), which never pass the relay.
- **Reads only for the connection's read scope** (owner decision 2026-10-31, design §9
  「中継で HubSpot を読める人」; replaces P4's "only those who may see every card"): an owner /
  admin chooses, per connection, departments and / or members (`PUT /plugins/:id/read-scope
  { departmentIds, userIds }`, the admin page's 「<HubSpot> を読める人」). A member named, or who
  can read the folder of a named department (`recordReader` on the department's folder, so owners
  / admins count for a department but not by role alone), and their AI (any broker token of
  theirs) read everything the relay already allows (deals, companies, owners, contacts,
  meetings…); everyone else and their AI → 403 `ACB_READ_NOT_ALLOWED`. **No filtering by deal
  inside the scope** (owner: 「案件ごとに分けなくて良い」). **Empty = nobody**: turning on needs a
  scope, and it cannot be emptied while on (409 `READ_SCOPE_REQUIRED`; turn off first). Only this
  company's departments and members (400 `READ_SCOPE_INVALID`; table `plugin_read_scopes` behind
  the company handle, triggers: subjects of the same company, no row moves). A new connection
  (`connection/renew`) carries the scope over. History `read-scope` (ids only). Every managed relay
  call is logged in the AI action log with the member, `connection` and the path as a pattern
  (`relayPathPattern`: outside ids → `{id}`) — never a body or the key. Tests:
  `tests/integration/plugins.test.ts` 「who may read HubSpot through the relay」 (each guard
  mutation-checked), permission matrix row + `CROSS`, `company-scoped-sql.test.ts`.
- Companies whose plugin was never on keep the relay as before. **Inventory (2026-10-31)**:
  div's `法人ソリューション/.claude/skills/anken-sync` reads (owners, pipelines, deal search /
  get, v3 paths) **and writes** (creates deals, PATCHes deals, creates meetings) through the
  relay when the app gives it `ACB_HUBSPOT_*`; `weekly-report` prepares the same variables.
  Turning the HubSpot plugin on for div stops anken-sync's writes (and its v3 searches) there
  until it moves to the typed operations — an owner decision.

## Connections (review §5.7, §5.8)

- A connector's install is one **connection**: `connection_id` (new at install) and `account_id`
  (the outside account), shared by every business plugin using it (`bindAccount` /
  `connection/renew` act on the connector; the pace below is per connection). A package that writes must declare `account_info` (a GET; the connector reads
  HubSpot's `portalId` from it). The first answer binds the connection (`bindAccount`, a
  compare-and-set; history `account`); on every import and refresh (and before every P6 write)
  the account is read again, and another account → `ACCOUNT_CHANGED`: nothing is read into or
  written for the old connection until an owner/admin starts a new one (`POST
  /plugins/:id/connection/renew`, history `connection`; account bound again by the next call).
  Rotating the key keeps the connection. Outside ids are keyed by company + connection + account
  + object + external id (`plugin_external_links`), so the fake and the real HubSpot, or two
  accounts, never mix (their records are separate). Undo never writes to another account (P6).
- **Records of an earlier connection** (owner, 2026-11-01, after staging showed one deal three
  times): kept as they are — never deleted, ledger untouched — but marked in every answer
  (`fromOldConnection: true`, `notice` = `OLD_CONNECTION_LABEL`
  「前のつなぎ先から取り込んだもの（いまは使われていません）」), left out of `POST /records/query`
  unless `includeOldConnection: true`, never in 「あなたの番」, and nothing runs on them: every
  operation, `refresh_deal` included, is 409 `NOT_LINKED` with nothing asked outside. Old = no
  link of the record is on a current connection of the company's installs (`oldConnectionRecordIds`). The AI's
  tools say so (`records_query` / `records_get` descriptions, `RECORDS_INSTRUCTIONS`). Test:
  `tests/integration/plugin-import.test.ts` 「records of the earlier connection…」 (each filter
  and the company condition mutation-checked).
- **A real secret never reaches the fake**: while a service goes to its practice copy
  (`ACB_FAKE_HUBSPOT_URL`, staging; per service — `ACB_FAKE_GOOGLE_URL` alone leaves HubSpot
  real, `google-connector.md`), registering a company key, replacing one or saving an own
  key whose value is not a practice key (`pat-fake-…`, `PRACTICE_KEY_PREFIX`) is refused (400
  `REAL_KEY_ON_PRACTICE`), and the practice way out (`adapters/upstream-practice.ts`) never sends
  a request whose credential is not a practice key (`practice-real-secret`; a key saved before
  the redirect was on). Test: `tests/integration/broker-practice-upstream.test.ts`.

## The connector (P5, `services/plugin-connector.ts`)

- The only part of the core that talks to an outside system for a plugin. It makes exactly the
  declared calls — the endpoint's fixed method and path template under the one `base_url`, `{id}`
  filled with a plain outside id (`EXTERNAL_ID_RE`), a query of fixed parameter names — to the
  declared host only, through the key broker's way out (`UpstreamClient`: address checks;
  staging's practice redirect). Anything else is `not-sent` / `undeclared-call`.
- The key: `vault.reveal` right before each attempt, only into the service's credential header
  (`Authorization: Bearer` for HubSpot); never logged, stored, returned or put in an error. Error
  answers' bodies are dropped (they could echo what was sent).
- Wire format: HubSpot's CRM API (search `{ filterGroups, properties, sorts, limit, after }` →
  `{ results, paging.next.after, total }`; objects `{ id, properties, associations }`; account
  `{ portalId }`; `pipeline` and `hs_lastmodifieddate` for the import window). Another shape
  needs another connector kind in the core — never conditions in a declaration (§8-1).
- **Pace**: per company × connection at most 80 requests per 10 s and 4 searches per second
  (HubSpot Free / Starter: 100 per 10 s, search 5 per second; headroom for scripts on the same
  key), waiting rather than failing.
- **Retries differ by kind** (review §5.6). Reads (get, search, lists, account): after a 429, a
  5xx or a failed connection — wait `Retry-After` (capped at 10 s) or 1 s, 2 s, 4 s; at most 3
  retries and 15 s of waiting (HubSpot does not say how long to wait after a 429; this is our
  conservative choice). **Writes (update, create, archive) are never re-sent**: a 429 / 5xx is
  returned as is; a connection lost after sending (anything but dns / tls / a refused address) is
  `unknown` — the caller compares the outside state with its stored evidence (P6) and **never
  re-sends a create**.
- **`precheck` before every attempt**, also after each wait: the plugin's `active()` (every kill
  switch), the same connection, the records switch, and the caller's membership / role (review
  §6.5). A refusal sends nothing.

- **A deal's contacts for outbound mail** (milestone 4 G8, `outbound-mail.md`):
  `pluginImport.dealContacts(member, dealRecordId)` reads, fresh, the deal's `get` with
  `associations=contacts` and each contact's `get` (properties `email`, `firstname`, `lastname` —
  HubSpot's wire format) through the declared object `contact` (a `get` only, no record type: people
  are never imported). Only for a deal the member may read, imported through the current connection,
  by a member in the connection's read scope (`plugins.readAllowed`); the account is checked first;
  nothing is stored. A package without a `contact` object offers no HubSpot recipients.

## Import (P5, `services/plugin-import.ts`)

- `POST /plugins/:pluginId/import` (owner/admin, a business plugin; 404 for a plugin the company
  has not installed): one run per company at a time (409 `IMPORT_RUNNING`), at most 5 minutes, one
  company per run (no server-wide sweep). Needs the plugin running (409 `PLUGIN_NOT_ACTIVE` +
  `problem`) and the records switch on (409 `RECORDS_DISABLED`). The account is checked first.
- Per mapped object with a `search`: the mapping's window (`pipelines`, `updated_within_days`,
  newest first) up to `max`; per item, when the mapping has `links`, a `get` with the
  associations and the linked objects' own `get` (a target object needs a record type, a `get` and
  a mapping section; at most 20 per link). Values through `externalToAcb` (untranslatable values
  reported by field name only).
- Records are written by the engine's **external entry** (`createExternalRecordWriter`,
  `records.md` "Outside systems"): **server-only, no file, no commit** (owner rule §8-3), folder =
  the mapping's `visible_to_folder`, ledger actor `external` / the business plugin's id with a
  **receipt** (`kind: observed`: who changed it outside is not known). An outside object another
  business plugin already brought in is skipped (「ほかの業務の記録」). The business plugin's types
  are stored when it is turned on, and again here if a newer version came meanwhile.
- The report says what happened, not more (review §6.8): per object `seen / created / updated /
  unchanged / truncated` (the `max` cut it) and problem counts; status `complete`, `truncated`,
  `stopped` (a kill switch between requests), `failed`, `timed-out` — kept in the history
  (`import`). "Not in the map" never means "not in HubSpot".
- `refreshRecord(member, pluginId, recordId)` (for P6's reads and writes): only a record the
  member may read (else the same 404 as a missing one, and **nothing is asked outside**; review
  §5.1 — there is no read by outside id); only one imported through the current connection and
  account.

## Typed operations (P6, `services/plugin-operations.ts`)

Code: `services/plugin-operations.ts` composes the service (run, create, similar records, reconcile,
recreate) from `plugin-operation-checks.ts` (the checks and the precheck before every send),
`-inputs.ts` (bodies), `-records.ts` (the operation record and its view), `-sending.ts` (send,
settle, reconcile — never re-sent), `-undo.ts`, `-approvals.ts` (the approval seam), `-similar.ts` and
`-common.ts` (words, refusals, the one per-object serialiser every part shares).

```
POST /api/companies/:companyId/plugins/:pluginId/records/:recordId/operations/:operation   a person (session)
POST /api/records-ai/plugins/:pluginId/records/:recordId/operations/:operation             their AI (record token)
     update: { expectedVersion, fields: { <ACB field>: value }, note? }   read (refresh_deal): {}
     create on the record (log_meeting): { title, body?, at (ISO with offset), outcome?, note? }
POST /api/companies/:companyId/plugins/:pluginId/create/:operation   a create of a record (create_deal) { title, fields, note? }
POST /api/records-ai/plugins/:pluginId/create/:operation             the same for their AI (act token)
GET  …/plugins/:pluginId/operations/:operationId          (both; only for readers of the record)
POST /api/companies/:companyId/plugins/:pluginId/operations/:operationId/undo        people only
POST /api/companies/:companyId/plugins/:pluginId/operations/:operationId/reconcile   people only
POST /api/companies/:companyId/plugins/:pluginId/operations/:operationId/recreate    people only 「もう一度作る」
```

- Checks, each refusing with nothing sent: records switch on; the record readable by the
  member (else the same 404 as a missing record — the AI only acts on what its owner can see);
  `active()` (operator stop, company switch, package, key, mapping, acknowledged auto fields);
  the AI not stopped (also checked by the service, not only the token); the operation exists
  (a create of a record on the record route → 400 `OPERATION_CREATES_RECORD`);
  the record imported through the current connection; `who` (`viewer` → can read; `ai` only
  where listed and only for what the member may do: the engine's `mayAct`); **the AI's reason
  for a decision operation** (`REASON_REQUIRED`; people may leave it out); every field `auto`
  (a `prior` field — `stage` at best, milestone 4 — → 409 `APPROVAL_REQUIRED`, an `off` one → 400
  `FIELD_NOT_WRITABLE`; **one such field refuses the whole request**, review §6.3); values
  translatable; `expectedVersion` current. A create: its policy `auto` (`prior` → 409
  `APPROVAL_REQUIRED`, `off` → 400 `OPERATION_OFF`), below. **Over HTTP an `APPROVAL_REQUIRED`
  is never the answer**: the routes call `approvals.runOrRequest` / `createOrRequest`, which make
  the approval request instead → 202 `{ outcome: 'approval-requested', approval, existing }`
  (`approvals.md`); the service's own refusal stays for the approvals service to recognise.
- Then **serialised per outside object** (company × connection × object × id) inside this
  server (review §5.5): the outside account is checked; the object is read again — a difference
  is brought in (an `external` ledger entry) and the request refused as stale (409
  `VERSION_CONFLICT` with the current values); `expectedVersion` checked again. **Limits**: a read
  just before the write detects known differences; HubSpot's object update (2026-03) offers no
  conditional update we can rely on, so a change made in HubSpot between that read and the PATCH
  can still be overwritten. ACB reads the object back after writing and records any other
  difference as an observed change. Two ACB servers would not share the serialisation.
- **The operation record (`plugin_operations`, 操作の控え) is written before the send**: plugin
  version, fingerprint, mapping version, connection, account, outside object and id, the ACB
  fields asked, the raw outside values sent (`written`) and the **raw previous values**
  (`previous`) — those three never change (trigger). States: `pending` → `applied` (2xx: the
  ledger entry is written with the person / AI as actor, `receipt.kind: written`, the note and,
  for a decision, the reason) / `failed` (429, 4xx, nothing sent — known not applied) /
  `sent-unknown` (the answer was lost, or a 5xx) → read back once at once: the intended values
  are there → **`observed`** (recorded as an observed change; **not ACB's confirmed success,
  never undoable** — someone else may have written the same, review §5.6) — else it stays
  `sent-unknown` (`not-observed`). **A write is never re-sent** (the connector never retries
  writes). `POST …/reconcile` (the actor or an owner / admin) reads back again and works while
  the plugin is stopped or off (`active({ collectingFacts: true })`: stops stop new writes, not
  the collection of facts, §6.5).
- **Before every send** (and after any wait in the connector): the plugin still runs on the same
  connection, the records switch, the member's membership and right to act, the AI stop, and
  every field still `auto` under the mapping in force (§6.5).
- **「変更前の値を書き戻す」** (`UNDO_LABEL`; undo, people only — no AI route): only an `applied`
  update not yet undone, by its actor (an AI's change: the member it acted for) or an owner /
  admin, re-checked like a new write (stops, membership, `who`, policy), on the **same connection
  and account** (else `ACCOUNT_CHANGED`), serialised, and only while HubSpot still holds exactly
  what ACB wrote (else 409 `CHANGED_OUTSIDE` with the current values). It sends the stored raw
  previous values to the stored properties — never re-read through the current mapping (§6.1) —
  as a new operation (`operation: undo`, `undoOf`), and marks the original `undoneBy`. Every
  answer carries `undoNotice` (`UNDO_NOTICE`): HubSpot workflows and notifications that followed
  are not undone (§5.4). A value changed B → A → S → A in HubSpot looks unchanged to this check.
- Answers carry the operation record as its record's readers see it (`PluginOperationRecordView`,
  `shared/types/plugins.ts`): the record's title, `actorKind`, and for an applied write
  `changes` — each field before → after, from its ledger entry. The session routes (run, undo)
  take the app's informational provenance `conversationId` / `proposedBy`
  (`selfReportedProvenance`, records.md "Provenance"); it lands on the ledger entry and never
  authorizes anything.
- Notices: the engine's `records` signal (kind + version, no content) to the record's assignee.
- Kill switches, each from the next call (5 levels): the operator's stop file (the connector: every
  use of it; the business plugin: its own), the company's switch of either, the key's stop /
  「すべての鍵を止める」, the AI emergency stop (AI only), a field's `off` (the mapping), the
  records switch.

## Creates (milestone 4 G5, `services/plugin-operations.ts`; design §3-6, §4-4, §6-3)

- Two kinds (declaration: "Creates" above). **`log_meeting`** (attached to a deal, record route):
  the body's ACB words go to the declared `content` slots (`at` sent as epoch ms), associated to
  the deal's outside id with `association_type`. Its policy is `effectiveOperationPolicy` (the
  company's mapping `log_meeting: auto` with the acknowledgement, design §9 q17); `prior` → 409
  `APPROVAL_REQUIRED` from the service, which the routes turn into an approval request (202). A created meeting
  gets **no record**: the deal's ledger gets an entry without field changes
  (`entryWithoutChanges` on the engine's external entry, records.md), whose receipt names the
  meeting (`object: meeting`, its id, the operation). **`create_deal`** (a create of a record,
  its own route): `{ title, fields }` — title through the mapping's `title.from`, fields through
  `acbToExternal` (only `write: true` fields). **Never `auto`** (declaration, mapping, and
  `createPolicy` here): a direct request is always `APPROVAL_REQUIRED` (over HTTP: an approval
  request, 202), after every other
  check (who = may read the mapping's `visible_to_folder` + `who`); it is written only through
  `executeApproved`. The created deal becomes a record through the engine's external entry
  (server only, no file, folder `visible_to_folder`, linked in `plugin_external_links` like an
  import), its first ledger entry the requester's.
- **The correlation value**: the operation record (操作の控え) is written before the send with the
  outside properties to send, including `correlation_property` = **the operation's own id**
  (`acb_operation_id`, a unique-value property the owner makes in HubSpot). `external_id` is null
  until the answer (or a lookup) gives it; `record_id` is null for `create_deal` until the record
  exists (both set once — triggers, `migratePluginOperationCreates`).
- **Never re-sent.** Answer lost / 5xx / unreadable → `sent-unknown`, then looked up at once
  (`reconcileCreate`): the object's `get` with `idProperty=<correlation property>` (a unique
  value is found directly); a 400 there (not a unique identifier for that object) or no `get` →
  the declared `search` filtered by the value, **only `CREATE_SEARCH_DELAY_MS` (60 s) after the
  send** (HubSpot's search does not see a new object at once; before: reason `too-early`, nothing
  asked). Found → **ours** (the value proves it, unlike an update's `observed`): `applied`, reason
  `found-by-correlation`, settled like a confirmed create (record / ledger entry) and undoable.
  Not found → stays `sent-unknown`, reason `not-found` — never "does not exist". `POST
  …/reconcile` does the same while the plugin is stopped or off (collecting facts). The sample
  package's meetings have no `get` on purpose (the search path).
- **「もう一度作る」** (`recreate`, people only — the actor or an owner / admin): only for a create in
  `sent-unknown` / `not-found` not yet replaced, with `{ confirm: true }` after
  `RECREATE_WARNING` (409 `RECREATE_NEEDS_CONFIRMATION`); it looks once more, then runs the same
  input as a **new** operation (new correlation value) with every check of a direct run (a create
  needing approval stays 409); the old one gets `replaced_by`. The AI has no such route.
- **「作ったものを取り消す」** (`CREATE_UNDO_LABEL`; undo of a create, people only): an archive
  (`DELETE`, HubSpot's recycling bin) of the object an `applied` create made — its id came in the
  answer to ACB's own create or was found by ACB's correlation value — by the actor or an owner /
  admin, re-checked like a new write (stops, membership, `who`, the create not `off`), same
  connection and account, as a new operation (`undo`, `undoOf`); the record's ledger notes it.
  `CREATE_UNDO_NOTICE`: what HubSpot did after the create is not undone. An archive whose answer
  was lost: reconcile reads the object (`observed` when gone, who removed it not known).
- **Similar records** ("Similar records" below; `similarRecords(member, pluginId, operation, {
  title, meetingId })`, for the approval card, no route of its own).

## Similar records (owner decision 2026-11-02; `services/plugin-operation-similar.ts`)

Before a create of a record (`create_deal`) is approved, the approval card shows existing records
that may be the same, so duplicates are not made (div's anken-sync rule). Generic: the core names no
business type.

```yaml
# connector (hubspot): a read-only search — not an operation, never run directly
operations:
  search_deals:
    label: 似ている取引を探す
    kind: search
    object: deal                                                   # needs the object's `search` call
    counterpart: { object: company, property: associations.company } # optional: filter by the 相手's outside id
# business plugin (corporate-sales): on its create of a record
operations:
  create_deal:
    who: [viewer, ai]
    similar: { by: [counterpart, name], search: search_deals, status: stage }
```

- Declaration (any contract; contract 1 and 2 packages without it read as before):
  `similar.by` ⊆ `counterpart` / `name` (one or more, no repeats); `search` names a connector
  search (`kind: search`) on the **same object**; `status` a `choice` field of the record's type
  (its `option_labels` shown; absent → the record's state). Refused (`combineUse`): `similar` on
  anything but a create of a record, an unknown search, a search of another object, `by:
  [counterpart]` with a search that has no `counterpart`, a `counterpart.object` the business
  plugin did not make one of its types, a search listed in the business plugin's `operations`.
  A connector search takes only `label` / `kind` / `object` / `counterpart` (`object` / `property`;
  the property is an outside name — HubSpot's `associations.company`). Parsed into the connector's
  `searches` (not `operations`), resolved into the combined operation's `similar`.
- Without `similar`: `by: [name]` through the object's `search` call when it has one (milestone 4's
  behaviour) plus the title's words in ACB.
- Found, in this order, at most `SIMILAR_MAX` (5), each a live record of the create's type the
  member may read (an unreadable one does not exist — no count), not from an old connection:
  1. `counterpart`: records of that type linking to the request's 相手 — the 相手 of its meeting
     (`basis.meetingId`), every record of that 相手's 名寄せ identity (`identity.md`) and the 相手
     records with the same company domain (`identityKeysOf`, never a free-mail domain) — only 相手
     the member may read;
  2. the connector's search (read only, the member's key and checks as any read; nothing written):
     `counterpart.property EQ <outside id>` for up to 2 of those 相手 that this plugin imported
     through the current connection, and `CONTAINS_TOKEN` on the mapping's title property for up to
     3 words of the title (≤ 5 filter groups); only hits already imported as this plugin's records
     come back (`matchedBy: outside`). The account is checked first; a search that cannot be asked
     leaves ACB's own records (`outside: unavailable`), never a refusal;
  3. `name`: records of that type whose title holds one of those words.
  Each: title, status, `assignee` (when the type has that person field), last update, `matchedBy`.
- Someone who cannot run the create (cannot read its folder, `who`) gets its refusal with nothing
  asked outside. The card and 「同じ」: `approvals.md` (`same-as`).
- Tests: `tests/unit/plugins.test.ts` 「similar records before a create of a record」 (the syntax and
  each refusal), `tests/integration/approvals.test.ts` 「similar records before a new deal」 (the
  meeting's 相手, the same domain, HubSpot's search by the company, an unreadable deal left out,
  「同じ」 by requester and approver, meeting linked, nothing created — mutation-checked),
  `tests/integration/plugin-operations.test.ts` (title search, a reader of no folder asks nothing),
  `client/tests/ui/approval-card.spec.ts` (approve disabled until chosen; 「同じ」 sends the record).

## The approval seam (milestone 4 G5; the approvals service builds on it)

`services/plugin-operations.ts` exports (built in `plugin-operation-approvals.ts`), for `services/approvals.ts` (G6) only — no route here:

- `prepareApproval(member, actor, pluginId, recordId | null, operation, input) → Outcome<{ payload:
  PluginApprovalPayload; approver: ApproverRule; folder }>`: every check of a direct run (record
  readable, `active()`, AI stop, `who`, the AI's reason, values translatable, version current,
  account) except the policy gate, which must say `prior` (`APPROVAL_NOT_NEEDED` when every field
  is `auto`; an `off` field is still 400). Reads the outside object now (update: `rawBefore` per
  property; a change seen is brought in and refused as stale) and builds the fixed payload
  (`shared/core/approvals.ts`; plugin version / fingerprint, mapping version, connection, account,
  record version, raw before / after, or the create's raw properties without the correlation
  value), approver = `approverFor`, folder = the record's (or `visible_to_folder`). Sends and
  writes nothing.
- `executeApproved(approver, requestedFor { userId, actorKind, conversationId, source? }, payload,
  reason) → Outcome<PluginOperationRecordView>`: a reason (`approvalReasonProblem`); the requester
  still a member (`REQUESTER_NOT_MEMBER`), the AI not stopped; the plugin running on the payload's
  package version, fingerprint, **mapping version** and **connection** / account (else 409
  `APPROVAL_STALE`); record readable and linked to the same outside object; `who` for the
  requester; the policy not `off` (`FIELD_NOT_WRITABLE` / `OPERATION_OFF`); for an update, the
  outside raw values **still equal `rawBefore`** (else 409 `CHANGED_OUTSIDE` with the current
  values, nothing sent), for an attached create the record's version unchanged. Then the
  operation record (`approved_by`) and the send of **exactly the payload's raw values** (never
  re-translated through the mapping); ledger actor = the requester (human or AI), a decision whose
  reason is the approver's, `receipt.approvedBy`. Never re-sent on a lost answer (as above).
  A remapping after approval makes the request stale (the mapping version is part of the fixed
  content), so "raw, not re-translated" is tested by the payload's own raw value.
- Approving itself (who may, the hash, once only) is the approvals service's (G6, `approvals.md`).
- `similarRecords(member, pluginId, operation, { title, meetingId })`: shown on a
  create-of-a-record approval card (only records the viewer may read).

## The gate of a step's run (plan C4 「業務×操作の関所」)

The server gate is the pair business plugin × operation, and inside a step's run also the step.

- An execution run (`ai-turns.md`, S10b) of a business plugin's step is named
  `<pluginId>__<step>` (`parsePluginRunStep`, `plugin-operation-checks.ts`; a plugin id has no `_`).
  Any other run step (minutes reading) and a consultation's token keep what they had.
- **Operations** (`stepRefusal`, first in `recordChecks` / `newRecordChecks`, so it also covers
  approval requests through `prepareApproval`): an AI whose token is bound to such a run may call
  only **its own plugin's** declared operations (`plugins.active` — so the company switch, the
  operator stop, the package and the connector apply), only when the step's `tools` include
  `plugin_operations`, and an operation that **asks first** (`asksFirst`: `reaches: external`,
  `moves_money` or creates a record — never `auto`, never `ok_from`, never direct) only when they also include
  `approvals`: it can only become an approval request (202), never be sent.
- **Approval requests, per field** (`approvalStepRefusal`, coordinator decision 2026-11-02): an
  operation that does not ask first may still write something whose policy is `prior` — a money
  field (`money: true`), any field or create the declaration or the company keeps `prior`. Inside
  a step's run that write becomes an approval request only when the step's `tools` include
  `approvals`; otherwise the direct call and the request (`prepareApproval`, checked first) both
  get the same `NOT_IN_STEP`, nothing asked or sent. A consultation or a core step: the direct
  call answers `APPROVAL_REQUIRED` and the request is made, as before.
- **Connector roles** (`createPluginRunGate` in `plugin-ai-tools.ts`, wired in
  `composition/plugins.ts`; routes call `connectorRoleRefusal(c, h, role)` from
  `routes/record-ai-auth.ts` before using a role): only the roles the step's `connector_roles`
  declare (`mail.read` as is, or a bare `mail` for all its operations), while the plugin is
  installed here, on, on the shelf and not stopped by the operator. No AI route uses a role yet —
  lanes A / B call it when they add theirs.
- **A core step's run** (minutes reading…, plan C5): a business plugin's reads only — any other
  operation is refused (`NOT_IN_STEP`) and the tool list shows reads only; what a まとまり gets
  from a meeting is the business plugin's own step (`plugin-steps.md` "After a meeting is read").
- Every refusal is one answer, 403 `NOT_IN_STEP` 「この手順では使えない操作です」, checked before
  anything else: it does not tell another plugin, another company's, a stopped one or an
  undeclared operation apart, and nothing is asked outside.
- **The AI's tool list** (`GET /api/records-ai/plugins`, `aiTools(member, scope, runId)`): a token
  bound to such a run lists only its plugin's operations its step allows (`stepAllowsOperation`,
  the gate's own rule; a run that cannot be read lists none; a core step's run, reads only); a consultation as
  before. The gate still decides each call.
- **Roles in an operation's `who`** (`mayRunAt(…, { pluginId, recordId })`): `role:<name>` is the
  plugin's role held on the operation's record (its まとまり's override, else the company's; a
  create of a record not made yet: the company's), through `pluginRoles.holdsForPlugin`, bound
  with `pluginOperations.useRoles` in `composition/plugins.ts`; a delegate (`actsFor`) stands in
  for an absent holder. Unbound or unassigned: nobody.
- The step is the installed version's, narrowed by the run's pinned version (C5, `plugin-steps.md`:
  `usePinnedSteps` / `runStepOf`); a stopped or missing pinned version refuses every call.
- Test: `tests/integration/plugin-run-gate.test.ts` (a step without `plugin_operations`, another
  plugin's / not installed here, asks first without `approvals` then only a request, money
  (`moves_money`) never direct and only a request in a step, a `prior` write of an operation that
  does not ask first only with the step's `approvals`, the tool list per step, `role:` in an
  operation's `who` (company / まとまり / delegate), the step's
  roles only, the switch and the operator stop, a consultation unchanged, a core step reads only) —
  mutation-checked.

## 「HubSpot に聞いて確かめる」 (P8, `services/plugin-mapping-check.ts`)

- `POST /plugins/:pluginId/mapping/check { text? }` (owner/admin; 404 for a plugin not installed):
  a business plugin's; the text being edited (or the mapping in force) parsed for this company like a save (400
  `MAPPING_INVALID` + `errors`), then each mapped object's declared `properties_list` read through
  the connector and `checkMappingAgainstProperties` applied → `PluginMappingCheck` (per object
  `errors` / `warnings`, sentences only). HubSpot's answer is read as `{ results: [{ name, type,
  calculated, modificationMetadata.readOnlyValue, options, externalOptions }] }`
  (`propertiesFromAnswer`; owners are `externalOptions`, translated by `people`).
- It works **before the plugin is on and before its auto fields are acknowledged** (checking
  comes first): `plugins.forChecking` requires the business plugin's install and its connector's
  (neither stopped by the operator, the same package fingerprints, a version it accepts) and a
  usable company key (else 409 `PLUGIN_NOT_READY` + `problem`) —
  asked again as the connector's precheck with the caller's role. It writes nothing (no mapping
  version, no account binding, no record).
- HubSpot not reachable (key refused, missing scope, 429 / 5xx after the read retries…) →
  `reachable: false` + a fixed `reason`; the mapping can still be saved (design §1-5).
- Test: `tests/integration/plugin-mapping-check.test.ts` (against the fake HubSpot: findings
  of each kind right after install, nothing written, owner/admin only, the operator's stop and
  an invalid text send nothing, a refused key → not reachable and the key nowhere).

## The admin page 「つなぎ先」 (P8, `admin/src/app/companies/[id]/integrations/`)

- Owner/admin only (menu `integrations`; others see the lock and load nothing). Per package:
  version and company key (the key by its name and last 4 from `GET /broker`; never a value),
  on / off (off with a confirmation; the server's `problem` in plain words), the mapping as a
  table (ACB field by its Japanese name from the business plugin's types — `PluginDetail.labels` — with
  the identifier in small print, outside property, 「書き戻さない（読むだけ）」 / 「承認が要る」 / 「自動で書き戻す」;
  `stage` is shown as not writable) or as YAML for advanced use, versions with 「この版に戻す」,
  「HubSpot に聞いて確かめる」 on the text being edited, import with its report (and
  「新しいつなぎ先として始める」 after `ACCOUNT_CHANGED`), the history.
- The table edits the YAML (`admin/src/lib/integrations.ts`): parsed with `yaml-lite`, one field
  changed, written back (`mappingToYaml`, read back unchanged by the strict reader; comments
  are not kept). Writing back always states the field's `policy` explicitly.
- `auto` is saved only through the server's 400 `AUTO_NEEDS_ACKNOWLEDGEMENT`: the page lists
  the fields, asks for the `AUTO_ACKNOWLEDGEMENT` checkbox and resends with `acknowledgeAuto`.
- The practice HubSpot is said on the page (`practice` of the service in `GET /broker`).
- Connector and business are separate entries (owner, 2026-11-01). A connector shows version,
  key, 「<HubSpot> を読める人」 and on / off (off: every business using it stops its exchange); no
  mapping or import, and it names no business. A business shows version and on / off and, when it
  uses a connector (`PluginPackageView.connector`), whether it is connected: 「HubSpot とつながって
  います」 / 「HubSpot との行き来は止まっています：<reason>。記録はそのまま使えます。」
  (`connector-*` and key problems, `CONNECTOR_PROBLEMS` in `admin/src/lib/integrations.ts`; its
  badge stays 「使っています」), before install what the exchange needs; and its mapping and import.
  `CONNECTOR_REQUIRED` shows the server's sentence; 「新しいつなぎ先として始める」 on a business's
  import renews the connector's connection. A business inside ACB only shows version and on / off.
- No jargon on screen (no プラグイン / 型 / オントロジー; test).
- Tests: `admin/tests/integrations.test.tsx`; the requests in
  `server/tests/integration/admin-contract.test.ts`.

## The app (P7): the AI's tools and the chat card

- `GET /api/records-ai/plugins` (record token; `plugins.aiTools`): the running business plugins'
  connector operations the member's AI may call (`id` the business plugin, `label` the outside system) — `who` lists `ai`, and with a `read` token (Codex) no
  update or create; an update lists the fields it may write now (`auto` / `prior`; `off` never);
  a create (milestone 4) its policy now (`off` left out), its content slots or — creating a record
  — its fields. `client/electron/records/tools.ts` `pluginToolSpecs` turns each into a tool on
  the `acb_records` server (`corporate-sales__update_deal`, `corporate-sales__refresh_deal`,
  `corporate-sales__log_meeting`, `corporate-sales__create_deal`), generated each turn like the type
  tools (the minutes app's first message names them by their ending, `minutes.md`),
  called with the turn's record token. The app drops writes for a read token too
  (`client/tests/plugin-tools.test.ts`). The create tools say a create is **never re-sent** (an
  `unknown` outcome: do not call again — a duplicate) and that needing approval makes an approval
  request (`approval-requested`: nothing made until a person approves; the AI cannot); `create_deal`'s tells the AI to look for similar records first.
- The update tool's `note` is required for a `decision` operation; its description tells the AI to
  draft the reason from the consultation and cite the message it rests on (optional `basis {
  meetingId, quote }` for the approval card), that one approval field makes the whole request an
  approval request, and **never to claim success unless the outcome is
  `applied`** (an `unknown` result is not re-sent; the member checks).
- The outcome becomes a card in the reply (`client/shared/plugin-operations.ts`, data part
  `data-plugin-operation`, stored with the message as `pluginOperations`;
  `src/features/chat/components/PluginOperationCard.tsx`). Outcomes, only what is known:
  `applied` (before → after per field, 「AI が記録」 when the AI asked), `unchanged`, `refused`
  (ACB's checks; nothing changed), `not-sent` (HubSpot refused or could not be read), `conflict`
  (changed first; the values there now), `unknown` (answer lost, a 5xx, the app could not reach
  the server — never "updated"), `observed` (HubSpot shows it, not confirmed as ACB's; no undo).
  The AI is told the same (`aiSummaryOf`). A choice is shown by its type's `option_labels`
  (「A（高）」, not `a`): the server sends them with the AI's fields (`optionLabels`) and with every
  operation answer (`valueLabels`); the card shows them and the AI gets `…Shown` values next to
  the raw ones (plus the record's title).
- 「変更前の値を書き戻す」 on an applied card: the person's own action through IPC
  `pluginOperations:undo` (`client/electron/features/plugin-operations/ipc.ts`) with the
  member's **session**, never the record token, and the consultation as `conversationId`. The
  card always states that HubSpot workflows and notifications are not undone. An unknown card
  offers 「もう一度確かめる」 (`pluginOperations:reconcile`). The card does not re-read the
  operation on its own: after a restart the server answers the button (`NOT_UNDOABLE` when it was
  already written back).
- A create's card (`kind: 'create'`): what was made — title, time (the member's clock), outcome;
  never the body — 「<HubSpot> に作りました」 with 「作ったものを取り消す」 (the server's `undoLabel`);
  unknown → 「<HubSpot> に作れたか分かりません… HubSpot で確かめてください」 and 「もう一度確かめる」;
  `APPROVAL_REQUIRED` → `needsApproval`, 「作っていません。…」 (only from an older server; a current
  one answers `approval-requested`, which becomes the approval card instead of this one:
  `approvals.md`). 「もう一度作る」 (milestone 4 G9): once
  「もう一度確かめる」 answers `recreatable` (HubSpot did not show it), the card offers the button;
  pressing it sends IPC `pluginOperations:recreate` without `confirm`, shows the server's
  `RECREATE_WARNING` (409 `RECREATE_NEEDS_CONFIRMATION`) with 「確かめたので作る」 / 「やめる」, and
  only then sends `confirm: true` — the person's session, never the record token
  (`client/tests/plugin-tools.test.ts`).
- No jargon on the card (no 型 / プラグイン / オントロジー); the outside system is named by its
  label (HubSpot).

## Not yet (later PRs of milestone 3)

P9
staging (compose wiring of `PLUGINS_DIR`). Milestone 4: approval requests and their card (G6, on
the seam above), the 「もう一度作る」 button and similar records on a screen. `add_note` runs like
`log_meeting` (an attached create) but div does not use it. The real packages live in
private repositories ("Where packages come from"): `hubspot@0.3.0` (the connector) and `corporate-sales@0.2.0`
(「法人営業」: deal / customer, `connector: hubspot >= 0.3.0`, its recommended mapping). Its flows
(screens, actions) come with milestone 5. A business plugin uses one connector; a second one (Google
for 法人営業) would need `connector` to become a list — not before it is needed.

## Tests

`server/tests/unit/plugin-shelf.test.ts` (packages that are not data or do not pass are refused
naming only the folder; fingerprint; `available_to`; the stop list read per call, fail closed),
`server/tests/integration/plugins.test.ts` (another company's package = 404 and nothing written;
owner/admin only; keys of another company / service refused; members only, no private folder;
versions and restore; read-only relay on; no key value anywhere; every kill switch on the next
call; the managed relay: no writes from old tokens or after turning off, declared searches only,
no reads for those who cannot see the cards, the switch locked), `tests/unit/company-data.test.ts`
(handle isolation and the triggers, external links per company / connection / account),
`server/tests/unit/plugin-connector.test.ts` (declared calls only, plain ids, key only in its
header, read retries and caps, writes never re-sent, lost write = unknown, precheck after waits),
`server/tests/integration/plugin-import.test.ts` (against the fake HubSpot: no file / commit,
external ledger with receipt, declared calls only, no key anywhere, visibility, refresh only when
readable, one run per company, a stop between requests, another account and a new connection,
the records switch, deleting the key), `server/tests/integration/plugin-operations.test.ts`
(end to end against the fake HubSpot behind the practice redirect: the AI's update with its
reason and the person's 「変更前の値を書き戻す」, the AI cannot undo, Codex reads only, prior / stage /
mixed write nothing, who and read checks, a change in HubSpot before (brought in, refused) and
after (not written back), raw previous values after a remapping, a policy changed while waiting,
one PATCH for two simultaneous requests, a lost answer never re-sent and `observed` not undoable,
a 5xx `sent-unknown` and reconcile while off, every stop on the next call, a new connection never
undone through; milestone 4: log_meeting `prior` by default, `auto` only acknowledged, the AI's
meeting on the deal with the correlation value and its archive, a lost create never re-sent and not
searched before 60 s then found by its value, not found stays unknown also while off, 「もう一度作る」
only after that and confirmed, create_deal never without approval (route, AI, read token, forged
policy), similar records only readable, prepareApproval / executeApproved for create_deal and stage
(changed outside, mapping version, connection, field off, raw values sent, requester as actor), no
key in operation records or ledger), `tests/unit/plugin-schema-migrations.test.ts`, permission matrix
rows + `CROSS`, `company-scoped-sql.test.ts` (`HANDLE_TABLES`) — each guard mutation-checked.
Connector and business (owner, 2026-11-01): `tests/unit/plugins.test.ts` 「a connector is a shared
part; a business plugin uses it」 (what each refuses and where it belongs, the old shapes, `connector`
syntax, the use refused for another / older connector or what it lacks, **only declared operations
and objects in a combination**, core type names), `tests/unit/plugin-shelf.test.ts` (read on their
own, old shapes refused, `available_to` each on its own), `tests/integration/plugins.test.ts`
「two roles」 and the kill-switch test (connector alone, business types at once, connector off /
stopped / too old → `connector-*` while the business stays on, `PLUGIN_WOULD_STOP` dependents,
`TYPE_OWNED_ELSEWHERE`, `NOT_A_CONNECTOR` / `NOT_A_BUSINESS`, `CONNECTOR_REQUIRED`, the old version's
way out), `tests/integration/plugin-import.test.ts` 「two business plugins on one connector…」 (import,
refresh, operations, undeclared operation, similar records) — mutation-checked; integration tests key
the mapping / import / operations by `sample-sales` and the key / read scope / switch by `sample-hub`
(`tests/helpers/plugin-packages.ts`).
Contract 2: `server/tests/unit/plugin-contract-v2.test.ts` with `fixtures/plugins/sample-flow`
(roles, settings, both step starts, an overridable procedure, ui, upgrade; contract-1 fixtures read
as before and every flow key / folder / `role:` refused on them and on connectors; unknown keys at
every level; conditions, cron, `runs_on`, scripts, outside entries; settings that branch or break
their bounds; types / states / files of steps, frames and upgrade points; the Skill override and
the tool ceiling; fingerprint v2 and the signature slot), `tests/unit/plugin-shelf.test.ts`
「contract 2」 (v1 unchanged for contract 1, v2 changes with one byte and ignores the signature,
`scripts/` and other files refused, the v2 folders and a signature refused on contract 1).
`server/tests/unit/plugins.test.ts` with `server/tests/fixtures/plugins/` (connectors `sample-hub`
— the fake HubSpot's —, `sample-crm` — a HubSpot-shaped fictional CRM — and `sample-desk` — a
read-only company connector of another shape; the business plugins using them `sample-sales`,
`sample-crm-sales` with its recommended mapping, and `sample-support`):
unknown / program / destination / key / approval keys, contract, one https destination, unsafe
paths and methods, external never auto (declaration, mapping, run time), type names without a
layer, server-only types, `available_to`, translation both ways and per company, unambiguous
write-back, the property check — each guard mutation-checked.
