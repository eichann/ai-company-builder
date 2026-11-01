/**
 * A company's plugins (milestone 3 P4, `.claude/rules/plugins.md`): which
 * package of the shelf it uses (version, fingerprint), on / off, and the
 * history. Owners and admins only; a department manager or member gets 403,
 * a non-member 404 (the route).
 *
 * Two roles (owner decision 2026-11-01, plugins.md "Two roles"): a
 * **connector** is a company-wide shared part — installed, turned on and
 * stopped on its own, with the company key, the connection (account), the
 * relay's read scope and read-only switch; it knows no business plugin. A
 * **business plugin** owns types (stored in the company as soon as it is
 * turned on) and, when it names a connector (`connector: hubspot >= 0.3.0`),
 * the mapping (読み替え表, versioned, field policies included), the
 * acknowledged automatic fields, the import and the typed operations: what
 * runs is the business plugin's use of the connector (`combineUse`), keyed by
 * the business plugin's id. Without its connector (absent, off, stopped, too
 * old) the business plugin still works inside ACB; only its connector-backed
 * parts stop (`connector-*`, 「HubSpot との行き来は止まっています」). One type
 * name has one owner.
 *
 * `active()` is what the connector (P5) and the typed operations (P6) ask
 * before every call: it re-decides every kill switch each time (the
 * operator's stop and the company's switch of both plugins, the packages'
 * fingerprints, the key and its status, the mapping), so each takes effect
 * from the next call.
 *
 * Every company row is reached through the company handle; the shelf is
 * shared and read only, filtered by `available_to` for the asking company.
 */
/*
 * Composed from one module per responsibility:
 *
 *   plugin-service-common.ts  the refusals' words, the dependencies, ActivePlugin, storeBusinessTypes
 *   plugin-evaluation.ts      every kill switch and missing piece (active(), a plugin's problem)
 *   plugin-views.ts           the admin page's answers (list item, detail)
 *   plugin-relay-scope.ts     the relay's rule for a managed connection, the read scope
 *   plugin-ai-tools.ts        the AI's tools (P7)
 *
 * and this module installs, turns on / off, sets the read scope and saves mappings.
 */
import type { PluginPackage } from '../../shared/core/plugins'
import type { PluginDetail, PluginListItem, PluginProblem } from '../../shared/types/plugins'
import type { PluginInstallRow, PluginHistoryRow } from '../ports/plugins'
import { requireFullAccess, type Member } from './access'
import { ok, refuse, type Outcome } from './outcome'
import { createPluginAiTools } from './plugin-ai-tools'
import { activeOf, createPluginEvaluation } from './plugin-evaluation'
import { createPluginRelayScope } from './plugin-relay-scope'
import {
  AUTO_ACKNOWLEDGEMENT, CONNECTOR_PROBLEMS, NOT_A_BUSINESS, NOT_A_CONNECTOR, NO_CONNECTOR, PLUGIN_NOT_FOUND, PLUGINS_FORBIDDEN,
  TYPE_EXTENSION_CONFLICT, businessTypePlan, connectorRequired, storeBusinessTypes, type ActivePlugin, type PluginServiceDeps,
} from './plugin-service-common'
import { createPluginViews } from './plugin-views'

export {
  AUTO_ACKNOWLEDGEMENT, AUTO_CREATE_PREFIX, NOT_A_BUSINESS, NOT_A_CONNECTOR, NO_CONNECTOR, PLUGIN_NOT_FOUND, PLUGINS_FORBIDDEN,
  connectorRequired, storeBusinessTypes, type ActivePlugin, type PluginKeyInfo, type PluginServiceDeps,
} from './plugin-service-common'

/** The body's acknowledged field names (absent = none); null when malformed. */
const ackList = (v: unknown): string[] | null =>
  v === undefined ? [] : Array.isArray(v) && v.length <= 100 && v.every(x => typeof x === 'string' && x.length <= 40) ? v as string[] : null
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const MAPPING_MAX = 128 * 1024

export function createPluginService(deps: PluginServiceDeps) {
  const { companyData, clock, shelf } = deps
  const evaluation = createPluginEvaluation(deps)
  const { parseForCompany, keyProblem, unacknowledgedAuto, packageProblem, connectorUse, useForEditing, evaluate } = evaluation
  const { listItem, detail } = createPluginViews({ ...deps, evaluation })
  const relayScope = createPluginRelayScope(deps)
  const aiTools = createPluginAiTools({ ...deps, evaluation })

  const history = (pluginId: string, action: string, by: string, at: string, change: Record<string, unknown>): PluginHistoryRow =>
    ({ id: deps.ids.newId(), pluginId, action, at, by, change: JSON.stringify(change) })

  /** The install, or the package this company may see; else the same 404 as an id that exists nowhere. */
  function known(companyId: string, pluginId: string): boolean {
    if (typeof pluginId !== 'string' || pluginId.length > 40) return false
    return companyData.forCompany(companyId).plugins.install(pluginId) !== null
      || shelf.packagesFor(companyId).some(p => p.pkg.manifest.id === pluginId)
  }

  const notFound = () => refuse('not-found', PLUGIN_NOT_FOUND.error, { code: PLUGIN_NOT_FOUND.code })
  const notAConnector = () => refuse('conflict', NOT_A_CONNECTOR.error, { code: NOT_A_CONNECTOR.code })
  /** The installed version is a business plugin (it has no key, connection or read scope). */
  const isBusinessInstall = (companyId: string, install: PluginInstallRow) =>
    install.service === '' || shelf.find(companyId, install.pluginId, install.version)?.pkg.manifest.role === 'business'

  /**
   * Installing or changing a business plugin: each type name has one owner in
   * a company — a type another installed business plugin owns is refused.
   */
  function typeOwnerConflict(companyId: string, pluginId: string, pkg: PluginPackage): string | null {
    for (const other of companyData.forCompany(companyId).plugins.installs()) {
      if (other.pluginId === pluginId) continue
      const theirs = shelf.find(companyId, other.pluginId, other.version)?.pkg.manifest
      const taken = theirs?.role === 'business' ? pkg.manifest.types.find(t => theirs.types.includes(t)) : undefined
      if (taken && theirs) return `型「${taken}」は、すでに入っている「${theirs.label}」の型です。同じ名前の型を2つのプラグインが持つことはできません`
    }
    return null
  }

  /** 409 TYPE_EXTENSION_CONFLICT (with the sentences) when the package's types would go over the company's extensions. */
  function typeExtensionConflict(companyId: string, pkg: PluginPackage) {
    const { conflicts } = businessTypePlan(companyData, companyId, pkg.types)
    return conflicts.length > 0 ? refuse('conflict', TYPE_EXTENSION_CONFLICT.error, { code: TYPE_EXTENSION_CONFLICT.code, conflicts }) : null
  }

  /**
   * Turned-on business plugins whose use of connector `connectorId` runs now
   * and would stop with `next` (a version or key change of the connector).
   */
  async function dependentsStoppedBy(companyId: string, connectorId: string, next: PluginInstallRow): Promise<string[]> {
    const out: string[] = []
    for (const i of companyData.forCompany(companyId).plugins.installs()) {
      if (!i.enabled || i.pluginId === connectorId) continue
      const found = shelf.find(companyId, i.pluginId, i.version)
      if (found?.pkg.manifest.uses?.connector.id !== connectorId) continue
      const now = await evaluate(companyId, i)
      if (now.problem && CONNECTOR_PROBLEMS.includes(now.problem)) continue
      const after = await evaluate(companyId, i, false, next)
      if (after.problem && CONNECTOR_PROBLEMS.includes(after.problem)) out.push(i.pluginId)
    }
    return out
  }

  return {
    /** GET /plugins — the shelf as this company sees it (available_to applied) and its installs. */
    async list(member: Member): Promise<Outcome<{ plugins: PluginListItem[] }>> {
      const allowed = requireFullAccess(member, PLUGINS_FORBIDDEN)
      if (!allowed.ok) return allowed
      const installs = new Map(companyData.forCompany(member.companyId).plugins.installs().map(i => [i.pluginId, i]))
      const ids = [...new Set([...shelf.packagesFor(member.companyId).map(p => p.pkg.manifest.id), ...installs.keys()])].sort()
      const plugins: PluginListItem[] = []
      for (const id of ids) plugins.push(await listItem(member.companyId, id, installs.get(id) ?? null))
      return ok({ plugins })
    },

    /** GET /plugins/:pluginId */
    async get(member: Member, pluginId: string): Promise<Outcome<PluginDetail>> {
      const allowed = requireFullAccess(member, PLUGINS_FORBIDDEN)
      if (!allowed.ok) return allowed
      if (!known(member.companyId, pluginId)) return notFound()
      return ok(await detail(member.companyId, pluginId))
    },

    /**
     * PUT /plugins/:pluginId { version, keyId } — install, or choose another
     * version or key. Records the package's fingerprint. A connector takes a
     * company key of its service; a business plugin none (`keyId: null`), and
     * its first version with a recommended mapping makes that mapping version
     * 1. A plugin that is on must still run afterwards, and a connector change
     * must not stop a business plugin using it (else 409, nothing changed).
     */
    async install(member: Member, pluginId: string, body: unknown): Promise<Outcome<PluginDetail>> {
      const allowed = requireFullAccess(member, PLUGINS_FORBIDDEN)
      if (!allowed.ok) return allowed
      if (!known(member.companyId, pluginId)) return notFound()
      if (!isObject(body) || typeof body.version !== 'string' || !(body.keyId === null || typeof body.keyId === 'string')) {
        return refuse('bad-request', 'Body: { version: string, keyId: string | null }')
      }
      const found = shelf.find(member.companyId, pluginId, body.version)
      if (!found) return refuse('bad-request', 'この版は棚にありません', { code: 'VERSION_NOT_ON_SHELF' })
      const manifest = found.pkg.manifest
      const keyId = body.keyId as string | null
      if (manifest.role === 'business' && keyId !== null) {
        return refuse('bad-request', '業務のプラグインに鍵は要りません（鍵はつなぎ先で選びます）', { code: 'KEY_NOT_USABLE' })
      }
      if (keyId !== null && keyProblem(member.companyId, manifest, keyId) === 'no-key') {
        return refuse('bad-request', `${manifest.service} の会社の鍵を選んでください（「API キー」で登録した鍵）`, { code: 'KEY_NOT_USABLE' })
      }
      const repo = companyData.forCompany(member.companyId).plugins
      const before = repo.install(pluginId)
      const at = clock.now()
      if (before && before.service !== manifest.service) {
        return refuse('conflict', 'この版は別のサービスにつなぐため、選べません', { code: 'SERVICE_CHANGED' })
      }
      if (manifest.role === 'business') {
        const conflict = typeOwnerConflict(member.companyId, pluginId, found.pkg)
        if (conflict) return refuse('conflict', conflict, { code: 'TYPE_OWNED_ELSEWHERE' })
      }
      const row: PluginInstallRow = {
        pluginId, version: body.version, fingerprint: found.fingerprint, service: manifest.service,
        connectionId: before?.connectionId ?? deps.ids.newId(), accountId: before?.accountId ?? null,
        enabled: before?.enabled ?? false, managedSince: before?.managedSince ?? null, keyId,
        mappingVersion: before?.mappingVersion ?? 0, updatedAt: at, updatedBy: member.userId,
      }
      if (row.enabled) {
        // A plugin that is on must keep running: its own switches (and a connector's key).
        const p = await packageProblem(member.companyId, row, false)
        const problem = p.problem ?? (manifest.role === 'connector' ? keyProblem(member.companyId, manifest, keyId) : null)
        if (problem) return refuse('conflict', 'この設定ではプラグインが動かないため、変えていません（先にオフにしてください）', { code: 'PLUGIN_WOULD_STOP', problem })
      }
      if (manifest.role === 'connector' && before) {
        // A business plugin using this connector must not lose it by a version or key change (turn it off first).
        const dependents = await dependentsStoppedBy(member.companyId, pluginId, row)
        if (dependents.length > 0) {
          return refuse('conflict', 'この版にすると、このつなぎ先を使っている業務との行き来が止まるため、変えていません（先にその業務をオフにしてください）',
            { code: 'PLUGIN_WOULD_STOP', problem: 'connector-mismatch', dependents })
        }
      }
      if (row.enabled && manifest.role === 'business') {
        // A company's extension of a type must survive a newer version: report, never store over it (plugins.md ④).
        const conflict = typeExtensionConflict(member.companyId, found.pkg)
        if (conflict) return conflict
      }
      const change = before
        ? { version: { before: before.version, after: row.version }, keyId: { before: before.keyId, after: keyId }, fingerprint: row.fingerprint }
        : { version: row.version, keyId, fingerprint: row.fingerprint }
      repo.saveInstall(row, history(pluginId, before ? 'change' : 'install', member.userId, at, change))
      if (row.mappingVersion === 0 && found.recommendedMapping !== null) {
        // Start from the package's recommended mapping (checked against this company and the connector when it runs).
        repo.addMapping({ pluginId, version: 1, text: found.recommendedMapping, createdAt: at, createdBy: member.userId },
          history(pluginId, 'mapping', member.userId, at, { version: 1, from: 'recommended' }))
      }
      if (row.enabled && manifest.role === 'business') storeBusinessTypes(companyData, member.companyId, found.pkg.types, at)
      return ok(await detail(member.companyId, pluginId))
    },

    /**
     * PUT /plugins/:pluginId/enabled { enabled }. A business plugin: on when its
     * package may be used (its connector is not needed — without it only the
     * connector-backed parts stop); turning it on stores its types in the
     * company at once. A connector: on with a usable key and a relay read
     * scope; turning it on also makes the relay read-only for its service.
     * Off: always (a kill switch; a connector's stops every business plugin's
     * use of it from the next call).
     */
    async setEnabled(member: Member, pluginId: string, body: unknown): Promise<Outcome<PluginDetail>> {
      const allowed = requireFullAccess(member, PLUGINS_FORBIDDEN)
      if (!allowed.ok) return allowed
      if (!known(member.companyId, pluginId)) return notFound()
      if (!isObject(body) || typeof body.enabled !== 'boolean') return refuse('bad-request', 'Body: { enabled: boolean }')
      const repo = companyData.forCompany(member.companyId).plugins
      const install = repo.install(pluginId)
      if (!install) return refuse('conflict', '先にプラグインを入れてください（版と鍵を選ぶ）', { code: 'NOT_INSTALLED' })
      if (install.enabled === body.enabled) return ok(await detail(member.companyId, pluginId))
      const at = clock.now()
      if (isBusinessInstall(member.companyId, install)) {
        const row = { ...install, enabled: body.enabled, updatedAt: at, updatedBy: member.userId }
        if (body.enabled) {
          const p = await packageProblem(member.companyId, row, false)
          if (p.problem) return refuse('conflict', 'まだオンにできません', { code: 'PLUGIN_NOT_READY', problem: p.problem })
          const conflict = typeExtensionConflict(member.companyId, p.found.pkg)
          if (conflict) return conflict
          repo.saveInstall(row, history(pluginId, 'enable', member.userId, at, { version: row.version }))
          // Its types are the company's from now on (owner decision 2026-11-01), import or not.
          storeBusinessTypes(companyData, member.companyId, p.found.pkg.types, at)
        } else {
          repo.saveInstall(row, history(pluginId, 'disable', member.userId, at, {}))
        }
        return ok(await detail(member.companyId, pluginId))
      }
      const row = { ...install, enabled: body.enabled, managedSince: install.managedSince ?? (body.enabled ? at : null), updatedAt: at, updatedBy: member.userId }
      if (body.enabled) {
        const evaluated = await evaluate(member.companyId, row)
        if (evaluated.problem) return refuse('conflict', 'まだオンにできません', { code: 'PLUGIN_NOT_READY', problem: evaluated.problem })
        // Who may read through the relay must be decided: a forgotten setting never opens it to everyone.
        if (repo.readScope(pluginId, install.connectionId).length === 0) {
          return refuse('conflict', '先に「中継で読める人」（部署かメンバー）を決めてください', { code: 'READ_SCOPE_REQUIRED' })
        }
        repo.saveInstall(row, history(pluginId, 'enable', member.userId, at, { version: row.version }))
        deps.relayReadOnly(member, row.service)
      } else {
        repo.saveInstall(row, history(pluginId, 'disable', member.userId, at, {}))
      }
      return ok(await detail(member.companyId, pluginId))
    },

    /**
     * PUT /plugins/:pluginId/read-scope { departmentIds, userIds } — who may read
     * the outside system through the relay, for the connector's current
     * connection. Only this company's departments and members. Empty = closed;
     * not while the connector is on (turn it off first).
     */
    async setReadScope(member: Member, pluginId: string, body: unknown): Promise<Outcome<PluginDetail>> {
      const allowed = requireFullAccess(member, PLUGINS_FORBIDDEN)
      if (!allowed.ok) return allowed
      if (!known(member.companyId, pluginId)) return notFound()
      const ids = (v: unknown) => Array.isArray(v) && v.length <= 200 && v.every(x => typeof x === 'string' && x.length > 0 && x.length <= 100) ? [...new Set(v as string[])] : null
      const departmentIds = isObject(body) ? ids(body.departmentIds ?? []) : null
      const userIds = isObject(body) ? ids(body.userIds ?? []) : null
      if (!departmentIds || !userIds) return refuse('bad-request', 'Body: { departmentIds: string[], userIds: string[] }')
      const handle = companyData.forCompany(member.companyId)
      const repo = handle.plugins
      const install = repo.install(pluginId)
      if (!install) return refuse('conflict', '先にプラグインを入れてください（版と鍵を選ぶ）', { code: 'NOT_INSTALLED' })
      if (isBusinessInstall(member.companyId, install)) return notAConnector()
      const known_ = new Set(handle.departments.list().map(d => d.id))
      if (departmentIds.some(id => !known_.has(id))) return refuse('bad-request', 'この会社にない部署が含まれています', { code: 'READ_SCOPE_INVALID' })
      if (userIds.some(id => !deps.isMember(member.companyId, id))) return refuse('bad-request', 'この会社のメンバーではない人が含まれています', { code: 'READ_SCOPE_INVALID' })
      if (install.enabled && departmentIds.length + userIds.length === 0) {
        return refuse('conflict', 'オンの間は「中継で読める人」を空にできません（先にオフにしてください）', { code: 'READ_SCOPE_REQUIRED' })
      }
      const at = clock.now()
      repo.setReadScope(pluginId, install.connectionId, [...departmentIds.map(id => ({ type: 'department' as const, id })), ...userIds.map(id => ({ type: 'user' as const, id }))],
        at, member.userId, history(pluginId, 'read-scope', member.userId, at, { connectionId: install.connectionId, departmentIds, userIds }))
      return ok(await detail(member.companyId, pluginId))
    },

    /** PUT /plugins/:pluginId/mapping { text } — a business plugin's new mapping version (checked in full; field policies are its `policy`). */
    async saveMapping(member: Member, pluginId: string, body: unknown): Promise<Outcome<PluginDetail>> {
      const allowed = requireFullAccess(member, PLUGINS_FORBIDDEN)
      if (!allowed.ok) return allowed
      if (!known(member.companyId, pluginId)) return notFound()
      if (!isObject(body) || typeof body.text !== 'string' || body.text.length > MAPPING_MAX) return refuse('bad-request', 'Body: { text: string, acknowledgeAuto?: string[] } (up to 128 KB)')
      const acks = ackList(body.acknowledgeAuto)
      if (!acks) return refuse('bad-request', 'acknowledgeAuto: field names')
      return saveVersion(member, pluginId, body.text, 'mapping', {}, acks)
    },

    /** POST /plugins/:pluginId/mapping/restore { version } — an earlier version becomes the next one (checked again). */
    async restoreMapping(member: Member, pluginId: string, body: unknown): Promise<Outcome<PluginDetail>> {
      const allowed = requireFullAccess(member, PLUGINS_FORBIDDEN)
      if (!allowed.ok) return allowed
      if (!known(member.companyId, pluginId)) return notFound()
      if (!isObject(body) || !Number.isInteger(body.version) || (body.version as number) < 1) return refuse('bad-request', 'Body: { version: integer ≥ 1, acknowledgeAuto?: string[] }')
      const acks = ackList(body.acknowledgeAuto)
      if (!acks) return refuse('bad-request', 'acknowledgeAuto: field names')
      const row = companyData.forCompany(member.companyId).plugins.mapping(pluginId, body.version as number)
      if (!row) return refuse('not-found', 'この版の読み替え表はありません', { code: 'MAPPING_VERSION_NOT_FOUND' })
      return saveVersion(member, pluginId, row.text, 'restore', { from: row.version }, acks)
    },

    // The relay's rule and read scope (plugin-relay-scope.ts).
    ...relayScope,

    /** The kind of an operation a business plugin uses, as its installed connector declares it (read / update / create), or null. */
    operationKind(companyId: string, pluginId: string, operation: string): string | null {
      const install = typeof pluginId === 'string' ? companyData.forCompany(companyId).plugins.install(pluginId) : null
      const found = install ? shelf.find(companyId, pluginId, install.version) : null
      const editing = found ? useForEditing(companyId, found) : null
      const ops = editing?.ok ? editing.use.manifest.operations : null
      return ops && Object.prototype.hasOwnProperty.call(ops, operation) ? ops[operation].kind : null
    },

    /**
     * For 「HubSpot に聞いて確かめる」 (P8, services/plugin-mapping-check.ts): a
     * business plugin's use of its connector with the connector's key and a
     * mapping — `text`, else the one in force — for the connector's reads of
     * the outside property list. Unlike `active()` it does not need either
     * plugin on or the auto fields acknowledged (checking the mapping comes
     * before both); the operator's stop of either, the packages' fingerprints,
     * the key and the mapping's own checks still apply. Re-decided on every
     * call (it is also the precheck).
     */
    async forChecking(companyId: string, pluginId: string, text: string | null): Promise<{ ok: true; plugin: ActivePlugin } | { ok: false; problem: PluginProblem; errors?: string[] }> {
      const repo = companyData.forCompany(companyId).plugins
      const install = repo.install(pluginId)
      if (!install) return { ok: false, problem: 'off' }
      if (await shelf.isStopped(install.pluginId, install.version)) return { ok: false, problem: 'stopped' }
      const found = shelf.find(companyId, install.pluginId, install.version)
      if (!found) return { ok: false, problem: 'not-on-shelf' }
      if (found.fingerprint !== install.fingerprint) return { ok: false, problem: 'package-changed' }
      if (found.pkg.manifest.role === 'connector') return { ok: false, problem: 'not-a-business' }
      // Checking reads only the outside property list: the connector must be there (not on).
      const c = await connectorUse(companyId, found, true)
      if (c.problem) return { ok: false, problem: c.problem }
      if (await shelf.isStopped(c.install.pluginId, c.install.version)) return { ok: false, problem: 'connector-stopped' }
      const source = text ?? (install.mappingVersion > 0 ? repo.mapping(install.pluginId, install.mappingVersion)?.text ?? null : null)
      if (source === null) return { ok: false, problem: 'mapping-invalid', errors: ['読み替え表がまだありません'] }
      const parsed = parseForCompany(companyId, c.use, source)
      if (!parsed.ok) return { ok: false, problem: 'mapping-invalid', errors: parsed.errors }
      return { ok: true, plugin: activeOf(install, c.install, c.use, parsed.mapping) }
    },

    // The AI's tools (plugin-ai-tools.ts).
    ...aiTools,

    /**
     * For the connector and the typed operations (P5 / P6): the business
     * plugin's use of its connector if it may run now, else why not.
     * Re-decided on every call. `collectingFacts`: for reading back the result
     * of a write already sent — the operator's stop and the company's switch
     * (of either plugin) stop new writes, not the collection of facts (review
     * §6.5); key, account and mapping still apply.
     */
    async active(companyId: string, pluginId: string, options: { collectingFacts?: boolean } = {}): Promise<{ ok: true; plugin: ActivePlugin } | { ok: false; problem: PluginProblem }> {
      const install = companyData.forCompany(companyId).plugins.install(pluginId)
      if (!install) return { ok: false, problem: 'off' }
      const evaluated = await evaluate(companyId, install, options.collectingFacts === true)
      if (evaluated.problem) return { ok: false, problem: evaluated.problem }
      if (evaluated.active) return { ok: true, plugin: evaluated.active }
      return { ok: false, problem: isBusinessInstall(companyId, install) ? 'no-connector' : 'not-a-business' }
    },
  }

  async function saveVersion(member: Member, pluginId: string, text: string, action: string, extra: Record<string, unknown>, acknowledge: string[]): Promise<Outcome<PluginDetail>> {
    const repo = companyData.forCompany(member.companyId).plugins
    const install = repo.install(pluginId)
    if (!install) return refuse('conflict', '先にプラグインを入れてください（版と鍵を選ぶ）', { code: 'NOT_INSTALLED' })
    const found = shelf.find(member.companyId, pluginId, install.version)
    if (!found) return refuse('conflict', '入れた版が棚にありません。版を選び直してください', { code: 'VERSION_NOT_ON_SHELF' })
    if (found.pkg.manifest.role === 'connector') return refuse('conflict', NOT_A_BUSINESS.error, { code: NOT_A_BUSINESS.code })
    if (!found.pkg.manifest.uses) return refuse('conflict', NO_CONNECTOR.error, { code: NO_CONNECTOR.code })
    const editing = useForEditing(member.companyId, found)
    if (!editing.ok) {
      return refuse('conflict', connectorRequired(editing.label, editing.minVersion), { code: 'CONNECTOR_REQUIRED', plugin: found.pkg.manifest.uses.connector.id, minVersion: editing.minVersion })
    }
    const parsed = parseForCompany(member.companyId, editing.use, text)
    if (!parsed.ok) return refuse('bad-request', '読み替え表を保存できません', { code: 'MAPPING_INVALID', errors: parsed.errors })
    // A field that would write automatically needs the acknowledgement, recorded with who and when.
    const missing = unacknowledgedAuto(member.companyId, pluginId, editing.use.manifest, parsed.mapping)
    const unconfirmed = missing.filter(f => !acknowledge.includes(f.field))
    if (unconfirmed.length > 0) {
      return refuse('bad-request', `自動で書き戻す欄は、「${AUTO_ACKNOWLEDGEMENT}」の確認が要ります`, {
        code: 'AUTO_NEEDS_ACKNOWLEDGEMENT', fields: unconfirmed.map(f => f.field), acknowledgement: AUTO_ACKNOWLEDGEMENT,
      })
    }
    const version = (repo.mappingVersions(pluginId)[0]?.version ?? 0) + 1
    const at = clock.now()
    if (missing.length > 0) {
      repo.addPolicyAcks(missing.map(f => ({ pluginId, field: f.field, property: f.property, acknowledgedBy: member.userId, acknowledgedAt: at })),
        history(pluginId, 'acknowledge', member.userId, at, { fields: missing, acknowledgement: AUTO_ACKNOWLEDGEMENT }))
    }
    repo.addMapping({ pluginId, version, text, createdAt: at, createdBy: member.userId },
      history(pluginId, action, member.userId, at, { version, ...extra }))
    return ok(await detail(member.companyId, pluginId))
  }
}

export type PluginService = ReturnType<typeof createPluginService>
