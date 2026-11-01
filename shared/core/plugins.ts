/**
 * Plugins that connect ACB to an outside system (milestone 3, 「つなぎ先の
 * プラグイン」) and the business plugins that use them: one copy of
 * their shape for the server (the shelf, the connector), the admin console
 * (the mapping editor) and, later, the app.
 *
 * Two roles (owner decision 2026-11-01, revised the same day): **a connector
 * is a company-wide shared part; a business plugin owns its types and flows
 * and uses a connector.** A connector (HubSpot) has a `service`, `base_url`,
 * the account check and its objects and operations — generic windows on the
 * service (read a deal, update a deal's properties, create a meeting…) — and
 * knows nothing of business plugins. A business plugin (「法人営業」,
 * `corporate-sales`) declares `types` and, optionally, the one connector it
 * can use (`connector: hubspot >= 0.3.0`): which connector objects become
 * which of its types (`objects`), which connector operations it uses and who
 * may run them (`operations`), its field policy defaults and its recommended
 * mapping. The dependency points one way (business → connector);
 * `combineUse` joins the two into what runs. Business plugins are never
 * shared or inherited between slightly different work: copying a type into
 * another business plugin is fine.
 *
 * A plugin is data only (owner decision §6-1): a **declaration**
 * (`plugin.yaml`: a connector's destination, fixed paths and operations; a
 * business plugin's types, connector use and recommended field policies), the
 * **types** a business plugin brings (`types/<name>.md`, same format as
 * `.acb/types/`) and its recommended **mapping** (which ACB field is which
 * outside property). The core's one connector performs the calls; a
 * declaration has no place for a program, a destination other than its one
 * `base_url`, a key value, approval rights or a computed value — unknown keys
 * make the whole package unusable.
 *
 * Contract 2 (stages 4a / 4b, `plugin-flow-declaration.ts`) adds to a business
 * plugin its `roles`, `settings` (parameters only), `steps` (instructions under `steps/`, run on the
 * member's PC — never on the server), `ui` (frames under `ui/`, with the
 * bridge version) and `upgrade`, and to every package the signature slot and
 * fingerprint v2 (`plugin-fingerprint.ts`). `scripts/` is refused. Contract 1
 * packages are read exactly as before.
 *
 * Owner rules (§8, 2026-10-31):
 * 1. The declaration does not grow into a language: no conditions, loops,
 *    expressions or templating beyond `{id}`. A system it cannot describe
 *    needs the (future, sandboxed) second kind of plugin, not a new key here.
 * 2. Type names do not carry their layer (`deal`, never `pack_deal`,
 *    `company_deal` or `hubspot_deal`), so a type can move between core,
 *    industry pack and company without renaming records (`typeNameLayerProblem`).
 * 3. Imported records create no files (enforced where records are imported, P5).
 * 4. Company-specific declarations are written by div (FDE) and put on the
 *    shelf with `available_to` (the company ids that may use it); companies
 *    never upload declarations. Absent = every company.
 *
 * YAML is the strict subset of `yaml-lite.ts` (no anchors, aliases, tags…).
 */
/*
 * This module is the one entry point the server, the admin console and the
 * app import; the rules live in one module per responsibility:
 *
 *   plugin-declaration.ts            the parsed shape (roles, objects, operations, a connector use), contract, actors
 *   plugin-declaration-rules.ts      strict reading helpers, forbidden keys, type names without a layer, path templates
 *   plugin-manifest.ts               parsePluginManifest (common keys, then the role's part)
 *   plugin-connector-declaration.ts  a connector's part: destination, calls, operations
 *   plugin-business-declaration.ts   a business plugin's part: types, `connector`, its use, field policy defaults
 *   plugin-flow-declaration.ts       contract 2: a business plugin's roles, steps, ui, upgrade
 *   plugin-settings.ts               contract 2: a business plugin's settings (parameters only), settingValueProblem
 *   plugin-fingerprint.ts            fingerprint v2 and the signature slot (signature.yaml)
 *   plugin-package.ts                validatePluginPackage, combineUse
 *   plugin-mapping.ts                the mapping: parsePluginMapping, checkMappingAgainstProperties
 *   plugin-policies.ts               approverFor, effectiveFieldPolicy, effectiveOperationPolicy
 *   plugin-values.ts                 externalToAcb, acbToExternal
 */
export {
  CREATE_CONTENT_SLOTS, FIELD_POLICIES, PLUGIN_ACTORS, PLUGIN_CONTRACT, PLUGIN_CONTRACTS, PLUGIN_CONTRACT_V2, PLUGIN_ENDPOINTS, ROLE_WHO_PREFIX, roleOfWho, PLUGIN_ID_RE, PLUGIN_VERSION_RE, PRIOR_ONLY_FIELDS,
  comparePluginVersions, connectorName, pluginAvailableTo,
  type ConnectorUse, type CreateContentSlot, type FieldPolicy, type OperationKind, type OperationReach, type OperationUse, type PluginEndpoint,
  type PluginEndpointName, type PluginKind, type PluginManifest, type PluginObject, type PluginOperation, type PluginPackage, type PluginParsed,
  PLUGIN_SETTING_KINDS, PLUGIN_STEP_STARTS, noFlow,
  type FlowPart, type PluginSetting,
  type PluginRole, type PluginRoleDeclaration, type PluginStatePoint, type PluginStep, type PluginStepProcedure, type PluginStepProcedurePin, type PluginStepStart, type PluginUi, type PluginUpgrade, type UndoKind,
} from './plugin-declaration'
export {
  CONNECTOR_ROLE_NAME_RE, FLOW_KEYS, PLUGIN_BRIDGE_VERSIONS, PLUGIN_PEEK_STATE_GROUPS, PLUGIN_STEP_TOOLS, STEP_FILE_RE, UI_ENTRY_RE,
  companySkillOverrideProblem, stepToolsFor,
} from './plugin-flow-declaration'
export {
  PLUGIN_FINGERPRINT_V2_HEADER, PLUGIN_SIGNATURE_FILE, parsePluginSignature, pluginFingerprintV2, pluginFingerprintV2Listing, pluginSignedMessage,
  type PluginSignature,
} from './plugin-fingerprint'
export { SETTING_DURATION_RE, settingDurationMinutes, settingValueProblem } from './plugin-settings'
export { TYPE_LAYER_WORDS, checkPluginPathTemplate, typeNameLayerProblem } from './plugin-declaration-rules'
export { parsePluginManifest } from './plugin-manifest'
export { combineUse, validatePluginPackage } from './plugin-package'
export {
  DEFAULT_APPROVERS, MAPPING_IMPORT_MAX, MAPPING_SECTIONS, checkMappingAgainstProperties, parsePluginMapping,
  type ExternalPropertyInfo, type MappingField, type MappingObject, type PluginMapping,
} from './plugin-mapping'
export { approverFor, effectiveFieldPolicy, effectiveOperationPolicy } from './plugin-policies'
export { acbToExternal, externalToAcb, type AcbValue, type ExternalProperties } from './plugin-values'
export { companyExtensionConflicts } from './plugin-type-upgrade'
export { PLUGIN_PACKAGE_DIR_RE, isPluginPackagePath } from './plugin-package-paths'
