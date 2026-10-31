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
import { FULL_ACCESS_ROLES } from '../../shared/core/permissions'
import { isSameOrAncestorPath } from '../../shared/core/paths'
import { approvalReasonProblem, type ApproverRule, type ApprovalFieldChange, type PluginApprovalPayload } from '../../shared/core/approvals'
import {
  acbToExternal, approverFor, effectiveFieldPolicy, effectiveOperationPolicy, externalToAcb,
  type AcbValue, type CreateContentSlot, type ExternalProperties, type FieldPolicy, type PluginOperation,
} from '../../shared/core/plugins'
import type { ExternalReceipt, LedgerValue } from '../../shared/core/record-ledger'
import { RECORD_ID_RE } from '../../shared/core/records'
import type { Clock, IdGenerator } from '../ports/clock'
import type { CompanyDataSource } from '../ports/company-data'
import type { PluginOperationRow } from '../ports/plugins'
import type { RecordRow } from '../ports/records'
import type { PluginOperationRecordView } from '../../shared/types/plugins'
import type { Member } from './access'
import { ok, refuse, type Outcome } from './outcome'
import { EXTERNAL_ID_RE, type PluginConnector } from './plugin-connector'
import type { PluginImportService } from './plugin-import'
import type { ActivePlugin, PluginService } from './plugins'
import { recordReader } from './record-access'
import { currentTypes } from './record-index'
import { mayAct, type ExternalRecordWriter } from './record-engine'
import { RECORD_NOT_FOUND, RECORDS_DISABLED } from './records'

/** The words for an undo, on the screens and to the AI (review §5.4 / §6.4). */
export const UNDO_LABEL = '変更前の値を書き戻す'
export const UNDO_NOTICE = 'HubSpot のワークフローや通知など、変更のあとに HubSpot 側で起きたことは元に戻りません。'
/** The undo of a create: an archive (HubSpot's recycling bin). */
export const CREATE_UNDO_LABEL = '作ったものを取り消す'
export const CREATE_UNDO_NOTICE = 'HubSpot のごみ箱に移します。作ったあとに HubSpot 側で起きたこと（ワークフローや通知など）は元に戻りません。'
/** What a person confirms before 「もう一度作る」 (design §4-4). */
export const RECREATE_WARNING = 'HubSpot で見つからなかったため、もう一度作ります。前に送ったものがあとから HubSpot に現れると、二つになることがあります。HubSpot の画面で無いことを確かめてから押してください。'
/** A create looked up by search only this long after it was sent (HubSpot's search does not see a new object at once). */
export const CREATE_SEARCH_DELAY_MS = 60_000
const NOTE_MAX = 2000
const TITLE_MAX = 200
const BODY_MAX = 20_000
const OUTCOME_MAX = 100

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

type RecordRef = { id: string; version: number }
type RunAnswer = { operation: OperationView | null; record: RecordRef | null }

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
const opNotFound = () => refuse('not-found', 'その操作はありません', { code: 'OPERATION_RECORD_NOT_FOUND' })
const notActive = (problem: string) => conflict('いまは HubSpot とつながっていません（止められているか、設定が足りません）', 'PLUGIN_NOT_ACTIVE', { problem })
const approvalRequired = (fields?: string[]) => conflict(
  fields ? `承認が必要な欄のため、変えていません：${fields.join('、')}（ほかの欄も変えていません。承認を頼んでください）` : 'この操作は承認が必要です。承認されるまで何も送っていません',
  'APPROVAL_REQUIRED', fields ? { fields } : {})
const operationOff = () => refuse('bad-request', 'この操作はいまは使わない設定です（何も送っていません）', { code: 'OPERATION_OFF' })

/** The plugin's `who` in the engine's words (`viewer` is anyone who reaches the record: it was read-checked first). */
const engineWho = (who: string[]) => who.map(w => (w === 'viewer' ? 'anyone' : w))

/** The ISO time of an epoch-milliseconds outside value (`at` slot), or the raw value. */
const isoOf = (raw: string) => (/^\d{1,15}$/.test(raw) ? new Date(Number(raw)).toISOString() : raw)

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

  function readable(member: Member, recordId: string | null): RecordRow | null {
    if (recordId === null) return null
    const handle = companyData.forCompany(member.companyId)
    const row = RECORD_ID_RE.test(recordId) ? handle.records.byIds([recordId])[0] : undefined
    if (!row || row.removedAt !== null || !recordReader(member, handle.scopes.listWithRules()).record(row)) return null
    return row
  }

  /** Whether the member may read a folder (where a created record would go). */
  function folderReadable(member: Member, folder: string): boolean {
    const handle = companyData.forCompany(member.companyId)
    return recordReader(member, handle.scopes.listWithRules()).record({ id: '', type: '', scopeId: null, path: null, folder })
  }

  function valuesOf(companyId: string, recordId: string): { version: number; fields: Record<string, LedgerValue> } {
    const s = companyData.forCompany(companyId).records.states([recordId])[0]
    let fields: Record<string, LedgerValue> = {}
    try { fields = s ? JSON.parse(s.fields) as Record<string, LedgerValue> : {} } catch { fields = {} }
    return { version: s?.version ?? 0, fields }
  }

  /** `who` for a member (and kind) at a place, with the record's values (none for a record not made yet). */
  function mayRunAt(member: Member, actor: Pick<OperationActor, 'kind' | 'source'>, who: string[], values: Record<string, LedgerValue>, place: string): boolean {
    const managesPlace = who.includes('dept_manager') && deps.managedFolders(member.companyId, member.userId).some(f => isSameOrAncestorPath(f, place))
    return mayAct(engineWho(who), member, { kind: actor.kind, source: actor.source }, values, managesPlace)
  }

  function mayRun(member: Member, actor: Pick<OperationActor, 'kind' | 'source'>, who: string[], recordId: string, place: string): boolean {
    return mayRunAt(member, actor, who, valuesOf(member.companyId, recordId).fields, place)
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

  /**
   * A create's policy now. A create of a record is never `auto` whatever the
   * declaration or mapping say (checked here too, not only by the parser).
   */
  function createPolicy(plugin: ActivePlugin, operation: string, op: PluginOperation): FieldPolicy {
    const p = effectiveOperationPolicy(plugin.manifest, operation, plugin.mapping)
    return op.createsRecord && p === 'auto' ? 'prior' : p
  }

  /** Update rows always store the raw previous values of the properties written; creates and archives store none. */
  const kindOf = (o: PluginOperationRow): OperationView['kind'] => (o.operation === 'undo' ? 'undo' : o.previous === '{}' ? 'create' : 'update')

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

  /**
   * The checks right before a send (the connector repeats them after any
   * wait): the plugin still runs on the same connection, the records switch,
   * the member still belongs (and may still do it), the AI is not stopped,
   * the policy still allows it (`policyOk`).
   */
  function precheckFor(
    member: Member, actor: Pick<OperationActor, 'kind' | 'source'>, plugin: ActivePlugin, who: string[], recordId: string | null, place: string,
    policyOk: (now: ActivePlugin) => boolean,
  ) {
    return async (): Promise<string | null> => {
      const now = await plugins.active(member.companyId, plugin.pluginId)
      if (!now.ok) return now.problem
      if (now.plugin.connectionId !== plugin.connectionId) return 'connection-changed'
      if (!companyData.forCompany(member.companyId).records.settings().enabled) return 'records-off'
      const role = deps.roleOf(member.companyId, member.userId)
      if (role === null) return 'not-member'
      if (actor.kind === 'ai' && deps.aiStopped(member.companyId)) return 'ai-stopped'
      const values = recordId ? valuesOf(member.companyId, recordId).fields : {}
      if (!mayRunAt({ ...member, role }, actor, who, values, place)) return 'not-allowed'
      if (!policyOk(now.plugin)) return 'policy-changed'
      return null
    }
  }

  const fieldsAuto = (operation: string, fields: string[]) => (p: ActivePlugin) => { const n = notAuto(p, operation, fields); return n.prior.length + n.off.length === 0 }

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

  function newRow(member: Member, actor: OperationActor, plugin: ActivePlugin, parts: Pick<PluginOperationRow, 'operation' | 'accountId' | 'object' | 'externalId' | 'recordId' | 'fields' | 'written' | 'previous'> & { approvedBy?: string | null; undoOf?: string | null }): PluginOperationRow {
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

  function receiptFor(plugin: ActivePlugin, op: PluginOperationRow, externalId: string, externalUpdatedAt: string | null): ExternalReceipt {
    return {
      plugin: plugin.pluginId, pluginVersion: op.pluginVersion, fingerprint: op.fingerprint, mappingVersion: op.mappingVersion,
      connectionId: op.connectionId, accountId: op.accountId, object: op.object, externalId, externalUpdatedAt, operationId: op.id, kind: 'written',
      ...(op.approvedBy ? { approvedBy: op.approvedBy } : {}),
    }
  }

  const actorOf = (op: PluginOperationRow, proposedBy: 'ai' | null = null) =>
    ({ id: op.actorId, kind: op.actorKind, source: op.actorSource, conversationId: op.conversationId, proposedBy: op.actorKind === 'human' ? proposedBy : null })

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
    const current = valuesOf(member.companyId, recordId)
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

  /** The ACB words of a create attached to a record (`{ title, body, at, outcome }`) → the declared outside properties. */
  function attachedInput(op: PluginOperation, b: Record<string, unknown>): { ok: true; fields: Record<string, AcbValue>; properties: Record<string, string> } | { ok: false; error: string } {
    const fields: Record<string, AcbValue> = {}
    const properties: Record<string, string> = {}
    for (const [slot, property] of Object.entries(op.content) as Array<[CreateContentSlot, string]>) {
      const v = b[slot]
      if (slot === 'title') {
        if (typeof v !== 'string' || v.trim() === '' || v.length > TITLE_MAX) return { ok: false, error: `title: 1–${TITLE_MAX} characters` }
        fields.title = v.normalize('NFC'); properties[property] = fields.title
      } else if (slot === 'body') {
        if (v !== undefined && (typeof v !== 'string' || v.length > BODY_MAX)) return { ok: false, error: `body: up to ${BODY_MAX} characters` }
        fields.body = typeof v === 'string' ? v.normalize('NFC') : ''; properties[property] = fields.body as string
      } else if (slot === 'at') {
        const ms = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) ? Date.parse(v) : NaN
        if (!Number.isFinite(ms)) return { ok: false, error: 'at: an ISO date and time (2026-11-05T15:00:00+09:00)' }
        fields.at = new Date(ms).toISOString(); properties[property] = String(ms)
      } else if (v !== undefined && v !== null) {
        if (typeof v !== 'string' || v.trim() === '' || v.length > OUTCOME_MAX) return { ok: false, error: `outcome: up to ${OUTCOME_MAX} characters` }
        fields.outcome = v; properties[property] = v
      }
    }
    return { ok: true, fields, properties }
  }

  /** A create of a record: `{ title, fields }` (ACB words) → the outside properties (title through the mapping's `title.from`). */
  function recordInput(plugin: ActivePlugin, op: PluginOperation, b: Record<string, unknown>): { ok: true; fields: Record<string, AcbValue>; properties: Record<string, string> } | { ok: false; error: string; errors?: string[] } {
    if (typeof b.title !== 'string' || b.title.trim() === '' || b.title.length > TITLE_MAX) return { ok: false, error: `title: 1–${TITLE_MAX} characters` }
    const titleFrom = plugin.mapping.objects[op.object]?.fields.title?.from
    if (!titleFrom) return { ok: false, error: '読み替え表に件名（title）の項目がありません' }
    const asked = b.fields === undefined ? {} : b.fields
    if (!isObj(asked) || Object.keys(asked).length > 30 || 'title' in asked || 'summary' in asked) return { ok: false, error: 'fields: { <field>: value } (up to 30; not title)' }
    const translated = acbToExternal({ manifest: plugin.manifest, types: plugin.types }, plugin.mapping, op.object, asked as Record<string, AcbValue>)
    if (!translated.ok) return { ok: false, error: '書けない値があります（何も送っていません）', errors: translated.errors }
    const title = b.title.normalize('NFC')
    return { ok: true, fields: { title, ...(asked as Record<string, AcbValue>) }, properties: { ...translated.properties, [titleFrom]: title } }
  }

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
      const { title: _t, summary: _s, ...fields } = externalToAcb({ manifest: plugin.manifest, types: plugin.types }, plugin.mapping, op.object, written).values
      void _t; void _s
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

  /**
   * An operation the member may see: of a record they may read; a create of a
   * record not made yet — only its actor and owners / admins.
   */
  async function opFor(member: Member, pluginId: string, operationId: string) {
    const op = typeof operationId === 'string' && operationId.length <= 100 ? companyData.forCompany(member.companyId).plugins.operation(operationId) : null
    if (!op || op.pluginId !== pluginId) return null
    if (op.recordId === null) return op.actorId === member.userId || FULL_ACCESS_ROLES.has(member.role) ? op : null
    return readable(member, op.recordId) ? op : null
  }

  function answerFor(member: Member, op: PluginOperationRow): Outcome<RunAnswer> {
    const record = op.recordId ? { id: op.recordId, version: valuesOf(member.companyId, op.recordId).version } : null
    if (op.state === 'failed') {
      return refuse(op.reason === 'rate-limited' ? 'rate-limited' : 'conflict', 'HubSpot に書けませんでした（何も変わっていません）', { code: 'WRITE_FAILED', reason: op.reason, operation: view(member.companyId, op), record })
    }
    return ok({ operation: view(member.companyId, op), record })
  }

  /** Note / reason of a body (people may leave it out; the AI must give it for a decision). */
  function noteOf(b: Record<string, unknown>, op: PluginOperation, actor: OperationActor): { ok: true; note: string } | { ok: false; refusal: Outcome<never> } {
    const note = b.note === undefined ? '' : b.note
    if (typeof note !== 'string' || note.length > NOTE_MAX) return { ok: false, refusal: refuse('bad-request', `note: up to ${NOTE_MAX} characters`) }
    if (op.decision && actor.kind === 'ai' && note.trim() === '') {
      return { ok: false, refusal: refuse('bad-request', 'AI が書き換えるときは、相談のどこからそう判断したか（理由と根拠）を note に書いてください', { code: 'REASON_REQUIRED' }) }
    }
    if (op.note === 'required' && note.trim() === '') return { ok: false, refusal: refuse('bad-request', 'この操作にはひとことのメモが要ります', { code: 'NOTE_REQUIRED' }) }
    return { ok: true, note }
  }

  /** Where the record (or the created record's folder) sits, for `who`'s department managers. */
  const placeOf = (row: RecordRow) => row.path ?? row.folder ?? ''

  /** The checks a record operation gets before its own work: (row, plugin, op, link) or the refusal. */
  async function recordChecks(member: Member, actor: OperationActor, pluginId: string, recordId: string, operation: string) {
    if (!companyData.forCompany(member.companyId).records.settings().enabled) return { refusal: refuse('not-found', RECORDS_DISABLED.error, { code: RECORDS_DISABLED.code }) } as const
    const row = readable(member, recordId)
    if (!row) return { refusal: notFound() } as const
    const active = await plugins.active(member.companyId, pluginId)
    if (!active.ok) return { refusal: notActive(active.problem) } as const
    if (actor.kind === 'ai' && deps.aiStopped(member.companyId)) return { refusal: refuse('forbidden', '管理者が AI の利用を一時停止しています。', { code: 'ACB_STOPPED' }) } as const
    const plugin = active.plugin
    const op = Object.prototype.hasOwnProperty.call(plugin.manifest.operations, operation) ? plugin.manifest.operations[operation] : undefined
    if (!op) return { refusal: refuse('not-found', 'この操作はありません', { code: 'OPERATION_NOT_FOUND' }) } as const
    if (op.kind === 'create' && op.createsRecord) return { refusal: refuse('bad-request', 'この操作は記録を新しく作るものです（記録を指定しません）', { code: 'OPERATION_CREATES_RECORD' }) } as const
    const link = companyData.forCompany(member.companyId).plugins.linkOfRecord(recordId)
    if (!link || link.pluginId !== pluginId || link.connectionId !== plugin.connectionId || link.object !== (op.attachTo ?? op.object)) {
      return { refusal: conflict('この記録は、いまの接続から取り込んだものではありません', 'NOT_LINKED') } as const
    }
    const place = placeOf(row)
    if (!mayRun(member, actor, op.who, recordId, place)) {
      return { refusal: refuse('forbidden', actor.kind === 'ai' && !op.who.includes('ai') ? 'この操作は AI からはできません' : 'この操作をする権限がありません', { code: 'NOT_ALLOWED' }) } as const
    }
    return { refusal: null, row, plugin, op, link, place } as const
  }

  /** The checks a create of a record gets (no record yet): the folder it would go to stands for the record. */
  async function newRecordChecks(member: Member, actor: OperationActor, pluginId: string, operation: string) {
    if (!companyData.forCompany(member.companyId).records.settings().enabled) return { refusal: refuse('not-found', RECORDS_DISABLED.error, { code: RECORDS_DISABLED.code }) } as const
    const active = await plugins.active(member.companyId, pluginId)
    if (!active.ok) return { refusal: notActive(active.problem) } as const
    if (actor.kind === 'ai' && deps.aiStopped(member.companyId)) return { refusal: refuse('forbidden', '管理者が AI の利用を一時停止しています。', { code: 'ACB_STOPPED' }) } as const
    const plugin = active.plugin
    const op = Object.prototype.hasOwnProperty.call(plugin.manifest.operations, operation) ? plugin.manifest.operations[operation] : undefined
    if (!op || op.kind !== 'create' || !op.createsRecord) return { refusal: refuse('not-found', 'この操作はありません', { code: 'OPERATION_NOT_FOUND' }) } as const
    const place = plugin.mapping.objects[op.object]?.visibleToFolder ?? ''
    if (!folderReadable(member, place) || !mayRunAt(member, actor, op.who, {}, place)) {
      return { refusal: refuse('forbidden', actor.kind === 'ai' && !op.who.includes('ai') ? 'この操作は AI からはできません' : 'この操作をする権限がありません', { code: 'NOT_ALLOWED' }) } as const
    }
    return { refusal: null, plugin, op, place } as const
  }

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
        const row = link ? readable(member, link.recordId) : null
        if (row && !similar.some(s => s.recordId === row.id)) similar.push({ recordId: row.id, title: row.title })
      }
      return ok({ similar })
    },

    /** The operation (only for someone who may read its record). */
    async get(member: Member, pluginId: string, operationId: string): Promise<Outcome<{ operation: OperationView }>> {
      const op = await opFor(member, pluginId, operationId)
      return op ? ok({ operation: view(member.companyId, op) }) : opNotFound()
    },

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
    async undo(member: Member, pluginId: string, operationId: string, provenance: Pick<OperationActor, 'conversationId' | 'proposedBy'> = {}): Promise<Outcome<RunAnswer>> {
      const op = await opFor(member, pluginId, operationId)
      if (!op) return opNotFound()
      if (op.actorId !== member.userId && !FULL_ACCESS_ROLES.has(member.role)) return refuse('forbidden', '自分の（自分の AI の）変更か、管理者だけが書き戻せます', { code: 'NOT_ALLOWED' })
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
      if (!mayRun(member, human, declared.who, recordId, place)) return refuse('forbidden', 'この操作をする権限がありません', { code: 'NOT_ALLOWED' })
      const asked = JSON.parse(op.fields) as Record<string, AcbValue>
      const names = Object.keys(asked)
      const policy = notAuto(plugin, op.operation, names)
      if (policy.prior.length + policy.off.length > 0) return conflict('いまは自動で書き戻せない欄が含まれています', 'APPROVAL_REQUIRED', { fields: [...policy.prior, ...policy.off] })
      const precheck = precheckFor(member, human, plugin, declared.who, recordId, place, fieldsAuto(op.operation, names))
      const externalId = op.externalId as string

      return serialised(`${member.companyId}|${op.connectionId}|${op.object}|${externalId}`, async () => {
        const account = await importer.verifyAccount(member.companyId, plugin, precheck)
        if (!account.ok || account.accountId !== op.accountId) return conflict('この変更は別の HubSpot のアカウントでしたものです。書き戻せません', 'ACCOUNT_CHANGED')
        const written = JSON.parse(op.written) as Record<string, string>
        const previous = JSON.parse(op.previous) as Record<string, string>
        const props = Object.keys(written)
        const outside = await readOutside(member.companyId, plugin, op.object, externalId, props, precheck)
        if (!outside) return refuse('unavailable', 'HubSpot から今の値を読めませんでした（何も変えていません）', { code: 'OUTSIDE_UNAVAILABLE' })
        importer.applyOne(member.companyId, plugin, op.accountId, op.object, outside, {}, null)
        if (!same(written, rawOf(outside.properties, props))) {
          const now = externalToAcb({ manifest: plugin.manifest, types: plugin.types }, plugin.mapping, op.object, outside.properties).values
          return conflict('HubSpot 側でそのあとに変わっているため、書き戻せません', 'CHANGED_OUTSIDE', { current: Object.fromEntries(names.map(n => [n, now[n] ?? null])) })
        }
        // The ACB values the previous raw values stand for (for the record's copy); the write itself sends the raw values.
        const back = externalToAcb({ manifest: plugin.manifest, types: plugin.types }, plugin.mapping, op.object, previous).values
        const undoRow = newRow(member, human, plugin, {
          operation: 'undo', accountId: op.accountId, object: op.object, externalId, recordId, undoOf: op.id,
          fields: JSON.stringify(Object.fromEntries(names.filter(n => n in back).map(n => [n, back[n]]))),
          written: JSON.stringify(previous), previous: JSON.stringify(rawOf(outside.properties, props)),
        })
        const repo = companyData.forCompany(member.companyId).plugins
        repo.insertOperation(undoRow)
        const settled = await sendAndSettle(member, human, plugin, undoRow, JSON.parse(undoRow.fields) as Record<string, AcbValue>, precheck,
          { action: `${pluginId}.undo`, note: `${UNDO_LABEL}（${op.id}）`, decision: false })
        if (settled.state === 'applied') repo.updateOperation(op.id, { undoneBy: settled.id }, clock.now())
        return answerFor(member, settled)
      })
    },

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
      const minutesId = typeof basis.minutesId === 'string' && basis.minutesId.length <= 100 ? basis.minutesId : null
      const quote = typeof basis.quote === 'string' && basis.quote.length <= 2000 ? basis.quote.normalize('NFC') : null
      const head = (plugin: ActivePlugin) => ({
        v: 1 as const, kind: 'plugin_operation' as const, plugin: { id: plugin.pluginId, version: plugin.version, fingerprint: plugin.fingerprint },
        mappingVersion: plugin.mappingVersion, connectionId: plugin.connectionId, operation, basis: { minutesId, quote },
      })

      if (recordId === null) {
        const c = await newRecordChecks(member, actor, pluginId, operation)
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

      const c = await recordChecks(member, actor, pluginId, recordId, operation)
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
        const outside = await readOutside(member.companyId, plugin, link.object, link.externalId, properties, precheck)
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
        if (!folderReadable(member, place) || !mayRunAt(member, actor, op.who, {}, place)) return refuse('forbidden', 'お願いした人には、もうこの操作をする権限がありません', { code: 'NOT_ALLOWED' })
        if (createPolicy(plugin, operation, op) === 'off') return operationOff()
        const precheck = precheckFor(member, actor, plugin, op.who, null, place, p => createPolicy(p, operation, op) !== 'off')
        const asked = { title: payload.create.title, ...stripTitle(externalToAcb({ manifest: plugin.manifest, types: plugin.types }, plugin.mapping, op.object, payload.create.properties).values) }
        const sent = await sendNewRecord(member, actor, plugin, operation, op, { fields: asked, properties: payload.create.properties }, precheck, { ...decided, approvedBy: approver.userId }, payload.accountId)
        return sent.ok ? (sent.value.operation ? ok(sent.value.operation) : refuse('conflict', 'HubSpot に送れませんでした', { code: 'WRITE_FAILED' })) : sent
      }

      // On a record: it must still be readable, linked through this connection to the same outside object.
      const recordId = payload.record?.id ?? ''
      const row = readable(member, recordId)
      if (!row) return notFound()
      const link = repo.linkOfRecord(recordId)
      if (!link || link.pluginId !== plugin.pluginId || link.connectionId !== plugin.connectionId || link.accountId !== payload.accountId || link.externalId !== payload.externalId) {
        return conflict('この記録は、いまの接続から取り込んだものではありません', 'NOT_LINKED')
      }
      const place = placeOf(row)
      if (!mayRun(member, actor, op.who, recordId, place)) return refuse('forbidden', 'お願いした人には、もうこの操作をする権限がありません', { code: 'NOT_ALLOWED' })

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
        const row0 = newRow(member, actor, plugin, {
          operation, accountId: payload.accountId, object: op.object, externalId: null, recordId, fields: JSON.stringify(fields), written: '', previous: '{}', approvedBy: approver.userId,
        })
        row0.written = JSON.stringify({ ...payload.create.properties, [op.correlationProperty as string]: row0.id })
        repo.insertOperation(row0)
        const settled = await sendCreate(companyId, plugin, row0, link.externalId, precheck, decided)
        return settled.state === 'failed'
          ? refuse('conflict', 'HubSpot に書けませんでした（何も変わっていません）', { code: 'WRITE_FAILED', reason: settled.reason, operation: view(companyId, settled) })
          : ok(view(companyId, settled))
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
        const outside = await readOutside(companyId, plugin, link.object, externalId, props, precheck)
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
        const row0 = newRow(member, actor, plugin, {
          operation, accountId: payload.accountId, object: link.object, externalId, recordId,
          fields: JSON.stringify(asked), written: JSON.stringify(written), previous: JSON.stringify(Object.fromEntries(props.map(p => [p, now[p]]))), approvedBy: approver.userId,
        })
        repo.insertOperation(row0)
        const settled = await sendAndSettle(member, actor, plugin, row0, asked, precheck, { action: `${plugin.pluginId}.${operation}`, note: reason, decision: true })
        return settled.state === 'failed'
          ? refuse(settled.reason === 'rate-limited' ? 'rate-limited' : 'conflict', 'HubSpot に書けませんでした（何も変わっていません）', { code: 'WRITE_FAILED', reason: settled.reason, operation: view(companyId, settled) })
          : ok(view(companyId, settled))
      })
    },
  }
  return service

  function stripTitle(values: Record<string, AcbValue>): Record<string, AcbValue> {
    const { title: _t, summary: _s, ...rest } = values
    void _t; void _s
    return rest
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
    const row0 = newRow(member, actor, plugin, {
      operation, accountId: account.accountId, object: op.object, externalId: null, recordId: null,
      fields: JSON.stringify(input.fields), written: '', previous: '{}', approvedBy: how.approvedBy,
    })
    row0.written = JSON.stringify({ ...input.properties, [op.correlationProperty as string]: row0.id })
    companyData.forCompany(member.companyId).plugins.insertOperation(row0)
    const settled = await sendCreate(member.companyId, plugin, row0, null, precheck, { note: how.note || undefined, decision: how.decision })
    return answerFor(member, settled)
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
    if (!mayRun(member, human, declared.who, row.id, place)) return refuse('forbidden', 'この操作をする権限がありません', { code: 'NOT_ALLOWED' })
    if (createPolicy(plugin, op.operation, declared) === 'off') return operationOff()
    const precheck = precheckFor(member, human, plugin, declared.who, row.id, place, p => createPolicy(p, op.operation, declared) !== 'off')
    const externalId = op.externalId
    return serialised(`${member.companyId}|${op.connectionId}|${op.object}|${externalId}`, async () => {
      const account = await importer.verifyAccount(member.companyId, plugin, precheck)
      if (!account.ok || account.accountId !== op.accountId) return conflict('この操作は別の HubSpot のアカウントでしたものです。取り消せません', 'ACCOUNT_CHANGED')
      const repo = companyData.forCompany(member.companyId).plugins
      const undoRow = newRow(member, human, plugin, {
        operation: 'undo', accountId: op.accountId, object: op.object, externalId, recordId: row.id, undoOf: op.id, fields: op.fields, written: '{}', previous: '{}',
      })
      repo.insertOperation(undoRow)
      const r = await connector.call(member.companyId, plugin, { endpoint: 'archive', object: op.object, id: externalId }, precheck)
      if (!r.ok) {
        repo.updateOperation(undoRow.id, r.kind === 'unknown' || r.kind === 'server-error' ? { state: 'sent-unknown', reason: r.reason } : { state: 'failed', reason: r.reason }, clock.now())
        return answerFor(member, repo.operation(undoRow.id)!)
      }
      const applied = writer.apply(member.companyId, {
        recordId: row.id, type: row.type, folder: null, title: null, fields: {}, links: {}, entryWithoutChanges: true,
        action: `${plugin.pluginId}.undo`, source: plugin.pluginId, note: `${CREATE_UNDO_LABEL}（${op.id}）`,
        actor: { id: member.userId, kind: 'human', source: null, conversationId: human.conversationId ?? null, proposedBy: human.proposedBy ?? null },
        receipt: receiptFor(plugin, undoRow, externalId, null),
      })
      repo.updateOperation(undoRow.id, { state: 'applied', recordVersion: applied.ok ? applied.version : null, reason: applied.ok ? null : 'ledger-not-written' }, clock.now())
      repo.updateOperation(op.id, { undoneBy: undoRow.id }, clock.now())
      return answerFor(member, repo.operation(undoRow.id)!)
    })
  }

  /** An archive whose answer was lost: gone from the object's `get` → observed (who removed it is not known); else unknown. */
  async function reconcileArchive(companyId: string, plugin: ActivePlugin, op: PluginOperationRow): Promise<PluginOperationRow> {
    const repo = companyData.forCompany(companyId).plugins
    if (!plugin.manifest.objects[op.object]?.endpoints.get || op.externalId === null) return op
    const r = await connector.call(companyId, plugin, { endpoint: 'get', object: op.object, id: op.externalId, query: { properties: ['hs_object_id'] } }, async () => null)
    if (!r.ok && r.kind === 'refused' && r.status === 404) repo.updateOperation(op.id, { state: 'observed', reason: 'gone-actor-unknown' }, clock.now())
    else if (r.ok) repo.updateOperation(op.id, { state: 'sent-unknown', reason: 'still-there' }, clock.now())
    return repo.operation(op.id)!
  }
}

export type PluginOperationService = ReturnType<typeof createPluginOperationService>
