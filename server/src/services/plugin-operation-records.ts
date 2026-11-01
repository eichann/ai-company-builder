/**
 * The operation record (操作の控え, plugins.md "Typed operations"): a new row
 * as it is written before the send, the receipt and actor its ledger entry
 * carries, and how its record's readers see it (`OperationView`, the answer
 * of every operation route).
 */
import type { AcbValue } from '../../shared/core/plugins'
import type { ExternalReceipt } from '../../shared/core/record-ledger'
import type { PluginOperationRow } from '../ports/plugins'
import type { Member } from './access'
import { ok, refuse, type Outcome } from './outcome'
import type { OperationChecks } from './plugin-operation-checks'
import {
  CREATE_UNDO_LABEL, CREATE_UNDO_NOTICE, UNDO_LABEL, UNDO_NOTICE,
  type OperationActor, type OperationView, type PluginOperationDeps, type RunAnswer,
} from './plugin-operation-common'
import type { ActivePlugin } from './plugins'
import { currentTypes } from './record-index'

/** Update rows always store the raw previous values of the properties written; creates and archives store none. */
export const kindOf = (o: PluginOperationRow): OperationView['kind'] => (o.operation === 'undo' ? 'undo' : o.previous === '{}' ? 'create' : 'update')

export function receiptFor(plugin: ActivePlugin, op: PluginOperationRow, externalId: string, externalUpdatedAt: string | null): ExternalReceipt {
  return {
    plugin: plugin.pluginId, pluginVersion: op.pluginVersion, fingerprint: op.fingerprint, mappingVersion: op.mappingVersion,
    connectionId: op.connectionId, accountId: op.accountId, object: op.object, externalId, externalUpdatedAt, operationId: op.id, kind: 'written',
    ...(op.approvedBy ? { approvedBy: op.approvedBy } : {}),
  }
}

export const actorOf = (op: PluginOperationRow, proposedBy: 'ai' | null = null) =>
  ({ id: op.actorId, kind: op.actorKind, source: op.actorSource, conversationId: op.conversationId, proposedBy: op.actorKind === 'human' ? proposedBy : null })

type NewRowParts = Pick<PluginOperationRow, 'operation' | 'accountId' | 'object' | 'externalId' | 'recordId' | 'fields' | 'written' | 'previous'> & { approvedBy?: string | null; undoOf?: string | null }

export function createOperationRecords(deps: Pick<PluginOperationDeps, 'companyData' | 'clock' | 'ids'> & Pick<OperationChecks, 'valuesOf'>) {
  const { companyData, clock } = deps

  function newRow(member: Member, actor: OperationActor, plugin: ActivePlugin, parts: NewRowParts): PluginOperationRow {
    const at = clock.now()
    return {
      id: deps.ids.newId(), pluginId: plugin.pluginId, pluginVersion: plugin.version, fingerprint: plugin.fingerprint, mappingVersion: plugin.mappingVersion,
      connectionId: plugin.connectionId, actorId: member.userId, actorKind: actor.kind, actorSource: actor.kind === 'ai' ? actor.source ?? null : null,
      conversationId: actor.conversationId ?? null, state: 'pending', reason: null, undoOf: parts.undoOf ?? null, undoneBy: null, recordVersion: null,
      createdAt: at, updatedAt: at, replacedBy: null, approvedBy: parts.approvedBy ?? null,
      operation: parts.operation, accountId: parts.accountId, object: parts.object, externalId: parts.externalId, recordId: parts.recordId,
      fields: parts.fields, written: parts.written, previous: parts.previous,
    }
  }

  function view(companyId: string, o: PluginOperationRow): OperationView {
    const handle = companyData.forCompany(companyId)
    const kind = kindOf(o)
    // The ledger entry of an applied update says exactly what changed (before → after).
    const entry = kind !== 'create' && o.state === 'applied' && o.recordVersion !== null && o.recordId !== null
      ? handle.records.ledger(o.recordId).find(e => e.version === o.recordVersion) : undefined
    const created = kind === 'create'
    const row = o.recordId ? handle.records.byIds([o.recordId])[0] : undefined
    const fields = JSON.parse(o.fields) as Record<string, AcbValue>
    const changes = entry ? entry.changes.map(c => ({ field: c.field, before: c.before as AcbValue, after: c.after as AcbValue })) : null
    // How a choice's values are shown (the type's option_labels): a card and the AI say 「A（高）」, not `a`.
    const def = row ? currentTypes(handle.records).get(row.type)?.definition : undefined
    const valueLabels: Record<string, Record<string, string>> = {}
    for (const f of new Set([...Object.keys(fields), ...(changes ?? []).map(c => c.field)])) {
      const labels = def?.fields[f]?.optionLabels
      if (labels) valueLabels[f] = { ...labels }
    }
    return {
      id: o.id, operation: o.operation, kind, recordId: o.recordId, recordTitle: row?.title ?? null,
      state: o.state, fields, changes, valueLabels,
      actorKind: o.actorKind === 'ai' ? 'ai' : 'human', reason: o.reason,
      undoable: o.operation !== 'undo' && o.state === 'applied' && o.undoneBy === null,
      undoLabel: created ? CREATE_UNDO_LABEL : UNDO_LABEL, undoNotice: created ? CREATE_UNDO_NOTICE : UNDO_NOTICE,
      undoOf: o.undoOf, undoneBy: o.undoneBy, replacedBy: o.replacedBy,
      recreatable: created && o.state === 'sent-unknown' && o.reason === 'not-found' && o.replacedBy === null,
      approvedBy: o.approvedBy, recordVersion: o.recordVersion, createdAt: o.createdAt,
    }
  }

  function answerFor(member: Member, op: PluginOperationRow): Outcome<RunAnswer> {
    const record = op.recordId ? { id: op.recordId, version: deps.valuesOf(member.companyId, op.recordId).version } : null
    if (op.state === 'failed') {
      return refuse(op.reason === 'rate-limited' ? 'rate-limited' : 'conflict', 'HubSpot に書けませんでした（何も変わっていません）', { code: 'WRITE_FAILED', reason: op.reason, operation: view(member.companyId, op), record })
    }
    return ok({ operation: view(member.companyId, op), record })
  }

  return { newRow, view, answerFor }
}

export type OperationRecords = ReturnType<typeof createOperationRecords>
