/**
 * The approval seam of the typed operations (milestone 4 G5, plugins.md "The
 * approval seam"; `services/approvals.ts` builds on it, no route here):
 * `prepareApproval` runs every check of a direct run except the policy gate
 * (which must say `prior`) and builds the fixed payload; `executeApproved`
 * re-checks everything at send time and sends exactly the payload's raw
 * values (never re-translated through the mapping).
 */
import { approvalReasonProblem, type ApprovalFieldChange, type ApproverRule, type PluginApprovalPayload } from '../../shared/core/approvals'
import { acbToExternal, approverFor, effectiveFieldPolicy, externalToAcb, type AcbValue } from '../../shared/core/plugins'
import type { Member } from './access'
import { ok, refuse, type Outcome } from './outcome'
import { createPolicy, notAuto, placeOf, type OperationChecks } from './plugin-operation-checks'
import {
  conflict, isObj, isoOf, notActive, notFound, operationOff, rawOf, stripTitle,
  type OperationActor, type OperationView, type PluginOperationDeps, type Serialised,
} from './plugin-operation-common'
import { attachedInput, noteOf, recordInput } from './plugin-operation-inputs'
import type { OperationRecords } from './plugin-operation-records'
import type { OperationSending } from './plugin-operation-sending'
import type { ActivePlugin } from './plugins'
import { RECORDS_DISABLED } from './records'

export function createOperationApprovals(
  deps: Pick<PluginOperationDeps, 'companyData' | 'plugins' | 'importer' | 'roleOf' | 'aiStopped'> & {
    checks: Pick<OperationChecks, 'recordChecks' | 'newRecordChecks' | 'readable' | 'folderReadable' | 'valuesOf' | 'mayRun' | 'mayRunAt' | 'precheckFor'>
    records: Pick<OperationRecords, 'newRow' | 'view'>
    sending: Pick<OperationSending, 'readOutside' | 'sendAndSettle' | 'sendCreate' | 'sendNewRecord'>
    serialised: Serialised
  },
) {
  const { companyData, plugins, importer, checks, records, sending, serialised } = deps
  const { valuesOf, precheckFor } = checks

  return {
    /**
     * The approval seam (milestone 4, design §3-4; the approvals service
     * builds on it). Runs every check a direct run would — except the policy
     * gate, which must say `prior` (a request with an `off` field is refused;
     * one with every field `auto` needs no approval) — reads the outside object
     * now (update: the raw value of each property before), and builds the
     * fixed payload. Sends nothing, writes nothing.
     */
    async prepareApproval(
      member: Member, actor: OperationActor, pluginId: string, recordId: string | null, operation: string, input: unknown,
    ): Promise<Outcome<{ payload: PluginApprovalPayload; approver: ApproverRule; folder: string | null }>> {
      const b = isObj(input) ? input : null
      if (!b) return refuse('bad-request', 'The input must be an object')
      const basis = isObj(b.basis) ? b.basis : {}
      const meetingId = typeof basis.meetingId === 'string' && basis.meetingId.length <= 100 ? basis.meetingId : null
      const quote = typeof basis.quote === 'string' && basis.quote.length <= 2000 ? basis.quote.normalize('NFC') : null
      const head = (plugin: ActivePlugin) => ({
        v: 1 as const, kind: 'plugin_operation' as const, plugin: { id: plugin.pluginId, version: plugin.version, fingerprint: plugin.fingerprint },
        mappingVersion: plugin.mappingVersion, connectionId: plugin.connectionId, operation, basis: { meetingId, quote },
      })

      if (recordId === null) {
        const c = await checks.newRecordChecks(member, actor, pluginId, operation)
        if (c.refusal) return c.refusal
        const { plugin, op, place } = c
        const given = recordInput(plugin, op, b)
        if (!given.ok) return refuse('bad-request', given.error, { code: 'BAD_VALUE', ...(given.errors ? { errors: given.errors } : {}) })
        const noted = noteOf(b, op, actor)
        if (!noted.ok) return noted.refusal
        const policy = createPolicy(plugin, operation, op)
        if (policy === 'off') return operationOff()
        if (policy !== 'prior') return conflict('この操作は承認なしで動きます', 'APPROVAL_NOT_NEEDED')
        const precheck = precheckFor(member, actor, plugin, op.who, null, place, () => true)
        const account = await importer.verifyAccount(member.companyId, plugin, precheck)
        if (!account.ok) return conflict('HubSpot のアカウントを確かめられません', 'ACCOUNT_CHANGED', { reason: account.reason })
        return ok({
          payload: { ...head(plugin), accountId: account.accountId, record: null, object: op.object, externalId: null, changes: [], create: { title: given.fields.title as string, properties: given.properties } },
          approver: approverFor(plugin.manifest, plugin.mapping, operation, {}), folder: place,
        })
      }

      const c = await checks.recordChecks(member, actor, pluginId, recordId, operation)
      if (c.refusal) return c.refusal
      const { plugin, op, link, place } = c
      if (op.kind === 'read') return refuse('bad-request', '読む操作に承認は要りません', { code: 'APPROVAL_NOT_NEEDED' })
      const noted = noteOf(b, op, actor)
      if (!noted.ok) return noted.refusal
      const precheck = precheckFor(member, actor, plugin, op.who, recordId, place, () => true)

      if (op.kind === 'create') {
        const given = attachedInput(op, b)
        if (!given.ok) return refuse('bad-request', given.error, { code: 'BAD_INPUT' })
        const policy = createPolicy(plugin, operation, op)
        if (policy === 'off') return operationOff()
        if (policy !== 'prior') return conflict('この操作は承認なしで動きます', 'APPROVAL_NOT_NEEDED')
        const account = await importer.verifyAccount(member.companyId, plugin, precheck)
        if (!account.ok || account.accountId !== link.accountId) return conflict('HubSpot のアカウントを確かめられないか、この記録のものと違います', 'ACCOUNT_CHANGED')
        return ok({
          payload: {
            ...head(plugin), accountId: link.accountId, record: { id: recordId, version: valuesOf(member.companyId, recordId).version }, object: op.object,
            externalId: link.externalId, changes: [], create: { title: typeof given.fields.title === 'string' ? given.fields.title : '', properties: given.properties },
          },
          approver: approverFor(plugin.manifest, plugin.mapping, operation, {}), folder: place,
        })
      }

      // An update.
      if (!Number.isInteger(b.expectedVersion) || (b.expectedVersion as number) < 0) return refuse('bad-request', 'expectedVersion: the version you saw', { code: 'VERSION_REQUIRED' })
      if (!isObj(b.fields) || Object.keys(b.fields).length === 0 || Object.keys(b.fields).length > 30) return refuse('bad-request', 'fields: { <field>: value } (1–30)')
      const asked = b.fields as Record<string, AcbValue>
      const names = Object.keys(asked)
      const policy = notAuto(plugin, operation, names)
      if (policy.off.length > 0) return refuse('bad-request', `書き戻さない欄です：${policy.off.join('、')}（何も変えていません）`, { code: 'FIELD_NOT_WRITABLE', fields: policy.off })
      if (policy.prior.length === 0) return conflict('この変更は承認なしで書けます', 'APPROVAL_NOT_NEEDED')
      const pkg = { manifest: plugin.manifest, types: plugin.types }
      const rules = plugin.mapping.objects[op.object]?.fields ?? {}
      const translated = acbToExternal(pkg, plugin.mapping, op.object, asked)
      if (!translated.ok) return refuse('bad-request', '書き戻せない値があります（何も変えていません）', { code: 'BAD_VALUE', errors: translated.errors })
      const current = valuesOf(member.companyId, recordId)
      if (current.version !== b.expectedVersion) return conflict('ほかの人が先に変えました。最新の状態を見てからもう一度お試しください', 'VERSION_CONFLICT', { version: current.version })
      return serialised(`${member.companyId}|${plugin.connectionId}|${link.object}|${link.externalId}`, async () => {
        const account = await importer.verifyAccount(member.companyId, plugin, precheck)
        if (!account.ok || account.accountId !== link.accountId) return conflict('HubSpot のアカウントを確かめられないか、この記録のものと違います', 'ACCOUNT_CHANGED')
        const properties = Object.keys(translated.properties)
        const outside = await sending.readOutside(member.companyId, plugin, link.object, link.externalId, properties, precheck)
        if (!outside) return refuse('unavailable', 'HubSpot から今の値を読めませんでした', { code: 'OUTSIDE_UNAVAILABLE' })
        const seen = importer.applyOne(member.companyId, plugin, link.accountId, link.object, outside, {}, null)
        if (seen?.changed) {
          const now = externalToAcb(pkg, plugin.mapping, link.object, outside.properties).values
          return conflict('HubSpot 側で先に変わっていました。最新の値を見てからもう一度お試しください', 'VERSION_CONFLICT', {
            version: valuesOf(member.companyId, recordId).version, current: Object.fromEntries(names.map(n => [n, now[n] ?? null])),
          })
        }
        const now = valuesOf(member.companyId, recordId)
        const changes: ApprovalFieldChange[] = names.map(field => {
          const property = rules[field].from
          const raw = outside.properties[property]
          return {
            field, property, before: (now.fields[field] ?? null) as AcbValue, after: asked[field] ?? null,
            rawBefore: raw === undefined || raw === null || raw === '' ? null : String(raw), rawAfter: translated.properties[property],
          }
        })
        return ok({
          payload: {
            ...head(plugin), accountId: link.accountId, record: { id: recordId, version: now.version }, object: link.object,
            externalId: link.externalId, changes, create: null,
          },
          approver: approverFor(plugin.manifest, plugin.mapping, operation, asked), folder: place,
        })
      })
    },

    /**
     * Run what a person approved (the approvals service calls it once, after
     * checking the approver and the payload's hash). Re-checks everything at
     * send time: the plugin runs on the same package, mapping version,
     * connection and account; the requester is still a member and may still
     * do it (AI: not stopped); the policy is not `off`; for an update the
     * outside raw values still equal `rawBefore` (else 409 CHANGED_OUTSIDE,
     * nothing sent), for a create the record's version is unchanged. Then it
     * writes the operation record and sends exactly the payload's raw values
     * (never re-translated); the ledger actor is the requester, the entry a
     * decision with the approver's reason, the approver on the receipt and the
     * operation record. Never re-sent on a lost answer.
     */
    async executeApproved(
      approver: Member, requestedFor: { userId: string; actorKind: 'human' | 'ai'; conversationId: string | null; source?: string | null },
      payload: PluginApprovalPayload, reason: string,
    ): Promise<Outcome<OperationView>> {
      const reasonProblem = approvalReasonProblem(reason)
      if (reasonProblem) return refuse('bad-request', reasonProblem, { code: 'REASON_REQUIRED' })
      if (!isObj(payload) || payload.v !== 1 || payload.kind !== 'plugin_operation' || !isObj(payload.plugin)) return refuse('bad-request', 'payload: a plugin operation (v1)')
      const companyId = approver.companyId
      const role = deps.roleOf(companyId, requestedFor.userId)
      if (role === null) return conflict('お願いした人がもうこの会社のメンバーではありません', 'REQUESTER_NOT_MEMBER')
      const member: Member = { companyId, userId: requestedFor.userId, role }
      const actor: OperationActor = {
        kind: requestedFor.actorKind === 'ai' ? 'ai' : 'human', conversationId: requestedFor.conversationId,
        ...(requestedFor.actorKind === 'ai' ? { source: requestedFor.source ?? undefined } : {}),
      }
      if (!companyData.forCompany(companyId).records.settings().enabled) return refuse('not-found', RECORDS_DISABLED.error, { code: RECORDS_DISABLED.code })
      const active = await plugins.active(companyId, payload.plugin.id)
      if (!active.ok) return notActive(active.problem)
      const plugin = active.plugin
      if (plugin.version !== payload.plugin.version || plugin.fingerprint !== payload.plugin.fingerprint || plugin.mappingVersion !== payload.mappingVersion
        || plugin.connectionId !== payload.connectionId || (plugin.accountId !== null && plugin.accountId !== payload.accountId)) {
        return conflict('承認のあとで設定（プラグインの版・読み替え表・つなぎ先）が変わったため、送っていません。もう一度お願いしてください', 'APPROVAL_STALE')
      }
      if (actor.kind === 'ai' && deps.aiStopped(companyId)) return refuse('forbidden', '管理者が AI の利用を一時停止しています。', { code: 'ACB_STOPPED' })
      const operation = payload.operation
      const op = Object.prototype.hasOwnProperty.call(plugin.manifest.operations, operation) ? plugin.manifest.operations[operation] : undefined
      if (!op || op.kind === 'read' || op.object !== payload.object) return refuse('bad-request', 'この操作はありません', { code: 'OPERATION_NOT_FOUND' })
      const repo = companyData.forCompany(companyId).plugins
      const decided = { note: reason, decision: true, proposedBy: null }

      if (op.kind === 'create' && op.createsRecord) {
        if (payload.record !== null || !payload.create) return refuse('bad-request', 'payload: a create of a record')
        const place = plugin.mapping.objects[op.object]?.visibleToFolder ?? ''
        if (!checks.folderReadable(member, place) || !checks.mayRunAt(member, actor, op.who, {}, place)) return refuse('forbidden', 'お願いした人には、もうこの操作をする権限がありません', { code: 'NOT_ALLOWED' })
        if (createPolicy(plugin, operation, op) === 'off') return operationOff()
        const precheck = precheckFor(member, actor, plugin, op.who, null, place, p => createPolicy(p, operation, op) !== 'off')
        const asked = { title: payload.create.title, ...stripTitle(externalToAcb({ manifest: plugin.manifest, types: plugin.types }, plugin.mapping, op.object, payload.create.properties).values) }
        const sent = await sending.sendNewRecord(member, actor, plugin, operation, op, { fields: asked, properties: payload.create.properties }, precheck, { ...decided, approvedBy: approver.userId }, payload.accountId)
        return sent.ok ? (sent.value.operation ? ok(sent.value.operation) : refuse('conflict', 'HubSpot に送れませんでした', { code: 'WRITE_FAILED' })) : sent
      }

      // On a record: it must still be readable, linked through this connection to the same outside object.
      const recordId = payload.record?.id ?? ''
      const row = checks.readable(member, recordId)
      if (!row) return notFound()
      const link = repo.linkOfRecord(recordId)
      if (!link || link.pluginId !== plugin.pluginId || link.connectionId !== plugin.connectionId || link.accountId !== payload.accountId || link.externalId !== payload.externalId) {
        return conflict('この記録は、いまの接続から取り込んだものではありません', 'NOT_LINKED')
      }
      const place = placeOf(row)
      if (!checks.mayRun(member, actor, op.who, recordId, place)) return refuse('forbidden', 'お願いした人には、もうこの操作をする権限がありません', { code: 'NOT_ALLOWED' })

      if (op.kind === 'create') {
        if (!payload.create) return refuse('bad-request', 'payload: a create')
        if (valuesOf(companyId, recordId).version !== payload.record!.version) return conflict('承認のあとで記録が変わったため、送っていません。もう一度お願いしてください', 'VERSION_CONFLICT')
        if (createPolicy(plugin, operation, op) === 'off') return operationOff()
        const precheck = precheckFor(member, actor, plugin, op.who, recordId, place, p => createPolicy(p, operation, op) !== 'off')
        const account = await importer.verifyAccount(companyId, plugin, precheck)
        if (!account.ok || account.accountId !== payload.accountId) return conflict('HubSpot のアカウントを確かめられないか、承認のときと違います', 'ACCOUNT_CHANGED')
        // The ACB words of what is sent, from the payload's raw content (for the operation record and card).
        const fields: Record<string, AcbValue> = {}
        for (const [slot, property] of Object.entries(op.content)) {
          const raw = payload.create.properties[property]
          if (raw !== undefined) fields[slot] = slot === 'at' ? isoOf(raw) : raw
        }
        const row0 = records.newRow(member, actor, plugin, {
          operation, accountId: payload.accountId, object: op.object, externalId: null, recordId, fields: JSON.stringify(fields), written: '', previous: '{}', approvedBy: approver.userId,
        })
        row0.written = JSON.stringify({ ...payload.create.properties, [op.correlationProperty as string]: row0.id })
        repo.insertOperation(row0)
        const settled = await sending.sendCreate(companyId, plugin, row0, link.externalId, precheck, decided)
        return settled.state === 'failed'
          ? refuse('conflict', 'HubSpot に書けませんでした（何も変わっていません）', { code: 'WRITE_FAILED', reason: settled.reason, operation: records.view(companyId, settled) })
          : ok(records.view(companyId, settled))
      }

      // An update: exactly the payload's raw values, only while HubSpot still holds rawBefore.
      if (!Array.isArray(payload.changes) || payload.changes.length === 0) return refuse('bad-request', 'payload: changes')
      const names = payload.changes.map(c => c.field)
      const stillWritable = (p: ActivePlugin) => names.every(f => effectiveFieldPolicy(p.manifest, p.mapping, operation, f) !== 'off')
      if (!stillWritable(plugin)) return refuse('bad-request', 'いまは書き戻さない欄が含まれています（何も変えていません）', { code: 'FIELD_NOT_WRITABLE' })
      const precheck = precheckFor(member, actor, plugin, op.who, recordId, place, stillWritable)
      const externalId = link.externalId
      return serialised(`${companyId}|${plugin.connectionId}|${link.object}|${externalId}`, async () => {
        const account = await importer.verifyAccount(companyId, plugin, precheck)
        if (!account.ok || account.accountId !== payload.accountId) return conflict('HubSpot のアカウントを確かめられないか、承認のときと違います', 'ACCOUNT_CHANGED')
        const props = payload.changes.map(c => c.property)
        const outside = await sending.readOutside(companyId, plugin, link.object, externalId, props, precheck)
        if (!outside) return refuse('unavailable', 'HubSpot から今の値を読めませんでした（何も変えていません）', { code: 'OUTSIDE_UNAVAILABLE' })
        importer.applyOne(companyId, plugin, link.accountId, link.object, outside, {}, null)
        const now = rawOf(outside.properties, props)
        if (payload.changes.some(c => (c.rawBefore ?? '') !== now[c.property])) {
          return conflict('承認のあとで HubSpot の値が変わったため、書いていません。もう一度お願いしてください', 'CHANGED_OUTSIDE', {
            current: Object.fromEntries(payload.changes.map(c => [c.field, now[c.property] === '' ? null : now[c.property]])),
          })
        }
        const written = Object.fromEntries(payload.changes.map(c => [c.property, c.rawAfter]))
        const asked = Object.fromEntries(payload.changes.map(c => [c.field, c.after])) as Record<string, AcbValue>
        const row0 = records.newRow(member, actor, plugin, {
          operation, accountId: payload.accountId, object: link.object, externalId, recordId,
          fields: JSON.stringify(asked), written: JSON.stringify(written), previous: JSON.stringify(Object.fromEntries(props.map(p => [p, now[p]]))), approvedBy: approver.userId,
        })
        repo.insertOperation(row0)
        const settled = await sending.sendAndSettle(member, actor, plugin, row0, asked, precheck, { action: `${plugin.pluginId}.${operation}`, note: reason, decision: true })
        return settled.state === 'failed'
          ? refuse(settled.reason === 'rate-limited' ? 'rate-limited' : 'conflict', 'HubSpot に書けませんでした（何も変わっていません）', { code: 'WRITE_FAILED', reason: settled.reason, operation: records.view(companyId, settled) })
          : ok(records.view(companyId, settled))
      })
    },
  }
}
