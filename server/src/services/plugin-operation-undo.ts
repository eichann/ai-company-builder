/**
 * Undo, people only (plugins.md "Typed operations" 「変更前の値を書き戻す」,
 * "Creates" 「作ったものを取り消す」): a new compensating operation — the stored
 * raw previous values of an applied update, or an archive of what an applied
 * create made — re-checked like a new write, on the same connection and
 * account, serialised with every other write to the same outside object.
 */
import { FULL_ACCESS_ROLES } from '../../shared/core/permissions'
import { externalToAcb, type AcbValue, type PluginOperation } from '../../shared/core/plugins'
import type { PluginOperationRow } from '../ports/plugins'
import type { Member } from './access'
import { refuse, type Outcome } from './outcome'
import { createPolicy, fieldsAuto, notAuto, placeOf, type OperationChecks } from './plugin-operation-checks'
import {
  CREATE_UNDO_LABEL, UNDO_LABEL, conflict, notActive, notFound, opNotFound, operationOff, rawOf, same,
  type OperationActor, type PluginOperationDeps, type RunAnswer, type Serialised,
} from './plugin-operation-common'
import { receiptFor, type OperationRecords } from './plugin-operation-records'
import type { OperationSending } from './plugin-operation-sending'
import type { ActivePlugin } from './plugins'

export function createOperationUndo(
  deps: Pick<PluginOperationDeps, 'companyData' | 'clock' | 'plugins' | 'connector' | 'writer' | 'importer'> & {
    checks: Pick<OperationChecks, 'opFor' | 'readable' | 'mayRun' | 'precheckFor' | 'valuesOf'>
    records: Pick<OperationRecords, 'newRow' | 'answerFor'>
    sending: Pick<OperationSending, 'readOutside' | 'sendAndSettle'>
    serialised: Serialised
  },
) {
  const { companyData, clock, plugins, connector, writer, importer, checks, records, sending, serialised } = deps
  const { readable, mayRun, precheckFor } = checks

  /**
   * 「変更前の値を書き戻す」 (a person only; review §6.4): a new compensating
   * write of the raw previous values stored with the operation — never
   * re-read through the current mapping — on the same connection and
   * account, only while HubSpot still holds what ACB wrote, after every
   * check a new write gets. Downstream effects are not undone.
   * For a create, 「作ったものを取り消す」: an archive of the object ACB made
   * (only an `applied` create — its id came in the answer to ACB's create, or
   * was found by ACB's correlation value).
   */
  async function undo(member: Member, pluginId: string, operationId: string, provenance: Pick<OperationActor, 'conversationId' | 'proposedBy'> = {}): Promise<Outcome<RunAnswer>> {
    const op = await checks.opFor(member, pluginId, operationId)
    if (!op) return opNotFound()
    // An AI's automatic change (nobody approved it) may also be undone by the record's assignee, who is told of it (知らせ「AI が変えました」).
    const assigneeOfAiChange = op.actorKind === 'ai' && !op.approvedBy && op.recordId !== null
      && checks.valuesOf(member.companyId, op.recordId).fields.assignee === member.userId
    if (op.actorId !== member.userId && !assigneeOfAiChange && !FULL_ACCESS_ROLES.has(member.role)) {
      return refuse('forbidden', '自分の（自分の AI の）変更か、担当する記録を AI が変えたものか、管理者だけが書き戻せます', { code: 'NOT_ALLOWED' })
    }
    if (op.operation === 'undo' || op.undoneBy !== null) return conflict('この変更はもう書き戻してあるか、書き戻しそのものです', 'NOT_UNDOABLE')
    if (op.state !== 'applied') {
      return conflict(op.state === 'observed'
        ? 'HubSpot でその値になったことは分かりましたが、ACB が書いたと確かめられないため、書き戻せません'
        : 'HubSpot に書けたと確かめられていない変更は、書き戻せません', 'NOT_UNDOABLE', { state: op.state })
    }
    const active = await plugins.active(member.companyId, pluginId)
    if (!active.ok) return notActive(active.problem)
    const plugin = active.plugin
    if (plugin.connectionId !== op.connectionId || (plugin.accountId !== null && plugin.accountId !== op.accountId)) {
      return conflict('この変更は別の HubSpot のアカウント（接続）でしたものです。書き戻せません', 'ACCOUNT_CHANGED')
    }
    const declared = plugin.manifest.operations[op.operation]
    const human: OperationActor = { kind: 'human', conversationId: provenance.conversationId ?? null, proposedBy: provenance.proposedBy ?? null }
    if (declared?.kind === 'create') return undoCreate(member, human, plugin, op, declared)
    if (!declared || declared.undo !== 'restore_previous') return conflict('この操作は書き戻せません', 'NOT_UNDOABLE')
    const recordId = op.recordId as string
    const row = readable(member, recordId)!
    const place = placeOf(row)
    if (!mayRun(member, human, declared.who, recordId, place, plugin.pluginId)) return refuse('forbidden', 'この操作をする権限がありません', { code: 'NOT_ALLOWED' })
    const asked = JSON.parse(op.fields) as Record<string, AcbValue>
    const names = Object.keys(asked)
    // Writing back the previous values is a move too: to or from a closing stage it is not automatic.
    const writeValues = () => ({ raw: JSON.parse(op.previous) as Record<string, unknown>, current: checks.valuesOf(member.companyId, recordId).fields })
    const policy = notAuto(plugin, op.operation, names, writeValues())
    if (policy.prior.length + policy.off.length > 0) return conflict('いまは自動で書き戻せない欄が含まれています', 'APPROVAL_REQUIRED', { fields: [...policy.prior, ...policy.off] })
    const precheck = precheckFor(member, human, plugin, declared.who, recordId, place, fieldsAuto(op.operation, names, writeValues))
    const externalId = op.externalId as string

    return serialised(`${member.companyId}|${op.connectionId}|${op.object}|${externalId}`, async () => {
      const account = await importer.verifyAccount(member.companyId, plugin, precheck)
      if (!account.ok || account.accountId !== op.accountId) return conflict('この変更は別の HubSpot のアカウントでしたものです。書き戻せません', 'ACCOUNT_CHANGED')
      const written = JSON.parse(op.written) as Record<string, string>
      const previous = JSON.parse(op.previous) as Record<string, string>
      const props = Object.keys(written)
      const outside = await sending.readOutside(member.companyId, plugin, op.object, externalId, props, precheck)
      if (!outside) return refuse('unavailable', 'HubSpot から今の値を読めませんでした（何も変えていません）', { code: 'OUTSIDE_UNAVAILABLE' })
      importer.applyOne(member.companyId, plugin, op.accountId, op.object, outside, {}, null)
      if (!same(written, rawOf(outside.properties, props))) {
        const now = externalToAcb({ manifest: plugin.manifest, types: plugin.types }, plugin.mapping, op.object, outside.properties).values
        return conflict('HubSpot 側でそのあとに変わっているため、書き戻せません', 'CHANGED_OUTSIDE', { current: Object.fromEntries(names.map(n => [n, now[n] ?? null])) })
      }
      // The ACB values the previous raw values stand for (for the record's copy); the write itself sends the raw values.
      const back = externalToAcb({ manifest: plugin.manifest, types: plugin.types }, plugin.mapping, op.object, previous).values
      const undoRow = records.newRow(member, human, plugin, {
        operation: 'undo', accountId: op.accountId, object: op.object, externalId, recordId, undoOf: op.id,
        fields: JSON.stringify(Object.fromEntries(names.filter(n => n in back).map(n => [n, back[n]]))),
        written: JSON.stringify(previous), previous: JSON.stringify(rawOf(outside.properties, props)),
      })
      const repo = companyData.forCompany(member.companyId).plugins
      repo.insertOperation(undoRow)
      const settled = await sending.sendAndSettle(member, human, plugin, undoRow, JSON.parse(undoRow.fields) as Record<string, AcbValue>, precheck,
        { action: `${pluginId}.undo`, note: `${UNDO_LABEL}（${op.id}）`, decision: false })
      if (settled.state === 'applied') repo.updateOperation(op.id, { undoneBy: settled.id }, clock.now())
      return records.answerFor(member, settled)
    })
  }

  /**
   * 「作ったものを取り消す」: archive the object an applied create made (its id
   * is ACB's: the answer to its own create, or found by its correlation
   * value) — by its actor or an owner / admin, re-checked like a new write,
   * on the same connection and account. A new operation (`undo`, `undoOf`).
   */
  async function undoCreate(member: Member, human: OperationActor, plugin: ActivePlugin, op: PluginOperationRow, declared: PluginOperation): Promise<Outcome<RunAnswer>> {
    if (declared.undo !== 'archive' || op.externalId === null || !plugin.manifest.objects[op.object]?.endpoints.archive) return conflict('この操作は取り消せません', 'NOT_UNDOABLE')
    const row = op.recordId ? readable(member, op.recordId) : null
    if (!row) return notFound()
    const place = placeOf(row)
    if (!mayRun(member, human, declared.who, row.id, place, plugin.pluginId)) return refuse('forbidden', 'この操作をする権限がありません', { code: 'NOT_ALLOWED' })
    if (createPolicy(plugin, op.operation, declared) === 'off') return operationOff()
    const precheck = precheckFor(member, human, plugin, declared.who, row.id, place, p => createPolicy(p, op.operation, declared) !== 'off')
    const externalId = op.externalId
    return serialised(`${member.companyId}|${op.connectionId}|${op.object}|${externalId}`, async () => {
      const account = await importer.verifyAccount(member.companyId, plugin, precheck)
      if (!account.ok || account.accountId !== op.accountId) return conflict('この操作は別の HubSpot のアカウントでしたものです。取り消せません', 'ACCOUNT_CHANGED')
      const repo = companyData.forCompany(member.companyId).plugins
      const undoRow = records.newRow(member, human, plugin, {
        operation: 'undo', accountId: op.accountId, object: op.object, externalId, recordId: row.id, undoOf: op.id, fields: op.fields, written: '{}', previous: '{}',
      })
      repo.insertOperation(undoRow)
      const r = await connector.call(member.companyId, plugin, { endpoint: 'archive', object: op.object, id: externalId }, precheck)
      if (!r.ok) {
        repo.updateOperation(undoRow.id, r.kind === 'unknown' || r.kind === 'server-error' ? { state: 'sent-unknown', reason: r.reason } : { state: 'failed', reason: r.reason }, clock.now())
        return records.answerFor(member, repo.operation(undoRow.id)!)
      }
      const applied = writer.apply(member.companyId, {
        recordId: row.id, type: row.type, folder: null, title: null, fields: {}, links: {}, entryWithoutChanges: true,
        action: `${plugin.pluginId}.undo`, source: plugin.pluginId, note: `${CREATE_UNDO_LABEL}（${op.id}）`,
        actor: { id: member.userId, kind: 'human', source: null, conversationId: human.conversationId ?? null, proposedBy: human.proposedBy ?? null },
        receipt: receiptFor(plugin, undoRow, externalId, null),
      })
      repo.updateOperation(undoRow.id, { state: 'applied', recordVersion: applied.ok ? applied.version : null, reason: applied.ok ? null : 'ledger-not-written' }, clock.now())
      repo.updateOperation(op.id, { undoneBy: undoRow.id }, clock.now())
      return records.answerFor(member, repo.operation(undoRow.id)!)
    })
  }

  return { undo }
}
