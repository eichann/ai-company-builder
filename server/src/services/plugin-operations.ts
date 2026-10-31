/**
 * Typed operations of a connector plugin (milestone 3 P6, `.claude/rules/plugins.md`
 * "Typed operations"): a person (session) or their AI (record token) asks for
 * `update_deal` / `refresh_deal` on a record; the core decides, writes the
 * operation record (操作の控え) before sending, sends through the connector
 * and writes the ledger through the engine's external entry. Undo is a new,
 * compensating write of the stored raw previous values, by a person.
 *
 * In order, every check refusing with nothing sent:
 * 1. the record is one the member may read (else the same 404 as a missing
 *    one — AI included: it acts only on what its owner can see);
 * 2. the plugin runs (`active()`: operator stop, company switch, package,
 *    key, mapping, acknowledged auto fields), the AI is not stopped;
 * 3. the operation's `who` (`viewer` = can read; `ai` only where listed and
 *    only for what the member may do themselves);
 * 4. the AI gives a reason for a decision operation;
 * 5. every field is `auto` — judged on the outside property; `stage` never;
 *    one `prior` or `off` field refuses the whole request (review §6.3);
 * 6. the version the caller saw is current;
 * then, serialised per outside object inside this server (review §5.5):
 * 7. the outside account is the connection's; the outside object is read
 *    again — a difference is brought in first (an `external` entry) and the
 *    request is refused as stale (a read just before detects known
 *    differences; HubSpot's object update has no conditional form we can
 *    rely on, so a change made after this read can still be overwritten);
 * 8. right before the send — and the connector asks again after any wait —
 *    every switch, the member's role and the policy are checked again.
 * A write is never re-sent. Its answer lost → `sent-unknown`; reading back
 * the intended values makes it `observed` (who made them is not known: not
 * ACB's confirmed success, never undoable — review §5.6).
 */
import { FULL_ACCESS_ROLES } from '../../shared/core/permissions'
import { isSameOrAncestorPath } from '../../shared/core/paths'
import { acbToExternal, effectiveFieldPolicy, externalToAcb, type AcbValue, type ExternalProperties } from '../../shared/core/plugins'
import type { LedgerValue } from '../../shared/core/record-ledger'
import { RECORD_ID_RE } from '../../shared/core/records'
import type { Clock, IdGenerator } from '../ports/clock'
import type { CompanyDataSource } from '../ports/company-data'
import type { PluginOperationRow } from '../ports/plugins'
import type { PluginOperationRecordView } from '../../shared/types/plugins'
import type { Member } from './access'
import { ok, refuse, type Outcome } from './outcome'
import type { PluginConnector } from './plugin-connector'
import type { PluginImportService } from './plugin-import'
import type { ActivePlugin, PluginService } from './plugins'
import { recordReader } from './record-access'
import { currentTypes } from './record-index'
import { mayAct, type ExternalRecordWriter } from './record-engine'
import { RECORD_NOT_FOUND, RECORDS_DISABLED } from './records'

/** The words for an undo, on the screens and to the AI (review §5.4 / §6.4). */
export const UNDO_LABEL = '変更前の値を書き戻す'
export const UNDO_NOTICE = 'HubSpot のワークフローや通知など、変更のあとに HubSpot 側で起きたことは元に戻りません。'
const NOTE_MAX = 2000

export interface OperationActor {
  kind: 'human' | 'ai'
  /** For the AI: the agent of its token. */
  source?: string
  conversationId?: string | null
  /** A person confirming what their AI suggested (informational, self-reported by the app; records.md "Provenance"). */
  proposedBy?: 'ai' | null
}

/** An operation record as its record's readers see it (contract: shared/types/plugins.ts). */
export type OperationView = PluginOperationRecordView

export interface PluginOperationDeps {
  companyData: CompanyDataSource
  clock: Clock
  ids: IdGenerator
  plugins: PluginService
  connector: PluginConnector
  writer: ExternalRecordWriter
  importer: PluginImportService
  roleOf: (companyId: string, userId: string) => string | null
  managedFolders: (companyId: string, userId: string) => string[]
  /** The company's whole AI is stopped (M2). */
  aiStopped: (companyId: string) => boolean
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const conflict = (error: string, code: string, extra: Record<string, unknown> = {}) => refuse('conflict', error, { code, ...extra })
const notFound = () => refuse('not-found', RECORD_NOT_FOUND.error, { code: RECORD_NOT_FOUND.code })

/** The plugin's `who` in the engine's words (`viewer` is anyone who reaches the record: it was read-checked first). */
const engineWho = (who: string[]) => who.map(w => (w === 'viewer' ? 'anyone' : w))

export function createPluginOperationService(deps: PluginOperationDeps) {
  const { companyData, clock, plugins, connector, writer, importer } = deps
  const locks = new Map<string, Promise<unknown>>()

  /** One write (or undo) per outside object at a time inside this server. */
  async function serialised<T>(key: string, run: () => Promise<T>): Promise<T> {
    const before = locks.get(key) ?? Promise.resolve()
    const mine = before.catch(() => undefined).then(run)
    locks.set(key, mine)
    try { return await mine } finally { if (locks.get(key) === mine) locks.delete(key) }
  }

  function readable(member: Member, recordId: string) {
    const handle = companyData.forCompany(member.companyId)
    const row = RECORD_ID_RE.test(recordId) ? handle.records.byIds([recordId])[0] : undefined
    if (!row || row.removedAt !== null || !recordReader(member, handle.scopes.listWithRules()).record(row)) return null
    return row
  }

  function valuesOf(companyId: string, recordId: string): { version: number; fields: Record<string, LedgerValue> } {
    const s = companyData.forCompany(companyId).records.states([recordId])[0]
    let fields: Record<string, LedgerValue> = {}
    try { fields = s ? JSON.parse(s.fields) as Record<string, LedgerValue> : {} } catch { fields = {} }
    return { version: s?.version ?? 0, fields }
  }

  function mayRun(member: Member, actor: OperationActor, who: string[], recordId: string, place: string): boolean {
    const managesPlace = who.includes('dept_manager') && deps.managedFolders(member.companyId, member.userId).some(f => isSameOrAncestorPath(f, place))
    return mayAct(engineWho(who), member, { kind: actor.kind, source: actor.source }, valuesOf(member.companyId, recordId).fields, managesPlace)
  }

  /** Fields that are not `auto` now (prior / off), for this operation and mapping. */
  function notAuto(plugin: ActivePlugin, operation: string, fields: string[]) {
    const prior: string[] = []
    const off: string[] = []
    for (const f of fields) {
      const p = effectiveFieldPolicy(plugin.manifest, plugin.mapping, operation, f)
      if (p === 'prior') prior.push(f)
      else if (p !== 'auto') off.push(f)
    }
    return { prior, off }
  }

  function view(companyId: string, o: PluginOperationRow): OperationView {
    const handle = companyData.forCompany(companyId)
    // The ledger entry of an applied write says exactly what changed (before → after).
    const entry = o.state === 'applied' && o.recordVersion !== null ? handle.records.ledger(o.recordId).find(e => e.version === o.recordVersion) : undefined
    const row = handle.records.byIds([o.recordId])[0]
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
      id: o.id, operation: o.operation, recordId: o.recordId, recordTitle: row?.title ?? null,
      state: o.state, fields, changes, valueLabels,
      actorKind: o.actorKind === 'ai' ? 'ai' : 'human', reason: o.reason,
      undoable: o.operation !== 'undo' && o.state === 'applied' && o.undoneBy === null, undoLabel: UNDO_LABEL, undoNotice: UNDO_NOTICE,
      undoOf: o.undoOf, undoneBy: o.undoneBy, recordVersion: o.recordVersion, createdAt: o.createdAt,
    }
  }

  /**
   * The checks right before a send (the connector repeats them after any
   * wait): the plugin still runs on the same connection, the records switch,
   * the member still belongs (and may still do it), the AI is not stopped,
   * every field is still `auto`.
   */
  function precheckFor(member: Member, actor: OperationActor, plugin: ActivePlugin, operation: string, who: string[], recordId: string, place: string, fields: string[]) {
    return async (): Promise<string | null> => {
      const now = await plugins.active(member.companyId, plugin.pluginId)
      if (!now.ok) return now.problem
      if (now.plugin.connectionId !== plugin.connectionId) return 'connection-changed'
      if (!companyData.forCompany(member.companyId).records.settings().enabled) return 'records-off'
      const role = deps.roleOf(member.companyId, member.userId)
      if (role === null) return 'not-member'
      if (actor.kind === 'ai' && deps.aiStopped(member.companyId)) return 'ai-stopped'
      if (!mayRun({ ...member, role }, actor, who, recordId, place)) return 'not-allowed'
      const p = notAuto(now.plugin, operation, fields)
      if (p.prior.length + p.off.length > 0) return 'policy-changed'
      return null
    }
  }

  /** GET the outside object's properties the mapping reads (and those written). */
  async function readOutside(companyId: string, plugin: ActivePlugin, object: string, externalId: string, extra: string[], precheck: () => Promise<string | null>) {
    const properties = [...new Set([...importer.propertiesOf(plugin, object), ...extra])]
    const r = await connector.call(companyId, plugin, { endpoint: 'get', object, id: externalId, query: { properties } }, precheck)
    if (!r.ok || !isObj(r.body) || !isObj(r.body.properties) || r.body.id !== externalId) return null
    return { id: externalId, properties: r.body.properties as ExternalProperties }
  }

  const rawOf = (props: ExternalProperties, names: string[]) =>
    Object.fromEntries(names.map(n => [n, props[n] === undefined || props[n] === null ? '' : String(props[n])]))
  const same = (a: Record<string, string>, b: Record<string, string>) => Object.keys(a).every(k => (a[k] ?? '') === (b[k] ?? ''))

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
    const r = await connector.call(member.companyId, plugin, { endpoint: 'update', object: op.object, id: op.externalId, body: { properties: written } }, precheck)
    const at = () => clock.now()
    if (!r.ok) {
      // A 5xx may have been applied: as unknown as a lost answer. A 429 / 4xx / nothing sent: known not applied.
      if (r.kind === 'unknown' || r.kind === 'server-error') {
        repo.updateOperation(op.id, { state: 'sent-unknown', reason: r.reason }, at())
        return reconcileOnce(member, plugin, repo.operation(op.id)!)
      }
      repo.updateOperation(op.id, { state: 'failed', reason: r.reason }, at())
      return repo.operation(op.id)!
    }
    repo.updateOperation(op.id, { state: 'external-ok' }, at())
    // ACB's confirmed write: its own entry, with the values it wrote.
    const current = valuesOf(member.companyId, op.recordId)
    const applied = writer.apply(member.companyId, {
      recordId: op.recordId, type: plugin.manifest.objects[op.object].recordType as string, folder: null, title: null,
      fields: acbFields as Record<string, LedgerValue>, links: {}, action: ledger.action, source: plugin.pluginId, note: ledger.note, decision: ledger.decision,
      expectedVersion: current.version,
      actor: { id: member.userId, kind: actor.kind, source: actor.kind === 'ai' ? actor.source ?? null : null, conversationId: actor.conversationId ?? null, proposedBy: actor.kind === 'human' ? actor.proposedBy ?? null : null },
      receipt: {
        plugin: plugin.pluginId, pluginVersion: op.pluginVersion, fingerprint: op.fingerprint, mappingVersion: op.mappingVersion,
        connectionId: op.connectionId, accountId: op.accountId, object: op.object, externalId: op.externalId,
        externalUpdatedAt: isObj(r.body) && typeof r.body.updatedAt === 'string' ? r.body.updatedAt : null, operationId: op.id, kind: 'written',
      },
    })
    repo.updateOperation(op.id, { state: 'applied', recordVersion: applied.ok ? applied.version : null, reason: applied.ok ? null : 'ledger-not-written' }, at())
    // Read back after writing: anything else changed meanwhile arrives as an observed change.
    const back = await readOutside(member.companyId, plugin, op.object, op.externalId, Object.keys(written), async () => null)
    if (back) importer.applyOne(member.companyId, plugin, op.accountId, op.object, back, {}, null)
    return repo.operation(op.id)!
  }

  /**
   * Compare the outside state with the operation's evidence (review §5.6):
   * the intended values are there → `observed` (not ACB's confirmed success:
   * someone else may have written the same; not undoable), recorded as an
   * observed change; otherwise it stays `sent-unknown`. Never re-sends.
   */
  async function reconcileOnce(member: Member, plugin: ActivePlugin, op: PluginOperationRow): Promise<PluginOperationRow> {
    const repo = companyData.forCompany(member.companyId).plugins
    const written = JSON.parse(op.written) as Record<string, string>
    // Only a read, to collect facts: the stops are for new writes, not for this (review §6.5).
    const back = await readOutside(member.companyId, plugin, op.object, op.externalId, Object.keys(written), async () => null)
    if (!back) return op
    importer.applyOne(member.companyId, plugin, op.accountId, op.object, back, {}, null)
    if (same(written, rawOf(back.properties, Object.keys(written)))) {
      repo.updateOperation(op.id, { state: 'observed', reason: 'observed-actor-unknown' }, clock.now())
    } else {
      repo.updateOperation(op.id, { state: 'sent-unknown', reason: 'not-observed' }, clock.now())
    }
    return repo.operation(op.id)!
  }

  async function opFor(member: Member, pluginId: string, operationId: string) {
    const op = typeof operationId === 'string' && operationId.length <= 100 ? companyData.forCompany(member.companyId).plugins.operation(operationId) : null
    if (!op || op.pluginId !== pluginId || !readable(member, op.recordId)) return null
    return op
  }

  return {
    /**
     * Run a typed operation on a record. `update`: { expectedVersion, fields:
     * { <ACB field>: value }, note? }; `read` (refresh): {}.
     */
    async run(member: Member, actor: OperationActor, pluginId: string, recordId: string, operation: string, body: unknown): Promise<Outcome<{ operation: OperationView | null; record: { id: string; version: number } }>> {
      if (!companyData.forCompany(member.companyId).records.settings().enabled) return refuse('not-found', RECORDS_DISABLED.error, { code: RECORDS_DISABLED.code })
      const row = readable(member, recordId)
      if (!row) return notFound()
      const active = await plugins.active(member.companyId, pluginId)
      if (!active.ok) return conflict('いまは HubSpot とつながっていません（止められているか、設定が足りません）', 'PLUGIN_NOT_ACTIVE', { problem: active.problem })
      if (actor.kind === 'ai' && deps.aiStopped(member.companyId)) return refuse('forbidden', '管理者が AI の利用を一時停止しています。', { code: 'ACB_STOPPED' })
      const plugin = active.plugin
      const op = Object.prototype.hasOwnProperty.call(plugin.manifest.operations, operation) ? plugin.manifest.operations[operation] : undefined
      if (!op) return refuse('not-found', 'この操作はありません', { code: 'OPERATION_NOT_FOUND' })
      if (op.kind === 'create') return conflict('この操作は節目3ではまだ使えません', 'OPERATION_NOT_AVAILABLE')
      const link = companyData.forCompany(member.companyId).plugins.linkOfRecord(recordId)
      if (!link || link.pluginId !== pluginId || link.connectionId !== plugin.connectionId || link.object !== op.object) {
        return conflict('この記録は、いまの接続から取り込んだものではありません', 'NOT_LINKED')
      }
      const place = row.path ?? row.folder ?? ''
      if (!mayRun(member, actor, op.who, recordId, place)) {
        return refuse('forbidden', actor.kind === 'ai' && !op.who.includes('ai') ? 'この操作は AI からはできません' : 'この操作をする権限がありません', { code: 'NOT_ALLOWED' })
      }

      if (op.kind === 'read') {
        const r = await importer.refreshRecord(member, pluginId, recordId)
        return r.ok ? ok({ operation: null, record: { id: recordId, version: r.value.version } }) : r
      }

      // An update.
      const b = isObj(body) ? body : null
      if (!b) return refuse('bad-request', 'The body must be an object')
      if (!Number.isInteger(b.expectedVersion) || (b.expectedVersion as number) < 0) return refuse('bad-request', 'expectedVersion: the version you saw', { code: 'VERSION_REQUIRED' })
      if (!isObj(b.fields) || Object.keys(b.fields).length === 0 || Object.keys(b.fields).length > 30) return refuse('bad-request', 'fields: { <field>: value } (1–30)')
      const note = b.note === undefined ? '' : b.note
      if (typeof note !== 'string' || note.length > NOTE_MAX) return refuse('bad-request', `note: up to ${NOTE_MAX} characters`)
      if (op.decision && actor.kind === 'ai' && note.trim() === '') {
        return refuse('bad-request', 'AI が書き換えるときは、相談のどこからそう判断したか（理由と根拠）を note に書いてください', { code: 'REASON_REQUIRED' })
      }
      if (op.note === 'required' && note.trim() === '') return refuse('bad-request', 'この操作にはひとことのメモが要ります', { code: 'NOTE_REQUIRED' })
      const asked = b.fields as Record<string, AcbValue>
      const names = Object.keys(asked)
      const policy = notAuto(plugin, operation, names)
      if (policy.off.length > 0) return refuse('bad-request', `書き戻さない欄です：${policy.off.join('、')}（何も変えていません）`, { code: 'FIELD_NOT_WRITABLE', fields: policy.off })
      if (policy.prior.length > 0) {
        return conflict(`承認が必要な欄のため、変えていません：${policy.prior.join('、')}（ほかの欄も変えていません。HubSpot の画面で変えるか、管理者に頼んでください）`, 'APPROVAL_REQUIRED', { fields: policy.prior })
      }
      const pkg = { manifest: plugin.manifest, types: plugin.types }
      const translated = acbToExternal(pkg, plugin.mapping, op.object, asked)
      if (!translated.ok) return refuse('bad-request', '書き戻せない値があります（何も変えていません）', { code: 'BAD_VALUE', errors: translated.errors })
      if (valuesOf(member.companyId, recordId).version !== b.expectedVersion) {
        return conflict('ほかの人が先に変えました。最新の状態を見てからもう一度お試しください', 'VERSION_CONFLICT', { version: valuesOf(member.companyId, recordId).version })
      }
      const precheck = precheckFor(member, actor, plugin, operation, op.who, recordId, place, names)

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
        const at = clock.now()
        const row0: PluginOperationRow = {
          id: deps.ids.newId(), pluginId, operation, pluginVersion: plugin.version, fingerprint: plugin.fingerprint, mappingVersion: plugin.mappingVersion,
          connectionId: plugin.connectionId, accountId: link.accountId, object: link.object, externalId: link.externalId, recordId,
          actorId: member.userId, actorKind: actor.kind, actorSource: actor.kind === 'ai' ? actor.source ?? null : null, conversationId: actor.conversationId ?? null,
          state: 'pending', fields: JSON.stringify(asked), written: JSON.stringify(translated.properties), previous: JSON.stringify(previous),
          reason: null, undoOf: null, undoneBy: null, recordVersion: null, createdAt: at, updatedAt: at,
        }
        companyData.forCompany(member.companyId).plugins.insertOperation(row0)
        const settled = await sendAndSettle(member, actor, plugin, row0, asked, precheck, { action: `${pluginId}.${operation}`, note, decision: op.decision })
        return answerFor(member, settled)
      })
    },

    /** The operation (only for someone who may read its record). */
    async get(member: Member, pluginId: string, operationId: string): Promise<Outcome<{ operation: OperationView }>> {
      const op = await opFor(member, pluginId, operationId)
      return op ? ok({ operation: view(member.companyId, op) }) : refuse('not-found', 'その操作はありません', { code: 'OPERATION_RECORD_NOT_FOUND' })
    },

    /**
     * 「変更前の値を書き戻す」 (a person only; review §6.4): a new compensating
     * write of the raw previous values stored with the operation — never
     * re-read through the current mapping — on the same connection and
     * account, only while HubSpot still holds what ACB wrote, after every
     * check a new write gets. Downstream effects are not undone.
     */
    async undo(member: Member, pluginId: string, operationId: string, provenance: Pick<OperationActor, 'conversationId' | 'proposedBy'> = {}): Promise<Outcome<{ operation: OperationView | null; record: { id: string; version: number } }>> {
      const op = await opFor(member, pluginId, operationId)
      if (!op) return refuse('not-found', 'その操作はありません', { code: 'OPERATION_RECORD_NOT_FOUND' })
      if (op.actorId !== member.userId && !FULL_ACCESS_ROLES.has(member.role)) return refuse('forbidden', '自分の（自分の AI の）変更か、管理者だけが書き戻せます', { code: 'NOT_ALLOWED' })
      if (op.operation === 'undo' || op.undoneBy !== null) return conflict('この変更はもう書き戻してあるか、書き戻しそのものです', 'NOT_UNDOABLE')
      if (op.state !== 'applied') {
        return conflict(op.state === 'observed'
          ? 'HubSpot でその値になったことは分かりましたが、ACB が書いたと確かめられないため、書き戻せません'
          : 'HubSpot に書けたと確かめられていない変更は、書き戻せません', 'NOT_UNDOABLE', { state: op.state })
      }
      const active = await plugins.active(member.companyId, pluginId)
      if (!active.ok) return conflict('いまは HubSpot とつながっていません（止められているか、設定が足りません）', 'PLUGIN_NOT_ACTIVE', { problem: active.problem })
      const plugin = active.plugin
      if (plugin.connectionId !== op.connectionId || (plugin.accountId !== null && plugin.accountId !== op.accountId)) {
        return conflict('この変更は別の HubSpot のアカウント（接続）でしたものです。書き戻せません', 'ACCOUNT_CHANGED')
      }
      const declared = plugin.manifest.operations[op.operation]
      if (!declared || declared.undo !== 'restore_previous') return conflict('この操作は書き戻せません', 'NOT_UNDOABLE')
      const row = readable(member, op.recordId)!
      const place = row.path ?? row.folder ?? ''
      const human: OperationActor = { kind: 'human', conversationId: provenance.conversationId ?? null, proposedBy: provenance.proposedBy ?? null }
      if (!mayRun(member, human, declared.who, op.recordId, place)) return refuse('forbidden', 'この操作をする権限がありません', { code: 'NOT_ALLOWED' })
      const asked = JSON.parse(op.fields) as Record<string, AcbValue>
      const names = Object.keys(asked)
      const policy = notAuto(plugin, op.operation, names)
      if (policy.prior.length + policy.off.length > 0) return conflict('いまは自動で書き戻せない欄が含まれています', 'APPROVAL_REQUIRED', { fields: [...policy.prior, ...policy.off] })
      const precheck = precheckFor(member, human, plugin, op.operation, declared.who, op.recordId, place, names)

      return serialised(`${member.companyId}|${op.connectionId}|${op.object}|${op.externalId}`, async () => {
        const account = await importer.verifyAccount(member.companyId, plugin, precheck)
        if (!account.ok || account.accountId !== op.accountId) return conflict('この変更は別の HubSpot のアカウントでしたものです。書き戻せません', 'ACCOUNT_CHANGED')
        const written = JSON.parse(op.written) as Record<string, string>
        const previous = JSON.parse(op.previous) as Record<string, string>
        const props = Object.keys(written)
        const outside = await readOutside(member.companyId, plugin, op.object, op.externalId, props, precheck)
        if (!outside) return refuse('unavailable', 'HubSpot から今の値を読めませんでした（何も変えていません）', { code: 'OUTSIDE_UNAVAILABLE' })
        importer.applyOne(member.companyId, plugin, op.accountId, op.object, outside, {}, null)
        if (!same(written, rawOf(outside.properties, props))) {
          const now = externalToAcb({ manifest: plugin.manifest, types: plugin.types }, plugin.mapping, op.object, outside.properties).values
          return conflict('HubSpot 側でそのあとに変わっているため、書き戻せません', 'CHANGED_OUTSIDE', { current: Object.fromEntries(names.map(n => [n, now[n] ?? null])) })
        }
        // The ACB values the previous raw values stand for (for the record's copy); the write itself sends the raw values.
        const back = externalToAcb({ manifest: plugin.manifest, types: plugin.types }, plugin.mapping, op.object, previous).values
        const at = clock.now()
        const undoRow: PluginOperationRow = {
          ...op, id: deps.ids.newId(), operation: 'undo', pluginVersion: plugin.version, fingerprint: plugin.fingerprint, mappingVersion: plugin.mappingVersion,
          actorId: member.userId, actorKind: 'human', actorSource: null, conversationId: human.conversationId ?? null, state: 'pending',
          fields: JSON.stringify(Object.fromEntries(names.filter(n => n in back).map(n => [n, back[n]]))),
          written: JSON.stringify(previous), previous: JSON.stringify(rawOf(outside.properties, props)),
          reason: null, undoOf: op.id, undoneBy: null, recordVersion: null, createdAt: at, updatedAt: at,
        }
        const repo = companyData.forCompany(member.companyId).plugins
        repo.insertOperation(undoRow)
        const settled = await sendAndSettle(member, human, plugin, undoRow, JSON.parse(undoRow.fields) as Record<string, AcbValue>, precheck,
          { action: `${pluginId}.undo`, note: `${UNDO_LABEL}（${op.id}）`, decision: false })
        if (settled.state === 'applied') repo.updateOperation(op.id, { undoneBy: settled.id }, clock.now())
        return answerFor(member, settled)
      })
    },

    /**
     * Read the outside object back for an operation whose answer was lost
     * (owner/admin or its actor). Allowed while the plugin is stopped or off
     * (collecting facts is not a new write, review §6.5). Never re-sends.
     */
    async reconcile(member: Member, pluginId: string, operationId: string): Promise<Outcome<{ operation: OperationView }>> {
      const op = await opFor(member, pluginId, operationId)
      if (!op) return refuse('not-found', 'その操作はありません', { code: 'OPERATION_RECORD_NOT_FOUND' })
      if (op.actorId !== member.userId && !FULL_ACCESS_ROLES.has(member.role)) return refuse('forbidden', '自分の変更か、管理者だけが確かめられます', { code: 'NOT_ALLOWED' })
      if (op.state !== 'sent-unknown') return ok({ operation: view(member.companyId, op) })
      const active = await plugins.active(member.companyId, pluginId, { collectingFacts: true })
      if (!active.ok) return conflict('いまは HubSpot を読めません', 'PLUGIN_NOT_ACTIVE', { problem: active.problem })
      if (active.plugin.connectionId !== op.connectionId) return conflict('この変更は別の接続でしたものです', 'ACCOUNT_CHANGED')
      const account = await importer.verifyAccount(member.companyId, active.plugin, async () => null)
      if (!account.ok || account.accountId !== op.accountId) return conflict('この変更は別の HubSpot のアカウントでしたものです', 'ACCOUNT_CHANGED')
      return ok({ operation: view(member.companyId, await reconcileOnce(member, active.plugin, op)) })
    },
  }

  function answerFor(member: Member, op: PluginOperationRow): Outcome<{ operation: OperationView | null; record: { id: string; version: number } }> {
    const record = { id: op.recordId, version: valuesOf(member.companyId, op.recordId).version }
    if (op.state === 'failed') {
      return refuse(op.reason === 'rate-limited' ? 'rate-limited' : 'conflict', 'HubSpot に書けませんでした（何も変わっていません）', { code: 'WRITE_FAILED', reason: op.reason, operation: view(member.companyId, op), record })
    }
    return ok({ operation: view(member.companyId, op), record })
  }
}

export type PluginOperationService = ReturnType<typeof createPluginOperationService>
