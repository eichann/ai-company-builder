/**
 * Bringing an outside system's objects into the company map (milestone 3 P5,
 * `.claude/rules/plugins.md` "Import"): the connector reads (search, get), the
 * mapping translates (`externalToAcb`), the engine's external entry writes
 * the records (server only: no file, owner rule §8-3) and the ledger
 * (`external`, with a receipt), and `plugin_external_links` remembers which
 * outside object of which connection and account each record stands for.
 *
 * - One run per company at a time (409 `IMPORT_RUNNING`), at most
 *   `IMPORT_TIME_LIMIT_MS`; one company per run, never a server-wide sweep.
 * - Before anything else the connection is checked against the outside
 *   account (`account_info`): the first answer binds it; another account
 *   stops every call until an owner/admin starts a new connection (review
 *   §5.7). Practice and real HubSpot are different accounts, so they never mix.
 * - Every request re-asks `active()` (the kill switches), the records switch
 *   and the caller's role right before it is sent (review §6.5).
 * - What a run saw is reported as it is: how many, whether the `max` cut it
 *   (`truncated`), stopped or failed — never "all synchronised" (§6.8).
 *   Values seen are observations of the outside system: who changed them
 *   there is not known (`receipt.kind: observed`).
 */
import { canonicalTypeJson } from '../../shared/core/record-types'
import { externalToAcb, type ExternalProperties } from '../../shared/core/plugins'
import type { ExternalReceipt, LedgerValue } from '../../shared/core/record-ledger'
import { RECORD_ID_RE } from '../../shared/core/records'
import type { Clock, IdGenerator } from '../ports/clock'
import type { CompanyDataSource } from '../ports/company-data'
import { hasFullAccess, type Member } from './access'
import { ok, refuse, type Outcome } from './outcome'
import { EXTERNAL_ID_RE, type ConnectorCall, type ConnectorResult, type PluginConnector } from './plugin-connector'
import type { ActivePlugin, PluginService } from './plugins'
import { recordReader } from './record-access'
import type { ExternalRecordWriter } from './record-engine'
import { RECORD_NOT_FOUND } from './records'
import { PLUGIN_NOT_FOUND, PLUGINS_FORBIDDEN } from './plugins'

export const IMPORT_TIME_LIMIT_MS = 5 * 60_000
const PAGE = 100
/** The outside system's last-modified property (HubSpot's; part of the connector's wire format). */
const MODIFIED = 'hs_lastmodifieddate'

export interface PluginImportDeps {
  companyData: CompanyDataSource
  clock: Clock
  ids: IdGenerator
  plugins: PluginService
  connector: PluginConnector
  writer: ExternalRecordWriter
  roleOf: (companyId: string, userId: string) => string | null
}

// The report's shape is part of the API contract (the admin page shows it).
import type { ImportObjectReport, ImportReport } from '../../shared/types/plugins'
export type { ImportObjectReport, ImportReport }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The outside system's answer for one object: `{ id, properties, associations }` (HubSpot's shape). */
function objectOf(body: unknown): { id: string; properties: ExternalProperties; associations: Record<string, string[]> } | null {
  if (!isObj(body) || typeof body.id !== 'string' || !isObj(body.properties)) return null
  const associations: Record<string, string[]> = {}
  if (isObj(body.associations)) {
    for (const [name, a] of Object.entries(body.associations)) {
      if (isObj(a) && Array.isArray(a.results)) associations[name] = a.results.filter(isObj).map(r => String(r.id)).filter(id => EXTERNAL_ID_RE.test(id))
    }
  }
  return { id: body.id, properties: body.properties as ExternalProperties, associations }
}

export function createPluginImportService(deps: PluginImportDeps) {
  const { companyData, clock, plugins, connector, writer } = deps
  const running = new Set<string>()

  /** Store the package's types (source plugin) unless a version at least as new is there. */
  function ensureTypes(companyId: string, plugin: ActivePlugin, at: string) {
    const records = companyData.forCompany(companyId).records
    const stored = new Map<string, number>()
    for (const row of records.typeVersions()) stored.set(row.name, Math.max(stored.get(row.name) ?? 0, row.version))
    for (const def of Object.values(plugin.types)) {
      if ((stored.get(def.name) ?? 0) >= def.version) continue
      records.insertTypeVersion({ name: def.name, version: def.version, definition: canonicalTypeJson(def), source: 'plugin', commitSha: null, createdAt: at })
    }
  }

  /**
   * The precheck before every request: the plugin still runs (every kill
   * switch), on the same connection, the records switch is on, and (for a
   * person's run) they still have the role it needs.
   */
  function precheckFor(companyId: string, pluginId: string, connectionId: string, who: { userId: string; needsFullAccess: boolean } | null) {
    return async (): Promise<string | null> => {
      const now = await plugins.active(companyId, pluginId)
      if (!now.ok) return now.problem
      if (now.plugin.connectionId !== connectionId) return 'connection-changed'
      if (!companyData.forCompany(companyId).records.settings().enabled) return 'records-off'
      if (who) {
        const role = deps.roleOf(companyId, who.userId)
        if (role === null || (who.needsFullAccess && !hasFullAccess(role))) return 'not-allowed'
      }
      return null
    }
  }

  /**
   * The outside account of the key in use, checked against the connection:
   * bound on first sight; another account → refused (a new connection is an
   * owner/admin's decision). Returns the account id or why not.
   */
  async function verifyAccount(companyId: string, plugin: ActivePlugin, precheck: () => Promise<string | null>): Promise<{ ok: true; accountId: string } | { ok: false; reason: string }> {
    if (!plugin.manifest.accountInfo) return { ok: true, accountId: plugin.accountId ?? '-' }
    const r = await connector.call(companyId, plugin, { endpoint: 'account_info' }, precheck)
    if (!r.ok) return { ok: false, reason: r.reason }
    const seen = isObj(r.body) && (typeof r.body.portalId === 'number' || typeof r.body.portalId === 'string') ? String(r.body.portalId) : null
    if (!seen || !EXTERNAL_ID_RE.test(seen)) return { ok: false, reason: 'account-unreadable' }
    if (plugin.accountId === seen) return { ok: true, accountId: seen }
    if (plugin.accountId === null) {
      const repo = companyData.forCompany(companyId).plugins
      const at = clock.now()
      if (repo.bindAccount(plugin.pluginId, plugin.connectionId, seen, { id: deps.ids.newId(), pluginId: plugin.pluginId, action: 'account', at, by: 'connector', change: JSON.stringify({ connectionId: plugin.connectionId, accountId: seen }) })) {
        return { ok: true, accountId: seen }
      }
      const again = repo.install(plugin.pluginId)
      return again?.accountId === seen && again.connectionId === plugin.connectionId ? { ok: true, accountId: seen } : { ok: false, reason: 'account-changed' }
    }
    return { ok: false, reason: 'account-changed' }
  }

  function receiptOf(plugin: ActivePlugin, accountId: string, object: string, externalId: string, updatedAt: string | null): ExternalReceipt {
    return {
      plugin: plugin.pluginId, pluginVersion: plugin.version, fingerprint: plugin.fingerprint, mappingVersion: plugin.mappingVersion,
      connectionId: plugin.connectionId, accountId, object, externalId, externalUpdatedAt: updatedAt, operationId: null, kind: 'observed',
    }
  }

  /** The fields the mapping reads of `object`, plus the last-modified property. */
  const propertiesOf = (plugin: ActivePlugin, object: string) =>
    [...new Set([...Object.values(plugin.mapping.objects[object]?.fields ?? {}).map(f => f.from), MODIFIED])]

  /**
   * Translate one outside object and hand it to the engine; remember the
   * link. Returns what happened, or null when it could not be applied.
   */
  function applyOne(
    companyId: string, plugin: ActivePlugin, accountId: string, object: string,
    item: { id: string; properties: ExternalProperties }, links: Record<string, string[]>, report: ImportObjectReport | null,
  ): { recordId: string; created: boolean; changed: boolean } | null {
    const pkg = { manifest: plugin.manifest, types: plugin.types }
    const { values, problems } = externalToAcb(pkg, plugin.mapping, object, item.properties)
    if (report) for (const p of problems) report.problems[p] = (report.problems[p] ?? 0) + 1
    const { title, summary: _summary, ...fields } = values
    void _summary
    const repo = companyData.forCompany(companyId).plugins
    const existing = repo.link(plugin.connectionId, accountId, object, item.id)
    const updatedAt = typeof item.properties[MODIFIED] === 'string' ? item.properties[MODIFIED] as string : null
    const result = writer.apply(companyId, {
      recordId: existing?.recordId ?? null,
      type: plugin.manifest.objects[object].recordType as string,
      folder: plugin.mapping.objects[object]?.visibleToFolder ?? null,
      title: typeof title === 'string' ? title : null,
      fields: fields as Record<string, LedgerValue>,
      links,
      action: `${plugin.pluginId}.import`,
      source: plugin.pluginId,
      receipt: receiptOf(plugin, accountId, object, item.id, updatedAt),
    })
    if (!result.ok) return null
    repo.saveLink({
      pluginId: plugin.pluginId, connectionId: plugin.connectionId, accountId, object, externalId: item.id,
      recordId: result.recordId, externalUpdatedAt: updatedAt, seenAt: clock.now(),
    })
    return { recordId: result.recordId, created: result.created, changed: result.changed }
  }

  /** Records for the associated objects of `item` (their own get, mapped like any object), by link name. */
  async function linkedRecords(
    companyId: string, plugin: ActivePlugin, accountId: string, object: string, associations: Record<string, string[]>,
    precheck: () => Promise<string | null>, cache: Map<string, string | null>,
  ): Promise<Record<string, string[]>> {
    const type = plugin.types[plugin.manifest.objects[object].recordType as string]
    const out: Record<string, string[]> = {}
    for (const [linkName, rule] of Object.entries(plugin.mapping.objects[object]?.links ?? {})) {
      const target = type?.links[linkName]?.target
      const targetObject = Object.entries(plugin.manifest.objects).find(([, o]) => o.recordType === target)?.[0]
      if (!targetObject || !plugin.mapping.objects[targetObject] || !plugin.manifest.objects[targetObject].endpoints.get) continue
      const ids: string[] = []
      for (const externalId of (associations[rule.fromAssociation] ?? []).slice(0, 20)) {
        const key = `${targetObject}|${externalId}`
        if (!cache.has(key)) {
          const r = await connector.call(companyId, plugin, { endpoint: 'get', object: targetObject, id: externalId, query: { properties: propertiesOf(plugin, targetObject) } }, precheck)
          const item = r.ok ? objectOf(r.body) : null
          cache.set(key, item ? applyOne(companyId, plugin, accountId, targetObject, item, {}, null)?.recordId ?? null : null)
        }
        const recordId = cache.get(key)
        if (recordId) ids.push(recordId)
      }
      out[linkName] = ids
    }
    return out
  }

  async function importObject(
    companyId: string, plugin: ActivePlugin, accountId: string, object: string, precheck: () => Promise<string | null>,
    deadline: number, cache: Map<string, string | null>,
  ): Promise<{ report: ImportObjectReport; stop: { status: ImportReport['status']; reason: string } | null }> {
    const rule = plugin.mapping.objects[object]
    const report: ImportObjectReport = { seen: 0, created: 0, updated: 0, unchanged: 0, truncated: false, problems: {} }
    const filters: Array<Record<string, unknown>> = []
    if (rule.import.pipelines.length > 0) filters.push({ propertyName: 'pipeline', operator: 'IN', values: rule.import.pipelines })
    if (rule.import.updatedWithinDays !== null) {
      filters.push({ propertyName: MODIFIED, operator: 'GTE', value: String(clock.nowMs() - rule.import.updatedWithinDays * 86_400_000) })
    }
    const hasLinks = Object.keys(rule.links).length > 0
    let after: string | null = null
    for (;;) {
      if (clock.nowMs() > deadline) return { report, stop: { status: 'timed-out', reason: 'time-limit' } }
      const limit = Math.min(PAGE, rule.import.max - report.seen)
      const call: ConnectorCall = {
        endpoint: 'search', object,
        body: {
          filterGroups: filters.length > 0 ? [{ filters }] : [], properties: propertiesOf(plugin, object),
          sorts: [{ propertyName: MODIFIED, direction: 'DESCENDING' }], limit, ...(after ? { after } : {}),
        },
      }
      const r: ConnectorResult = await connector.call(companyId, plugin, call, precheck)
      if (!r.ok) return { report, stop: { status: r.kind === 'not-sent' ? 'stopped' : 'failed', reason: r.reason } }
      const body = isObj(r.body) ? r.body : {}
      const results = Array.isArray(body.results) ? body.results : []
      for (const raw of results) {
        const item = objectOf(raw)
        if (!item || !EXTERNAL_ID_RE.test(item.id)) { report.problems['取り込めない形の答え'] = (report.problems['取り込めない形の答え'] ?? 0) + 1; continue }
        report.seen++
        let links: Record<string, string[]> = {}
        if (hasLinks) {
          // Associations come with a get of the object (search answers carry none).
          const got = await connector.call(companyId, plugin, {
            endpoint: 'get', object, id: item.id,
            query: { properties: propertiesOf(plugin, object), associations: Object.values(rule.links).map(l => l.fromAssociation) },
          }, precheck)
          const full = got.ok ? objectOf(got.body) : null
          if (!got.ok && got.kind === 'not-sent') return { report, stop: { status: 'stopped', reason: got.reason } }
          if (full) links = await linkedRecords(companyId, plugin, accountId, object, full.associations, precheck, cache)
        }
        const done = applyOne(companyId, plugin, accountId, object, item, links, report)
        if (!done) { report.problems['反映できませんでした'] = (report.problems['反映できませんでした'] ?? 0) + 1; continue }
        if (done.created) report.created++
        else if (done.changed) report.updated++
        else report.unchanged++
      }
      const next = isObj(body.paging) && isObj(body.paging.next) && typeof body.paging.next.after === 'string' ? body.paging.next.after : null
      if (report.seen >= rule.import.max) {
        report.truncated = next !== null || (typeof body.total === 'number' && body.total > report.seen)
        return { report, stop: null }
      }
      if (!next || results.length === 0) return { report, stop: null }
      after = next
    }
  }

  return {
    /** POST /plugins/:pluginId/import — owner/admin: one run for this company. */
    async run(member: Member, pluginId: string): Promise<Outcome<ImportReport>> {
      if (!hasFullAccess(member.role)) return refuse('forbidden', PLUGINS_FORBIDDEN)
      const companyId = member.companyId
      if (typeof pluginId !== 'string' || !companyData.forCompany(companyId).plugins.install(pluginId)) return refuse('not-found', PLUGIN_NOT_FOUND.error, { code: PLUGIN_NOT_FOUND.code })
      const active = await plugins.active(companyId, pluginId)
      if (!active.ok) return refuse('conflict', 'いまは取り込めません', { code: 'PLUGIN_NOT_ACTIVE', problem: active.problem })
      if (!companyData.forCompany(companyId).records.settings().enabled) return refuse('conflict', '記録の仕組みがオフのため、取り込めません', { code: 'RECORDS_DISABLED' })
      if (running.has(companyId)) return refuse('conflict', 'この会社の取り込みが実行中です。終わってからもう一度お試しください', { code: 'IMPORT_RUNNING' })
      running.add(companyId)
      const startedAt = clock.now()
      const deadline = clock.nowMs() + IMPORT_TIME_LIMIT_MS
      const report: ImportReport = { status: 'complete', reason: null, objects: {}, startedAt, finishedAt: startedAt }
      try {
        const plugin = active.plugin
        const precheck = precheckFor(companyId, pluginId, plugin.connectionId, { userId: member.userId, needsFullAccess: true })
        const account = await verifyAccount(companyId, plugin, precheck)
        if (!account.ok) {
          report.status = account.reason === 'account-changed' ? 'failed' : 'stopped'
          report.reason = account.reason
        } else {
          ensureTypes(companyId, plugin, startedAt)
          const cache = new Map<string, string | null>()
          for (const object of Object.keys(plugin.mapping.objects)) {
            if (!plugin.manifest.objects[object]?.endpoints.search) continue
            const { report: r, stop } = await importObject(companyId, plugin, account.accountId, object, precheck, deadline, cache)
            report.objects[object] = r
            if (stop) { report.status = stop.status; report.reason = stop.reason; break }
            if (r.truncated) report.status = 'truncated'
          }
        }
      } finally {
        running.delete(companyId)
        report.finishedAt = clock.now()
        companyData.forCompany(companyId).plugins.addHistory({
          id: deps.ids.newId(), pluginId, action: 'import', at: report.finishedAt, by: member.userId, change: JSON.stringify(report),
        })
      }
      if (report.reason === 'account-changed') {
        return refuse('conflict', 'HubSpot のアカウントが、この接続のものと違います。新しい接続にするかを管理者が決めてください', { code: 'ACCOUNT_CHANGED', report })
      }
      return ok(report)
    },

    /**
     * Bring one record up to date from the outside system (before a write, and
     * when the AI reads it, P6). Only a record the member may read; nothing is
     * asked outside for any other (review §5.1: no read by outside id).
     */
    async refreshRecord(member: Member, pluginId: string, recordId: string, precheck?: () => Promise<string | null>): Promise<Outcome<{ recordId: string; version: number; changed: boolean; accountId: string; external: { object: string; externalId: string; properties: ExternalProperties } }>> {
      const handle = companyData.forCompany(member.companyId)
      const row = RECORD_ID_RE.test(recordId) ? handle.records.byIds([recordId])[0] : undefined
      const readable = row && row.removedAt === null && recordReader(member, handle.scopes.listWithRules()).record(row)
      if (!readable) return refuse('not-found', RECORD_NOT_FOUND.error, { code: RECORD_NOT_FOUND.code })
      const active = await plugins.active(member.companyId, pluginId)
      if (!active.ok) return refuse('conflict', 'いまは HubSpot とつながっていません', { code: 'PLUGIN_NOT_ACTIVE', problem: active.problem })
      const plugin = active.plugin
      const link = handle.plugins.linkOfRecord(recordId)
      if (!link || link.pluginId !== pluginId || link.connectionId !== plugin.connectionId) {
        return refuse('conflict', 'この記録は、いまの接続から取り込んだものではありません', { code: 'NOT_LINKED' })
      }
      const check = precheck ?? precheckFor(member.companyId, pluginId, plugin.connectionId, { userId: member.userId, needsFullAccess: false })
      const account = await verifyAccount(member.companyId, plugin, check)
      if (!account.ok) return refuse('conflict', 'HubSpot と確かめられませんでした', { code: account.reason === 'account-changed' ? 'ACCOUNT_CHANGED' : 'NOT_CONFIRMED', reason: account.reason })
      if (account.accountId !== link.accountId) return refuse('conflict', 'この記録は別の HubSpot のアカウントのものです', { code: 'ACCOUNT_CHANGED' })
      const r = await connector.call(member.companyId, plugin, { endpoint: 'get', object: link.object, id: link.externalId, query: { properties: propertiesOf(plugin, link.object) } }, check)
      const item = r.ok ? objectOf(r.body) : null
      if (!item) return refuse('unavailable', 'HubSpot から読めませんでした', { code: 'OUTSIDE_UNAVAILABLE', reason: r.ok ? 'unreadable-answer' : r.reason })
      const applied = applyOne(member.companyId, plugin, account.accountId, link.object, item, {}, null)
      if (!applied) return refuse('conflict', '記録に反映できませんでした', { code: 'NOT_APPLIED' })
      const version = handle.records.states([recordId])[0]?.version ?? 0
      return ok({ recordId, version, changed: applied.changed, accountId: account.accountId, external: { object: link.object, externalId: link.externalId, properties: item.properties } })
    },

    /** POST /plugins/:pluginId/connection/renew — owner/admin: the outside account changed on purpose; a new connection. */
    renewConnection(member: Member, pluginId: string): Outcome<{ connectionId: string }> {
      if (!hasFullAccess(member.role)) return refuse('forbidden', PLUGINS_FORBIDDEN)
      const repo = companyData.forCompany(member.companyId).plugins
      const install = typeof pluginId === 'string' ? repo.install(pluginId) : null
      if (!install) return refuse('not-found', PLUGIN_NOT_FOUND.error, { code: PLUGIN_NOT_FOUND.code })
      const connectionId = deps.ids.newId()
      const at = clock.now()
      repo.renewConnection(pluginId, connectionId, at, member.userId, {
        id: deps.ids.newId(), pluginId, action: 'connection', at, by: member.userId,
        change: JSON.stringify({ before: { connectionId: install.connectionId, accountId: install.accountId }, after: { connectionId } }),
      })
      return ok({ connectionId })
    },

    /** For P6: the account check and the precheck builder. */
    verifyAccount,
    precheckFor,
    applyOne,
    propertiesOf,
  }
}

export type PluginImportService = ReturnType<typeof createPluginImportService>
