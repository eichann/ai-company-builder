/**
 * Typed operations of a connector plugin (milestone 3 P6 + milestone 4 G5,
 * `.claude/rules/plugins.md` "Typed operations", "Creates", "The approval
 * seam"): a person (session) or their AI (record token) asks for
 * `update_deal` / `refresh_deal` on a record, `log_meeting` on a deal (a
 * create attached to a record) or `create_deal` (a create of a record); the
 * core decides, writes the operation record (操作の控え) before sending, sends
 * through the connector and writes the ledger through the engine's external
 * entry. Undo is a new, compensating write of the stored raw previous values
 * (update) or an archive of what ACB made (create), by a person.
 *
 * In order, every check refusing with nothing sent:
 * 1. the record is one the member may read (else the same 404 as a missing
 *    one — AI included: it acts only on what its owner can see); a create of
 *    a record: the folder the record would go to;
 * 2. the plugin runs (`active()`: operator stop, company switch, package,
 *    key, mapping, acknowledged auto fields and creates), the AI is not stopped;
 * 3. the operation's `who` (`viewer` = can read; `ai` only where listed and
 *    only for what the member may do themselves);
 * 4. the AI gives a reason for a decision operation;
 * 5. update: every field is `auto` — judged on the outside property; one
 *    `prior` (stage at best) or `off` field refuses the whole request (review
 *    §6.3); create: the operation's policy is `auto` (`effectiveOperationPolicy`;
 *    a create of a record never is); `prior` → 409 APPROVAL_REQUIRED (a person
 *    approves: `prepareApproval` / `executeApproved` below, the approvals
 *    service builds on them);
 * 6. the version the caller saw is current (update);
 * then, serialised per outside object inside this server (review §5.5):
 * 7. the outside account is the connection's; for an update the outside object
 *    is read again — a difference is brought in first (an `external` entry)
 *    and the request is refused as stale (a read just before detects known
 *    differences; HubSpot's object update has no conditional form we can
 *    rely on, so a change made after this read can still be overwritten);
 * 8. right before the send — and the connector asks again after any wait —
 *    every switch, the member's role and the policy are checked again.
 *
 * A write is never re-sent. An update whose answer was lost → `sent-unknown`;
 * reading back the intended values makes it `observed` (who made them is not
 * known: not ACB's confirmed success, never undoable — review §5.6). A create
 * carries its operation id in the declaration's `correlation_property`
 * (`acb_operation_id`); after a lost answer it is looked up by that value
 * (`GET …/{opId}?idProperty=…` when the object has a `get`, else the declared
 * search, only 60 s after the send — HubSpot's search does not see a new object
 * at once — design §4-4). Found → it is ours (the value proves it): `applied`,
 * undoable. Not found → stays `sent-unknown` (reason `not-found`: "not found"
 * never means "does not exist"); a person may then press 「もう一度作る」 (a new
 * operation with a new correlation value, after a warning).
 */
/*
 * The service is composed here from one module per responsibility:
 *
 *   plugin-operation-common.ts     words, the actor, refusals, the per-object serialiser, value helpers
 *   plugin-operation-inputs.ts     reading a body (attached create, create of a record, note / reason)
 *   plugin-operation-checks.ts     steps 1–3 and 8: readable, active, who, policy gates, the precheck
 *   plugin-operation-records.ts    the operation record (操作の控え): new row, receipt, view, answer
 *   plugin-operation-sending.ts    send and settle; reconcile (never re-sent)
 *   plugin-operation-undo.ts       「変更前の値を書き戻す」 / 「作ったものを取り消す」
 *   plugin-operation-approvals.ts  the approval seam (prepareApproval / executeApproved)
 *
 * and this module runs, reads, reconciles and recreates.
 */
import { FULL_ACCESS_ROLES } from '../../shared/core/permissions'
import { acbToExternal, externalToAcb, type AcbValue, type PluginOperation } from '../../shared/core/plugins'
import type { Member } from './access'
import { ok, refuse, type Outcome } from './outcome'
import { EXTERNAL_ID_RE } from './plugin-connector'
import { createOperationApprovals } from './plugin-operation-approvals'
import { createOperationChecks, createPolicy, fieldsAuto, notAuto } from './plugin-operation-checks'
import {
  RECREATE_WARNING, approvalRequired, conflict, createSerialiser, isObj, opNotFound, operationOff, rawOf, same,
  type OperationActor, type OperationView, type PluginOperationDeps, type RunAnswer,
} from './plugin-operation-common'
import { TITLE_MAX, attachedInput, noteOf, recordInput } from './plugin-operation-inputs'
import { createOperationRecords, kindOf } from './plugin-operation-records'
import { createOperationSending } from './plugin-operation-sending'
import { createOperationUndo } from './plugin-operation-undo'
import type { ActivePlugin } from './plugins'

export {
  CREATE_SEARCH_DELAY_MS, CREATE_UNDO_LABEL, CREATE_UNDO_NOTICE, RECREATE_WARNING, UNDO_LABEL, UNDO_NOTICE,
  type OperationActor, type OperationView, type PluginOperationDeps,
} from './plugin-operation-common'

export function createPluginOperationService(deps: PluginOperationDeps) {
  const { companyData, clock, plugins, connector, importer } = deps
  const serialised = createSerialiser()
  const checks = createOperationChecks(deps)
  const { readable, valuesOf, precheckFor, recordChecks, newRecordChecks, opFor } = checks
  const records = createOperationRecords({ ...deps, valuesOf })
  const { newRow, view, answerFor } = records
  const sending = createOperationSending({ ...deps, valuesOf, newRow, answerFor })
  const { readOutside, sendAndSettle, sendCreate, reconcileUpdate, reconcileCreate, reconcileArchive, sendNewRecord } = sending
  const undoing = createOperationUndo({ ...deps, checks, records, sending, serialised })
  const approvals = createOperationApprovals({ ...deps, checks, records, sending, serialised })

  /** A create attached to a record, run directly (policy `auto`) — also 「もう一度作る」. */
  async function runAttached(
    member: Member, actor: OperationActor, plugin: ActivePlugin, operation: string, op: PluginOperation,
    link: { accountId: string; externalId: string }, recordId: string, place: string, b: Record<string, unknown>,
  ): Promise<Outcome<RunAnswer>> {
    const input = attachedInput(op, b)
    if (!input.ok) return refuse('bad-request', input.error, { code: 'BAD_INPUT' })
    const noted = noteOf(b, op, actor)
    if (!noted.ok) return noted.refusal
    const policy = createPolicy(plugin, operation, op)
    if (policy === 'off') return operationOff()
    if (policy !== 'auto') return approvalRequired()
    const precheck = precheckFor(member, actor, plugin, op.who, recordId, place, p => createPolicy(p, operation, op) === 'auto')
    const account = await importer.verifyAccount(member.companyId, plugin, precheck)
    if (!account.ok || account.accountId !== link.accountId) return conflict('HubSpot のアカウントを確かめられないか、この記録のものと違います', 'ACCOUNT_CHANGED', { reason: account.ok ? 'other-account' : account.reason })
    const row0 = newRow(member, actor, plugin, {
      operation, accountId: link.accountId, object: op.object, externalId: null, recordId, fields: JSON.stringify(input.fields), written: '', previous: '{}',
    })
    // The correlation value is the operation's own id, written with it before the send.
    row0.written = JSON.stringify({ ...input.properties, [op.correlationProperty as string]: row0.id })
    companyData.forCompany(member.companyId).plugins.insertOperation(row0)
    const settled = await sendCreate(member.companyId, plugin, row0, link.externalId, precheck,
      { note: noted.note.trim() || undefined, decision: op.decision, proposedBy: actor.kind === 'human' ? actor.proposedBy ?? null : null })
    return answerFor(member, settled)
  }

  const service = {
    /**
     * Run a typed operation on a record. `update`: { expectedVersion, fields:
     * { <ACB field>: value }, note? }; `read` (refresh): {}; a create attached
     * to the record (log_meeting): { title, body?, at, outcome?, note? }.
     */
    async run(member: Member, actor: OperationActor, pluginId: string, recordId: string, operation: string, body: unknown): Promise<Outcome<RunAnswer>> {
      const c = await recordChecks(member, actor, pluginId, recordId, operation)
      if (c.refusal) return c.refusal
      const { plugin, op, link, place } = c

      if (op.kind === 'read') {
        const r = await importer.refreshRecord(member, pluginId, recordId)
        return r.ok ? ok({ operation: null, record: { id: recordId, version: r.value.version } }) : r
      }
      const b = isObj(body) ? body : null
      if (!b) return refuse('bad-request', 'The body must be an object')
      if (op.kind === 'create') return runAttached(member, actor, plugin, operation, op, link, recordId, place, b)

      // An update.
      if (!Number.isInteger(b.expectedVersion) || (b.expectedVersion as number) < 0) return refuse('bad-request', 'expectedVersion: the version you saw', { code: 'VERSION_REQUIRED' })
      if (!isObj(b.fields) || Object.keys(b.fields).length === 0 || Object.keys(b.fields).length > 30) return refuse('bad-request', 'fields: { <field>: value } (1–30)')
      const noted = noteOf(b, op, actor)
      if (!noted.ok) return noted.refusal
      const note = noted.note
      const asked = b.fields as Record<string, AcbValue>
      const names = Object.keys(asked)
      const policy = notAuto(plugin, operation, names)
      if (policy.off.length > 0) return refuse('bad-request', `書き戻さない欄です：${policy.off.join('、')}（何も変えていません）`, { code: 'FIELD_NOT_WRITABLE', fields: policy.off })
      if (policy.prior.length > 0) return approvalRequired(policy.prior)
      const pkg = { manifest: plugin.manifest, types: plugin.types }
      const translated = acbToExternal(pkg, plugin.mapping, op.object, asked)
      if (!translated.ok) return refuse('bad-request', '書き戻せない値があります（何も変えていません）', { code: 'BAD_VALUE', errors: translated.errors })
      if (valuesOf(member.companyId, recordId).version !== b.expectedVersion) {
        return conflict('ほかの人が先に変えました。最新の状態を見てからもう一度お試しください', 'VERSION_CONFLICT', { version: valuesOf(member.companyId, recordId).version })
      }
      const precheck = precheckFor(member, actor, plugin, op.who, recordId, place, fieldsAuto(operation, names))

      return serialised(`${member.companyId}|${plugin.connectionId}|${link.object}|${link.externalId}`, async () => {
        const account = await importer.verifyAccount(member.companyId, plugin, precheck)
        if (!account.ok || account.accountId !== link.accountId) return conflict('HubSpot のアカウントを確かめられないか、この記録のものと違います', 'ACCOUNT_CHANGED', { reason: account.ok ? 'other-account' : account.reason })
        const properties = Object.keys(translated.properties)
        const outside = await readOutside(member.companyId, plugin, link.object, link.externalId, properties, precheck)
        if (!outside) return refuse('unavailable', 'HubSpot から今の値を読めませんでした（何も変えていません）', { code: 'OUTSIDE_UNAVAILABLE' })
        // Someone changed it in HubSpot: bring that in first, and refuse the stale request.
        const seen = importer.applyOne(member.companyId, plugin, link.accountId, link.object, outside, {}, null)
        if (seen?.changed) {
          const now = externalToAcb(pkg, plugin.mapping, link.object, outside.properties).values
          return conflict('HubSpot 側で先に変わっていました。最新の値を見てからもう一度お試しください', 'VERSION_CONFLICT', {
            version: valuesOf(member.companyId, recordId).version, current: Object.fromEntries(names.map(n => [n, now[n] ?? null])),
          })
        }
        // Another request for this record may have gone first while this one waited (serialised above).
        if (valuesOf(member.companyId, recordId).version !== b.expectedVersion) {
          return conflict('ほかの人が先に変えました。最新の状態を見てからもう一度お試しください', 'VERSION_CONFLICT', { version: valuesOf(member.companyId, recordId).version })
        }
        const previous = rawOf(outside.properties, properties)
        if (same(translated.properties, previous)) {
          return ok({ operation: null, record: { id: recordId, version: valuesOf(member.companyId, recordId).version } })
        }
        const row0 = newRow(member, actor, plugin, {
          operation, accountId: link.accountId, object: link.object, externalId: link.externalId, recordId,
          fields: JSON.stringify(asked), written: JSON.stringify(translated.properties), previous: JSON.stringify(previous),
        })
        companyData.forCompany(member.companyId).plugins.insertOperation(row0)
        const settled = await sendAndSettle(member, actor, plugin, row0, asked, precheck, { action: `${pluginId}.${operation}`, note, decision: op.decision })
        return answerFor(member, settled)
      })
    },

    /**
     * A create of a record (create_deal): { title, fields: { <ACB field>:
     * value }, note? }. Never `auto` — so a direct request is always refused
     * with 409 APPROVAL_REQUIRED (nothing sent) after every other check; the
     * write happens only through `executeApproved`.
     */
    async createRecord(member: Member, actor: OperationActor, pluginId: string, operation: string, body: unknown): Promise<Outcome<RunAnswer>> {
      const c = await newRecordChecks(member, actor, pluginId, operation)
      if (c.refusal) return c.refusal
      const { plugin, op, place } = c
      const b = isObj(body) ? body : null
      if (!b) return refuse('bad-request', 'The body must be an object')
      const input = recordInput(plugin, op, b)
      if (!input.ok) return refuse('bad-request', input.error, { code: 'BAD_VALUE', ...(input.errors ? { errors: input.errors } : {}) })
      const noted = noteOf(b, op, actor)
      if (!noted.ok) return noted.refusal
      const policy = createPolicy(plugin, operation, op)
      if (policy === 'off') return operationOff()
      if (policy !== 'auto') return approvalRequired()
      // Not reached while createPolicy holds (a create of a record is never auto); kept as the one send path.
      const precheck = precheckFor(member, actor, plugin, op.who, null, place, p => createPolicy(p, operation, op) === 'auto')
      return sendNewRecord(member, actor, plugin, operation, op, input, precheck, { note: noted.note, approvedBy: null })
    },

    /**
     * Similar existing records before a create of a record (design §6-3: show
     * them before creating a deal): a declared `search` on the object by the
     * title's words (HubSpot `CONTAINS_TOKEN` on the mapping's title property),
     * returning only records already imported through the current connection
     * that the member may read — never an outside object the member cannot see.
     */
    async similarDeals(member: Member, pluginId: string, title: string): Promise<Outcome<{ similar: Array<{ recordId: string; title: string | null }> }>> {
      const running = await plugins.active(member.companyId, pluginId)
      const creating = running.ok ? Object.entries(running.plugin.manifest.operations).find(([, o]) => o.kind === 'create' && o.createsRecord)?.[0] : undefined
      const c = await newRecordChecks(member, { kind: 'human' }, pluginId, creating ?? '')
      if (c.refusal) return c.refusal
      if (typeof title !== 'string' || title.trim() === '' || title.length > TITLE_MAX) return refuse('bad-request', `title: 1–${TITLE_MAX} characters`)
      const { plugin, op } = c
      const titleFrom = plugin.mapping.objects[op.object]?.fields.title?.from
      if (!titleFrom || !plugin.manifest.objects[op.object].endpoints.search) return ok({ similar: [] })
      const words = [...new Set(title.normalize('NFC').split(/[\s\u3000（）()「」『』【】・,、。/]+/).filter(w => w.length >= 2))].slice(0, 3)
      if (words.length === 0) return ok({ similar: [] })
      const precheck = precheckFor(member, { kind: 'human' }, plugin, ['viewer'], null, c.place, () => true)
      const account = await importer.verifyAccount(member.companyId, plugin, precheck)
      if (!account.ok) return conflict('HubSpot のアカウントを確かめられません', 'ACCOUNT_CHANGED', { reason: account.reason })
      const r = await connector.call(member.companyId, plugin, {
        endpoint: 'search', object: op.object,
        body: { filterGroups: words.map(w => ({ filters: [{ propertyName: titleFrom, operator: 'CONTAINS_TOKEN', value: `*${w}*` }] })), properties: [titleFrom], limit: 20 },
      }, precheck)
      if (!r.ok || !isObj(r.body) || !Array.isArray(r.body.results)) return refuse('unavailable', 'HubSpot を探せませんでした', { code: 'OUTSIDE_UNAVAILABLE' })
      const repo = companyData.forCompany(member.companyId).plugins
      const similar: Array<{ recordId: string; title: string | null }> = []
      for (const x of r.body.results) {
        if (!isObj(x) || typeof x.id !== 'string' || !EXTERNAL_ID_RE.test(x.id)) continue
        const link = repo.link(plugin.connectionId, account.accountId, op.object, x.id)
        const row = link && link.pluginId === plugin.pluginId ? readable(member, link.recordId) : null
        if (row && !similar.some(s => s.recordId === row.id)) similar.push({ recordId: row.id, title: row.title })
      }
      return ok({ similar })
    },

    /** The operation (only for someone who may read its record). */
    async get(member: Member, pluginId: string, operationId: string): Promise<Outcome<{ operation: OperationView }>> {
      const op = await opFor(member, pluginId, operationId)
      return op ? ok({ operation: view(member.companyId, op) }) : opNotFound()
    },


    undo: undoing.undo,

    /**
     * Read the outside system again for an operation whose answer was lost
     * (owner/admin or its actor). Allowed while the plugin is stopped or off
     * (collecting facts is not a new write, review §6.5). Never re-sends.
     */
    async reconcile(member: Member, pluginId: string, operationId: string): Promise<Outcome<{ operation: OperationView }>> {
      const op = await opFor(member, pluginId, operationId)
      if (!op) return opNotFound()
      if (op.actorId !== member.userId && !FULL_ACCESS_ROLES.has(member.role)) return refuse('forbidden', '自分の変更か、管理者だけが確かめられます', { code: 'NOT_ALLOWED' })
      if (op.state !== 'sent-unknown') return ok({ operation: view(member.companyId, op) })
      const active = await plugins.active(member.companyId, pluginId, { collectingFacts: true })
      if (!active.ok) return conflict('いまは HubSpot を読めません', 'PLUGIN_NOT_ACTIVE', { problem: active.problem })
      if (active.plugin.connectionId !== op.connectionId) return conflict('この変更は別の接続でしたものです', 'ACCOUNT_CHANGED')
      const account = await importer.verifyAccount(member.companyId, active.plugin, async () => null)
      if (!account.ok || account.accountId !== op.accountId) return conflict('この変更は別の HubSpot のアカウントでしたものです', 'ACCOUNT_CHANGED')
      const kind = kindOf(op)
      if (kind === 'create') return ok({ operation: view(member.companyId, await reconcileCreate(member.companyId, active.plugin, op)) })
      if (kind === 'undo' && op.previous === '{}') return ok({ operation: view(member.companyId, await reconcileArchive(member.companyId, active.plugin, op)) })
      return ok({ operation: view(member.companyId, await reconcileUpdate(member.companyId, active.plugin, op)) })
    },

    /**
     * 「もう一度作る」 (a person only, design §4-4): only for a create whose
     * answer was lost and which reconciling did not find (`not-found`), by its
     * actor or an owner / admin, with `{ confirm: true }` after
     * `RECREATE_WARNING`. Looks it up once more first; then runs the same
     * create as a NEW operation (new correlation value) with every check of a
     * direct run — a create needing approval stays refused (APPROVAL_REQUIRED).
     */
    async recreate(member: Member, pluginId: string, operationId: string, body: unknown): Promise<Outcome<RunAnswer>> {
      const op = await opFor(member, pluginId, operationId)
      if (!op) return opNotFound()
      if (op.actorId !== member.userId && !FULL_ACCESS_ROLES.has(member.role)) return refuse('forbidden', '自分の（自分の AI の）操作か、管理者だけがもう一度作れます', { code: 'NOT_ALLOWED' })
      if (kindOf(op) !== 'create' || op.state !== 'sent-unknown' || op.reason !== 'not-found' || op.replacedBy !== null) {
        return conflict('「HubSpot で見つからなかった」作る操作だけ、もう一度作れます（先に「もう一度確かめる」を押してください）', 'NOT_RECREATABLE', { state: op.state, reason: op.reason })
      }
      if (!isObj(body) || body.confirm !== true) return conflict(RECREATE_WARNING, 'RECREATE_NEEDS_CONFIRMATION', { warning: RECREATE_WARNING })
      const human: OperationActor = { kind: 'human', ...(typeof body.conversationId === 'string' ? { conversationId: body.conversationId.slice(0, 200) } : {}) }
      // Look once more (the first answer may have been "not yet").
      const facts = await plugins.active(member.companyId, pluginId, { collectingFacts: true })
      if (facts.ok && facts.plugin.connectionId === op.connectionId) {
        const again = await reconcileCreate(member.companyId, facts.plugin, op)
        if (again.state !== 'sent-unknown' || again.reason !== 'not-found') return answerFor(member, again)
      }
      const asked = JSON.parse(op.fields) as Record<string, AcbValue>
      let result: Outcome<RunAnswer>
      if (op.recordId === null) {
        const { title, ...fields } = asked
        result = await service.createRecord(member, human, pluginId, op.operation, { title, fields })
      } else {
        result = await service.run(member, human, pluginId, op.recordId, op.operation, asked)
      }
      if (result.ok && result.value.operation) companyData.forCompany(member.companyId).plugins.updateOperation(op.id, { replacedBy: result.value.operation.id }, clock.now())
      return result
    },

    prepareApproval: approvals.prepareApproval,
    executeApproved: approvals.executeApproved,
    /** Business roles in an operation's `who` (plan C3): bound once by the plugins lane. */
    useRoles: checks.useRoles,
  }
  return service
}

export type PluginOperationService = ReturnType<typeof createPluginOperationService>
