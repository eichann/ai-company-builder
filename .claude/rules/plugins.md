---
paths:
  - "shared/core/plugins.ts"
  - "shared/core/upstream-path.ts"
  - "server/tests/unit/plugins.test.ts"
  - "server/tests/fixtures/plugins/**"
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
  `ai`, `dept_manager`, `admin`, `anyone` — the engine's `mayAct` reading), `reaches` internal /
  external, `undo` (update: restore_previous / none; create: archive / none), `note`. An update
  writes `fields: mapped` only (the mapping's `write: true` fields); a create names `attach_to`
  (an object with a record type) and may carry its own `policy`.

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
   **P4 requirement**: the shelf filters with `pluginAvailableTo` — a company not listed neither
   sees the package in any answer nor can enable it (test both in P4).

## Field policies (0.21)

- `auto` (write at once, undoable), `prior` (a person approves first — milestone 3 refuses and
  writes nothing), `off`. Declaration defaults `field_policy_defaults`; the company's mapping
  `policy` overrides; unspecified = `prior`; a field the mapping does not write = `off`
  (`effectiveFieldPolicy`, `effectiveOperationPolicy`).
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

## Not yet (later PRs of milestone 3)

P4 the shelf (`PLUGINS_DIR`, fingerprints, `available_to` filtering) and per-company install /
mapping versions / history (company handle); P5 the connector and import; P6 typed operations,
undo and stops; P7 the app's tools; P8 the admin page 「つなぎ先」. The real HubSpot package lives
in the private `acb-plugins` repository (§6-6).

## Tests

`server/tests/unit/plugins.test.ts` with `server/tests/fixtures/plugins/` (`sample-crm`, a
HubSpot-shaped fictional CRM; `sample-desk`, a read-only company package of another shape):
unknown / program / destination / key / approval keys, contract, one https destination, unsafe
paths and methods, external never auto (declaration, mapping, run time), type names without a
layer, server-only types, `available_to`, translation both ways and per company, unambiguous
write-back, the property check — each guard mutation-checked.
