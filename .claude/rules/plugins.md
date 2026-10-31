---
paths:
  - "shared/core/plugins.ts"
  - "shared/core/upstream-path.ts"
  - "server/tests/unit/plugins.test.ts"
  - "server/tests/fixtures/plugins/**"
  - "shared/types/plugins.ts"
  - "server/src/ports/plugins.ts"
  - "server/src/adapters/plugin-shelf.ts"
  - "server/src/adapters/sqlite/plugins.ts"
  - "server/src/services/plugin-shelf.ts"
  - "server/src/services/plugins.ts"
  - "server/src/routes/plugins.ts"
  - "server/tests/unit/plugin-shelf.test.ts"
  - "server/tests/integration/plugins.test.ts"
  - "server/src/adapters/upstream-practice.ts"
  - "server/src/services/plugin-connector.ts"
  - "server/src/services/plugin-import.ts"
  - "server/tests/unit/plugin-connector.test.ts"
  - "server/tests/unit/plugin-schema-migrations.test.ts"
  - "server/tests/integration/plugin-import.test.ts"
  - "server/tests/helpers/fake-upstream.ts"
  - "server/tests/fakes/hubspot/**"
---

# Connector plugins (milestone 3): declaration, mapping, field policies

Owner design 「節目3 プラグインの仕組みと HubSpot」 (2026-10-31, every §6 recommendation
approved, §8 rules 1–4). A connector plugin connects a company to an outside system (HubSpot
first). Screen plugins (tabs, isolated views) are milestone 5 and not covered here.

## A plugin is data only

- A package = `plugin.yaml` (the **declaration**) + `types/<name>.md` (the types it brings, same
  format as `.acb/types/`) + optional `mapping.yaml` (the recommended **mapping**). No program:
  the core's one connector (P5) makes the calls the declaration describes. This keeps other
  people's code off the server (0.15) and the line between the AGPL core and paid plugins clear
  (0.17).
- Shape and rules: `shared/core/plugins.ts` (`parsePluginManifest`, `validatePluginPackage`,
  `parsePluginMapping`). YAML is the strict `yaml-lite` subset. Keys English, `label`s Japanese.
- **Unknown keys make the whole package unusable**, anywhere (top level, object, endpoint,
  operation, mapping). Keys someone might reach for get a specific reason
  (`FORBIDDEN_KEY_REASONS`): a program (`script`, `code`, `command`, `exec`, `run`, `start`,
  `tools`, `hooks`), a condition or expression (`when`, `if`, `expression`, `formula`), another
  destination (`url`, `host`, `hosts`, `redirect`), a key value (`key`, `api_key`, `token`,
  `secret`), approval rights (`approve`, `approver`).
- `contract` must be `PLUGIN_CONTRACT` (1); another value → not used (0.17's plugin contract).
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
- **Operations** (`kind` read / update / create): `who` (person fields of the record's type or
  `PLUGIN_ACTORS`: `viewer` = anyone who can read the record, `ai` = the member's AI — only on
  records its owner can read and only what its owner may do —, `dept_manager`, `admin`; a plugin
  never says `anyone`), `reaches` internal / external, `undo` (update: restore_previous / none;
  create: archive / none), `note`, `decision: true` (only on operations that write: the reason
  is part of the ledger entry and **the AI must give one** — a note drafted from the
  consultation, citing its basis; optional for people. `update_deal` is a decision,
  `refresh_deal` is not). An update
  writes `fields: mapped` only (the mapping's `write: true` fields); a create names `attach_to`
  (an object with a record type) and may carry its own `policy`.

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
3. **Imported records create no files**: a package's types must be `storage: server`
   (`validatePluginPackage`); the import itself (P5) is tested for it too.
4. **Company-specific packages are div's (FDE) work**: companies never upload declarations.
   `kind: company` needs `available_to: [<company id>, …]` (unique, 1–200); `kind: official` may
   have it. Absent = every company may use the package (`pluginAvailableTo`).
   The shelf filters with `pluginAvailableTo` (P4, below): a company not listed neither sees the
   package in any answer nor can install or enable it (`tests/integration/plugins.test.ts`,
   `tests/unit/plugin-shelf.test.ts`, permission matrix `CROSS`).

## Field policies (0.21)

- `auto` (write at once, undoable), `prior` (a person approves first — milestone 3 refuses and
  writes nothing), `off`. Declaration defaults `field_policy_defaults`; the company's mapping
  `policy` overrides; unspecified = `prior`; a field the mapping does not write = `off`
  (`effectiveFieldPolicy`, `effectiveOperationPolicy`).
- **`stage` is never written in milestone 3** (`MILESTONE3_UNWRITABLE_FIELDS`, review §5.3,
  owner 2026-10-31): moving the stage can make a deal won / lost, the outcome `closed` guards with
  `prior`. A mapping with `write: true` on it, an `auto` default or policy for it are refused; at
  run time it is `off` whatever is stored. No fixture or example ships it writable.
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
  Reading HubSpot's workflows to check this automatically would need more key scopes — an option
  for later, not taken now.
- **An operation reaching people outside the company is never `auto`**: refused in the
  declaration (an external create with `policy: auto`, auto defaults while an external update
  exists), refused in a mapping (`policy: auto` on a field an external update writes), and
  clamped to `prior` at run time whatever is stored.

## The mapping (読み替え表)

- Per company (versioned on the server, P4); the recommended one ships in the package. Top level:
  one key per object with a record type, plus `people` and `policy`.
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
  operator (div): one folder per package named `<id>@<version>` of its declaration, holding
  exactly `plugin.yaml`, optional `mapping.yaml`, `types/<name>.md`. Read at startup
  (`index.ts` logs what was loaded and, per refused folder, its name and the rule's sentence —
  never a file's content). **Not used**: any other file or folder (a program has no place), a
  symbolic link, a file over 256 KB, a folder name that does not match, anything
  `validatePluginPackage` refuses. Never read from a company repository; never synced.
- **Fingerprint**: sha256 over every file's path and content. The company's install records the
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
  that exists but cannot be read stops everything (fails closed).

## A company's install, mapping and history (P4, `services/plugins.ts`)

Owner/admin only (others 403, non-members 404); routes (`routes/plugins.ts`, contract
`shared/types/plugins.ts`) under `/api/companies/:companyId`:

```
GET  /plugins                            the shelf as this company sees it + its installs (problem per install)
GET  /plugins/:pluginId                  install, mapping in force, versions, effective field policies, mapping errors, history (50)
PUT  /plugins/:pluginId                  { version, keyId } install (first time: the package's mapping.yaml = version 1) or change
PUT  /plugins/:pluginId/enabled          { enabled } on / off
PUT  /plugins/:pluginId/mapping          { text } a new mapping version (YAML; field policies are its `policy`)
POST /plugins/:pluginId/mapping/restore  { version } an earlier version saved again as the next one
```

- Tables (company handle `plugins`, `adapters/sqlite/plugins.ts`): `plugin_installs` (version,
  fingerprint, enabled, `key_id`, mapping version in force), `plugin_mappings` (every version's
  YAML), `plugin_history` (install / change / enable / disable / mapping / restore; JSON without
  any secret). Triggers (`db/index.ts` `migratePluginTables`): `key_id` must be a **company key
  of the same company** (another company's key or a member's own key throws), a mapping only
  under its own company's install, no row moves to another company
  (`tests/unit/company-data.test.ts`).
- The key: a company key (`scope: company`) of the declaration's `service`, chosen by id; its
  value is never read here. Another company's key, a member's own key or a key of another
  service → 400 `KEY_NOT_USABLE`.
- Server checks of a mapping (on save and on every `active()`): `people` name members of this
  company; `visible_to_folder` is not a private folder nor inside one. → 400 `MAPPING_INVALID`
  with `errors` (Japanese sentences).
- **Turning on** needs everything `active()` checks (else 409 `PLUGIN_NOT_READY` + `problem`);
  it also turns the relay's **read-only switch on** for the plugin's service (owner 0.21: writes
  go only through the plugin's typed operations; recorded in the key broker's history as the
  admin's change; turning the plugin off leaves the switch as it is). A change of version or key
  on a plugin that is on must keep it running (409 `PLUGIN_WOULD_STOP`, nothing changed).
- **`active(companyId, pluginId)`** — for the connector (P5) and the typed operations (P6),
  re-decided on every call, so each kill switch acts from the next call: the operator's stop →
  `stopped`; the company's switch → `off`; installed version not on the shelf for this company
  → `not-on-shelf`; changed package → `package-changed`; key deleted / not a company key of the
  service → `no-key`; key stopped (「鍵を止める」, 「すべての鍵を止める」) → `key-stopped`; the key's
  hosts do not include the declaration's host → `key-destination`; mapping missing or no longer
  passing → `mapping-invalid`.

## The relay and a managed connection (review §5.1 / §5.2, P4)

A plugin turned on at least once makes its service a **managed connection** for the company
(`plugin_installs.managed_since`, never cleared). From then on, on **every** relay call
(`services/broker-relay.ts` step 2a, `plugins.relayPolicy`), whatever the token's age or the
plugin's switch:

- **No writes**: only GET / HEAD and POSTs to the **declared search paths** of the installed
  version (exact path, not `*/search`); a method-override header is refused → 403
  `ACB_MANAGED_BY_PLUGIN`. Turning the plugin off does not bring writes back; the key broker's
  read-only switch cannot be turned off (409 `MANAGED_BY_PLUGIN`). Writes go only through the
  plugin's typed operations (P6), which never pass the relay.
- **Reads only for those who may see every card**: the member must be able to read the place of
  every mapped object (`visible_to_folder`; an invalid mapping → owners / admins only), else 403
  `ACB_READ_NOT_ALLOWED`. The relay cannot apply record permissions to each outside answer, and
  it reaches more than the cards (contacts, other deals): this rule only stops people who
  cannot see the cards; whom the relay serves beyond that is an owner decision (open).
- Companies whose plugin was never on keep the relay as before. **Inventory (2026-10-31)**:
  div's `法人ソリューション/.claude/skills/anken-sync` reads (owners, pipelines, deal search /
  get, v3 paths) **and writes** (creates deals, PATCHes deals, creates meetings) through the
  relay when the app gives it `ACB_HUBSPOT_*`; `weekly-report` prepares the same variables.
  Turning the HubSpot plugin on for div stops anken-sync's writes (and its v3 searches) there
  until it moves to the typed operations — an owner decision.

## Connections (review §5.7, §5.8)

- An install is one **connection**: `connection_id` (new at install) and `account_id` (the outside
  account). A package that writes must declare `account_info` (a GET; the connector reads
  HubSpot's `portalId` from it). The first answer binds the connection (`bindAccount`, a
  compare-and-set; history `account`); on every import and refresh (and before every P6 write)
  the account is read again, and another account → `ACCOUNT_CHANGED`: nothing is read into or
  written for the old connection until an owner/admin starts a new one (`POST
  /plugins/:id/connection/renew`, history `connection`; account bound again by the next call).
  Rotating the key keeps the connection. Outside ids are keyed by company + connection + account
  + object + external id (`plugin_external_links`), so the fake and the real HubSpot, or two
  accounts, never mix (their records are separate). Undo never writes to another account (P6).
- **A real secret never reaches the fake**: while a service goes to its practice copy
  (`ACB_FAKE_HUBSPOT_URL`, staging), registering a company key, replacing one or saving an own
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

## Import (P5, `services/plugin-import.ts`)

- `POST /plugins/:pluginId/import` (owner/admin; 404 for a plugin the company has not
  installed): one run per company at a time (409 `IMPORT_RUNNING`), at most 5 minutes, one
  company per run (no server-wide sweep). Needs the plugin running (409 `PLUGIN_NOT_ACTIVE` +
  `problem`) and the records switch on (409 `RECORDS_DISABLED`). The account is checked first.
- Per mapped object with a `search`: the mapping's window (`pipelines`, `updated_within_days`,
  newest first) up to `max`; per item, when the mapping has `links`, a `get` with the
  associations and the linked objects' own `get` (a target object needs a record type, a `get` and
  a mapping section; at most 20 per link). Values through `externalToAcb` (untranslatable values
  reported by field name only).
- Records are written by the engine's **external entry** (`createExternalRecordWriter`,
  `records.md` "Outside systems"): **server-only, no file, no commit** (owner rule §8-3), folder =
  the mapping's `visible_to_folder`, ledger actor `external` / the plugin id with a **receipt**
  (`kind: observed`: who changed it outside is not known). The package's types are stored with
  source `plugin` unless a version at least as new is there.
- The report says what happened, not more (review §6.8): per object `seen / created / updated /
  unchanged / truncated` (the `max` cut it) and problem counts; status `complete`, `truncated`,
  `stopped` (a kill switch between requests), `failed`, `timed-out` — kept in the history
  (`import`). "Not in the map" never means "not in HubSpot".
- `refreshRecord(member, pluginId, recordId)` (for P6's reads and writes): only a record the
  member may read (else the same 404 as a missing one, and **nothing is asked outside**; review
  §5.1 — there is no read by outside id); only one imported through the current connection and
  account.

## Not yet (later PRs of milestone 3)

P6 typed operations, undo and the remaining stops (AI stop, field
`off`, records switch); P7 the app's tools; P8 the admin page 「つなぎ先」 (it writes the mapping's
YAML, also from its table form); P9 staging (compose wiring of `PLUGINS_DIR`). The real HubSpot
package lives in the private `acb-plugins` repository (§6-6).

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
the records switch, deleting the key), `tests/unit/plugin-schema-migrations.test.ts`, permission matrix
rows + `CROSS`, `company-scoped-sql.test.ts` (`HANDLE_TABLES`) — each guard mutation-checked.
`server/tests/unit/plugins.test.ts` with `server/tests/fixtures/plugins/` (`sample-crm`, a
HubSpot-shaped fictional CRM; `sample-desk`, a read-only company package of another shape):
unknown / program / destination / key / approval keys, contract, one https destination, unsafe
paths and methods, external never auto (declaration, mapping, run time), type names without a
layer, server-only types, `available_to`, translation both ways and per company, unambiguous
write-back, the property check — each guard mutation-checked.
