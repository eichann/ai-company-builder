/**
 * Approval requests with fixed content (承認のお願い, milestone 4 G6, design
 * §1-7 / §3-4 / §4-3 / §4-5; `.claude/rules/approvals.md`).
 *
 * A plugin operation whose policy is `prior` (an update with a prior field, a
 * create that is never automatic) is not refused any more: the request is
 * made instead.
 *   1. `prepareApproval` (plugin-operations.ts) runs every check a direct run
 *      would, reads HubSpot's raw value of each property now and builds the
 *      payload; nothing is sent.
 *   2. The payload's canonical text is stored as version 1 of the request's
 *      fixed content (`fixed_payloads`) and the `approval` record is created
 *      through the service writer — one transaction. The approver is resolved
 *      by the server: `self` → the requester, `dept_manager` → a manager of the
 *      department holding the record's folder (the first by id who can read
 *      it; any of them may approve), else an owner / admin; `admin` → an
 *      owner / admin. An identical pending request is not made twice.
 *   3. A person approves through their session (there is no AI or admin-API
 *      route): they qualify (`mayApprove` on the server's own data), give a
 *      reason, send the hash they were shown — it must be the newest
 *      version's — and the request is still pending. Approvals of one request
 *      are serialised here and the state is a compare-and-set, so it is used
 *      once. Then `executeApproved` re-checks everything and sends exactly the
 *      payload's raw values only while HubSpot still holds `rawBefore`.
 *      applied → `approved` (+ a 「決めたこと」 by the approver); HubSpot or the
 *      settings changed → `stale` (nothing written); a send that failed or
 *      whose answer was lost → `failed` with the operation id (never retried);
 *      anything else (a stop, the plugin off) → refused, still pending.
 *
 * Who reads a request: its requester, the person asked, whoever qualifies to
 * approve it, owners / admins — and only while they may read its folder.
 * Anyone else gets the same 404 as a request that does not exist.
 */
import {
  APPROVER_LABELS, approvalPayloadCanonical, approvalReasonProblem, mayApprove, type ApproverRule, type PluginApprovalPayload,
} from '../../shared/core/approvals'
import { isSameOrAncestorPath } from '../../shared/core/paths'
import { FULL_ACCESS_ROLES } from '../../shared/core/permissions'
import { externalToAcb } from '../../shared/core/plugins'
import type { LedgerValue } from '../../shared/core/record-ledger'
import type { FieldDef, TypeDefinition } from '../../shared/core/record-types'
import { newRecordId, RECORD_ID_RE } from '../../shared/core/records'
import type {
  ApprovalFieldView, ApprovalListItem, ApprovalMaterial, ApprovalPrecedent, ApprovalRequested, ApprovalState, ApprovalView,
} from '../../shared/types/approvals'
import { CONTENT_CHANGED_TEXT } from '../../shared/types/approvals'
import type { PluginFieldValue, PluginOperationRecordView } from '../../shared/types/plugins'
import type { Clock, IdGenerator } from '../ports/clock'
import type { CompanyData, CompanyDataSource } from '../ports/company-data'
import type { RecordRow } from '../ports/records'
import type { Transactions } from '../ports/transactions'
import { hashCanonical as fixedHash } from '../lib/content-hash'
import { logError } from '../lib/error-log'
import type { Member } from './access'
import type { FixedPayloadService } from './fixed-payloads'
import { ok, refuse, type Outcome, type Refusal } from './outcome'
import type { ActivePlugin } from './plugins'
import { recordReader } from './record-access'
import type { ActorInput, ServiceRecordWriter, ServiceWriteFailed } from './record-engine'
import { currentTypes, ensureCoreTypes } from './record-index'
import { RECORDS_DISABLED } from './records'

const TYPE = 'approval'
export const APPROVAL_NOT_FOUND = { error: '承認のお願いが見つかりません', code: 'APPROVAL_NOT_FOUND' }
/** Refusing an approver who cannot see the record — never naming the place (like ASSIGNEE_CANNOT_READ). */
export const APPROVER_CANNOT_READ = { error: '承認する人がこの記録を見られないため、お願いできません。管理者に相談してください。', code: 'APPROVER_CANNOT_READ' }
export const STALE_TEXT = 'HubSpot 側で変わっています。もう一度お願いし直してください'
/** Codes of executeApproved meaning "what was approved no longer matches": the request is used up as stale. */
const STALE_CODES = new Set(['CHANGED_OUTSIDE', 'APPROVAL_STALE', 'VERSION_CONFLICT', 'ACCOUNT_CHANGED', 'NOT_LINKED'])
const LIST_MAX = 50
const PRECEDENTS_SHOWN = 5
const SCAN_MAX = 2000

/** What the approvals service needs of the plugin operations (services/plugin-operations.ts, the approval seam). */
export interface ApprovalOperations {
  run(member: Member, actor: ActorInput, pluginId: string, recordId: string, operation: string, body: unknown): Promise<Outcome<unknown>>
  createRecord(member: Member, actor: ActorInput, pluginId: string, operation: string, body: unknown): Promise<Outcome<unknown>>
  prepareApproval(member: Member, actor: ActorInput, pluginId: string, recordId: string | null, operation: string, input: unknown):
    Promise<Outcome<{ payload: PluginApprovalPayload; approver: ApproverRule; folder: string | null }>>
  executeApproved(approver: Member, requestedFor: { userId: string; actorKind: 'human' | 'ai'; conversationId: string | null; source?: string | null },
    payload: PluginApprovalPayload, reason: string): Promise<Outcome<PluginOperationRecordView>>
  similarDeals(member: Member, pluginId: string, title: string): Promise<Outcome<{ similar: Array<{ recordId: string; title: string | null }> }>>
}

export interface ApprovalDeps {
  companyData: CompanyDataSource
  transactions: Transactions
  clock: Clock
  ids: IdGenerator
  writer: ServiceRecordWriter
  fixed: FixedPayloadService
  operations: ApprovalOperations
  /** 「決めたこと」 after an approval (services/decisions.ts). */
  decisions: { record(member: Member, actor: ActorInput, body: unknown): Promise<Outcome<unknown>> }
  roleOf: (companyId: string, userId: string) => string | null
  /** Owners and admins of the company (member ids). */
  admins: (companyId: string) => string[]
  managedFolders: (companyId: string, userId: string) => string[]
  /** The plugin as installed (labels, mapping) even while stopped; null when unknown. Display only. */
  plugin: (companyId: string, pluginId: string) => Promise<ActivePlugin | null>
}

interface Loaded {
  row: RecordRow
  state: ApprovalState
  version: number
  fields: Record<string, LedgerValue>
  rule: ApproverRule
  requestedBy: string
  about: string | null
  minutes: string | null
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const notFound = () => refuse('not-found', APPROVAL_NOT_FOUND.error, { code: APPROVAL_NOT_FOUND.code })
const str = (v: LedgerValue | undefined): string | null => (typeof v === 'string' ? v : null)

/** A value as people read it: a choice by its label, yes / no, （空）. */
export function shownValue(v: PluginFieldValue | undefined, def?: FieldDef): string {
  if (v === undefined || v === null || v === '') return '（空）'
  if (typeof v === 'boolean') return v ? 'はい' : 'いいえ'
  if (typeof v === 'string' && def?.optionLabels && Object.prototype.hasOwnProperty.call(def.optionLabels, v)) return def.optionLabels[v]
  if (typeof v === 'number') return v.toLocaleString('ja-JP')
  return String(v)
}

/** The change in percent of two numbers (one decimal), or null. */
export function changePercent(before: PluginFieldValue, after: PluginFieldValue): number | null {
  if (typeof before !== 'number' || typeof after !== 'number' || before === 0) return null
  return Math.round(((after - before) / Math.abs(before)) * 1000) / 10
}

export function createApprovalService(deps: ApprovalDeps) {
  const { companyData, writer, fixed, operations } = deps
  const locks = new Map<string, Promise<unknown>>()

  /** One approve / send back / withdraw of a request at a time inside this server. */
  async function serialised<T>(key: string, run: () => Promise<T>): Promise<T> {
    const before = locks.get(key) ?? Promise.resolve()
    const mine = before.catch(() => undefined).then(run)
    locks.set(key, mine)
    try { return await mine } finally { if (locks.get(key) === mine) locks.delete(key) }
  }

  /** The department folder holding a place (the deepest), or null. */
  function departmentOf(handle: CompanyData, folder: string | null): { id: string; folder: string } | null {
    if (folder === null || folder === '') return null
    const hits = handle.departments.folders().filter(d => isSameOrAncestorPath(d.folder.normalize('NFC'), folder.normalize('NFC')))
    hits.sort((a, b) => b.folder.length - a.folder.length)
    return hits[0] ? { id: hits[0].id, folder: hits[0].folder } : null
  }

  const managesFolder = (companyId: string, userId: string, folder: string | null) =>
    folder !== null && folder !== '' && deps.managedFolders(companyId, userId).some(f => isSameOrAncestorPath(f, folder.normalize('NFC')))

  function canReadPlace(companyId: string, handle: CompanyData, userId: string, row: Pick<RecordRow, 'id' | 'type' | 'scopeId' | 'path' | 'folder'>): boolean {
    const role = deps.roleOf(companyId, userId)
    return role !== null && recordReader({ companyId, userId, role }, handle.scopes.listWithRules()).record(row)
  }

  /** Whether `member` qualifies to approve this request, by the server's own data. */
  function qualifies(member: Member, a: Loaded): boolean {
    return mayApprove(a.rule, {
      isRequester: a.requestedBy === member.userId,
      isDeptManager: managesFolder(member.companyId, member.userId, a.row.folder),
      isAdmin: FULL_ACCESS_ROLES.has(member.role),
    })
  }

  function parse(handle: CompanyData, row: RecordRow): Loaded | null {
    const s = handle.records.states([row.id])[0]
    if (!s) return null
    let fields: Record<string, LedgerValue> = {}
    try { fields = JSON.parse(s.fields) as Record<string, LedgerValue> } catch { return null }
    const links = handle.records.linksFrom([row.id])
    const rule = (['self', 'dept_manager', 'admin'] as const).find(r => r === fields.approver_rule) ?? 'admin'
    return {
      row, state: s.state as ApprovalState, version: s.version, fields, rule, requestedBy: str(fields.requested_by) ?? '',
      about: links.find(l => l.name === 'about')?.targetId ?? null, minutes: links.find(l => l.name === 'minutes')?.targetId ?? null,
    }
  }

  /** The request, when `member` may read it (else null: the same as one that does not exist). */
  function load(member: Member, id: string): Loaded | null {
    const handle = companyData.forCompany(member.companyId)
    if (typeof id !== 'string' || !RECORD_ID_RE.test(id)) return null
    const row = handle.records.byIds([id])[0]
    if (!row || row.type !== TYPE || row.removedAt !== null) return null
    if (!recordReader(member, handle.scopes.listWithRules()).record(row)) return null
    const a = parse(handle, row)
    if (!a) return null
    const involved = a.requestedBy === member.userId || a.fields.assignee === member.userId || FULL_ACCESS_ROLES.has(member.role) || qualifies(member, a)
    return involved ? a : null
  }

  function payloadOf(companyId: string, id: string): { payload: PluginApprovalPayload; hash: string; version: number } | null {
    const row = fixed.current(companyId, 'approval', id)
    if (!row || row.canonical === null) return null
    try { return { payload: JSON.parse(row.canonical) as PluginApprovalPayload, hash: row.hash, version: row.version } } catch { return null }
  }

  /** The record type (for labels): the record's own, else the plugin's type of the object. */
  function typeOf(handle: CompanyData, recordId: string | null, plugin: ActivePlugin | null, object: string): TypeDefinition | null {
    const types = currentTypes(handle.records)
    if (recordId) {
      const row = handle.records.byIds([recordId])[0]
      if (row) return types.get(row.type)?.definition ?? null
    }
    const name = plugin?.manifest.objects[object]?.recordType
    return name ? types.get(name)?.definition ?? plugin?.types[name] ?? null : null
  }

  function fieldViews(payload: PluginApprovalPayload, def: TypeDefinition | null): ApprovalFieldView[] {
    return payload.changes.map(c => {
      const f = def?.fields[c.field]
      return {
        field: c.field, label: f?.label ?? c.field, before: c.before, after: c.after,
        beforeShown: shownValue(c.before, f), afterShown: shownValue(c.after, f), changePercent: changePercent(c.before, c.after),
      }
    })
  }

  /** The first ledger entry (create): who asked — a person or their AI — and from which consultation. */
  function requestOrigin(handle: CompanyData, id: string) {
    const entries = handle.records.ledger(id)
    const first = entries.find(e => e.version === 1)
    const last = entries[entries.length - 1]
    return { first, last }
  }

  /** Earlier approvals of the same operation and field(s) in the same department, as far as the viewer may read (counts too). */
  function precedents(viewer: Member, handle: CompanyData, a: Loaded, payload: PluginApprovalPayload, def: TypeDefinition | null): ApprovalView['precedents'] {
    const dept = departmentOf(handle, a.row.folder)
    if (!dept) return { total: 0, items: [] }
    const reader = recordReader(viewer, handle.scopes.listWithRules())
    const op = str(a.fields.operation)
    if (!op) return { total: 0, items: [] }
    const mine = new Set(payload.changes.map(c => c.field))
    const candidates = handle.records.candidates({ types: [TYPE], states: ['approved', 'sent_back'], fields: [{ name: 'operation', values: [op] }] }, SCAN_MAX)
      .filter(c => c.id !== a.row.id && reader.record(c))
    const rows = handle.records.byIds(candidates.map(c => c.id))
      .filter(r => r.removedAt === null && departmentOf(handle, r.folder)?.id === dept.id)
    const payloads = new Map(fixed.currentOf(viewer.companyId, 'approval', rows.map(r => r.id)).map(p => [p.ownerId, p]))
    const items: Array<ApprovalPrecedent & { sortAt: string }> = []
    for (const r of rows) {
      const p = parse(handle, r)
      const fp = payloads.get(r.id)
      if (!p || !fp || fp.canonical === null) continue
      let earlier: PluginApprovalPayload
      try { earlier = JSON.parse(fp.canonical) as PluginApprovalPayload } catch { continue }
      const shared = earlier.changes.filter(c => mine.has(c.field) || mine.size === 0)
      if (mine.size > 0 && shared.length === 0) continue
      // The record it was about must be readable too; else it is not shown (and not counted).
      const aboutRow = p.about ? handle.records.byIds([p.about])[0] : undefined
      if (p.about && (!aboutRow || aboutRow.removedAt !== null || !reader.record(aboutRow))) continue
      const { last } = requestOrigin(handle, r.id)
      let nowShown: ApprovalPrecedent['nowShown'] = null
      if (aboutRow && shared.length > 0) {
        const s = handle.records.states([aboutRow.id])[0]
        let now: Record<string, LedgerValue> = {}
        try { now = s ? JSON.parse(s.fields) as Record<string, LedgerValue> : {} } catch { now = {} }
        nowShown = shared.map(c => ({ label: def?.fields[c.field]?.label ?? c.field, shown: shownValue((now[c.field] ?? null) as PluginFieldValue, def?.fields[c.field]) }))
      }
      items.push({
        approvalId: r.id, at: last?.at ?? r.updatedAt, sortAt: last?.at ?? r.updatedAt, state: p.state,
        fields: shared.map(c => ({ label: def?.fields[c.field]?.label ?? c.field, beforeShown: shownValue(c.before, def?.fields[c.field]), afterShown: shownValue(c.after, def?.fields[c.field]) })),
        reason: last && last.note ? last.note : null, nowShown,
      })
    }
    items.sort((x, y) => (x.sortAt < y.sortAt ? 1 : x.sortAt > y.sortAt ? -1 : 0))
    return { total: items.length, items: items.slice(0, PRECEDENTS_SHOWN).map(({ sortAt: _s, ...rest }) => { void _s; return rest }) }
  }

  /** References shown with the request, re-checked for the viewer each time (an unreadable one is left out, as if it did not exist). */
  function materials(viewer: Member, handle: CompanyData, a: Loaded, payload: PluginApprovalPayload): ApprovalMaterial[] {
    const reader = recordReader(viewer, handle.scopes.listWithRules())
    const out: ApprovalMaterial[] = []
    const ids = [...new Set([payload.record?.id, a.minutes ?? payload.basis.minutesId].filter((x): x is string => typeof x === 'string' && RECORD_ID_RE.test(x)))]
    for (const r of handle.records.byIds(ids)) {
      if (r.removedAt !== null || !reader.record(r)) continue
      const isMinutes = r.type === 'minutes'
      out.push({ kind: isMinutes ? 'minutes' : 'record', recordId: r.id, title: r.title, version: !isMinutes && payload.record?.id === r.id ? payload.record.version : null })
    }
    return out
  }

  async function view(viewer: Member, a: Loaded): Promise<ApprovalView | null> {
    const handle = companyData.forCompany(viewer.companyId)
    const fp = payloadOf(viewer.companyId, a.row.id)
    if (!fp) return null
    const { payload } = fp
    const plugin = await deps.plugin(viewer.companyId, payload.plugin.id).catch(() => null)
    const def = typeOf(handle, payload.record?.id ?? null, plugin, payload.object)
    const reader = recordReader(viewer, handle.scopes.listWithRules())
    const aboutRow = payload.record ? handle.records.byIds([payload.record.id])[0] : undefined
    const minutesRow = payload.basis.minutesId && RECORD_ID_RE.test(payload.basis.minutesId) ? handle.records.byIds([payload.basis.minutesId])[0] : undefined
    const { first, last } = requestOrigin(handle, a.row.id)
    let create: ApprovalView['create'] = null
    if (payload.create) {
      let fields: Array<{ label: string; shown: string }> = []
      if (plugin && payload.record === null) {
        const values = externalToAcb({ manifest: plugin.manifest, types: plugin.types }, plugin.mapping, payload.object, payload.create.properties).values
        fields = Object.entries(values).filter(([k]) => k !== 'title' && k !== 'summary')
          .map(([k, v]) => ({ label: def?.fields[k]?.label ?? k, shown: shownValue(v as PluginFieldValue, def?.fields[k]) }))
      }
      create = { title: payload.create.title, fields }
    }
    // Before approving a new record: what already looks like it (only records the viewer may read).
    let similar: ApprovalView['similar'] = null
    if (payload.create && payload.record === null && a.state === 'pending') {
      const found = await operations.similarDeals(viewer, payload.plugin.id, payload.create.title).catch(() => null)
      similar = found && found.ok ? found.value.similar : null
    }
    const pending = a.state === 'pending'
    return {
      id: a.row.id, state: a.state, recordVersion: a.version, pluginId: payload.plugin.id, operation: payload.operation,
      operationLabel: plugin?.manifest.operations[payload.operation]?.label ?? payload.operation,
      systemLabel: plugin?.manifest.label ?? payload.plugin.id,
      recordId: aboutRow && reader.record(aboutRow) ? aboutRow.id : null,
      recordTitle: aboutRow && reader.record(aboutRow) ? aboutRow.title : null,
      changes: fieldViews(payload, def), create, similar,
      basis: {
        minutesId: minutesRow && reader.record(minutesRow) ? minutesRow.id : null,
        minutesTitle: minutesRow && reader.record(minutesRow) ? minutesRow.title : null,
        quote: payload.basis.quote,
      },
      precedents: precedents(viewer, handle, a, payload, def),
      materials: materials(viewer, handle, a, payload),
      proposedReason: str(a.fields.reason),
      requestedBy: a.requestedBy, requestedByAi: first?.actorKind === 'ai',
      approver: str(a.fields.assignee), approverRule: a.rule, approverRuleLabel: APPROVER_LABELS[a.rule],
      hash: fp.hash, version: fp.version, createdAt: a.row.createdAt,
      viewerMayApprove: pending && qualifies(viewer, a), viewerIsRequester: a.requestedBy === viewer.userId,
      outcome: pending || !last || last.version === 1 ? null : {
        at: last.at, by: last.actorId, note: last.note || null, resultOperationId: str(a.fields.result_operation_id),
      },
    }
  }

  /** Whom to ask (a member id), by the server's data; null when nobody fits. */
  function resolveApprover(member: Member, rule: ApproverRule, place: Pick<RecordRow, 'id' | 'type' | 'scopeId' | 'path' | 'folder'>): string | null {
    const handle = companyData.forCompany(member.companyId)
    if (rule === 'self') return member.userId
    const reads = (userId: string) => canReadPlace(member.companyId, handle, userId, place)
    if (rule === 'dept_manager') {
      const dept = departmentOf(handle, place.folder)
      const managers = dept ? [...handle.scopes.departmentManagerIds(dept.id)].sort() : []
      const first = managers.find(reads)
      if (first) return first
    }
    return [...deps.admins(member.companyId)].sort().find(reads) ?? null
  }

  function writeFailure(r: ServiceWriteFailed): Refusal {
    if (r.reason === 'assignee-cannot-read') return refuse('bad-request', APPROVER_CANNOT_READ.error, { code: APPROVER_CANNOT_READ.code })
    if (r.reason === 'stale') return refuse('conflict', 'ほかの人が先に変えました。もう一度開いてください', { code: 'VERSION_CONFLICT' })
    if (r.reason === 'records-off') return refuse('not-found', RECORDS_DISABLED.error, { code: RECORDS_DISABLED.code })
    return refuse('conflict', '承認のお願いを記録できませんでした', { code: 'APPROVAL_NOT_RECORDED' })
  }

  /** The request's title: what changes, never a customer's or person's name (「金額の変更」「取引を作る」). */
  function titleOf(payload: PluginApprovalPayload, def: TypeDefinition | null, operationLabel: string): string {
    if (payload.changes.length > 0) return `${payload.changes.map(c => def?.fields[c.field]?.label ?? c.field).join('・')}の変更`.slice(0, 200)
    return operationLabel.slice(0, 200)
  }

  const service = {
    /**
     * A plugin operation through the person's or AI's route: run it; when its
     * policy needs approval (409 APPROVAL_REQUIRED), make the request instead.
     */
    async runOrRequest(member: Member, actor: ActorInput, pluginId: string, recordId: string, operation: string, body: unknown): Promise<Outcome<unknown>> {
      const r = await operations.run(member, actor, pluginId, recordId, operation, body)
      if (r.ok || r.body.code !== 'APPROVAL_REQUIRED') return r
      return service.request(member, actor, pluginId, recordId, operation, body)
    },

    /** A create of a record (create_deal): never automatic, so it becomes a request (after every check of a direct run). */
    async createOrRequest(member: Member, actor: ActorInput, pluginId: string, operation: string, body: unknown): Promise<Outcome<unknown>> {
      const r = await operations.createRecord(member, actor, pluginId, operation, body)
      if (r.ok || r.body.code !== 'APPROVAL_REQUIRED') return r
      return service.request(member, actor, pluginId, null, operation, body)
    },

    /** Make (or find the identical pending) approval request for an operation. Body as the operation's, plus `basis?: { minutesId?, quote? }`. */
    async request(member: Member, actor: ActorInput, pluginId: string, recordId: string | null, operation: string, body: unknown): Promise<Outcome<ApprovalRequested>> {
      // The AI emergency stop stops requests made by the AI too (people's still work; design §4-5):
      // prepareApproval refuses it (ACB_STOPPED), as the AI's token does as a whole.
      const prepared = await operations.prepareApproval(member, actor, pluginId, recordId, operation, body)
      if (!prepared.ok) return prepared
      const { payload, approver: rule, folder } = prepared.value
      const handle = companyData.forCompany(member.companyId)
      // The basis must be a minutes record the requester may read (else it would point at what they cannot see).
      const minutesId = payload.basis.minutesId
      if (minutesId !== null) {
        const m = RECORD_ID_RE.test(minutesId) ? handle.records.byIds([minutesId])[0] : undefined
        if (!m || m.type !== 'minutes' || m.removedAt !== null || !recordReader(member, handle.scopes.listWithRules()).record(m)) {
          return refuse('bad-request', 'basis.minutesId: a minutes record you can read', { code: 'BAD_LINK' })
        }
      }
      const canonical = approvalPayloadCanonical(payload)
      const proposed = isObj(body) && typeof body.note === 'string' && body.note.trim() !== '' ? body.note.trim().slice(0, 2000) : null

      // The same content asked by the same person and still pending: that request is the answer.
      const opName = `${pluginId}.${operation}`
      const hashNow = fixedHash(canonical)
      const same = handle.records.candidates({
        types: [TYPE], states: ['pending'],
        fields: [{ name: 'payload_hash', values: [hashNow] }, { name: 'requested_by', values: [member.userId] }],
      }, 5)[0]
      if (same) {
        const a = load(member, same.id)
        const v = a ? await view(member, a) : null
        if (v) return ok({ outcome: 'approval-requested', approval: v, existing: true })
      }

      const place = { id: 'approval-0000000000000000', type: TYPE, scopeId: null, path: null, folder: folder ?? null }
      const approver = resolveApprover(member, rule, place)
      if (!approver) return refuse('conflict', '承認できる人が見つかりません。管理者に相談してください。', { code: 'NO_APPROVER' })
      const plugin = await deps.plugin(member.companyId, pluginId).catch(() => null)
      const def = typeOf(handle, payload.record?.id ?? null, plugin, payload.object)
      const title = titleOf(payload, def, plugin?.manifest.operations[operation]?.label ?? operation)
      const id = newRecordId(TYPE, deps.ids.newToken().slice(0, 16))
      let failure: Refusal | null = null
      try {
        deps.transactions.run(() => {
          // The core types are stored by every index run; a company whose map was never indexed gets them here.
          ensureCoreTypes(handle.records, deps.clock.now())
          const fixedNow = fixed.fix(member.companyId, 'approval', id, canonical)
          if (!fixedNow) throw new Error('fixed-content-exists')
          const made = writer.create(member.companyId, {
            type: TYPE, id, title, folder: folder ?? null,
            fields: {
              requested_by: member.userId, assignee: approver, next_actor: approver, approver_rule: rule, operation: opName,
              payload_hash: fixedNow.hash, payload_version: fixedNow.version, reason: proposed,
            },
            links: { ...(payload.record ? { about: [payload.record.id] } : {}), ...(minutesId ? { minutes: [minutesId] } : {}) },
            actor: { id: member.userId, kind: actor.kind, source: actor.source ?? null, conversationId: actor.conversationId ?? null, proposedBy: actor.proposedBy ?? null },
            note: '承認をお願いしました',
          })
          if (!made.ok) { failure = writeFailure(made); throw new Error('not-created') }
        })
      } catch (err) {
        if (failure) return failure
        logError('approvals', 'Recording an approval request failed', err, { company: member.companyId })
        return refuse('conflict', '承認のお願いを記録できませんでした', { code: 'APPROVAL_NOT_RECORDED' })
      }
      const a = load(member, id)
      const v = a ? await view(member, a) : null
      if (!v) return refuse('conflict', '承認のお願いを記録できませんでした', { code: 'APPROVAL_NOT_RECORDED' })
      return ok({ outcome: 'approval-requested', approval: v, existing: false })
    },

    async get(member: Member, id: string): Promise<Outcome<{ approval: ApprovalView }>> {
      if (!companyData.forCompany(member.companyId).records.settings().enabled) return refuse('not-found', RECORDS_DISABLED.error, { code: RECORDS_DISABLED.code })
      const a = load(member, id)
      const v = a ? await view(member, a) : null
      return v ? ok({ approval: v }) : notFound()
    },

    /** `scope`: mine (I asked) | to-me (I may approve, or I am the one asked); `state`: pending or any. */
    async list(member: Member, query: { scope?: string; state?: string }): Promise<Outcome<{ approvals: ApprovalListItem[]; total: number }>> {
      const handle = companyData.forCompany(member.companyId)
      if (!handle.records.settings().enabled) return refuse('not-found', RECORDS_DISABLED.error, { code: RECORDS_DISABLED.code })
      const scope = query.scope ?? 'to-me'
      if (scope !== 'mine' && scope !== 'to-me') return refuse('bad-request', 'scope: mine | to-me')
      const state = query.state
      if (state !== undefined && state !== 'pending' && state !== 'any') return refuse('bad-request', 'state: pending | any')
      const rows = handle.records.candidates({ types: [TYPE], ...(state === 'any' ? {} : { states: ['pending'] }) }, SCAN_MAX)
      const items: ApprovalListItem[] = []
      const full = handle.records.byIds(rows.map(r => r.id))
      for (const r of full) {
        const a = load(member, r.id)
        if (!a) continue
        const mineToApprove = a.state === 'pending' ? qualifies(member, a) : a.fields.assignee === member.userId
        if (scope === 'mine' ? a.requestedBy !== member.userId : !(mineToApprove || a.fields.assignee === member.userId)) continue
        const fp = payloadOf(member.companyId, a.row.id)
        const summary = fp ? fp.payload.changes.map(c => `${shownValue(c.before)} → ${shownValue(c.after)}`).join('、') || (fp.payload.create?.title ?? '') : ''
        const aboutRow = a.about ? handle.records.byIds([a.about])[0] : undefined
        const readsAbout = aboutRow ? recordReader(member, handle.scopes.listWithRules()).record(aboutRow) : false
        items.push({
          id: a.row.id, state: a.state, operationLabel: a.row.title, recordTitle: readsAbout && aboutRow ? aboutRow.title : null,
          summary: `${a.row.title}：${summary}`.slice(0, 300), requestedBy: a.requestedBy, approver: str(a.fields.assignee), createdAt: a.row.createdAt,
          viewerMayApprove: a.state === 'pending' && qualifies(member, a),
        })
      }
      items.sort((x, y) => (x.createdAt < y.createdAt ? 1 : x.createdAt > y.createdAt ? -1 : 0))
      return ok({ approvals: items.slice(0, LIST_MAX), total: items.length })
    },

    /** 「承認」: a person (session) who qualifies, with a reason and the hash they were shown. Used once. */
    async approve(member: Member, id: string, body: unknown): Promise<Outcome<{ approval: ApprovalView; operation: PluginOperationRecordView }>> {
      return serialised(`${member.companyId}|${id}`, async () => {
        const a = load(member, id)
        if (!a) return notFound()
        const b = isObj(body) ? body : {}
        if (!qualifies(member, a)) return refuse('forbidden', 'この承認のお願いを承認できるのは、決められた人だけです', { code: 'NOT_APPROVER' })
        const reasonProblem = approvalReasonProblem(b.reason)
        if (reasonProblem) return refuse('bad-request', reasonProblem, { code: 'REASON_REQUIRED' })
        const reason = (b.reason as string).normalize('NFC')
        if (a.state !== 'pending') return refuse('conflict', 'このお願いはもう決まっています', { code: 'NOT_PENDING', state: a.state })
        const match = fixed.matches(member.companyId, 'approval', a.row.id, b.hash)
        if (!match.ok) return refuse('conflict', CONTENT_CHANGED_TEXT, { code: 'CONTENT_CHANGED' })
        let payload: PluginApprovalPayload
        try { payload = JSON.parse(match.row.canonical) as PluginApprovalPayload } catch { return refuse('conflict', CONTENT_CHANGED_TEXT, { code: 'CONTENT_CHANGED' }) }
        const handle = companyData.forCompany(member.companyId)
        const { first } = requestOrigin(handle, a.row.id)
        const requestedFor = {
          userId: a.requestedBy, actorKind: first?.actorKind === 'ai' ? 'ai' as const : 'human' as const,
          conversationId: first?.conversationId ?? null, source: first?.actorSource ?? null,
        }
        const actor = { id: member.userId, kind: 'human' as const, source: null }
        const result = await operations.executeApproved(member, requestedFor, payload, reason)

        const settle = (to: ApprovalState, fields: Record<string, LedgerValue>, note: string, decision: boolean) => writer.transition(member.companyId, {
          recordId: a.row.id, action: to === 'approved' ? 'approve' : to === 'stale' ? 'mark_stale' : 'mark_failed', expectedVersion: a.version, to,
          fields: { next_actor: null, ...fields }, actor, note, ...(decision ? { decisionReason: note } : {}), notify: [a.requestedBy],
        })
        const after = async () => {
          const again = load(member, a.row.id)
          return again ? await view(member, again) : null
        }

        if (!result.ok) {
          const code = typeof result.body.code === 'string' ? result.body.code : ''
          const op = isObj(result.body.operation) ? result.body.operation as unknown as PluginOperationRecordView : null
          if (STALE_CODES.has(code)) {
            const t = settle('stale', {}, STALE_TEXT, false)
            if (!t.ok) logError('approvals', 'Marking an approval stale failed', undefined, { company: member.companyId, reason: t.reason })
            return refuse('conflict', STALE_TEXT, { code, ...(await after().then(v => (v ? { approval: v } : {}))) })
          }
          if (op) {
            // Sent and refused, or not known to have arrived: the approval is used (never retried automatically).
            const t = settle('failed', { result_operation_id: op.id }, reason, false)
            if (!t.ok) logError('approvals', 'Marking an approval failed failed', undefined, { company: member.companyId, reason: t.reason })
            return refuse(result.kind, result.body.error as string, { ...result.body, ...(await after().then(v => (v ? { approval: v } : {}))) })
          }
          // A stop, the plugin off, the requester's right gone…: nothing sent, the request stays pending.
          return result
        }
        const operation = result.value
        if (operation.state !== 'applied') {
          const t = settle('failed', { result_operation_id: operation.id }, reason, false)
          if (!t.ok) logError('approvals', 'Marking an approval failed failed', undefined, { company: member.companyId, reason: t.reason })
        } else {
          const t = settle('approved', { result_operation_id: operation.id }, reason, true)
          if (!t.ok) logError('approvals', 'Marking an approval approved failed', undefined, { company: member.companyId, reason: t.reason })
          else await recordDecision(member, a, payload, reason)
        }
        const v = await after()
        if (!v) return notFound()
        return ok({ approval: v, operation })
      })
    },

    /** 「差し戻す」: the approver, with a reason; the request goes back to the requester's turn. */
    async sendBack(member: Member, id: string, body: unknown): Promise<Outcome<{ approval: ApprovalView }>> {
      return serialised(`${member.companyId}|${id}`, async () => {
        const a = load(member, id)
        if (!a) return notFound()
        const b = isObj(body) ? body : {}
        if (!qualifies(member, a)) return refuse('forbidden', 'この承認のお願いを差し戻せるのは、決められた人だけです', { code: 'NOT_APPROVER' })
        const reasonProblem = approvalReasonProblem(b.reason)
        if (reasonProblem) return refuse('bad-request', reasonProblem, { code: 'REASON_REQUIRED' })
        if (a.state !== 'pending') return refuse('conflict', 'このお願いはもう決まっています', { code: 'NOT_PENDING', state: a.state })
        const note = (b.reason as string).normalize('NFC')
        const input = {
          recordId: a.row.id, action: 'send_back', expectedVersion: a.version, to: 'sent_back',
          actor: { id: member.userId, kind: 'human' as const, source: null }, note, decisionReason: note, notify: [a.requestedBy],
        }
        let t = writer.transition(member.companyId, { ...input, fields: { next_actor: a.requestedBy } })
        // A requester who can no longer read it is told, but the turn is not handed to them.
        if (!t.ok && t.reason === 'assignee-cannot-read') t = writer.transition(member.companyId, { ...input, fields: { next_actor: null } })
        if (!t.ok) return writeFailure(t)
        const v = await view(member, load(member, a.row.id) ?? a)
        return v ? ok({ approval: v }) : notFound()
      })
    },

    /** 「取り下げる」: the requester, while pending or sent back. */
    async withdraw(member: Member, id: string): Promise<Outcome<{ approval: ApprovalView }>> {
      return serialised(`${member.companyId}|${id}`, async () => {
        const a = load(member, id)
        if (!a) return notFound()
        if (a.requestedBy !== member.userId) return refuse('forbidden', '取り下げられるのは、お願いした人だけです', { code: 'NOT_REQUESTER' })
        if (a.state !== 'pending' && a.state !== 'sent_back') return refuse('conflict', 'このお願いはもう決まっています', { code: 'NOT_PENDING', state: a.state })
        const t = writer.transition(member.companyId, {
          recordId: a.row.id, action: 'withdraw', expectedVersion: a.version, to: 'withdrawn', fields: { next_actor: null },
          actor: { id: member.userId, kind: 'human', source: null }, note: '取り下げました', notify: [str(a.fields.assignee) ?? ''].filter(Boolean),
        })
        if (!t.ok) return writeFailure(t)
        const v = await view(member, load(member, a.row.id) ?? a)
        return v ? ok({ approval: v }) : notFound()
      })
    },
  }

  /**
   * 「決めたこと」 for an approval (design §1-7 step 22): important, decided by
   * the approver, linked to the request and the record, in the department of
   * the record's folder. The title says what changed, never a name. When the
   * decisions service refuses (the place, a name in the reason…), the approval
   * stands and only the refusal's code is logged.
   */
  async function recordDecision(approver: Member, a: Loaded, payload: PluginApprovalPayload, reason: string): Promise<void> {
    const handle = companyData.forCompany(approver.companyId)
    const dept = departmentOf(handle, a.row.folder)
    if (!dept) return
    const aboutRow = a.about ? handle.records.byIds([a.about])[0] : undefined
    const body = (why: string) => ({
      folder: dept.folder, title: `${a.row.title}を承認`.slice(0, 120), why, source: `承認のお願い（${a.row.id}）`.slice(0, 300),
      links: { approval: a.row.id, ...(aboutRow?.type === 'deal' ? { deal: aboutRow.id } : {}) }, important: true, key: `${a.row.id}:decision`,
    })
    void payload
    try {
      let r = await deps.decisions.record(approver, { kind: 'human' }, body(reason.replace(/\s+/g, ' ').slice(0, 1000)))
      // A name in the reason: the decision is still kept, pointing at the request for the reason.
      if (!r.ok && r.body.code === 'NAME_IN_DECISION') r = await deps.decisions.record(approver, { kind: 'human' }, body('理由は承認のお願いに残しています'))
      if (!r.ok) logError('approvals', 'The decision of an approval was not recorded', undefined, { company: approver.companyId, code: String(r.body.code ?? r.kind) })
    } catch (err) {
      logError('approvals', 'The decision of an approval was not recorded', err, { company: approver.companyId })
    }
  }

  return service
}

export type ApprovalService = ReturnType<typeof createApprovalService>
