/**
 * The checks of a typed operation (plugins.md "Typed operations", steps 1–3
 * and 8): the record (or the folder a created record goes to) is readable,
 * the plugin runs, the AI is not stopped, the operation exists and the record
 * is linked through the current connection, `who`; the policy gates; and the
 * precheck repeated right before every send. Nothing is sent or written here.
 */
import { FULL_ACCESS_ROLES } from '../../shared/core/permissions'
import { isSameOrAncestorPath } from '../../shared/core/paths'
import { effectiveFieldPolicy, effectiveOperationPolicy, type FieldPolicy, type PluginOperation } from '../../shared/core/plugins'
import type { LedgerValue } from '../../shared/core/record-ledger'
import { RECORD_ID_RE } from '../../shared/core/records'
import type { RecordRow } from '../ports/records'
import type { Member } from './access'
import { refuse } from './outcome'
import { conflict, engineWho, notActive, notFound, type OperationActor, type PluginOperationDeps } from './plugin-operation-common'
import type { ActivePlugin } from './plugins'
import { recordReader } from './record-access'
import { mayAct } from './record-engine'
import { RECORDS_DISABLED } from './records'

/** Fields that are not `auto` now (prior / off), for this operation and mapping. */
export function notAuto(plugin: ActivePlugin, operation: string, fields: string[]) {
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
export function createPolicy(plugin: ActivePlugin, operation: string, op: PluginOperation): FieldPolicy {
  const p = effectiveOperationPolicy(plugin.manifest, operation, plugin.mapping)
  return op.createsRecord && p === 'auto' ? 'prior' : p
}

export const fieldsAuto = (operation: string, fields: string[]) => (p: ActivePlugin) => { const n = notAuto(p, operation, fields); return n.prior.length + n.off.length === 0 }

/** Where the record (or the created record's folder) sits, for `who`'s department managers. */
export const placeOf = (row: RecordRow) => row.path ?? row.folder ?? ''

export function createOperationChecks(deps: Pick<PluginOperationDeps, 'companyData' | 'plugins' | 'roleOf' | 'managedFolders' | 'aiStopped'>) {
  const { companyData, plugins } = deps

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
    return recordReader(member, handle.scopes.listWithRules()).record({ id: '', type: '', scopeId: null, path: null, folder, personalOwner: null })
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

  return { readable, folderReadable, valuesOf, mayRunAt, mayRun, precheckFor, recordChecks, newRecordChecks, opFor }
}

export type OperationChecks = ReturnType<typeof createOperationChecks>
