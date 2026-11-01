/**
 * The contract of a plugin screen's bridge (plan 4b B6 server, A5 client;
 * `.claude/rules/plugin-frame.md`). The app's main process sends one call per
 * request with the member's session:
 *
 *   POST /api/companies/:companyId/plugin-bridge   PluginBridgeRequest
 *     → 200 { success: true, data: <the op's answer> } (approvals.request: 202)
 *     → 403 PLUGIN_BRIDGE_REFUSED (one answer for every reason the bridge refuses)
 *     → 400 { error: 'Invalid request body' } (not this shape)
 *     → the op's own refusal once the bridge let it through (VERSION_CONFLICT, NOT_ALLOWED…)
 *
 * The frame never calls this itself: it has no network. `pluginId` / `version`
 * are the package the app opened the frame from (one the agent policy listed).
 */

/** The bridge version this server answers (`ui.bridge` in the declaration). */
export const PLUGIN_BRIDGE_VERSION = 1

export const PLUGIN_BRIDGE_OPS = ['records.query', 'records.get', 'records.act', 'approvals.request'] as const
export type PluginBridgeOp = typeof PLUGIN_BRIDGE_OPS[number]

export interface PluginBridgeRequest {
  pluginId: string
  version: string
  op: PluginBridgeOp
  /**
   * Per op:
   * - `records.query`: `{ type, state?, fields?, linkedTo?, link?, sort?, text?, limit?, offset?, countOnly? }`
   *   (`type` one of the plugin's types; answer RecordQueryResult)
   * - `records.get`: `{ recordId }` (a record of the plugin's types; answer RecordDetail with only
   *   links to records of the plugin's types — no file links)
   * - `records.act`: `{ recordId, action, expectedVersion, note?, args?, links?, decision? }`
   *   (an action whose type says `via: [… plugin …]`; answer `{ record, entry }`)
   * - `approvals.request`: `{ recordId: string | null, operation, input }` — `input` is the operation's
   *   body (`{ expectedVersion, fields, note?, basis? }`, or a create's); only an operation whose
   *   `via` lists `plugin`; answer (202) `{ outcome: 'approval-requested', approval, existing }`.
   *   Never runs the operation: approving and sending are the core's cards.
   */
  args: Record<string, unknown>
}

/** The bridge's one refusal: it does not tell a plugin that is off, stopped, changed or not here from an op, type, record or action it may not reach. */
export const PLUGIN_BRIDGE_REFUSED = { error: 'この画面からはできない操作です', code: 'PLUGIN_BRIDGE_REFUSED' } as const
