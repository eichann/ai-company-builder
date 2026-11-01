/**
 * The server end of a plugin screen's bridge (plan 4b B6 「橋の関所」,
 * `.claude/rules/plugin-frame.md`). A call is allowed only in the overlap of
 *
 * 1. what the company granted the plugin: the version the frame runs is one the
 *    agent policy lists now (contract-2 business plugin, turned on, on the shelf
 *    for this company, not stopped by the operator, the fingerprint the company
 *    chose — `pluginsFor`, the same list the app keeps packages by) and its
 *    package declares a screen with this bridge version (`ui.bridge`);
 * 2. the operation's own scope: only the plugin's own types; an action only when
 *    its type says `via: [… plugin …]`, a plugin operation only when the business
 *    plugin's use says so — and then only as an approval request (no direct run:
 *    approving and sending are the core's cards);
 * 3. the person's own rights: every call runs as the member (their session),
 *    through the same services as the core's screens (read filters, `who`…).
 *
 * Whatever the reason, the bridge itself refuses with one answer
 * (`PLUGIN_BRIDGE_REFUSED`) that tells nothing apart — another company's plugin,
 * one turned off, a type that is not the plugin's, a record the person cannot
 * read and a missing one look the same. A change made through it is recorded as
 * the person's, with `via` = the plugin and version (ledger cause `plugin`).
 */
import { PLUGIN_BRIDGE_VERSION, PLUGIN_BRIDGE_REFUSED, type PluginBridgeOp } from '../../shared/types/plugin-bridge'
import type { DistributedPlugin } from '../../shared/types/plugins'
import type { RecordDetail, RecordQueryResult } from '../../shared/types/records'
import { viaOf } from '../../shared/core/record-types'
import type { Member } from './access'
import { ok, refuse, type Outcome } from './outcome'
import type { PluginShelf } from './plugin-shelf'
import type { ActorInput } from './record-engine'

/** Query keys a plugin screen may use (no `implements`, no file links, no old connections). */
const QUERY_KEYS = new Set(['type', 'state', 'fields', 'linkedTo', 'link', 'sort', 'text', 'limit', 'offset', 'countOnly'])
/** What a plugin screen may send with an action (no attached files: the bridge opens no files). */
const ACT_KEYS = new Set(['expectedVersion', 'note', 'args', 'links', 'decision'])

export interface PluginBridgeDeps {
  /** What the company's apps may keep now (services/plugin-distribution.ts `pluginsFor`). */
  listed: (companyId: string) => Promise<DistributedPlugin[]>
  shelf: Pick<PluginShelf, 'find'>
  records: {
    query(member: Member, body: unknown): Outcome<RecordQueryResult>
    get(member: Member, recordId: string): Promise<Outcome<RecordDetail>>
  }
  act(member: Member, actor: ActorInput, recordId: string, action: string, body: unknown): Promise<Outcome<unknown>>
  /** Make (never run) an approval request for a plugin operation (services/approvals.ts `request`). */
  requestApproval(member: Member, actor: ActorInput, pluginId: string, recordId: string | null, operation: string, body: unknown): Promise<Outcome<unknown>>
}

const refused = () => refuse('forbidden', PLUGIN_BRIDGE_REFUSED.error, { code: PLUGIN_BRIDGE_REFUSED.code })
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const own = <T>(o: Record<string, T>, k: string): T | undefined => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined)

export function createPluginBridge(deps: PluginBridgeDeps) {
  /** The package the frame runs, when the company grants it a bridge now; else null. */
  async function granted(member: Member, pluginId: string, version: string) {
    const listed = (await deps.listed(member.companyId)).find(p => p.id === pluginId && p.version === version)
    if (!listed) return null
    const found = deps.shelf.find(member.companyId, pluginId, version)
    if (!found) return null
    const m = found.pkg.manifest
    if (m.role !== 'business' || m.ui === null || m.ui.bridge !== PLUGIN_BRIDGE_VERSION) return null
    return { manifest: m, types: new Set(m.types) }
  }

  return {
    /** One bridge call (POST /plugin-bridge). The route has parsed the shape; everything else is checked here. */
    async call(member: Member, req: { pluginId: string; version: string; op: PluginBridgeOp; args: Record<string, unknown> }): Promise<Outcome<{ status: 200 | 202; value: unknown }>> {
      const plugin = await granted(member, req.pluginId, req.version)
      if (!plugin) return refused()
      const actor: ActorInput = { kind: 'human', via: { plugin: req.pluginId, version: req.version } }
      const a = req.args
      /** A record of the plugin's types the person can read, else null (one answer for all the rest). */
      const recordOf = async (recordId: unknown) => {
        if (typeof recordId !== 'string') return null
        const got = await deps.records.get(member, recordId)
        return got.ok && plugin.types.has(got.value.record.type) ? got.value : null
      }

      switch (req.op) {
        case 'records.query': {
          if (typeof a.type !== 'string' || !plugin.types.has(a.type) || Object.keys(a).some(k => !QUERY_KEYS.has(k))) return refused()
          const r = deps.records.query(member, a)
          return r.ok ? ok({ status: 200, value: r.value }) : r
        }
        case 'records.get': {
          if (Object.keys(a).some(k => k !== 'recordId')) return refused()
          const detail = await recordOf(a.recordId)
          if (!detail) return refused()
          // Only what the screen's scope covers: links to records of the plugin's types (no files).
          const links = detail.links.filter(l => 'record' in l && l.record !== undefined && plugin.types.has(l.record.type))
          return ok({ status: 200, value: { record: detail.record, links } })
        }
        case 'records.act': {
          const { recordId, action, ...body } = a
          if (typeof action !== 'string' || Object.keys(body).some(k => !ACT_KEYS.has(k))) return refused()
          const detail = await recordOf(recordId)
          if (!detail) return refused()
          // The action's `via` is the engine's to check (one rule for every caller); its refusal is the bridge's one answer here.
          const r = await deps.act(member, actor, detail.record.id, action, body)
          if (!r.ok && (r.body.code === 'NOT_VIA' || r.body.code === 'ACTION_NOT_FOUND')) return refused()
          return r.ok ? ok({ status: 200, value: r.value }) : r
        }
        case 'approvals.request': {
          const { recordId, operation, input } = a
          if (typeof operation !== 'string' || Object.keys(a).some(k => !['recordId', 'operation', 'input'].includes(k))) return refused()
          if (input !== undefined && !isObj(input)) return refused()
          // The business plugin's use of the operation, in the version the frame runs: it must name `plugin` in `via`.
          const use = plugin.manifest.uses ? own(plugin.manifest.uses.operations, operation) : undefined
          if (!use || !viaOf(use).includes('plugin')) return refused()
          let target: string | null = null
          if (recordId !== null && recordId !== undefined) {
            const detail = await recordOf(recordId)
            if (!detail) return refused()
            target = detail.record.id
          }
          // Only ever a request: the checks there apply too (who, the installed version's `via`, the step gate, the policy must be prior).
          const r = await deps.requestApproval(member, actor, req.pluginId, target, operation, input ?? {})
          if (!r.ok && (r.body.code === 'NOT_VIA' || r.body.code === 'OPERATION_NOT_FOUND')) return refused()
          return r.ok ? ok({ status: 202, value: r.value }) : r
        }
      }
      return refused()
    },
  }
}

export type PluginBridge = ReturnType<typeof createPluginBridge>
