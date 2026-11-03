/**
 * The checks of a typed operation (plugins.md "Typed operations", steps 1–3
 * and 8): the record (or the folder a created record goes to) is readable,
 * the plugin runs, the AI is not stopped, the operation exists and the record
 * is linked through the current connection, `who`; the policy gates; and the
 * precheck repeated right before every send. Nothing is sent or written here.
 */
import { FULL_ACCESS_ROLES } from '../../shared/core/permissions'
import { isSameOrAncestorPath } from '../../shared/core/paths'
import { PLUGIN_ID_RE, asksFirst, effectiveFieldPolicy, effectiveOperationPolicy, type FieldPolicy, type PluginManifest, type PluginOperation, type PluginStep } from '../../shared/core/plugins'
import type { LedgerValue } from '../../shared/core/record-ledger'
import { ONTOLOGY_NAME_RE, viaOf } from '../../shared/core/record-types'
import { RECORD_ID_RE } from '../../shared/core/records'
import type { CompanyData } from '../ports/company-data'
import type { RecordRow } from '../ports/records'
import type { Member } from './access'
import { refuse } from './outcome'
import { conflict, engineWho, notActive, notFound, type OperationActor, type PluginOperationDeps } from './plugin-operation-common'
import type { ActivePlugin } from './plugins'
import { recordReader } from './record-access'
import { callVia, mayAct, NOT_VIA } from './record-engine'
import { RECORDS_DISABLED } from './records'

/** Fields that are not `auto` now (prior / off), for this operation and mapping. */
export function notAuto(plugin: ActivePlugin, operation: string, fields: string[]) {
  const prior: string[] = []
  const off: string[] = []
  for (const f of fields) {
    const p = effectiveFieldPolicy(plugin, plugin.mapping, operation, f)
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

/**
 * The business × operation gate (plan C4, plugins.md "The gate of a step's
 * run"): an execution run of a business plugin's step is named
 * `<pluginId>__<step>` (a plugin id has no `_`, so the first `__` splits it;
 * C5 claims runs under this name). null = not a plugin step (a core step such
 * as minutes reading keeps what it had).
 */
export const PLUGIN_RUN_STEP_SEPARATOR = '__'
export function parsePluginRunStep(runStep: string): { pluginId: string; step: string } | null {
  const at = runStep.indexOf(PLUGIN_RUN_STEP_SEPARATOR)
  if (at < 0) return null
  const pluginId = runStep.slice(0, at)
  const step = runStep.slice(at + PLUGIN_RUN_STEP_SEPARATOR.length)
  return PLUGIN_ID_RE.test(pluginId) && ONTOLOGY_NAME_RE.test(step) ? { pluginId, step } : null
}

/** The gate's one answer, whatever the reason (another plugin, another company's, stopped, undeclared…): it names nothing. */
export const NOT_IN_STEP = { error: 'この手順では使えない操作です', code: 'NOT_IN_STEP' } as const
export const notInStep = () => refuse('forbidden', NOT_IN_STEP.error, { code: NOT_IN_STEP.code })

/** An operation called from where its `via` does not list (a plugin's screen, a run, the core's screens). */
const notVia = () => refuse('forbidden', NOT_VIA.error, { code: NOT_VIA.code })

/** The step's declaration (own property only), or null. */
export const stepOf = (manifest: Pick<PluginManifest, 'steps'>, name: string): PluginStep | null =>
  Object.prototype.hasOwnProperty.call(manifest.steps, name) ? manifest.steps[name] : null

/**
 * An operation that never runs without a person's approval (`asksFirst`,
 * shared/core): it reaches people outside the company, moves money
 * (`moves_money`) or creates a record (統合版: never `ok_from`, never direct).
 * In a step's run it can only become an approval request, so the step must
 * declare the `approvals` tool.
 */
export { asksFirst }

/** May a step call this operation of its own plugin: the plugin declared it, the step has `plugin_operations` (and `approvals` when it asks first). */
export function stepAllowsOperation(step: Pick<PluginStep, 'tools'>, manifest: Pick<PluginManifest, 'operations'>, operation: string): boolean {
  const op = Object.prototype.hasOwnProperty.call(manifest.operations, operation) ? manifest.operations[operation] : undefined
  if (!op || !step.tools.includes('plugin_operations')) return false
  return !asksFirst(op) || step.tools.includes('approvals')
}

/** May a step use a connector role (`mail.send`): declared as is, or the bare role (`mail`) for all its operations. */
export function stepAllowsConnectorRole(step: Pick<PluginStep, 'connectorRoles'>, role: string): boolean {
  const bare = role.split('.')[0]
  return step.connectorRoles.some(r => r === role || r === bare)
}

/** Where the record (or the created record's folder) sits, for `who`'s department managers. */
export const placeOf = (row: RecordRow) => row.path ?? row.folder ?? ''

/**
 * Does `userId` hold the business role `role` of `pluginId` for this record
 * (its まとまり; a create's record not made yet: the company's assignment)?
 * Bound once by the plugins lane (plan C3, `composition/plugins.ts`); until
 * then a `role:` entry in an operation's `who` matches no one.
 */
export type OperationRoleHolds = (companyId: string, pluginId: string, recordId: string | null, role: string, userId: string) => boolean

/**
 * The step a run may use (plan C5, services/plugin-steps.ts `stepOfRun`): the
 * installed step narrowed by the work's pinned version; false when the pinned
 * version may not run now (the operator stopped it, it is gone). Bound once by
 * the plugins lane; until then the installed step decides alone.
 */
export type RunStepOf = (companyId: string, run: { step: string; procedure: string | null }) => Promise<PluginStep | null | false>

/**
 * The step an AI's call is bound to (plan C4 / C5): its execution run's, or — for a consultation
 * started from a `start: person` step (plugin-steps.md) — that step, as a run would name it, with
 * the work's pin. null: not bound (a member's ordinary consultation, a core step's run is its own
 * run); 'missing': a run that cannot be read (nothing passes).
 */
export function boundStepOf(
  handle: Pick<CompanyData, 'aiRuns' | 'pluginSteps'>, userId: string, actor: { runId?: string | null; conversationId?: string | null },
): { step: string; procedure: string | null } | null | 'missing' {
  if (actor.runId) return handle.aiRuns.byId(actor.runId) ?? 'missing'
  if (!actor.conversationId) return null
  const bound = handle.pluginSteps.consultationStep(userId, actor.conversationId)
  if (!bound) return null
  const step = `${bound.pluginId}${PLUGIN_RUN_STEP_SEPARATOR}${bound.step}`
  const pin = handle.pluginSteps.pin(bound.recordId, bound.pluginId, bound.step)?.pin
  return { step, procedure: pin ? JSON.stringify({ step, app: null, plugins: [], pin }) : null }
}

export function createOperationChecks(deps: Pick<PluginOperationDeps, 'companyData' | 'plugins' | 'roleOf' | 'managedFolders' | 'aiStopped'>) {
  const { companyData, plugins } = deps
  let roleHolds: OperationRoleHolds | null = null
  const useRoles = (r: OperationRoleHolds) => { roleHolds = r }
  let runStepOf: RunStepOf | null = null
  const usePinnedSteps = (f: RunStepOf) => { runStepOf = f }

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

  /**
   * `who` for a member (and kind) at a place, with the record's values (none
   * for a record not made yet); `role:<name>` is the plugin's role held on
   * that record (`at`, plan C3).
   */
  function mayRunAt(
    member: Member, actor: Pick<OperationActor, 'kind' | 'source'>, who: string[], values: Record<string, LedgerValue>, place: string,
    at: { pluginId: string; recordId: string | null },
  ): boolean {
    const managesPlace = who.includes('dept_manager') && deps.managedFolders(member.companyId, member.userId).some(f => isSameOrAncestorPath(f, place))
    const holds = (role: string) => roleHolds?.(member.companyId, at.pluginId, at.recordId, role, member.userId) === true
    return mayAct(engineWho(who), member, { kind: actor.kind, source: actor.source }, values, managesPlace, holds)
  }

  function mayRun(member: Member, actor: Pick<OperationActor, 'kind' | 'source'>, who: string[], recordId: string, place: string, pluginId: string): boolean {
    return mayRunAt(member, actor, who, valuesOf(member.companyId, recordId).fields, place, { pluginId, recordId })
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
      if (!mayRunAt({ ...member, role }, actor, who, values, place, { pluginId: plugin.pluginId, recordId })) return 'not-allowed'
      if (!policyOk(now.plugin)) return 'policy-changed'
      return null
    }
  }

  /**
   * The gate of a step's run (C4), checked before anything else so its one
   * answer tells nothing: an AI whose token is bound to a run of a business
   * plugin's step may call only that plugin's declared operations its step
   * allows, while the plugin runs. A core step's run (minutes reading): reads only. An
   * ordinary consultation: null.
   */
  async function stepRefusal(member: Member, actor: Pick<OperationActor, 'kind' | 'runId' | 'conversationId'>, pluginId: string, operation: string) {
    const run = actor.kind === 'ai' ? boundStepOf(companyData.forCompany(member.companyId), member.userId, actor) : null
    if (run && run !== 'missing' && !parsePluginRunStep(run.step)) {
      // A core step's run (minutes reading…) only reads a business plugin: what a まとまり gets from it
      // is the business plugin's own step (plugin-steps.md "After a meeting is read"; the core names none).
      const plugin = await plugins.active(member.companyId, pluginId)
      const op = plugin.ok && Object.prototype.hasOwnProperty.call(plugin.plugin.manifest.operations, operation) ? plugin.plugin.manifest.operations[operation] : undefined
      return op?.kind === 'read' ? null : notInStep()
    }
    const bound = await boundStep(member, actor, pluginId)
    if (bound === null) return null
    return bound && stepAllowsOperation(bound.step, bound.manifest, operation) ? null : notInStep()
  }

  /**
   * The step a run-bound AI works in, for `pluginId`: null = not a business
   * plugin's step (a consultation, a core step); false = refused (another
   * plugin's, not running, the pinned version stopped).
   */
  async function boundStep(
    member: Member, actor: Pick<OperationActor, 'kind' | 'runId' | 'conversationId'>, pluginId: string,
  ): Promise<{ step: PluginStep; manifest: PluginManifest } | null | false> {
    if (actor.kind !== 'ai') return null
    const run = boundStepOf(companyData.forCompany(member.companyId), member.userId, actor)
    if (run === null) return null
    if (run === 'missing') return false
    const bound = parsePluginRunStep(run.step)
    if (!bound) return null
    if (bound.pluginId !== pluginId) return false
    const active = await plugins.active(member.companyId, pluginId)
    const installed = active.ok ? stepOf(active.plugin.manifest, bound.step) : null
    if (!active.ok || !installed) return false
    // The work's pinned version narrows the step (C5); its stop refuses everything.
    const step = runStepOf ? await runStepOf(member.companyId, run) : installed
    return step ? { step, manifest: active.plugin.manifest } : false
  }

  /**
   * The gate for an approval request (C4, per field): inside a step's run, a
   * write that needs a person's approval — a money field, any field or create
   * whose policy is `prior` — becomes a request only when the step declares
   * `approvals`; otherwise the gate's one answer (`NOT_IN_STEP`). A
   * consultation or a core step: null.
   */
  async function approvalStepRefusal(member: Member, actor: Pick<OperationActor, 'kind' | 'runId' | 'conversationId'>, pluginId: string) {
    const bound = await boundStep(member, actor, pluginId)
    if (bound === null) return null
    return bound && bound.step.tools.includes('approvals') ? null : notInStep()
  }

  /** The checks a record operation gets before its own work: (row, plugin, op, link) or the refusal. */
  async function recordChecks(member: Member, actor: OperationActor, pluginId: string, recordId: string, operation: string) {
    const gate = await stepRefusal(member, actor, pluginId, operation)
    if (gate) return { refusal: gate } as const
    if (!companyData.forCompany(member.companyId).records.settings().enabled) return { refusal: refuse('not-found', RECORDS_DISABLED.error, { code: RECORDS_DISABLED.code }) } as const
    const row = readable(member, recordId)
    if (!row) return { refusal: notFound() } as const
    const active = await plugins.active(member.companyId, pluginId)
    if (!active.ok) return { refusal: notActive(active.problem) } as const
    if (actor.kind === 'ai' && deps.aiStopped(member.companyId)) return { refusal: refuse('forbidden', '管理者が AI の利用を一時停止しています。', { code: 'ACB_STOPPED' }) } as const
    const plugin = active.plugin
    const op = Object.prototype.hasOwnProperty.call(plugin.manifest.operations, operation) ? plugin.manifest.operations[operation] : undefined
    if (!op) return { refusal: refuse('not-found', 'この操作はありません', { code: 'OPERATION_NOT_FOUND' }) } as const
    if (!viaOf(op).includes(callVia(actor))) return { refusal: notVia() } as const
    if (op.kind === 'create' && op.createsRecord) return { refusal: refuse('bad-request', 'この操作は記録を新しく作るものです（記録を指定しません）', { code: 'OPERATION_CREATES_RECORD' }) } as const
    const link = companyData.forCompany(member.companyId).plugins.linkOfRecord(recordId)
    if (!link || link.pluginId !== pluginId || link.connectionId !== plugin.connectionId || link.object !== (op.attachTo ?? op.object)) {
      return { refusal: conflict('この記録は、いまの接続から取り込んだものではありません', 'NOT_LINKED') } as const
    }
    const place = placeOf(row)
    if (!mayRun(member, actor, op.who, recordId, place, pluginId)) {
      return { refusal: refuse('forbidden', actor.kind === 'ai' && !op.who.includes('ai') ? 'この操作は AI からはできません' : 'この操作をする権限がありません', { code: 'NOT_ALLOWED' }) } as const
    }
    return { refusal: null, row, plugin, op, link, place } as const
  }

  /** The checks a create of a record gets (no record yet): the folder it would go to stands for the record. */
  async function newRecordChecks(member: Member, actor: OperationActor, pluginId: string, operation: string) {
    const gate = await stepRefusal(member, actor, pluginId, operation)
    if (gate) return { refusal: gate } as const
    if (!companyData.forCompany(member.companyId).records.settings().enabled) return { refusal: refuse('not-found', RECORDS_DISABLED.error, { code: RECORDS_DISABLED.code }) } as const
    const active = await plugins.active(member.companyId, pluginId)
    if (!active.ok) return { refusal: notActive(active.problem) } as const
    if (actor.kind === 'ai' && deps.aiStopped(member.companyId)) return { refusal: refuse('forbidden', '管理者が AI の利用を一時停止しています。', { code: 'ACB_STOPPED' }) } as const
    const plugin = active.plugin
    const op = Object.prototype.hasOwnProperty.call(plugin.manifest.operations, operation) ? plugin.manifest.operations[operation] : undefined
    if (!op || op.kind !== 'create' || !op.createsRecord) return { refusal: refuse('not-found', 'この操作はありません', { code: 'OPERATION_NOT_FOUND' }) } as const
    if (!viaOf(op).includes(callVia(actor))) return { refusal: notVia() } as const
    const place = plugin.mapping.objects[op.object]?.visibleToFolder ?? ''
    if (!folderReadable(member, place) || !mayRunAt(member, actor, op.who, {}, place, { pluginId, recordId: null })) {
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

  return { readable, folderReadable, valuesOf, mayRunAt, mayRun, precheckFor, stepRefusal, approvalStepRefusal, recordChecks, newRecordChecks, opFor, useRoles, usePinnedSteps }
}

export type OperationChecks = ReturnType<typeof createOperationChecks>
