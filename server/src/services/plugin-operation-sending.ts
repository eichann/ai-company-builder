/**
 * Sending a typed operation and settling it (plugins.md "Typed operations",
 * "Creates"): one PATCH / POST / DELETE for an operation row already written
 * as pending, then `applied` (with the ledger entry), `failed`, or
 * `sent-unknown` — and the reads that compare the outside state with the
 * stored evidence afterwards (reconcile). **A write is never re-sent**: a lost
 * update is read back (`observed` when the intended values are there), a lost
 * create is looked up by its correlation value, a lost archive by its `get`.
 */
import { externalToAcb, type AcbValue, type ExternalProperties, type PluginOperation } from '../../shared/core/plugins'
import type { LedgerValue } from '../../shared/core/record-ledger'
import type { PluginOperationRow } from '../ports/plugins'
import type { Member } from './access'
import type { Outcome } from './outcome'
import { EXTERNAL_ID_RE } from './plugin-connector'
import type { OperationChecks } from './plugin-operation-checks'
import {
  CREATE_SEARCH_DELAY_MS, conflict, isObj, rawOf, same, stripTitle,
  type OperationActor, type PluginOperationDeps, type RunAnswer,
} from './plugin-operation-common'
import { actorOf, receiptFor, type OperationRecords } from './plugin-operation-records'
import type { ActivePlugin } from './plugins'
import type { ExternalRecordWriter } from './record-engine'

export function createOperationSending(
  deps: Pick<PluginOperationDeps, 'companyData' | 'clock' | 'connector' | 'writer' | 'importer'>
    & Pick<OperationChecks, 'valuesOf'> & Pick<OperationRecords, 'newRow' | 'answerFor'>,
) {
  const { companyData, clock, connector, writer, importer } = deps

  /** GET the outside object's properties the mapping reads (and those written). */
  async function readOutside(companyId: string, plugin: ActivePlugin, object: string, externalId: string, extra: string[], precheck: () => Promise<string | null>) {
    const properties = [...new Set([...importer.propertiesOf(plugin, object), ...extra])]
    const r = await connector.call(companyId, plugin, { endpoint: 'get', object, id: externalId, query: { properties } }, precheck)
    if (!r.ok || !isObj(r.body) || !isObj(r.body.properties) || r.body.id !== externalId) return null
    return { id: externalId, properties: r.body.properties as ExternalProperties }
  }

  // ── updates ──

  /**
   * Send one PATCH for an operation row already recorded as pending, and
   * settle it: applied (with the ledger entry), sent-unknown / observed, or
   * failed. Never re-sent.
   */
  async function sendAndSettle(
    member: Member, actor: OperationActor, plugin: ActivePlugin, op: PluginOperationRow, acbFields: Record<string, AcbValue>,
    precheck: () => Promise<string | null>, ledger: { action: string; note: string; decision: boolean },
  ): Promise<PluginOperationRow> {
    const repo = companyData.forCompany(member.companyId).plugins
    const written = JSON.parse(op.written) as Record<string, string>
    const externalId = op.externalId as string
    const recordId = op.recordId as string
    const r = await connector.call(member.companyId, plugin, { endpoint: 'update', object: op.object, id: externalId, body: { properties: written } }, precheck)
    const at = () => clock.now()
    if (!r.ok) {
      // A 5xx may have been applied: as unknown as a lost answer. A 429 / 4xx / nothing sent: known not applied.
      if (r.kind === 'unknown' || r.kind === 'server-error') {
        repo.updateOperation(op.id, { state: 'sent-unknown', reason: r.reason }, at())
        return reconcileUpdate(member.companyId, plugin, repo.operation(op.id)!)
      }
      repo.updateOperation(op.id, { state: 'failed', reason: r.reason }, at())
      return repo.operation(op.id)!
    }
    repo.updateOperation(op.id, { state: 'external-ok' }, at())
    // ACB's confirmed write: its own entry, with the values it wrote.
    const current = deps.valuesOf(member.companyId, recordId)
    const applied = writer.apply(member.companyId, {
      recordId, type: plugin.manifest.objects[op.object].recordType as string, folder: null, title: null,
      fields: acbFields as Record<string, LedgerValue>, links: {}, action: ledger.action, source: plugin.pluginId, note: ledger.note, decision: ledger.decision,
      expectedVersion: current.version,
      actor: { ...actorOf(op, actor.kind === 'human' ? actor.proposedBy ?? null : null), source: actor.kind === 'ai' ? actor.source ?? null : null },
      receipt: receiptFor(plugin, op, externalId, isObj(r.body) && typeof r.body.updatedAt === 'string' ? r.body.updatedAt : null),
    })
    repo.updateOperation(op.id, { state: 'applied', recordVersion: applied.ok ? applied.version : null, reason: applied.ok ? null : 'ledger-not-written' }, at())
    // Read back after writing: anything else changed meanwhile arrives as an observed change.
    const back = await readOutside(member.companyId, plugin, op.object, externalId, Object.keys(written), async () => null)
    if (back) importer.applyOne(member.companyId, plugin, op.accountId, op.object, back, {}, null)
    return repo.operation(op.id)!
  }

  /**
   * Compare the outside state with an update's evidence (review §5.6): the
   * intended values are there → `observed` (not ACB's confirmed success:
   * someone else may have written the same; not undoable), recorded as an
   * observed change; otherwise it stays `sent-unknown`. Never re-sends.
   */
  async function reconcileUpdate(companyId: string, plugin: ActivePlugin, op: PluginOperationRow): Promise<PluginOperationRow> {
    const repo = companyData.forCompany(companyId).plugins
    const written = JSON.parse(op.written) as Record<string, string>
    // Only a read, to collect facts: the stops are for new writes, not for this (review §6.5).
    const back = await readOutside(companyId, plugin, op.object, op.externalId as string, Object.keys(written), async () => null)
    if (!back) return op
    importer.applyOne(companyId, plugin, op.accountId, op.object, back, {}, null)
    if (same(written, rawOf(back.properties, Object.keys(written)))) {
      repo.updateOperation(op.id, { state: 'observed', reason: 'observed-actor-unknown' }, clock.now())
    } else {
      repo.updateOperation(op.id, { state: 'sent-unknown', reason: 'not-observed' }, clock.now())
    }
    return repo.operation(op.id)!
  }

  // ── creates ──

  /**
   * After the outside system made the object (its id known — from the answer,
   * or found by the correlation value): a create of a record becomes a record
   * (the engine's external entry: server only, no file, linked like an
   * import); a create attached to a record gets an entry on that record's
   * ledger (no field changes; the receipt names the new object).
   */
  function settleCreated(companyId: string, plugin: ActivePlugin, op: PluginOperationRow, externalId: string, how: { note?: string; decision?: boolean; reason?: string | null; proposedBy?: 'ai' | null } = {}): PluginOperationRow {
    const repo = companyData.forCompany(companyId).plugins
    if (op.externalId === null) repo.updateOperation(op.id, { externalId, state: 'external-ok' }, clock.now())
    const declared = plugin.manifest.operations[op.operation]
    const asked = JSON.parse(op.fields) as Record<string, AcbValue>
    const written = JSON.parse(op.written) as Record<string, string>
    const label = declared?.label ?? op.operation
    const title = typeof asked.title === 'string' ? asked.title : ''
    const summary = `${label}：「${title}」${typeof asked.at === 'string' ? `（${asked.at}）` : ''}`
    const common = {
      links: {}, action: `${plugin.pluginId}.${op.operation}`, source: plugin.pluginId, note: how.note ?? summary, decision: how.decision === true,
      actor: actorOf(op, how.proposedBy ?? null), receipt: receiptFor(plugin, op, externalId, null),
    }
    let applied: ReturnType<ExternalRecordWriter['apply']>
    if (declared?.createsRecord) {
      const fields = stripTitle(externalToAcb({ manifest: plugin.manifest, types: plugin.types }, plugin.mapping, op.object, written).values)
      applied = writer.apply(companyId, {
        ...common, recordId: null, type: plugin.manifest.objects[op.object].recordType as string,
        folder: plugin.mapping.objects[op.object]?.visibleToFolder ?? null, title, fields: fields as Record<string, LedgerValue>,
      })
      if (applied.ok) {
        repo.saveLink({
          pluginId: plugin.pluginId, connectionId: op.connectionId, accountId: op.accountId, object: op.object, externalId,
          recordId: applied.recordId, externalUpdatedAt: null, seenAt: clock.now(),
        })
        repo.updateOperation(op.id, { recordId: applied.recordId }, clock.now())
      }
    } else {
      const target = declared?.attachTo ? plugin.manifest.objects[declared.attachTo]?.recordType : null
      applied = op.recordId && target
        ? writer.apply(companyId, { ...common, recordId: op.recordId, type: target, folder: null, title: null, fields: {}, entryWithoutChanges: true })
        : { ok: false, reason: 'not-found' }
    }
    repo.updateOperation(op.id, {
      state: 'applied', recordVersion: applied.ok ? applied.version : null, reason: applied.ok ? how.reason ?? null : 'ledger-not-written',
    }, clock.now())
    return repo.operation(op.id)!
  }

  /**
   * Send one create for an operation row already recorded as pending (its
   * correlation value inside), and settle it. Never re-sent: a lost answer
   * or a 5xx is looked up by the correlation value, at once when the object
   * can be read by it, else by search after `CREATE_SEARCH_DELAY_MS`.
   */
  async function sendCreate(
    companyId: string, plugin: ActivePlugin, op: PluginOperationRow, attachTo: string | null, precheck: () => Promise<string | null>,
    how: { note?: string; decision?: boolean; proposedBy?: 'ai' | null },
  ): Promise<PluginOperationRow> {
    const repo = companyData.forCompany(companyId).plugins
    const declared = plugin.manifest.operations[op.operation]
    const body: Record<string, unknown> = { properties: JSON.parse(op.written) as Record<string, string> }
    if (attachTo && declared?.associationType) {
      body.associations = [{ to: { id: attachTo }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: declared.associationType }] }]
    }
    const r = await connector.call(companyId, plugin, { endpoint: 'create', object: op.object, body }, precheck)
    if (!r.ok) {
      if (r.kind === 'unknown' || r.kind === 'server-error') {
        repo.updateOperation(op.id, { state: 'sent-unknown', reason: r.reason }, clock.now())
        return reconcileCreate(companyId, plugin, repo.operation(op.id)!)
      }
      repo.updateOperation(op.id, { state: 'failed', reason: r.reason }, clock.now())
      return repo.operation(op.id)!
    }
    const id = isObj(r.body) && typeof r.body.id === 'string' && EXTERNAL_ID_RE.test(r.body.id) ? r.body.id : null
    if (!id) {
      repo.updateOperation(op.id, { state: 'sent-unknown', reason: 'unreadable-answer' }, clock.now())
      return reconcileCreate(companyId, plugin, repo.operation(op.id)!)
    }
    return settleCreated(companyId, plugin, op, id, how)
  }

  /**
   * Look a create whose answer was lost up by its correlation value (design
   * §4-4): the object's `get` with `idProperty` (a unique-value property),
   * else the declared search — only `CREATE_SEARCH_DELAY_MS` after the send.
   * Found → ours (`applied`, reason `found-by-correlation`). Not found → stays
   * `sent-unknown` (`not-found`, never "does not exist"); too early →
   * `too-early`. Only reads; never re-sends.
   */
  async function reconcileCreate(companyId: string, plugin: ActivePlugin, op: PluginOperationRow): Promise<PluginOperationRow> {
    const repo = companyData.forCompany(companyId).plugins
    const declared = plugin.manifest.operations[op.operation]
    const property = declared?.correlationProperty
    const endpoints = plugin.manifest.objects[op.object]?.endpoints ?? {}
    const mark = (reason: string) => { repo.updateOperation(op.id, { state: 'sent-unknown', reason }, clock.now()); return repo.operation(op.id)! }
    if (!property) return mark('cannot-look-up')
    const noStops = async () => null
    let decided: 'found' | 'not-found' | 'unreachable' | null = null
    let foundId: string | null = null
    if (endpoints.get && EXTERNAL_ID_RE.test(op.id)) {
      const r = await connector.call(companyId, plugin, { endpoint: 'get', object: op.object, id: op.id, query: { idProperty: property, properties: [property] } }, noStops)
      if (r.ok && isObj(r.body) && typeof r.body.id === 'string' && EXTERNAL_ID_RE.test(r.body.id) && isObj(r.body.properties) && r.body.properties[property] === op.id) {
        decided = 'found'; foundId = r.body.id
      } else if (!r.ok && r.kind === 'refused' && r.status === 404) decided = 'not-found'
      // A 400 (the property is not a unique identifier for this object) falls back to search.
      else if (!(!r.ok && r.kind === 'refused' && r.status === 400)) decided = 'unreachable'
    }
    if (decided === null) {
      if (!endpoints.search) return mark('cannot-look-up')
      if (clock.nowMs() - Date.parse(op.createdAt) < CREATE_SEARCH_DELAY_MS) return mark('too-early')
      const r = await connector.call(companyId, plugin, {
        endpoint: 'search', object: op.object,
        body: { filterGroups: [{ filters: [{ propertyName: property, operator: 'EQ', value: op.id }] }], properties: [property], limit: 2 },
      }, noStops)
      if (!r.ok || !isObj(r.body) || !Array.isArray(r.body.results)) decided = 'unreachable'
      else {
        const hit = r.body.results.find(x => isObj(x) && typeof x.id === 'string' && EXTERNAL_ID_RE.test(x.id) && isObj(x.properties) && x.properties[property] === op.id) as { id: string } | undefined
        decided = hit ? 'found' : 'not-found'
        foundId = hit?.id ?? null
      }
    }
    if (decided === 'found' && foundId) return settleCreated(companyId, plugin, op, foundId, { reason: 'found-by-correlation' })
    return mark(decided === 'not-found' ? 'not-found' : 'unreachable')
  }

  /** Send a create of a record (only reached through an approval) and settle it. */
  async function sendNewRecord(
    member: Member, actor: OperationActor, plugin: ActivePlugin, operation: string, op: PluginOperation,
    input: { fields: Record<string, AcbValue>; properties: Record<string, string> }, precheck: () => Promise<string | null>,
    how: { note: string; decision?: boolean; approvedBy: string | null }, expectedAccount?: string,
  ): Promise<Outcome<RunAnswer>> {
    const account = await importer.verifyAccount(member.companyId, plugin, precheck)
    if (!account.ok || (expectedAccount !== undefined && account.accountId !== expectedAccount)) {
      return conflict('HubSpot のアカウントを確かめられないか、承認のときと違います', 'ACCOUNT_CHANGED', { reason: account.ok ? 'other-account' : account.reason })
    }
    const row0 = deps.newRow(member, actor, plugin, {
      operation, accountId: account.accountId, object: op.object, externalId: null, recordId: null,
      fields: JSON.stringify(input.fields), written: '', previous: '{}', approvedBy: how.approvedBy,
    })
    row0.written = JSON.stringify({ ...input.properties, [op.correlationProperty as string]: row0.id })
    companyData.forCompany(member.companyId).plugins.insertOperation(row0)
    const settled = await sendCreate(member.companyId, plugin, row0, null, precheck, { note: how.note || undefined, decision: how.decision })
    return deps.answerFor(member, settled)
  }

  // ── archives (the undo of a create) ──

  /** An archive whose answer was lost: gone from the object's `get` → observed (who removed it is not known); else unknown. */
  async function reconcileArchive(companyId: string, plugin: ActivePlugin, op: PluginOperationRow): Promise<PluginOperationRow> {
    const repo = companyData.forCompany(companyId).plugins
    if (!plugin.manifest.objects[op.object]?.endpoints.get || op.externalId === null) return op
    const r = await connector.call(companyId, plugin, { endpoint: 'get', object: op.object, id: op.externalId, query: { properties: ['hs_object_id'] } }, async () => null)
    if (!r.ok && r.kind === 'refused' && r.status === 404) repo.updateOperation(op.id, { state: 'observed', reason: 'gone-actor-unknown' }, clock.now())
    else if (r.ok) repo.updateOperation(op.id, { state: 'sent-unknown', reason: 'still-there' }, clock.now())
    return repo.operation(op.id)!
  }

  return { readOutside, sendAndSettle, reconcileUpdate, sendCreate, reconcileCreate, sendNewRecord, reconcileArchive }
}

export type OperationSending = ReturnType<typeof createOperationSending>
